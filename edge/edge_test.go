package edge

import (
	"context"
	"net/http"

	"net/http/httptest"
	"strings"

	"github.com/caddyserver/caddy/v2"
	"go.uber.org/zap"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
)

// resetShared installs a fresh process-wide state for one test (the
// package's tests run sequentially, and every test starts here, so no two
// share a prober or a table).
func resetShared(t *testing.T, table *Table, prober *Prober) {
	t.Helper()
	shared.mu.Lock()
	if shared.prober != nil {
		shared.prober.Stop()
	}
	shared.refs = 0
	shared.tab = atomic.Pointer[Table]{}
	shared.lim = NewLimiter(time.Now)
	if prober == nil {
		prober = NewProber(time.Second, 2*time.Second, func(string) bool { return true })
	}
	shared.prober = prober
	shared.holdRecheck = 5 * time.Millisecond
	shared.holdCap = 50 * time.Millisecond
	shared.log = zap.NewNop()
	shared.loaded = false
	shared.mu.Unlock()
	if table != nil {
		shared.swap(table)
	}
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
	oldT := &Table{Generation: 1, Exact: map[string]Route{
		"a.test": {Kind: KindTenant, Upstream: "127.0.0.1:1"},
	}}
	newT := &Table{Generation: 2, Exact: map[string]Route{
		"a.test": {Kind: KindCustom, Upstream: "127.0.0.1:2"},
	}}
	e := testHandler(t, oldT)
	var wg sync.WaitGroup
	stop := make(chan struct{})
	wg.Add(1)
	go func() {
		defer wg.Done()
		for range 200 {
			select {
			case <-stop:
				return
			default:
			}
			shared.swap(newT)
			shared.swap(oldT)
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
	shared.mu.Lock()
	_, tracked := shared.prober.up["127.0.0.1:9"]
	shared.mu.Unlock()
	if tracked {
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
		if _, ok := shared.tab.Load().Lookup("a.test"); ok {
			t.Fatalf("stale host survived the swap")
		}
	}
}

func TestWaitHealthyCap(t *testing.T) {
	p := NewProber(time.Hour, time.Second, func(string) bool { return false })
	p.Track(map[string]bool{"127.0.0.1:9": true})
	defer p.Stop()
	start := time.Now()
	if p.WaitHealthy("127.0.0.1:9", 5*time.Millisecond, 40*time.Millisecond) {
		t.Fatalf("WaitHealthy returned true for a dead upstream")
	}
	if time.Since(start) > 5*time.Second {
		t.Fatalf("hold cap ignored")
	}
	if p.WaitHealthy("untracked:1", 5*time.Millisecond, time.Millisecond) != true {
		t.Fatalf("untracked upstream must fail open")
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
	rt, ok := shared.tab.Load().Lookup("anything.example.com")
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
	if _, ok := shared.tab.Load().Lookup("b.test"); ok {
		t.Fatalf("older generation clobbered the table")
	}
	same := `{"generation": 9, "exact": {"c.test": {"kind": "custom", "upstream": "127.0.0.1:3"}}}`
	r = httptest.NewRequest(http.MethodPost, "/edge/routes", strings.NewReader(same))
	if err := handleAdmin(httptest.NewRecorder(), r); err != nil {
		t.Fatalf("same generation must be accepted (idempotent re-push): %v", err)
	}
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
	if r2, ok := shared.tab.Load().Lookup("a.test"); !ok || r2.Kind != KindTenant {
		t.Fatalf("bad push clobbered the table")
	}
	good := `{"generation": 8, "exact": {"b.test": {"kind": "custom", "upstream": "127.0.0.1:2"}}}`
	r = httptest.NewRequest(http.MethodPost, "/edge/routes", strings.NewReader(good))
	w = httptest.NewRecorder()
	if err := handleAdmin(w, r); err != nil {
		t.Fatalf("good push rejected: %v", err)
	}
	if r2, ok := shared.tab.Load().Lookup("b.test"); !ok || r2.Upstream != "127.0.0.1:2" {
		t.Fatalf("good push not applied")
	}
	if _, ok := shared.tab.Load().Lookup("a.test"); ok {
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
