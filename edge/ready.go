// Fleet readiness for the noite edge module.
//
// Active health checks don't apply to dynamic upstreams, so the module
// probes fleet upstreams itself: one background goroutine per live fleet
// upstream, GETing /.well-known/celld/health every second with a 2 s
// timeout — the same numbers as the old TENANT_PROXY. Requests for a
// route whose upstream is down hold until the prober flips healthy (or a
// table swap changes the route), re-checking on a short interval as a
// backstop and giving up after a cap by proxying anyway and letting
// handle_errors answer the starting page. Asleep routes skip probing: the
// wake hop guarantees readiness.
package edge

import (
	"context"
	"net/http"
	"sync"
	"time"
)

// HealthPath is what celld answers 200 on once its ready gate opens (503
// before that, up to CELLD_READY_FLEET_GATE_MS).
const HealthPath = "/.well-known/celld/health"

type upstreamState struct {
	cancel  context.CancelFunc
	mu      sync.Mutex
	healthy bool
	// changed is closed and replaced on every flip; waiters select on it.
	changed chan struct{}
}

func (s *upstreamState) set(healthy bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.healthy == healthy {
		return
	}
	s.healthy = healthy
	close(s.changed)
	s.changed = make(chan struct{})
}

func (s *upstreamState) get() (bool, <-chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.healthy, s.changed
}

// Prober tracks one background health check per fleet upstream.
type Prober struct {
	mu       sync.Mutex
	up       map[string]*upstreamState
	interval time.Duration
	timeout  time.Duration
	check    func(upstream string) bool
}

// NewProber returns a Prober. check == nil uses the default HTTP probe;
// tests inject a fake.
func NewProber(interval, timeout time.Duration, check func(string) bool) *Prober {
	if check == nil {
		c := &http.Client{Timeout: timeout}
		check = func(upstream string) bool {
			resp, err := c.Get("http://" + upstream + HealthPath)
			if err != nil {
				return false
			}
			defer resp.Body.Close()
			return resp.StatusCode == http.StatusOK
		}
	}
	return &Prober{
		up:       make(map[string]*upstreamState),
		interval: interval,
		timeout:  timeout,
		check:    check,
	}
}

// Track starts probing every upstream in the set and stops the ones that
// left. New upstreams start down and the first probe runs immediately, so
// requests hold until the first result lands (like a fresh Caddy config
// checking health on load); they flip within one interval when up.
func (p *Prober) Track(upstreams map[string]bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for u := range upstreams {
		if _, ok := p.up[u]; ok {
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		st := &upstreamState{cancel: cancel, healthy: false, changed: make(chan struct{})}
		// New upstreams start down: the goroutine below probes immediately,
		// and requests hold until the first result lands — the same as a
		// fresh Caddy config checking health on load.
		p.up[u] = st
		go p.run(ctx, u, st)
	}
	for u, st := range p.up {
		if !upstreams[u] {
			st.cancel()
			delete(p.up, u)
		}
	}
}

func (p *Prober) run(ctx context.Context, upstream string, st *upstreamState) {
	t := time.NewTicker(p.interval)
	defer t.Stop()
	// Probe immediately: a dead upstream flips within ~one timeout of the
	// push instead of waiting out the first interval.
	st.set(p.check(upstream))
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			st.set(p.check(upstream))
		}
	}
}

// Healthy reports the last probed state (true for untracked upstreams).
func (p *Prober) Healthy(upstream string) bool {
	p.mu.Lock()
	st, ok := p.up[upstream]
	p.mu.Unlock()
	if !ok {
		return true
	}
	healthy, _ := st.get()
	return healthy
}

// WaitHealthy blocks until upstream is healthy, recheck elapses between
// backstop checks, and giveUp caps the hold. True means healthy (or the
// route changed under us — callers re-read the table then); false means
// the cap elapsed and the caller should proxy anyway.
func (p *Prober) WaitHealthy(upstream string, recheck, giveUp time.Duration) bool {
	deadline := time.Now().Add(giveUp)
	backstop := time.NewTicker(recheck)
	defer backstop.Stop()
	for {
		p.mu.Lock()
		st, ok := p.up[upstream]
		p.mu.Unlock()
		if !ok {
			return true
		}
		if healthy, changed := st.get(); healthy {
			return true
		} else {
			remaining := time.Until(deadline)
			if remaining <= 0 {
				return false
			}
			timer := time.NewTimer(remaining)
			select {
			case <-changed:
				timer.Stop()
			case <-backstop.C:
				timer.Stop()
			case <-timer.C:
				return false
			}
		}
	}
}

// Stop halts every probe goroutine.
func (p *Prober) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for u, st := range p.up {
		st.cancel()
		delete(p.up, u)
	}
}
