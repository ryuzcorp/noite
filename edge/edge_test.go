package edge

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"
)

// resetShared installs a fresh process-wide state for one test (the
// package's tests run sequentially, and every test starts here, so no two
// share a prober or a table). refs starts at 1: the test owns one instance.
func resetShared(t *testing.T, table *Table, prober *Prober) {
	t.Helper()
	if prober == nil {
		prober = NewProber(time.Second, 2*time.Second, func(string) bool { return true })
	}
	shared.mu.Lock()
	if prev := shared.st.prober; prev != nil {
		prev.Stop()
	}
	shared.refs = 1
	shared.st = edgeState{phase: PhaseBooting}
	shared.holdRecheck = 5 * time.Millisecond
	shared.holdCap = 50 * time.Millisecond
	shared.log = zap.NewNop()
	shared.newProber = func() *Prober { return prober }
	shared.mu.Unlock()
	if table != nil {
		if _, err := shared.install(table); err != nil {
			t.Fatalf("resetting the shared table: %v", err)
		}
	}
}

// liveTable is the table a request would serve from right now.
func liveTable() *Table {
	shared.mu.Lock()
	defer shared.mu.Unlock()
	return shared.st.tab
}

// liveProber is the prober the loaded edge owns, or nil.
func liveProber() *Prober {
	shared.mu.Lock()
	defer shared.mu.Unlock()
	return shared.st.prober
}

// tracks reports whether the loaded edge probes upstream.
func tracks(upstream string) bool {
	p := liveProber()
	if p == nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	_, ok := p.up[upstream]
	return ok
}

func testHandler(t *testing.T, table *Table) *EdgeRoutes {
	t.Helper()
	resetShared(t, table, nil)
	return &EdgeRoutes{}
}

func nextOK(vars map[string]string) (caddyhttp.Handler, *atomic.Bool) {
	called := &atomic.Bool{}
	return caddyhttp.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
		called.Store(true)
		for k, want := range vars {
			got, _ := caddyhttp.GetVar(r.Context(), k).(string)
			if got != want {
				w.WriteHeader(http.StatusTeapot)
				return nil
			}
		}
		w.WriteHeader(http.StatusOK)
		return nil
	}), called
}

func requestWithVars(host string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "http://"+host+"/", nil)
	ctx := r.Context()
	ctx = context.WithValue(ctx, caddyhttp.VarsCtxKey, map[string]any{})
	return r.WithContext(ctx)
}

func TestLookup(t *testing.T) {
	table := &Table{Exact: map[string]Route{
		"myapp.noite.localhost": {Kind: KindTenant, Upstream: "127.0.0.1:20011"},
	}, Wildcards: []Wildcard{
		{Suffix: ".myapp.noite.localhost", Route: Route{Kind: KindFallback, Upstream: "127.0.0.1:8080"}},
		{Suffix: ".preview.myapp.noite.localhost", Route: Route{Kind: KindDeny}},
		{Suffix: ".noite.localhost", Route: Route{Kind: KindFallback, Upstream: "127.0.0.1:8080"}},
	}}
	cases := []struct {
		host string
		kind string
		ok   bool
	}{
		{"myapp.noite.localhost", KindTenant, true},
		// Port, case, and trailing dot normalize to the exact route.
		{"MyApp.Noite.Localhost.:8443", KindTenant, true},
		// Env host falls to the per-app wildcard, not the base wildcard.
		{"main.myapp.noite.localhost", KindFallback, true},
		// Deeper preview labels match the deny suffix before the app one.
		{"x.preview.myapp.noite.localhost", KindDeny, true},
		{"unknown.noite.localhost", KindFallback, true},
		{"other.example.com", "", false},
		// Suffixes match exactly one label: multi-label hosts fall through.
		{"a.b.noite.localhost", "", false},
		{"a.b.myapp.noite.localhost", "", false},
	}
	for _, tc := range cases {
		r, ok := table.Lookup(tc.host)
		if ok != tc.ok || (ok && r.Kind != tc.kind) {
			t.Errorf("Lookup(%q) = (%q, %v), want (%q, %v)", tc.host, r.Kind, ok, tc.kind, tc.ok)
		}
	}
}

func TestValidate(t *testing.T) {
	bad := []*Table{
		{Exact: map[string]Route{"": {Kind: KindTenant, Upstream: "127.0.0.1:1"}}},
		{Exact: map[string]Route{"a": {Kind: "nope"}}},
		{Exact: map[string]Route{"a": {Kind: KindTenant}}},
		{Exact: map[string]Route{"a": {Kind: KindDeny, Upstream: "127.0.0.1:1"}}},
		{Exact: map[string]Route{"a": {Kind: KindTenant, Upstream: "127.0.0.1:1", ClientRPM: 1}}},
		{Exact: map[string]Route{"B.test": {Kind: KindTenant, Upstream: "127.0.0.1:1"}}},
		{Exact: map[string]Route{"a": {Kind: KindTenant, Upstream: "10.0.0.1:1"}}},
		{Exact: map[string]Route{"a": {Kind: KindTenant, Upstream: "127.0.0.1:0"}}},
		{Exact: map[string]Route{"a": {Kind: KindTenant, Upstream: "127.0.0.1:99999"}}},
		{Exact: map[string]Route{"a": {Kind: KindTenant, Upstream: "127.0.0.1"}}},
		{Wildcards: []Wildcard{{Suffix: "nodot", Route: Route{Kind: KindDeny}}}},
		{Wildcards: []Wildcard{{Suffix: ".B.test", Route: Route{Kind: KindDeny}}}},
	}
	for i, tbl := range bad {
		if err := tbl.Validate(); err == nil {
			t.Errorf("table %d validates, want error", i)
		}
	}
	good := &Table{Exact: map[string]Route{
		"a": {Kind: KindTenant, Upstream: "127.0.0.1:1", ClientRPM: 60, ClientZone: "c", AppRPM: 6, AppZone: "a"},
	}, Wildcards: []Wildcard{{Suffix: ".b", Route: Route{Kind: KindDeny}}}}
	if err := good.Validate(); err != nil {
		t.Errorf("good table rejected: %v", err)
	}
}

func TestClientKey(t *testing.T) {
	v4a, v4b := ClientKey("10.1.2.3"), ClientKey("10.1.2.4")
	if v4a == "" || v4a != ClientKey("10.1.2.3") {
		t.Errorf("ipv4 not stable: %q", v4a)
	}
	if v4a == v4b {
		t.Errorf("distinct ipv4 collapse: %q", v4a)
	}
	// One /64: same key. Different /64: different keys.
	p1 := ClientKey("2001:db8:1:2::1")
	p2 := ClientKey("2001:db8:1:2:ffff::9")
	p3 := ClientKey("2001:db8:1:3::1")
	if p1 == "" || p1 != p2 {
		t.Errorf("same /64 must share: %q vs %q", p1, p2)
	}
	if p1 == p3 {
		t.Errorf("different /64 must differ: %q", p1)
	}
	if ClientKey("garbage") != "" {
		t.Errorf("unparsable address must skip limiting")
	}
}

func TestRateLimit(t *testing.T) {
	now := time.Now()
	clock := &atomic.Int64{}
	clock.Store(now.UnixNano())
	l := NewLimiter(func() time.Time { return time.Unix(0, clock.Load()) })
	// rpm 60 -> budget 10 per window.
	for range 10 {
		if ok, _ := l.Allow("z", 60, "k"); !ok {
			t.Fatalf("denied inside budget")
		}
	}
	ok, retry := l.Allow("z", 60, "k")
	if ok || retry < time.Second {
		t.Fatalf("over budget allowed or no Retry-After: ok=%v retry=%v", ok, retry)
	}
	// A different key has its own budget; the shared "all" key is global.
	if ok, _ := l.Allow("z", 60, "other"); !ok {
		t.Fatalf("fresh key denied")
	}
	// Window slides: past the oldest stamp, budget frees up.
	clock.Store(now.Add(RateWindow + time.Second).UnixNano())
	if ok, _ := l.Allow("z", 60, "k"); !ok {
		t.Fatalf("denied after window slide")
	}
}

func TestServeRateLimited(t *testing.T) {
	table := &Table{Exact: map[string]Route{
		"a.test": {Kind: KindTenant, Upstream: "127.0.0.1:1", ClientRPM: 6, ClientZone: "c_a"},
	}}
	e := testHandler(t, table)
	next, called := nextOK(map[string]string{VarRoute: KindTenant, VarUpstream: "127.0.0.1:1"})
	r := requestWithVars("a.test")
	r = r.WithContext(context.WithValue(r.Context(), caddyhttp.VarsCtxKey,
		map[string]any{caddyhttp.ClientIPVarKey: "10.9.9.9"}))
	// rpm 6 -> budget 1: first passes, second is 429.
	w := httptest.NewRecorder()
	if err := e.ServeHTTP(w, r, next); err != nil {
		t.Fatal(err)
	}
	if !called.Load() {
		t.Fatalf("first request not proxied")
	}
	w = httptest.NewRecorder()
	if err := e.ServeHTTP(w, r, next); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") == "" {
		t.Fatalf("want 429 with Retry-After, got %d", w.Code)
	}
}

func TestAtomicSwapUnderRace(t *testing.T) {
	e := testHandler(t, &Table{Generation: 1, Exact: map[string]Route{
		"a.test": {Kind: KindTenant, Upstream: "127.0.0.1:1"},
	}})
	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		// Generations rise so every install applies; the content
		// alternates between two internally consistent tables.
		for gen := uint64(2); gen < 202; gen++ {
			select {
			case <-stop:
				return
			default:
			}
			next := &Table{Generation: gen, Exact: map[string]Route{
				"a.test": {Kind: KindTenant, Upstream: "127.0.0.1:1"},
			}}
			if gen%2 == 0 {
				next = &Table{Generation: gen, Exact: map[string]Route{
					"a.test": {Kind: KindCustom, Upstream: "127.0.0.1:2"},
				}}
			}
			if _, err := shared.install(next); err != nil {
				t.Errorf("install generation %d: %v", gen, err)
				return
			}
		}
	}()
	// Every request must see one coherent table: route and upstream agree,
	// and the vars the static config branches on are always set together.
	for range 200 {
		seen := caddyhttp.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
			route, _ := caddyhttp.GetVar(r.Context(), VarRoute).(string)
			up, _ := caddyhttp.GetVar(r.Context(), VarUpstream).(string)
			if (route == KindTenant && up != "127.0.0.1:1") || (route == KindCustom && up != "127.0.0.1:2") {
				t.Errorf("mixed table: route=%q upstream=%q", route, up)
				return nil
			}
			if route == "" || up == "" {
				t.Errorf("vars missing: route=%q upstream=%q", route, up)
			}
			return nil
		})
		w := httptest.NewRecorder()
		if err := e.ServeHTTP(w, requestWithVars("a.test"), seen); err != nil {
			t.Fatal(err)
		}
	}
	close(stop)
	wg.Wait()
}

func TestHoldAndRelease(t *testing.T) {
	healthy := &atomic.Bool{} // starts down
	resetShared(t, &Table{Exact: map[string]Route{
		"a.test": {Kind: KindTenant, Upstream: "127.0.0.1:9"},
	}}, NewProber(5*time.Millisecond, 10*time.Millisecond, func(string) bool { return healthy.Load() }))
	shared.holdCap = 10 * time.Second
	hold := EdgeHold{}
	next, called := nextOK(map[string]string{VarRoute: KindTenant})
	// EdgeRoutes sets the vars; the hold reads them.
	routes := &EdgeRoutes{}
	r := requestWithVars("a.test")
	w := httptest.NewRecorder()
	noop, _ := nextOK(nil)
	if err := routes.ServeHTTP(w, r, noop); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		w := httptest.NewRecorder()
		_ = hold.ServeHTTP(w, r, next)
	}()
	// While down, the request must not reach the upstream.
	select {
	case <-done:
		t.Fatalf("request proxied while upstream down")
	case <-time.After(50 * time.Millisecond):
	}
	healthy.Store(true)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatalf("held request never released after healthy")
	}
	if !called.Load() {
		t.Fatalf("released request did not reach next")
	}
}

func TestHoldSkipsAsleep(t *testing.T) {
	// F2: a down prober plus Asleep must reach next immediately — the wake
	// hop, not the hold, waits for the fleet.
	down := NewProber(time.Hour, time.Second, func(string) bool { return false })
	resetShared(t, &Table{Exact: map[string]Route{
		"a.test": {Kind: KindTenant, Upstream: "127.0.0.1:9", Asleep: true},
	}}, down)
	routes := &EdgeRoutes{}
	hold := EdgeHold{}
	next, called := nextOK(map[string]string{VarRoute: KindTenant})
	r := requestWithVars("a.test")
	w := httptest.NewRecorder()
	if err := routes.ServeHTTP(w, r, next); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- hold.ServeHTTP(httptest.NewRecorder(), r, next) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("asleep hold returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("asleep route held despite down prober")
	}
	if !called.Load() {
		t.Fatalf("asleep request did not reach next")
	}
	// Asleep upstreams are never probed.
	if tracks("127.0.0.1:9") {
		t.Fatalf("asleep upstream must not be tracked")
	}
}

func TestHoldTimeoutReturns503WithoutProxying(t *testing.T) {
	resetShared(t, &Table{Exact: map[string]Route{
		"a.test": {Kind: KindTenant, Upstream: "127.0.0.1:9"},
	}}, NewProber(time.Hour, time.Second, func(string) bool { return false }))
	shared.holdCap = 40 * time.Millisecond
	routes := &EdgeRoutes{}
	hold := EdgeHold{}
	next, called := nextOK(map[string]string{VarRoute: KindTenant})
	r := requestWithVars("a.test")
	w := httptest.NewRecorder()
	noop, _ := nextOK(nil)
	if err := routes.ServeHTTP(w, r, noop); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	err := hold.ServeHTTP(w, r, next)
	if called.Load() {
		t.Fatalf("timed-out hold must not proxy")
	}
	herr, ok := err.(caddyhttp.HandlerError)
	if !ok || herr.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("want 503 HandlerError, got %#v", err)
	}
}

func TestTwoInstancesShareOneTable(t *testing.T) {
	// F1: every instance reads the same process-wide table; one push
	// swaps it for all of them.
	testHandler(t, &Table{Exact: map[string]Route{
		"a.test": {Kind: KindTenant, Upstream: "127.0.0.1:1"},
	}})
	first, second := &EdgeRoutes{}, &EdgeRoutes{}
	raw := `{"generation": 2, "exact": {"b.test": {"kind": "custom", "upstream": "127.0.0.1:2"}}}`
	r := httptest.NewRequest(http.MethodPost, "/edge/routes", strings.NewReader(raw))
	if err := handleAdmin(httptest.NewRecorder(), r); err != nil {
		t.Fatalf("push rejected: %v", err)
	}
	for i, e := range []*EdgeRoutes{first, second} {
		seen := caddyhttp.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
			up, _ := caddyhttp.GetVar(r.Context(), VarUpstream).(string)
			if up != "127.0.0.1:2" {
				t.Errorf("instance %d routes stale upstream %q", i, up)
			}
			return nil
		})
		w := httptest.NewRecorder()
		if err := e.ServeHTTP(w, requestWithVars("b.test"), seen); err != nil {
			t.Fatal(err)
		}
		if _, ok := liveTable().Lookup("a.test"); ok {
			t.Fatalf("stale host survived the swap")
		}
	}
}

func TestWaitOutcomes(t *testing.T) {
	// Down past the cap is TimedOut; an untracked upstream is Abandoned
	// (fail open), never reported as healthy.
	p := NewProber(time.Hour, time.Second, func(string) bool { return false })
	p.Track(map[string]bool{"127.0.0.1:9": true})
	defer p.Stop()
	start := time.Now()
	if got := p.Wait("127.0.0.1:9", 5*time.Millisecond, 40*time.Millisecond); got != WaitTimedOut {
		t.Fatalf("dead upstream: Wait = %s, want timed out", got)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("hold cap ignored")
	}
	if got := p.Wait("untracked:1", 5*time.Millisecond, time.Millisecond); got != WaitAbandoned {
		t.Fatalf("untracked upstream: Wait = %s, want abandoned", got)
	}
}

func TestWaitAbandonsDroppedUpstream(t *testing.T) {
	// A hold must end the moment the table stops tracking the upstream:
	// the route changed under the request, so waiting out the cap only
	// delays the new route's answer.
	down := make(chan struct{})
	p := NewProber(time.Hour, time.Second, func(string) bool {
		<-down
		return false
	})
	defer p.Stop()
	p.Track(map[string]bool{"127.0.0.1:9": true})
	done := make(chan WaitOutcome, 1)
	go func() { done <- p.Wait("127.0.0.1:9", 5*time.Millisecond, 10*time.Second) }()
	p.Track(map[string]bool{})
	select {
	case got := <-done:
		if got != WaitAbandoned {
			t.Fatalf("Wait = %s, want abandoned", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("Wait never noticed the upstream was dropped")
	}
	close(down)
	if got := p.Health("127.0.0.1:9"); got != HealthUntracked {
		t.Fatalf("dropped upstream health = %s, want untracked", got)
	}
}

func TestWildcardWireShape(t *testing.T) {
	// The runner serializes wildcards nested as {"suffix", "route"}; a flat
	// shape would decode with a zero Route and fail validation.
	testHandler(t, &Table{})
	raw := `{"generation": 3, "exact": {}, "wildcards": [{"suffix": ".example.com", "route": {"kind": "fallback", "upstream": "127.0.0.1:8080", "rewrite": "/v1/edge/fallback"}}]}}`
	r := httptest.NewRequest(http.MethodPost, "/edge/routes", strings.NewReader(raw))
	w := httptest.NewRecorder()
	if err := handleAdmin(w, r); err != nil {
		t.Fatalf("nested wildcard rejected: %v", err)
	}
	rt, ok := liveTable().Lookup("anything.example.com")
	if !ok || rt.Kind != KindFallback || rt.Rewrite != "/v1/edge/fallback" {
		t.Fatalf("wildcard not applied: %+v %v", rt, ok)
	}
	flat := `{"generation": 4, "exact": {}, "wildcards": [{"suffix": ".example.com", "kind": "fallback", "upstream": "127.0.0.1:8080"}]}}`
	r = httptest.NewRequest(http.MethodPost, "/edge/routes", strings.NewReader(flat))
	w = httptest.NewRecorder()
	if _, ok := handleAdmin(w, r).(caddy.APIError); !ok {
		t.Fatalf("flat wildcard must be rejected")
	}
}

func TestConcurrentPostsNewestWins(t *testing.T) {
	// Two overlapping POSTs, older and newer generation: whatever order
	// they run in, the newer generation wins and the older gets a 409.
	testHandler(t, &Table{Generation: 100, Exact: map[string]Route{
		"a.test": {Kind: KindTenant, Upstream: "127.0.0.1:1"},
	}})
	post := func(gen uint64) {
		raw := `{"generation": ` + itoa(gen) + `, "exact": {"h.test": {"kind": "custom", "upstream": "127.0.0.1:2"}}}`
		r := httptest.NewRequest(http.MethodPost, "/edge/routes", strings.NewReader(raw))
		_ = handleAdmin(httptest.NewRecorder(), r)
	}
	// Rounds of two overlapping POSTs from a start barrier. Whatever order
	// a round runs in, the newer generation wins; without the lock the
	// older routinely swaps last.
	for round := uint64(0); round < 30; round++ {
		base := uint64(200 + round*2)
		start := make(chan struct{})
		var wg sync.WaitGroup
		for _, gen := range []uint64{base + 1, base + 2} {
			wg.Add(1)
			go func(g uint64) {
				defer wg.Done()
				<-start
				post(g)
			}(gen)
		}
		close(start)
		wg.Wait()
		final := liveTable()
		if final == nil || final.Generation != base+2 {
			got := uint64(0)
			if final != nil {
				got = final.Generation
			}
			t.Fatalf("round %d: want newest generation %d, got %d", round, base+2, got)
		}
	}
}

func TestRejectsOlderGeneration(t *testing.T) {
	// F6: generations are monotonic; an older table landing last must not
	// un-publish newer routes.
	testHandler(t, &Table{Generation: 9, Exact: map[string]Route{
		"a.test": {Kind: KindTenant, Upstream: "127.0.0.1:1"},
	}})
	old := `{"generation": 8, "exact": {"b.test": {"kind": "custom", "upstream": "127.0.0.1:2"}}}`
	r := httptest.NewRequest(http.MethodPost, "/edge/routes", strings.NewReader(old))
	w := httptest.NewRecorder()
	err := handleAdmin(w, r)
	apiErr, ok := err.(caddy.APIError)
	if !ok || apiErr.HTTPStatus != http.StatusConflict {
		t.Fatalf("want 409 APIError, got %#v", err)
	}
	if _, ok := liveTable().Lookup("b.test"); ok {
		t.Fatalf("older generation clobbered the table")
	}
	same := `{"generation": 9, "exact": {"c.test": {"kind": "custom", "upstream": "127.0.0.1:3"}}}`
	r = httptest.NewRequest(http.MethodPost, "/edge/routes", strings.NewReader(same))
	if err := handleAdmin(httptest.NewRecorder(), r); err != nil {
		t.Fatalf("same generation must be accepted (idempotent re-push): %v", err)
	}
}

func TestConcurrentPushesKeepNewest(t *testing.T) {
	// Overlapping pushes must serialize around the generation check and
	// the swap: the final table is always the newest generation, never a
	// stale one landing last. Rounds of 16 concurrent pushes from a start
	// barrier force the interleave; without the lock a lower generation
	// routinely swaps last.
	testHandler(t, &Table{Generation: 100, Exact: map[string]Route{
		"a.test": {Kind: KindTenant, Upstream: "127.0.0.1:1"},
	}})
	for round := 0; round < 10; round++ {
		base := uint64(200 + round*16)
		start := make(chan struct{})
		var wg sync.WaitGroup
		for g := base + 16; g > base; g-- {
			wg.Add(1)
			go func(gen uint64) {
				defer wg.Done()
				<-start
				raw := `{"generation": ` + itoa(gen) + `, "exact": {"h` + itoa(gen) + `.test": {"kind": "custom", "upstream": "127.0.0.1:2"}}}`
				r := httptest.NewRequest(http.MethodPost, "/edge/routes", strings.NewReader(raw))
				_ = handleAdmin(httptest.NewRecorder(), r)
			}(g)
		}
		close(start)
		wg.Wait()
		final := liveTable()
		if final == nil || final.Generation != base+16 {
			got := uint64(0)
			if final != nil {
				got = final.Generation
			}
			t.Fatalf("round %d: want newest generation %d, got %d", round, base+16, got)
		}
	}
}

func itoa(n uint64) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func TestAdminValidation(t *testing.T) {
	testHandler(t, &Table{Generation: 7, Exact: map[string]Route{
		"a.test": {Kind: KindTenant, Upstream: "127.0.0.1:1"},
	}})
	bad := `{"generation": 8, "exact": {"b.test": {"kind": "nope"}}}`
	r := httptest.NewRequest(http.MethodPost, "/edge/routes", strings.NewReader(bad))
	w := httptest.NewRecorder()
	// handleAdmin returns caddy.APIError; the admin framework turns it
	// into the status code, so assert on the value here.
	err := handleAdmin(w, r)
	apiErr, ok := err.(caddy.APIError)
	if !ok || apiErr.HTTPStatus != http.StatusBadRequest {
		t.Fatalf("want 400 APIError, got %#v", err)
	}
	// Old table intact.
	if r2, ok := liveTable().Lookup("a.test"); !ok || r2.Kind != KindTenant {
		t.Fatalf("bad push clobbered the table")
	}
	good := `{"generation": 8, "exact": {"b.test": {"kind": "custom", "upstream": "127.0.0.1:2"}}}`
	r = httptest.NewRequest(http.MethodPost, "/edge/routes", strings.NewReader(good))
	w = httptest.NewRecorder()
	if err := handleAdmin(w, r); err != nil {
		t.Fatalf("good push rejected: %v", err)
	}
	if r2, ok := liveTable().Lookup("b.test"); !ok || r2.Upstream != "127.0.0.1:2" {
		t.Fatalf("good push not applied")
	}
	if _, ok := liveTable().Lookup("a.test"); ok {
		t.Fatalf("stale host survived the swap")
	}
	r = httptest.NewRequest(http.MethodDelete, "/edge/routes", nil)
	w = httptest.NewRecorder()
	err = handleAdmin(w, r)
	apiErr, ok = err.(caddy.APIError)
	if !ok || apiErr.HTTPStatus != http.StatusMethodNotAllowed {
		t.Fatalf("want 405 APIError, got %#v", err)
	}
}

func TestAsleepAndGatedVars(t *testing.T) {
	table := &Table{Exact: map[string]Route{
		"sleepy.test": {Kind: KindTenant, Upstream: "127.0.0.1:1", Asleep: true},
		"gated.test":  {Kind: KindEnv, Upstream: "127.0.0.1:2", Gated: true},
	}}
	e := testHandler(t, table)
	for _, tc := range []struct{ host, v, want string }{
		{"sleepy.test", VarWake, "1"},
		{"gated.test", VarGate, "1"},
	} {
		seen := caddyhttp.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
			got, _ := caddyhttp.GetVar(r.Context(), tc.v).(string)
			if got != tc.want {
				t.Errorf("%s: var %s = %q, want %q", tc.host, tc.v, got, tc.want)
			}
			return nil
		})
		w := httptest.NewRecorder()
		if err := e.ServeHTTP(w, requestWithVars(tc.host), seen); err != nil {
			t.Fatal(err)
		}
	}
	next, _ := nextOK(nil)
	w := httptest.NewRecorder()
	if err := e.ServeHTTP(w, requestWithVars("missing.test"), next); err != nil {
		t.Fatal(err)
	}
	// Loaded table, unknown host: 404 (the 503 is only for the boot gap).
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown host: want 404, got %d", w.Code)
	}
	// No table at all: 503 edge starting.
	resetShared(t, nil, nil)
	w = httptest.NewRecorder()
	if err := e.ServeHTTP(w, requestWithVars("missing.test"), next); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("unloaded edge: want 503, got %d", w.Code)
	}
}

func TestLastCleanupDrainsSharedState(t *testing.T) {
	table := &Table{Generation: 1, Exact: map[string]Route{
		"a.test": {Kind: KindTenant, Upstream: "127.0.0.1:1"},
	}}
	e := testHandler(t, table)
	next, called := nextOK(nil)
	if err := e.ServeHTTP(httptest.NewRecorder(), requestWithVars("a.test"), next); err != nil {
		t.Fatal(err)
	}
	if !called.Load() {
		t.Fatalf("loaded edge did not proxy")
	}

	if err := e.Cleanup(); err != nil {
		t.Fatal(err)
	}
	shared.mu.Lock()
	st := shared.st
	shared.mu.Unlock()
	if st.phase != PhaseDraining || st.tab != nil || st.lim != nil || st.prober != nil {
		t.Fatalf("after the last Cleanup: phase %s tab %v lim %v prober %v, want draining with nothing",
			st.phase, st.tab, st.lim, st.prober)
	}

	// A request racing the cleanup must not be served from the dropped
	// table, and must not claim a boot gap that is not happening.
	called.Store(false)
	w := httptest.NewRecorder()
	if err := e.ServeHTTP(w, requestWithVars("a.test"), next); err != nil {
		t.Fatal(err)
	}
	if called.Load() {
		t.Fatalf("request served from the drained table")
	}
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "shutting down") {
		t.Fatalf("draining edge answered %d %q, want 503 shutting down", w.Code, w.Body.String())
	}

	// Re-provisioning without a table file starts a fresh boot: the old
	// table must not come back now that a limiter exists again.
	shared.retain(zap.NewNop())
	called.Store(false)
	w = httptest.NewRecorder()
	if err := e.ServeHTTP(w, requestWithVars("a.test"), next); err != nil {
		t.Fatal(err)
	}
	if called.Load() {
		t.Fatalf("stale table served after re-provisioning")
	}
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "edge starting") {
		t.Fatalf("booting edge answered %d %q, want 503 edge starting", w.Code, w.Body.String())
	}
	shared.release()
}

func TestProvisionOrdersByGeneration(t *testing.T) {
	// A config reload re-reads the table file. The file is only as fresh as
	// the runner's last write, which can be older than a table it has
	// pushed since; the load must keep the newer routes.
	dir := t.TempDir()
	path := filepath.Join(dir, "routes.json")
	writeTableFile(t, path, `{"generation": 5, "exact": {"file.test": {"kind": "tenant", "upstream": "127.0.0.1:5"}}}`)

	testHandler(t, nil)
	push := `{"generation": 9, "exact": {"pushed.test": {"kind": "tenant", "upstream": "127.0.0.1:9"}}}`
	r := httptest.NewRequest(http.MethodPost, "/edge/routes", strings.NewReader(push))
	if err := handleAdmin(httptest.NewRecorder(), r); err != nil {
		t.Fatalf("push rejected: %v", err)
	}

	routes := &EdgeRoutes{TablePath: path}
	if err := routes.Provision(caddy.Context{}); err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if _, ok := liveTable().Lookup("pushed.test"); !ok {
		t.Fatalf("the older table file clobbered the pushed table")
	}
	if _, ok := liveTable().Lookup("file.test"); ok {
		t.Fatalf("older file routes went live")
	}
	if gen := liveTable().Generation; gen != 9 {
		t.Fatalf("generation = %d, want 9", gen)
	}

	// A genuinely newer file still loads.
	writeTableFile(t, path, `{"generation": 10, "exact": {"file.test": {"kind": "tenant", "upstream": "127.0.0.1:5"}}}`)
	if err := routes.Provision(caddy.Context{}); err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if _, ok := liveTable().Lookup("file.test"); !ok {
		t.Fatalf("newer table file not applied")
	}
}

func TestEqualGenerationContentApplies(t *testing.T) {
	// The runner only re-pushes identical bytes under a generation, so an
	// equal generation with different routes is a correction that must
	// land instead of being dropped as a no-op.
	testHandler(t, &Table{Generation: 4, Exact: map[string]Route{
		"old.test": {Kind: KindTenant, Upstream: "127.0.0.1:1"},
	}})
	corrected := `{"generation": 4, "exact": {"new.test": {"kind": "tenant", "upstream": "127.0.0.1:2"}}}`
	r := httptest.NewRequest(http.MethodPost, "/edge/routes", strings.NewReader(corrected))
	if err := handleAdmin(httptest.NewRecorder(), r); err != nil {
		t.Fatalf("equal-generation correction rejected: %v", err)
	}
	if _, ok := liveTable().Lookup("new.test"); !ok {
		t.Fatalf("equal-generation correction was dropped")
	}
}

func writeTableFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

func TestValidateRefusesImpossibleModes(t *testing.T) {
	up := "127.0.0.1:1"
	bad := []Route{
		// Wake and gate are fleet/environment hops; on anything else the
		// static config would ignore them.
		{Kind: KindControl, Upstream: up, Asleep: true},
		{Kind: KindPreview, Upstream: up, Asleep: true},
		{Kind: KindTenant, Upstream: up, Gated: true},
		{Kind: KindFallback, Upstream: up, Gated: true},
		// Only git and the runner's fallback page have a rewrite.
		{Kind: KindTenant, Upstream: up, Rewrite: "/v1/edge/fallback"},
		{Kind: KindControl, Upstream: up, Rewrite: "/x"},
		// Deny answers before every hop and limit.
		{Kind: KindDeny, Asleep: true},
		{Kind: KindDeny, ClientRPM: 1, ClientZone: "c"},
	}
	for i, r := range bad {
		if err := r.validate(); err == nil {
			t.Errorf("route %d (%+v) validates, want an error", i, r)
		}
	}
	good := []Route{
		{Kind: KindTenant, Upstream: up, Asleep: true},
		{Kind: KindEnv, Upstream: up, Asleep: true},
		{Kind: KindEnv, Upstream: up, Gated: true},
		// The runner parks an awake or gated environment that has no fleet
		// port yet: both hops are real on env-parked.
		{Kind: KindEnvPark, Upstream: up, Rewrite: "/v1/edge/fallback", Asleep: true},
		{Kind: KindEnvPark, Upstream: up, Rewrite: "/v1/edge/fallback", Gated: true},
		{Kind: KindGit, Upstream: up, Rewrite: "/v1/git{uri}"},
	}
	for i, r := range good {
		if err := r.validate(); err != nil {
			t.Errorf("route %d (%+v) rejected: %v", i, r, err)
		}
	}
}

func TestModeTransitionTable(t *testing.T) {
	up := "127.0.0.1:1"
	cases := []struct {
		route                  Route
		deny, hold, wake, gate bool
	}{
		{Route{Kind: KindDeny}, true, false, false, false},
		{Route{Kind: KindControl, Upstream: up}, false, false, false, false},
		{Route{Kind: KindGit, Upstream: up}, false, false, false, false},
		{Route{Kind: KindTenant, Upstream: up}, false, true, false, false},
		{Route{Kind: KindCustom, Upstream: up}, false, true, false, false},
		{Route{Kind: KindTenant, Upstream: up, Asleep: true}, false, false, true, false},
		{Route{Kind: KindEnv, Upstream: up}, false, true, false, false},
		{Route{Kind: KindEnv, Upstream: up, Asleep: true}, false, false, true, false},
		{Route{Kind: KindEnv, Upstream: up, Gated: true}, false, true, false, true},
		{Route{Kind: KindEnvPark, Upstream: up}, false, false, false, false},
		{Route{Kind: KindPreview, Upstream: up}, false, false, false, false},
		{Route{Kind: KindFallback, Upstream: up}, false, false, false, false},
	}
	for _, tc := range cases {
		m := tc.route.mode()
		if m.Deny() != tc.deny || m.Hold() != tc.hold || m.Wake() != tc.wake || m.Gate() != tc.gate {
			t.Errorf("%s asleep=%v gated=%v: deny=%v hold=%v wake=%v gate=%v, want %v %v %v %v",
				tc.route.Kind, tc.route.Asleep, tc.route.Gated,
				m.Deny(), m.Hold(), m.Wake(), m.Gate(),
				tc.deny, tc.hold, tc.wake, tc.gate)
		}
		if m.Kind() != tc.route.Kind {
			t.Errorf("mode kind = %q, want %q", m.Kind(), tc.route.Kind)
		}
	}
}

func TestHoldDecisionPublishedOnce(t *testing.T) {
	// EdgeHold branches on VarHold, which EdgeRoutes sets from the derived
	// mode: a parked or asleep host must pass even with a down prober.
	down := NewProber(time.Hour, time.Second, func(string) bool { return false })
	resetShared(t, &Table{Exact: map[string]Route{
		"awake.test":  {Kind: KindTenant, Upstream: "127.0.0.1:9"},
		"sleepy.test": {Kind: KindTenant, Upstream: "127.0.0.1:9", Asleep: true},
		"parked.test": {Kind: KindEnvPark, Upstream: "127.0.0.1:8", Rewrite: "/v1/edge/fallback"},
	}}, down)
	routes := &EdgeRoutes{}
	for _, tc := range []struct{ host, hold string }{
		{"awake.test", "1"},
		{"sleepy.test", ""},
		{"parked.test", ""},
	} {
		seen := caddyhttp.HandlerFunc(func(w http.ResponseWriter, r *http.Request) error {
			got, _ := caddyhttp.GetVar(r.Context(), VarHold).(string)
			if got != tc.hold {
				t.Errorf("%s: VarHold = %q, want %q", tc.host, got, tc.hold)
			}
			return nil
		})
		if err := routes.ServeHTTP(httptest.NewRecorder(), requestWithVars(tc.host), seen); err != nil {
			t.Fatal(err)
		}
	}
}
