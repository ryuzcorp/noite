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
// key cannot extend its own window, and eviction never picks a Throttled
// key: a key flood must not clear the throttle of the key that caused it.
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

// maxKeys bounds memory under a wide flood: one entry per client address.
const maxKeys = 65536

// RateLimit is one zone a request counts against: the zone name the table
// shares between hosts, its configured per-minute rate and the key inside it.
type RateLimit struct {
	Zone string
	RPM  uint32
	Key  string
}

// Decision is a request's verdict. RetryAfter is only set when Allowed is
// false: the time until the zone that refused starts admitting again.
type Decision struct {
	Allowed    bool
	RetryAfter time.Duration
}

type keyState struct {
	stamps   []int64 // unix nanos, ascending, oldest first
	lastSeen int64   // unix nanos; last request, admitted or refused
	window   int64   // window of the rate its stamps were counted against
	size     int     // budget of that rate, so a Throttled key is recognised
}

type zoneState struct {
	keys map[string]*keyState
	// noRoomUntil is set when a full zone found no key it may evict; new
	// keys are then refused without rescanning every key until it passes.
	noRoomUntil int64
}

// Limiter holds the process-wide pool of rate-limit zones. Zones are
// shared by name across hosts (a subdomain, its custom domains and its
// plaintext twins draw from one budget), so state survives table swaps.
type Limiter struct {
	mu    sync.Mutex
	zones map[string]*zoneState
	now   func() time.Time
}

// NewLimiter returns a Limiter using now for time (inject a fake clock in
// tests; production passes time.Now).
func NewLimiter(now func() time.Time) *Limiter {
	if now == nil {
		now = time.Now
	}
	return &Limiter{zones: make(map[string]*zoneState), now: now}
}

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
	d := l.AllowAll([]RateLimit{{Zone: zone, RPM: rpm, Key: key}})
	return d.Allowed, d.RetryAfter
}

// AllowAll plans and commits one request against every zone at once: the
// request is admitted only when all zones fit it, and only then does each
// zone record a stamp. A refusal in the second zone therefore spends no
// budget in the first, so a client is not throttled twice for one refusal.
// RetryAfter is the longest remaining wait among the zones that refused.
func (l *Limiter) AllowAll(limits []RateLimit) Decision {
	now := l.now().UnixNano()
	l.mu.Lock()
	defer l.mu.Unlock()

	decision := Decision{Allowed: true}
	for _, lim := range limits {
		if lim.RPM == 0 || lim.Key == "" {
			continue
		}
		if ok, wait := l.fitLocked(lim, now); !ok {
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
	for _, lim := range limits {
		if lim.RPM == 0 || lim.Key == "" {
			continue
		}
		l.commitLocked(lim, now)
	}
	return decision
}

// fitLocked reports whether lim's key admits one more event and, when it
// does not, how long until it does. It records nothing: the caller commits
// only after every zone admitted the request. Expired stamps are dropped as
// they are encountered, which is not a state change (they no longer count).
func (l *Limiter) fitLocked(lim RateLimit, now int64) (bool, time.Duration) {
	window, size := limitFor(lim.RPM)
	z := l.zones[lim.Zone]
	if z == nil {
		// A new zone has room for a first key by definition.
		return true, 0
	}
	ks := z.keys[lim.Key]
	if ks == nil {
		if len(z.keys) < maxKeys {
			return true, 0
		}
		// The zone is full: make room by evicting keys whose budget has
		// recovered, never a throttled one. A failed scan is remembered for
		// one window so a flood of new keys cannot make every request in it
		// rescan the whole zone.
		if now < z.noRoomUntil {
			return false, window
		}
		if !l.makeRoomLocked(z, now) {
			z.noRoomUntil = now + int64(RateWindow)
			return false, window
		}
		return true, 0
	}
	cutoff := now - int64(window)
	keep := sort.Search(len(ks.stamps), func(i int) bool { return ks.stamps[i] > cutoff })
	ks.stamps = ks.stamps[keep:]
	ks.lastSeen = now
	ks.window, ks.size = int64(window), size
	if len(ks.stamps) < size {
		return true, 0
	}
	// Enough stamps must leave the window for this key to admit another
	// event; more than one when a lowered rate shrank the budget.
	need := len(ks.stamps) - size + 1
	return false, time.Duration(ks.stamps[need-1] + int64(window) - now)
}

// commitLocked records one admitted event for lim.
func (l *Limiter) commitLocked(lim RateLimit, now int64) {
	window, size := limitFor(lim.RPM)
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
	ks.window, ks.size = int64(window), size
}

// makeRoomLocked evicts the least-recently-seen quarter of keys that are not
// currently throttled, and reports whether it freed a slot. A key whose
// stamps still fill its live budget is never evicted: a client that floods a
// zone with fresh keys could otherwise cycle them to flush its own (or
// another client's) throttle and carry on unthrottled. When every key is
// throttled the zone refuses new keys for up to one window instead. O(n log
// n), and only while a zone is full.
func (l *Limiter) makeRoomLocked(z *zoneState, now int64) bool {
	type kv struct {
		k string
		t int64
	}
	all := make([]kv, 0, len(z.keys)/4+1)
	for k, ks := range z.keys {
		if throttled(ks, now) {
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

// throttled reports whether ks carries a live budget that a further request
// would be refused against. Its window and size are those of the last
// request it saw, so a key that changed zones' rate is judged as it was
// charged.
func throttled(ks *keyState, now int64) bool {
	if ks.size == 0 {
		return false
	}
	cutoff := now - ks.window
	live := len(ks.stamps) - sort.Search(len(ks.stamps), func(i int) bool { return ks.stamps[i] > cutoff })
	return live >= ks.size
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
	now := l.now().UnixNano()
	l.mu.Lock()
	defer l.mu.Unlock()
	for name, z := range l.zones {
		if !keep[name] {
			delete(l.zones, name)
			continue
		}
		for k, ks := range z.keys {
			if time.Duration(now-ks.lastSeen) <= idle || throttled(ks, now) {
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
