// The noite edge module: a host route table for Caddy.
//
// Caddy's config is static after boot. The runner pushes this table on
// every app lifecycle event (and every reconcile tick as a backstop), so
// app events never reload Caddy. All state (table, limiters, readiness
// probers) is process-wide and shared by every handler instance: the
// static config has one EdgeRoutes per site, and a push swaps the table
// once for all of them.
package edge

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/caddyserver/caddy/v2"
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/caddy/v2/caddyconfig/httpcaddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
	"go.uber.org/zap"
)

// init registers the module and its Caddyfile directives.
func init() {
	caddy.RegisterModule(new(EdgeRoutes))
	caddy.RegisterModule(new(EdgeHold))
	caddy.RegisterModule(new(EdgeAdmin))
	httpcaddyfile.RegisterHandlerDirective("edge_routes", parseCaddyfile)
	httpcaddyfile.RegisterHandlerDirective("edge_hold", parseHoldCaddyfile)
}

// Vars the module publishes for the static config.
const (
	// VarRoute is the route kind (tenant, custom, env, ...).
	VarRoute = "edge_route"
	// VarUpstream is the "127.0.0.1:port" upstream for reverse_proxy.
	VarUpstream = "edge_upstream"
	// VarWake is "1" when the static config must forward_auth /v1/edge/wake.
	VarWake = "edge_wake"
	// VarGate is "1" when the static config must forward_auth /v1/edge/env-gate.
	VarGate = "edge_gate"
	// VarHold is "1" when EdgeRoutes decided the request must wait for its
	// fleet upstream's readiness probe. EdgeHold reads it; the static
	// config never does, so the hold decision is made once.
	VarHold = "edge_hold"
)

// Hold timing mirrors the old TENANT_PROXY: 20 s cap, 250 ms backstop.
const (
	HoldCap      = 20 * time.Second
	HoldRecheck  = 250 * time.Millisecond
	ProbeEvery   = 1 * time.Second
	ProbeTimeout = 2 * time.Second
)

// Phase is the shared edge's lifecycle, shared by every EdgeRoutes and
// EdgeHold instance.
//
//	stateDiagram-v2
//	    [*] --> Booting: first instance Provisioned
//	    Booting --> Loaded: a table is installed (file or push)
//	    Loaded --> Loaded: a newer table is installed / re-pushed
//	    Booting --> Draining: last instance Cleanup, no table yet
//	    Loaded --> Draining: last instance Cleanup
//	    Draining --> Booting: an instance is Provisioned again
//	    Draining --> Loaded: a push arrives before the process exits
//	    Draining --> [*]: the process stops
//
// The phase owns the resources it needs, so they can never disagree with
// it: Loaded has a table, a limiter and a prober; Booting and Draining have
// none. Requests answer from the phase: Booting is 503 "edge starting"
// (running, nothing pushed yet), Loaded routes and rate-limits, Draining is
// the same 503 with no table left to route with. A push that revives a
// draining edge creates its limiter and prober again; the process is
// exiting, so nothing serves them.
type Phase uint8

const (
	// PhaseBooting is provisioned but has no table yet.
	PhaseBooting Phase = iota
	// PhaseLoaded has a table, a limiter and a prober.
	PhaseLoaded
	// PhaseDraining has no instances left: the prober is stopped and the
	// table and limiter are dropped.
	PhaseDraining
)

// String names the phase for logs and test failures.
func (p Phase) String() string {
	switch p {
	case PhaseBooting:
		return "booting"
	case PhaseLoaded:
		return "loaded"
	case PhaseDraining:
		return "draining"
	}
	return "unknown"
}

// edgeState is what the current phase owns. The zero value is Booting with
// nothing, so the invariants hold by construction.
type edgeState struct {
	phase  Phase
	tab    *Table
	lim    *Limiter
	prober *Prober
}

// edgeSnapshot is the immutable view a request serves from. It is built by
// publishLocked while mu is held and never mutated afterwards.
type edgeSnapshot struct {
	phase Phase
	tab   *Table
	lim   *Limiter
}

// bootSnapshot answers requests before anything is published.
var bootSnapshot = &edgeSnapshot{phase: PhaseBooting}

// sharedState is the process-wide edge state, shared by every EdgeRoutes
// and EdgeHold instance (the static config provisions one per site).
type sharedState struct {
	mu sync.Mutex
	// refs counts provisioned instances; the last Cleanup drains the
	// shared state so a full Caddy stop leaks no goroutines.
	refs int
	st   edgeState
	// cur is the view requests serve from: the phase and the table, limiter
	// it owns, published together. Requests only Load it, so the hot path
	// takes no lock and still cannot observe a phase disagreeing with its
	// resources.
	cur         atomic.Pointer[edgeSnapshot]
	log         *zap.Logger
	holdRecheck time.Duration
	holdCap     time.Duration
	// newProber builds the prober a Loaded edge owns. Tests replace it with
	// one whose check they control.
	newProber func() *Prober
}

var shared = newSharedState()

// newSharedState returns a booting shared state with the production probe timings.
func newSharedState() *sharedState {
	s := &sharedState{
		holdRecheck: HoldRecheck,
		holdCap:     HoldCap,
		newProber:   func() *Prober { return NewProber(ProbeEvery, ProbeTimeout, nil) },
	}
	s.cur.Store(&edgeSnapshot{phase: PhaseBooting})
	return s
}

// publishLocked makes the current edgeState the view requests see. Callers
// hold mu and call it after mutating s.st.
func (s *sharedState) publishLocked() {
	s.cur.Store(&edgeSnapshot{phase: s.st.phase, tab: s.st.tab, lim: s.st.lim})
}

// snapshot is the published view. A nil pointer means nothing was published
// yet, which is the boot phase.
func (s *sharedState) snapshot() *edgeSnapshot {
	if snap := s.cur.Load(); snap != nil {
		return snap
	}
	return bootSnapshot
}

// transitionLocked is the only writer of the phase. It also creates or drops
// the resources that phase has, in the same step, so a stale table can never
// survive behind a nil limiter. Callers hold mu and publish afterwards, once
// the whole operation is done.
func (s *sharedState) transitionLocked(next Phase) {
	prev := s.st.phase
	if prev == next {
		return
	}
	switch next {
	case PhaseBooting:
		s.st = edgeState{phase: PhaseBooting}
	case PhaseLoaded:
		if s.st.lim == nil {
			s.st.lim = NewLimiter(nil)
		}
		if s.st.prober == nil {
			s.st.prober = s.newProber()
		}
		s.st.phase = PhaseLoaded
	case PhaseDraining:
		if s.st.prober != nil {
			s.st.prober.Stop()
		}
		s.st = edgeState{phase: PhaseDraining}
	}
	if s.log != nil {
		s.log.Info("edge: phase transition",
			zap.String("from", prev.String()),
			zap.String("to", next.String()))
	}
}

// retain is the Provision transition: join the shared state, reviving it
// from Draining when this is the first instance after a full cleanup.
func (s *sharedState) retain(log *zap.Logger) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if log != nil {
		s.log = log
	}
	s.refs++
	if s.st.phase == PhaseDraining {
		s.transitionLocked(PhaseBooting)
		s.publishLocked()
	}
}

// release is the Cleanup transition: the last instance leaving drains the
// shared state, so no request can be served from a table whose limiter and
// prober are gone.
func (s *sharedState) release() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.refs > 0 {
		s.refs--
	}
	if s.refs == 0 && s.st.phase != PhaseDraining {
		s.transitionLocked(PhaseDraining)
		s.publishLocked()
	}
}

// table returns the installed table, or nil before the first install.
func (s *sharedState) table() *Table {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.st.tab
}

// logger returns the current logger, or nil before the first Provision.
func (s *sharedState) logger() *zap.Logger {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.log
}

// Install is what installing a table did.
//
//	stateDiagram-v2
//	    [*] --> Applied: no table installed yet
//	    [*] --> Stale: generation older than the live table
//	    [*] --> Identical: same generation and byte-equal content
//	    [*] --> Applied: same generation, different content
//	    [*] --> Invalid: Validate refused it
//
// Both writers — the table file read in Provision and an admin push — go
// through install, so a config reload can no longer re-install a file older
// than a table the runner has pushed since.
type Install uint8

const (
	// InstallApplied means the table now serves.
	InstallApplied Install = iota
	// InstallStale means an older generation arrived too late.
	InstallStale
	// InstallIdentical means the re-push changed nothing.
	InstallIdentical
	// InstallInvalid means Validate refused the table.
	InstallInvalid
)

// String names the outcome for logs and test failures.
func (i Install) String() string {
	switch i {
	case InstallApplied:
		return "applied"
	case InstallStale:
		return "stale"
	case InstallIdentical:
		return "identical"
	case InstallInvalid:
		return "invalid"
	}
	return "unknown"
}

// install validates and installs t, converging the phase, prober and limiter
// in one locked step: overlapping pushes, or a push racing the Provision
// load, cannot interleave them. A refused table leaves the live one serving
// and returns the reason.
func (s *sharedState) install(t *Table) (Install, error) {
	if t.Exact == nil {
		t.Exact = make(map[string]Route)
	}
	if err := t.Validate(); err != nil {
		return InstallInvalid, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if cur := s.st.tab; cur != nil {
		if t.Generation < cur.Generation {
			return InstallStale, fmt.Errorf("edge: generation %d older than current %d", t.Generation, cur.Generation)
		}
		if t.Generation == cur.Generation && sameRoutes(cur, t) {
			return InstallIdentical, nil
		}
	}
	s.st.tab = t
	s.transitionLocked(PhaseLoaded)
	s.reconcileLocked(t)
	s.publishLocked()
	return InstallApplied, nil
}

// sameRoutes compares two tables' routes. Map iteration order and the JSON
// key order the runner's HashMap serializes with are irrelevant, so equal
// content compares equal however it was decoded.
func sameRoutes(a, b *Table) bool {
	if len(a.Exact) != len(b.Exact) || len(a.Wildcards) != len(b.Wildcards) {
		return false
	}
	for host, ra := range a.Exact {
		rb, ok := b.Exact[host]
		if !ok || ra != rb {
			return false
		}
	}
	for i, wa := range a.Wildcards {
		wb := b.Wildcards[i]
		if wa.Suffix != wb.Suffix || wa.Route != wb.Route {
			return false
		}
	}
	return true
}

// reconcileLocked tracks exactly the upstreams a hold can wait on and drops
// the limiter zones the table no longer references. Asleep routes are never
// probed: the wake hop waits for the fleet's health gate itself, so probing
// them would only burn checks on a deliberately parked fleet. Callers hold
// mu.
func (s *sharedState) reconcileLocked(t *Table) {
	keep := make(map[string]bool)
	fleet := make(map[string]bool)
	collect := func(r Route) {
		m := r.mode()
		if r.ClientZone != "" {
			keep[r.ClientZone] = true
		}
		if r.AppZone != "" {
			keep[r.AppZone] = true
		}
		if m.Hold() && r.Upstream != "" {
			fleet[r.Upstream] = true
		}
	}
	for _, r := range t.Exact {
		collect(r)
	}
	for _, w := range t.Wildcards {
		collect(w.Route)
	}
	s.st.prober.Track(fleet)
	s.st.lim.Sweep(keep, time.Hour)
}

// EdgeRoutes holds the pushed route table and serves it per request.
//
// Per request it does the minimum only Go can do: host lookup, http.vars,
// and per-app rate limiting. The readiness hold lives in EdgeHold, placed
// after the wake/gate hops, so an anonymous request to a gated env with a
// down fleet gets the gate's answer immediately instead of waiting out
// the hold.
type EdgeRoutes struct {
	// TablePath is the JSON file the runner writes atomically and the
	// module loads in Provision (restart persistence without a manual step).
	TablePath string `json:"table,omitempty"`
}

// CaddyModule returns the Caddy module information.
func (*EdgeRoutes) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.handlers.edge_routes",
		New: func() caddy.Module { return new(EdgeRoutes) },
	}
}

// Provision joins the shared state and loads the table file (written by
// the runner before Caddy starts; a missing file leaves the edge booting —
// 503 — until the first push). The file is installed through the same
// generation ordering as a push, so a config reload never re-installs a
// table older than the one already live.
func (e *EdgeRoutes) Provision(ctx caddy.Context) error {
	if e.TablePath == "" {
		return fmt.Errorf("edge_routes: table path is required")
	}
	log := ctx.Logger()
	shared.retain(log)
	t, err := loadTable(e.TablePath)
	if err != nil {
		log.Warn("edge_routes: no table yet", zap.Error(err))
		return nil
	}
	outcome, err := shared.install(t)
	switch outcome {
	case InstallApplied:
		log.Info("edge_routes: table loaded",
			zap.Uint64("generation", t.Generation),
			zap.Int("exact", len(t.Exact)),
			zap.Int("wildcards", len(t.Wildcards)))
	case InstallInvalid:
		log.Warn("edge_routes: ignoring invalid table file", zap.Error(err))
	case InstallStale, InstallIdentical:
		log.Debug("edge_routes: table file is not newer than the live table",
			zap.Uint64("generation", t.Generation),
			zap.String("outcome", outcome.String()))
	}
	return nil
}

// Cleanup releases the shared state.
func (e *EdgeRoutes) Cleanup() error {
	shared.release()
	return nil
}

// Validate ensures the module was configured.
func (e *EdgeRoutes) Validate() error {
	if e.TablePath == "" {
		return fmt.Errorf("edge_routes: table path is required")
	}
	return nil
}

// UnmarshalCaddyfile sets up the handler from Caddyfile tokens (see
// parseInto in caddyfile.go).
func (e *EdgeRoutes) UnmarshalCaddyfile(d *caddyfile.Dispenser) error {
	return parseInto(e, d)
}

// loadTable decodes the table file. install owns normalization and
// validation, so the file and a push are judged by the same code.
func loadTable(path string) (*Table, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var t Table
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, err
	}
	return &t, nil
}

// ServeHTTP implements caddyhttp.MiddlewareHandler.
func (e *EdgeRoutes) ServeHTTP(w http.ResponseWriter, r *http.Request, next caddyhttp.Handler) error {
	snap := shared.snapshot()
	if snap.phase != PhaseLoaded {
		// Booting (nothing pushed yet) and Draining (the last instance
		// cleaned up) both have no table to route with. The answer stays
		// the boot gap's 503; the phase tells the two apart in the log.
		http.Error(w, "edge starting", http.StatusServiceUnavailable)
		return nil
	}
	route, ok := snap.tab.Lookup(r.Host)
	if !ok {
		// No route with a loaded table: 404, as Caddy did for unmatched
		// hosts. The 503 above is only for the phases that have no table.
		http.Error(w, "not found", http.StatusNotFound)
		return nil
	}
	mode := route.mode()
	if mode.Deny() {
		http.Error(w, "not found", http.StatusNotFound)
		return nil
	}
	// Both zones are decided in one step: a refusal in the app zone must not
	// spend the client's budget, and Retry-After reports whichever zone is
	// still over budget the longest.
	var limits [2]RateLimit
	n := 0
	if route.ClientRPM > 0 {
		clientIP, _ := caddyhttp.GetVar(r.Context(), caddyhttp.ClientIPVarKey).(string)
		limits[n] = RateLimit{Zone: route.ClientZone, RPM: route.ClientRPM, Key: ClientKey(clientIP)}
		n++
	}
	if route.AppRPM > 0 {
		limits[n] = RateLimit{Zone: route.AppZone, RPM: route.AppRPM, Key: "all"}
		n++
	}
	if d := snap.lim.AllowAll(limits[:n]); !d.Allowed {
		w.Header().Set("Retry-After", fmt.Sprintf("%d", int(d.RetryAfter/time.Second)))
		http.Error(w, "rate limited", http.StatusTooManyRequests)
		return nil
	}
	caddyhttp.SetVar(r.Context(), VarRoute, mode.Kind())
	caddyhttp.SetVar(r.Context(), VarUpstream, route.Upstream)
	if mode.Wake() {
		caddyhttp.SetVar(r.Context(), VarWake, "1")
	}
	if mode.Gate() {
		caddyhttp.SetVar(r.Context(), VarGate, "1")
	}
	if mode.Hold() {
		caddyhttp.SetVar(r.Context(), VarHold, "1")
	}
	return next.ServeHTTP(w, r)
}

// EdgeHold is the fleet readiness hold. It runs after the wake/gate hops
// (so those answer first) and immediately before reverse_proxy. Asleep
// routes are never held: the wake hop already waited for the fleet.
type EdgeHold struct{}

// CaddyModule returns the Caddy module information.
func (*EdgeHold) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.handlers.edge_hold",
		New: func() caddy.Module { return new(EdgeHold) },
	}
}

// Provision joins the shared state.
func (EdgeHold) Provision(ctx caddy.Context) error {
	shared.retain(ctx.Logger())
	return nil
}

// Cleanup releases the shared state.
func (EdgeHold) Cleanup() error {
	shared.release()
	return nil
}

// UnmarshalCaddyfile accepts a bare `edge_hold` directive.
func (EdgeHold) UnmarshalCaddyfile(d *caddyfile.Dispenser) error {
	d.Next()
	if d.NextArg() {
		return d.ArgErr()
	}
	return nil
}

// ServeHTTP implements caddyhttp.MiddlewareHandler.
//
//	stateDiagram-v2
//	    [*] --> Skipped: VarHold != 1 (not a held route, or EdgeRoutes did not run)
//	    [*] --> Passing: health is Up or Untracked (fail open)
//	    Skipped --> [*]: proxy
//	    Passing --> [*]: proxy
//	    [*] --> Holding: health is Down
//	    Holding --> Ready: Wait reports Ready
//	    Holding --> Abandoned: Wait reports Abandoned (route changed)
//	    Holding --> TimedOut: Wait reports TimedOut
//	    Ready --> [*]: proxy
//	    Abandoned --> [*]: proxy
//	    TimedOut --> [*]: 503, handle_errors renders the starting page
func (EdgeHold) ServeHTTP(w http.ResponseWriter, r *http.Request, next caddyhttp.Handler) error {
	// The hold decision is made once, in EdgeRoutes, and published as
	// VarHold: EdgeHold never re-derives it from the kind or the wake var.
	if hold, _ := caddyhttp.GetVar(r.Context(), VarHold).(string); hold != "1" {
		return next.ServeHTTP(w, r)
	}
	upstream, _ := caddyhttp.GetVar(r.Context(), VarUpstream).(string)
	shared.mu.Lock()
	prober, recheck, cap := shared.st.prober, shared.holdRecheck, shared.holdCap
	shared.mu.Unlock()
	if prober == nil || prober.Health(upstream) != HealthDown {
		return next.ServeHTTP(w, r)
	}
	// Held before any byte is sent (POSTs are never sent early). On
	// recovery the request proxies; on timeout return a 503 error so
	// the static handle_errors renders the starting page — proxying
	// anyway would stack the hold cap on top of lb_try_duration.
	if prober.Wait(upstream, recheck, cap) == WaitTimedOut {
		return caddyhttp.Error(http.StatusServiceUnavailable, fmt.Errorf("edge: upstream %s not ready", upstream))
	}
	return next.ServeHTTP(w, r)
}

// EdgeAdmin exposes the privileged table-push endpoint on the
// loopback-only admin API. Caddy only discovers admin routes on modules in
// the admin.api.* namespace, so this is a separate module ID operating on
// the shared state. A tenant that could reach it could hijack other apps'
// hosts; reachability is closed by the nft egress policy (hostile suite
// covers it).
type EdgeAdmin struct{}

// CaddyModule returns the Caddy module information.
func (*EdgeAdmin) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "admin.api.edge_routes",
		New: func() caddy.Module { return new(EdgeAdmin) },
	}
}

// Routes registers the table-push endpoint.
func (*EdgeAdmin) Routes() []caddy.AdminRoute {
	return []caddy.AdminRoute{
		{
			Pattern: "/edge/routes",
			Handler: caddy.AdminHandlerFunc(handleAdmin),
		},
	}
}

// handleAdmin serves GET/POST on the shared state.
func handleAdmin(w http.ResponseWriter, r *http.Request) error {
	switch r.Method {
	case http.MethodGet:
		t := shared.table()
		var gen uint64
		var n int
		if t != nil {
			gen = t.Generation
			n = len(t.Exact) + len(t.Wildcards)
		}
		return writeJSON(w, map[string]any{"generation": gen, "routes": n})
	case http.MethodPost:
		var t Table
		if err := json.NewDecoder(r.Body).Decode(&t); err != nil {
			return caddy.APIError{
				HTTPStatus: http.StatusBadRequest,
				Err:        fmt.Errorf("edge: bad route table: %w", err),
			}
		}
		// The generation ordering, the store, prober.Track and lim.Sweep
		// are one locked step in install, so overlapping pushes (or a push
		// racing the Provision load) cannot interleave them.
		log := shared.logger()
		outcome, err := shared.install(&t)
		switch outcome {
		case InstallInvalid:
			return caddy.APIError{HTTPStatus: http.StatusBadRequest, Err: err}
		case InstallStale:
			return caddy.APIError{HTTPStatus: http.StatusConflict, Err: err}
		case InstallIdentical:
			// No-op re-pushes (the runner re-pushes every tick as a
			// backstop) stay quiet; only a new generation logs at info, so
			// the lane can assert pushes happened and operators can see
			// real changes.
			if log != nil {
				log.Debug("edge_routes: table re-push (unchanged)",
					zap.Uint64("generation", t.Generation))
			}
		case InstallApplied:
			if log != nil {
				log.Info("edge_routes: table pushed",
					zap.Uint64("generation", t.Generation),
					zap.Int("exact", len(t.Exact)),
					zap.Int("wildcards", len(t.Wildcards)))
			}
		}
		return writeJSON(w, map[string]any{
			"generation": t.Generation,
			"routes":     len(t.Exact) + len(t.Wildcards),
		})
	default:
		return caddy.APIError{
			HTTPStatus: http.StatusMethodNotAllowed,
			Err:        fmt.Errorf("edge: method %s not allowed", r.Method),
		}
	}
}

// writeJSON answers one admin request.
func writeJSON(w http.ResponseWriter, v any) error {
	w.Header().Set("Content-Type", "application/json")
	return json.NewEncoder(w).Encode(v)
}

var (
	_ caddy.Provisioner           = (*EdgeRoutes)(nil)
	_ caddy.CleanerUpper          = (*EdgeRoutes)(nil)
	_ caddy.Validator             = (*EdgeRoutes)(nil)
	_ caddy.Provisioner           = (*EdgeHold)(nil)
	_ caddy.CleanerUpper          = (*EdgeHold)(nil)
	_ caddyhttp.MiddlewareHandler = (*EdgeRoutes)(nil)
	_ caddyhttp.MiddlewareHandler = (*EdgeHold)(nil)
	_ caddy.AdminRouter           = (*EdgeAdmin)(nil)
)
