// Fleet readiness for the noite edge module.
//
// Active health checks don't apply to dynamic upstreams, so the module
// probes fleet upstreams itself: one background goroutine per live fleet
// upstream, GETing /.well-known/celld/health every second with a 2 s
// timeout — the same numbers as the old TENANT_PROXY. Requests for a route
// whose upstream is down hold until the prober sees it up (or a table swap
// drops it), re-checking on a short interval as a backstop and giving up
// after a cap by answering 503 so handle_errors renders the starting page.
// Asleep routes skip probing: the wake hop guarantees readiness.
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

// Health is one upstream's readiness.
//
//	stateDiagram-v2
//	    [*] --> Untracked
//	    Untracked --> Down: Track (probe pending)
//	    Down --> Up: probe answers 200
//	    Up --> Down: probe fails or times out
//	    Up --> Untracked: Track drops it / Stop
//	    Down --> Untracked: Track drops it / Stop
//
// Untracked fails open: nothing probes that upstream, so holding a request
// would only add latency before the proxy's own connection error. Only Down
// is worth waiting for.
type Health uint8

const (
	// HealthUntracked is not probed by this process (fail open).
	HealthUntracked Health = iota
	// HealthDown is tracked and its last probe failed.
	HealthDown
	// HealthUp is tracked and its last probe answered 200.
	HealthUp
)

// String names the state for logs and test failures.
func (h Health) String() string {
	switch h {
	case HealthUntracked:
		return "untracked"
	case HealthDown:
		return "down"
	case HealthUp:
		return "up"
	}
	return "unknown"
}

// WaitOutcome is how a readiness hold ended.
//
//	stateDiagram-v2
//	    [*] --> Pending
//	    Pending --> Ready: health became Up
//	    Pending --> Abandoned: the table dropped the upstream (fail open)
//	    Pending --> TimedOut: the hold cap elapsed
type WaitOutcome uint8

const (
	// WaitReady means the upstream turned healthy before the cap.
	WaitReady WaitOutcome = iota
	// WaitAbandoned means the table no longer tracks the upstream: the
	// route changed under the request, so the caller proxies and lets the
	// new route answer.
	WaitAbandoned
	// WaitTimedOut means the cap elapsed with the upstream still down.
	WaitTimedOut
)

// String names the outcome for logs and test failures.
func (w WaitOutcome) String() string {
	switch w {
	case WaitReady:
		return "ready"
	case WaitAbandoned:
		return "abandoned"
	case WaitTimedOut:
		return "timed out"
	}
	return "unknown"
}

type upstreamState struct {
	cancel context.CancelFunc
	mu     sync.Mutex
	health Health
	// changed is closed and replaced on every flip; waiters select on it.
	changed chan struct{}
}

// observe is the only health transition: it records the state and wakes
// waiters when it actually changed.
func (s *upstreamState) observe(next Health) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.health == next {
		return
	}
	s.health = next
	close(s.changed)
	s.changed = make(chan struct{})
}

// get returns the last observed health and the channel that flips with it.
func (s *upstreamState) get() (Health, <-chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.health, s.changed
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

// Track starts probing every upstream in the set and untracks the ones that
// left. New upstreams start Down and the first probe runs immediately, so
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
		st := &upstreamState{cancel: cancel, health: HealthDown, changed: make(chan struct{})}
		p.up[u] = st
		go p.run(ctx, u, st)
	}
	for u := range p.up {
		if !upstreams[u] {
			p.dropLocked(u)
		}
	}
}

// dropLocked untracks one upstream. Callers hold p.mu.
func (p *Prober) dropLocked(upstream string) {
	st, ok := p.up[upstream]
	if !ok {
		return
	}
	st.cancel()
	// A waiter that already holds this state sees it untracked (fail open)
	// instead of the last probe result.
	st.observe(HealthUntracked)
	delete(p.up, upstream)
}

// run probes upstream until ctx is cancelled, recording every result.
func (p *Prober) run(ctx context.Context, upstream string, st *upstreamState) {
	t := time.NewTicker(p.interval)
	defer t.Stop()
	probe := func() {
		if p.check(upstream) {
			st.observe(HealthUp)
			return
		}
		st.observe(HealthDown)
	}
	// Probe immediately: a dead upstream flips within ~one timeout of the
	// push instead of waiting out the first interval.
	probe()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			probe()
		}
	}
}

// Health reports upstream's readiness. Untracked upstreams are
// HealthUntracked, never a stale probe result from before they left.
func (p *Prober) Health(upstream string) Health {
	p.mu.Lock()
	st, ok := p.up[upstream]
	p.mu.Unlock()
	if !ok {
		return HealthUntracked
	}
	health, _ := st.get()
	return health
}

// Wait blocks until upstream is Up, is dropped from the table, or giveUp
// elapses. recheck is the backstop interval between state reads, so a missed
// wakeup costs one tick rather than the whole cap.
func (p *Prober) Wait(upstream string, recheck, giveUp time.Duration) WaitOutcome {
	deadline := time.Now().Add(giveUp)
	backstop := time.NewTicker(recheck)
	defer backstop.Stop()
	for {
		p.mu.Lock()
		st, ok := p.up[upstream]
		p.mu.Unlock()
		if !ok {
			return WaitAbandoned
		}
		health, changed := st.get()
		switch health {
		case HealthUp:
			return WaitReady
		case HealthUntracked:
			return WaitAbandoned
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return WaitTimedOut
		}
		timer := time.NewTimer(remaining)
		select {
		case <-changed:
			timer.Stop()
		case <-backstop.C:
			timer.Stop()
		case <-timer.C:
			return WaitTimedOut
		}
	}
}

// Stop untracks every upstream and halts its probe goroutine.
func (p *Prober) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for u := range p.up {
		p.dropLocked(u)
	}
}
