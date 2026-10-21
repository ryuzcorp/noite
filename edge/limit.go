// Per-app rate limiting for the noite edge module.
//
// Semantics mirror caddy.rs guard_lines exactly: a 10 s window, a budget of
// ceil(rpm/6) (min 1) events per window, and a sliding-window log per key.
// Over the limit the module answers 429 with Retry-After.
package edge

import (
	"net/netip"
	"sort"
	"sync"
	"time"
)

// RateWindow is the sliding window the edge counts requests over (mirrors
// RATE_WINDOW_S in the runner: limits are configured per minute and
// enforced as a sixth of that per 10 s).
const RateWindow = 10 * time.Second

// maxKeys bounds memory under a wide flood: one entry per client address.
const maxKeys = 65536

type keyState struct {
	stamps   []int64 // unix nanos, ascending
	lastSeen int64
}

type zoneState struct {
	keys map[string]*keyState
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

// budget converts a per-minute rate to events per window, mirroring
// guard_lines: ceil(rpm/6), min 1.
func budget(rpm uint32) int {
	b := int((rpm + 5) / 6)
	if b < 1 {
		b = 1
	}
	return b
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

// Allow records one event in zone (creating it) and reports whether it fits
// the rpm budget. retryAfter is how long the caller should tell the client
// to wait when denied.
func (l *Limiter) Allow(zone string, rpm uint32, key string) (bool, time.Duration) {
	if rpm == 0 || key == "" {
		return true, 0
	}
	now := l.now().UnixNano()
	cutoff := now - int64(RateWindow)

	l.mu.Lock()
	defer l.mu.Unlock()

	z, ok := l.zones[zone]
	if !ok {
		z = &zoneState{keys: make(map[string]*keyState)}
		l.zones[zone] = z
	}
	// New zones for a renamed app must not inherit a stranger's budget:
	// zone names are per-app and the runner controls them, so a shared map
	// is exactly today's process-wide pool behavior.
	ks, ok := z.keys[key]
	if !ok {
		if len(z.keys) >= maxKeys {
			l.evictLocked(z)
		}
		ks = &keyState{}
		z.keys[key] = ks
	}
	// Drop stamps outside the window; the slice stays ascending.
	stamps := ks.stamps
	keep := sort.Search(len(stamps), func(i int) bool { return stamps[i] > cutoff })
	stamps = append(stamps[:0:0], stamps[keep:]...)
	if len(stamps) >= budget(rpm) {
		wait := time.Duration(stamps[0]+int64(RateWindow)-now) + time.Second - 1
		retry := wait / time.Second
		if retry < 1 {
			retry = 1
		}
		ks.stamps = stamps
		ks.lastSeen = now
		return false, retry * time.Second
	}
	ks.stamps = append(stamps, now)
	ks.lastSeen = now
	return true, 0
}

// evictLocked drops the least-recently-seen quarter of keys. O(n) and rare.
func (l *Limiter) evictLocked(z *zoneState) {
	type kv struct {
		k string
		t int64
	}
	all := make([]kv, 0, len(z.keys))
	for k, ks := range z.keys {
		all = append(all, kv{k, ks.lastSeen})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].t < all[j].t })
	for _, e := range all[:len(all)/4+1] {
		delete(z.keys, e.k)
	}
}

// Sweep drops zones the table no longer references and keys unseen for a
// long while. Called on every table push.
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
			if time.Duration(now-ks.lastSeen) > idle {
				delete(z.keys, k)
			}
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
