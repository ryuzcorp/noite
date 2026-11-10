// Per-app rate limiting for the noite edge module.
//
// A request is counted against every zone its route names (the client zone
// keyed by IP, then the app zone keyed by "all"), and a 429 answers with the
// remaining time of the zone that is still over budget.
//
// # State machine
//
// Each key is a sliding log of request stamps inside a window derived from
// the configured per-minute rate (limitFor). A request moves its key:
//
//	stateDiagram-v2
//	    [*] --> Open: first request inside the window
//	    Open --> Open: len(stamps) < budget (stamp recorded)
//	    Open --> Throttled: len(stamps) == budget
//	    Throttled --> Throttled: request refused (no stamp recorded)
//	    Throttled --> Open: enough stamps leave the window
//	    Open --> Cold: every stamp leaves the window
//	    Throttled --> Cold: every stamp leaves the window
//	    Cold --> [*]: evicted least-recently-seen, or swept after idle
//
// Every transition is in fitLocked/commitLocked below, and eviction of a
// Cold key is in makeRoomLocked. A refusal records no stamp, so a throttled
// key cannot extend its own window. Eviction only ever touches a Cold key:
// a key still inside its window keeps the budget it has spent, so a flood of
// fresh keys cannot clear a throttle. When a zone is full of such keys the
// request that would add one is admitted unrecorded (fitUnrecorded) rather
// than resetting a budget that is still in force.
package edge

import (
	"net/netip"
	"sort"
	"sync"
	"time"
)

// RateWindow is the sliding window the edge counts requests over. It must
// divide a minute: the budget is a whole number of events per window, so an
// exact number of windows in a minute is what makes it a per-minute ceiling.
// Limits are configured per minute and the budget rounds down (see limitFor).
const RateWindow = 10 * time.Second

// The window must divide a minute, or the per-window budget stops being a
// per-minute ceiling; a bad RateWindow fails the build here.
var _ = [1]struct{}{}[time.Minute%RateWindow]

// maxKeys bounds memory under a wide flood: one entry per client address. A
// full zone admits new keys unrecorded instead of evicting one that is still
// throttled, so memory stays bounded without resetting a live budget.
const maxKeys = 65536

// RateLimit is one zone a request counts against: the zone name the table
// shares between hosts, its configured per-minute rate and the key inside it.
// The zero value is no limit.
type RateLimit struct {
	Zone string
	RPM  uint32
	Key  string
}

// enabled reports whether the limit applies: a zero rate turns it off and an
// empty key (an unparsable client address) skips it.
func (r RateLimit) enabled() bool { return r.RPM > 0 && r.Key != "" }

// Decision is a request's verdict. RetryAfter is only set when Allowed is
// false: the time until the key that refused starts admitting again.
type Decision struct {
	Allowed    bool
	RetryAfter time.Duration
}

type keyState struct {
	stamps   []int64 // unix nanos, ascending, oldest first
	lastSeen int64   // unix nanos; last request, admitted or refused
	window   int64   // longest window its stamps were counted against
}

type zoneState struct {
	keys map[string]*keyState
	// noRoomUntil is set when a full zone found no key it may evict; new
	// keys are then admitted unrecorded without rescanning every key until
	// it passes.
	noRoomUntil int64
}

// fit is what one zone decides about a request.
type fit uint8

const (
	// fitAdmit admits the request and records a stamp in the zone.
	fitAdmit fit = iota
	// fitRefuse refuses it: the key is over its budget.
	fitRefuse
	// fitUnrecorded admits it without a stamp: the zone holds maxKeys keys
	// that are all still inside their windows, and evicting one would reset
	// a budget that is still in force.
	fitUnrecorded
)

// Limiter holds the process-wide pool of rate-limit zones. Zones are
// shared by name across hosts (a subdomain, its custom domains and its
// plaintext twins draw from one budget), so state survives table swaps.
type Limiter struct {
	mu    sync.Mutex
	zones map[string]*zoneState
	now   func() time.Time
	base  time.Time
}

// NewLimiter returns a Limiter using now for time (inject a fake clock in
// tests; production passes time.Now).
func NewLimiter(now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	return &Limiter{zones: make(map[string]*zoneState), now: now, base: now()}
}

// nanos is the clock the limiter counts in: nanoseconds since it was created.
// time.Time.Sub keeps the monotonic reading, so a wall-clock step (NTP, a VM
// resume) cannot reorder a key's stamps, which the ascending log and its
// binary searches rely on, or expire every window at once.
func (l *Limiter) nanos() int64 { return int64(l.now().Sub(l.base)) }

// limitFor returns the sliding window and the number of events the budget
// admits in it for a configured per-minute rate.
//
// The budget is a whole number of events, so it rounds the configured rate
// down and a limit is never exceeded: 1800/min is exactly 300 per 10 s,
// 100/min is 16 per 10 s (96/min). Below 6/min a 10 s window cannot hold
// even one event without rounding up (one per 10 s is six a minute), so the
// window widens to an exact divisor of a minute: 1/min is one event per
// 60 s, 5/min one per 12 s.
func limitFor(rpm uint32) (time.Duration, int) {
	if rpm == 0 {
		return 0, 0
	}
	if budget := int(uint64(rpm) * uint64(RateWindow) / uint64(time.Minute)); budget > 0 {
		return RateWindow, budget
	}
	return time.Minute / time.Duration(rpm), 1
}

// ClientKey collapses an IP for per-client zones: one IPv6 subscriber holds
// a whole /64, so counting addresses separately would let one client rotate
// past the limit. Returns "" when the address does not parse (callers then
// skip limiting rather than lumping every broken address together).
func ClientKey(clientIP string) string {
	addr, err := netip.ParseAddr(clientIP)
	if err != nil {
		// May be "ip:port" if the caller passed RemoteAddr through.
		if h, _, serr := splitHostPort(clientIP); serr == nil {
			addr, err = netip.ParseAddr(h)
		}
		if err != nil {
			return ""
		}
	}
	addr = addr.Unmap()
	if addr.Is6() {
		p := addr.As16()
		for i := 8; i < 16; i++ {
			p[i] = 0
		}
		addr = netip.AddrFrom16(p)
	}
	return addr.String()
}

// Allow reports whether one request counted against one zone fits, recording
// it when it does. retryAfter is how long the caller should tell the client
// to wait when denied.
func (l *Limiter) Allow(zone string, rpm uint32, key string) (bool, time.Duration) {
	d := l.AllowRequest(RateLimit{Zone: zone, RPM: rpm, Key: key}, RateLimit{})
	return d.Allowed, d.RetryAfter
}

// AllowRequest plans and commits one request against the client zone and the
// app zone of its route in one step: the request is admitted only when both
// zones fit it, and only then does each zone record a stamp. A refusal in the
// second zone therefore spends no budget in the first, so a client is not
// throttled twice for one refusal. RetryAfter is the longest remaining wait
// among the zones that refused.
//
// A zero-RPM or empty-key limit is absent, so either or both arguments may be
// the zero value.
func (l *Limiter) AllowRequest(client, app RateLimit) Decision {
	now := l.nanos()
	l.mu.Lock()
	defer l.mu.Unlock()

	limits := [2]RateLimit{client, app}
	var fits [2]fit
	decision := Decision{Allowed: true}
	for i, lim := range limits {
		if !lim.enabled() {
			continue
		}
		ok, wait := l.fitLocked(lim, now)
		fits[i] = ok
		if ok == fitRefuse {
			decision.Allowed = false
			if wait > decision.RetryAfter {
				decision.RetryAfter = wait
			}
		}
	}
	if !decision.Allowed {
		decision.RetryAfter = ceilSeconds(decision.RetryAfter)
		return decision
	}
	for i, lim := range limits {
		if fits[i] == fitAdmit {
			l.commitLocked(lim, now)
		}
	}
	return decision
}

// fitLocked reports what lim's key decides and, when it refuses, how long
// until it admits again. It records no stamp: the caller commits only after
// every zone admitted the request. Expired stamps are dropped as they are
// encountered, which is not a state change (they no longer count).
func (l *Limiter) fitLocked(lim RateLimit, now int64) (fit, time.Duration) {
	window, size := limitFor(lim.RPM)
	z := l.zones[lim.Zone]
	if z == nil {
		// A new zone has room for a first key by definition.
		return fitAdmit, 0
	}
	ks := z.keys[lim.Key]
	if ks == nil {
		if len(z.keys) < maxKeys {
			return fitAdmit, 0
		}
		// The zone is full: make room by evicting keys whose budget has
		// recovered, never one that is still inside its window. A failed scan
		// is remembered for a window so a flood of new keys cannot make every
		// request rescan the whole zone.
		if now < z.noRoomUntil {
			return fitUnrecorded, 0
		}
		if !l.makeRoomLocked(z, now) {
			z.noRoomUntil = now + int64(RateWindow)
			return fitUnrecorded, 0
		}
		return fitAdmit, 0
	}
	cutoff := now - int64(window)
	keep := sort.Search(len(ks.stamps), func(i int) bool { return ks.stamps[i] > cutoff })
	ks.stamps = ks.stamps[keep:]
	ks.lastSeen = now
	if int64(window) > ks.window {
		ks.window = int64(window)
	}
	if len(ks.stamps) < size {
		return fitAdmit, 0
	}
	// Enough stamps must leave the window for this key to admit another
	// event; more than one when a lowered rate shrank the budget.
	need := len(ks.stamps) - size + 1
	return fitRefuse, time.Duration(ks.stamps[need-1] + int64(window) - now)
}

// commitLocked records one admitted event for lim.
func (l *Limiter) commitLocked(lim RateLimit, now int64) {
	window, _ := limitFor(lim.RPM)
	z := l.zones[lim.Zone]
	if z == nil {
		z = &zoneState{keys: make(map[string]*keyState)}
		l.zones[lim.Zone] = z
	}
	ks := z.keys[lim.Key]
	if ks == nil {
		ks = &keyState{}
		z.keys[lim.Key] = ks
	}
	ks.stamps = append(ks.stamps, now)
	ks.lastSeen = now
	if int64(window) > ks.window {
		ks.window = int64(window)
	}
}

// makeRoomLocked evicts the least-recently-seen quarter of keys that are no
// longer inside their window, and reports whether it freed a slot. A key
// with even one live stamp is never evicted: a client that floods a zone with
// fresh keys could otherwise cycle them to flush its own (or another
// client's) budget and carry on before its window ends. O(n log n), and only
// while a zone is full.
func (l *Limiter) makeRoomLocked(z *zoneState, now int64) bool {
	type kv struct {
		k string
		t int64
	}
	all := make([]kv, 0, len(z.keys)/4+1)
	for k, ks := range z.keys {
		if live(ks, now) > 0 {
			continue
		}
		all = append(all, kv{k, ks.lastSeen})
	}
	if len(all) == 0 {
		return false
	}
	sort.Slice(all, func(i, j int) bool { return all[i].t < all[j].t })
	n := len(all)/4 + 1
	if n > len(all) {
		n = len(all)
	}
	for _, e := range all[:n] {
		delete(z.keys, e.k)
	}
	return true
}

// live returns how many of ks's stamps are still inside the window they were
// counted against.
func live(ks *keyState, now int64) int {
	if ks.window == 0 {
		return 0
	}
	cutoff := now - ks.window
	return len(ks.stamps) - sort.Search(len(ks.stamps), func(i int) bool { return ks.stamps[i] > cutoff })
}

// ceilSeconds rounds a wait up to whole seconds, never below one: the
// Retry-After header counts in seconds and the request is refused now.
func ceilSeconds(wait time.Duration) time.Duration {
	if wait < time.Second {
		return time.Second
	}
	return (wait + time.Second - 1) / time.Second * time.Second
}

// Sweep drops zones the table no longer references and keys unseen for a
// long while. Called on every table push. A key that is still inside its
// window keeps its budget regardless of idle, so a sweep never resets a live
// throttle.
func (l *Limiter) Sweep(keep map[string]bool, idle time.Duration) {
	now := l.nanos()
	l.mu.Lock()
	defer l.mu.Unlock()
	for name, z := range l.zones {
		if !keep[name] {
			delete(l.zones, name)
			continue
		}
		for k, ks := range z.keys {
			if time.Duration(now-ks.lastSeen) <= idle || live(ks, now) > 0 {
				continue
			}
			delete(z.keys, k)
		}
	}
}

// Zones returns the live zone names, for tests.
func (l *Limiter) Zones() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, 0, len(l.zones))
	for name := range l.zones {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}
