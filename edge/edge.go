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
)

// Hold timing mirrors the old TENANT_PROXY: 20 s cap, 250 ms backstop.
const (
	HoldCap      = 20 * time.Second
	HoldRecheck  = 250 * time.Millisecond
	ProbeEvery   = 1 * time.Second
	ProbeTimeout = 2 * time.Second
)

// sharedState is the process-wide edge state, shared by every EdgeRoutes
// and EdgeHold instance (the static config provisions one per site).
type sharedState struct {
	mu sync.Mutex
	// refs counts provisioned instances; the last Cleanup stops the
	// probers so a full Caddy stop leaks no goroutines.
	refs        int
	tab         atomic.Pointer[Table]
	lim         *Limiter
	prober      *Prober
	log         *zap.Logger
	holdRecheck time.Duration
	holdCap     time.Duration
	// loaded is true once any table has been installed (file or push).
	// Lookup misses answer 404 only then; before that the edge is still
	// starting and answers 503.
	loaded bool
}

var shared = newSharedState()

func newSharedState() *sharedState {
	return &sharedState{
		holdRecheck: HoldRecheck,
		holdCap:     HoldCap,
	}
}

// initLocked creates the limiter and prober on first use. Callers hold mu.
func (s *sharedState) initLocked(log *zap.Logger) {
	if s.lim == nil {
		s.lim = NewLimiter(nil)
	}
	if s.prober == nil {
		s.prober = NewProber(ProbeEvery, ProbeTimeout, nil)
	}
	if log != nil {
		s.log = log
	}
}

func (s *sharedState) retain(log *zap.Logger) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refs++
	s.initLocked(log)
}

func (s *sharedState) release() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.refs > 0 {
		s.refs--
	}
	if s.refs == 0 && s.prober != nil {
		s.prober.Stop()
		s.prober = nil
		s.lim = nil
	}
}

// swap installs a table and converges the prober and limiter state.
// Asleep routes are never probed: the wake hop waits for the fleet's
// health gate itself, so probing them would only burn checks on a
// deliberately parked fleet.
func (s *sharedState) swap(t *Table) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.initLocked(nil)
	s.tab.Store(t)
	s.loaded = true
	keep := make(map[string]bool)
	fleet := make(map[string]bool)
	collect := func(r Route) {
		if r.ClientZone != "" {
			keep[r.ClientZone] = true
		}
		if r.AppZone != "" {
			keep[r.AppZone] = true
		}
		if FleetKind(r.Kind) && !r.Asleep && r.Upstream != "" {
			fleet[r.Upstream] = true
		}
	}
	for _, r := range t.Exact {
		collect(r)
	}
	for _, w := range t.Wildcards {
		collect(w.Route)
	}
	s.prober.Track(fleet)
	s.lim.Sweep(keep, time.Hour)
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
// the runner before Caddy starts; a missing file leaves the edge
// unloaded — 503 — until the first push).
func (e *EdgeRoutes) Provision(ctx caddy.Context) error {
	if e.TablePath == "" {
		return fmt.Errorf("edge_routes: table path is required")
	}
	shared.retain(ctx.Logger())
	t, err := loadTable(e.TablePath)
	if err != nil {
		ctx.Logger().Warn("edge_routes: no table yet", zap.Error(err))
		return nil
	}
	shared.swap(t)
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

func loadTable(path string) (*Table, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var t Table
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, err
	}
	if t.Exact == nil {
		t.Exact = make(map[string]Route)
	}
	if err := t.Validate(); err != nil {
		return nil, err
	}
	return &t, nil
}

// ServeHTTP implements caddyhttp.MiddlewareHandler.
func (e *EdgeRoutes) ServeHTTP(w http.ResponseWriter, r *http.Request, next caddyhttp.Handler) error {
	t := shared.tab.Load()
	// Snapshot shared pointers under the mutex: swap/release publish
	// them there, and the limiter/prober have their own internal locks
	// for use after the snapshot.
	shared.mu.Lock()
	loaded, lim := shared.loaded, shared.lim
	shared.mu.Unlock()
	if t == nil || !loaded || lim == nil {
		http.Error(w, "edge starting", http.StatusServiceUnavailable)
		return nil
	}
	route, ok := t.Lookup(r.Host)
	if !ok {
		// No route with a loaded table: 404, as Caddy did for unmatched
		// hosts. The 503 above is only for the boot gap.
		http.Error(w, "not found", http.StatusNotFound)
		return nil
	}
	if route.Kind == KindDeny {
		http.Error(w, "not found", http.StatusNotFound)
		return nil
	}
	if route.ClientRPM > 0 {
		clientIP, _ := caddyhttp.GetVar(r.Context(), caddyhttp.ClientIPVarKey).(string)
		if allowed, retry := lim.Allow(route.ClientZone, route.ClientRPM, ClientKey(clientIP)); !allowed {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", int(retry.Seconds())))
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return nil
		}
	}
	if route.AppRPM > 0 {
		if allowed, retry := lim.Allow(route.AppZone, route.AppRPM, "all"); !allowed {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", int(retry.Seconds())))
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return nil
		}
	}
	caddyhttp.SetVar(r.Context(), VarRoute, route.Kind)
	caddyhttp.SetVar(r.Context(), VarUpstream, route.Upstream)
	if route.Asleep {
		caddyhttp.SetVar(r.Context(), VarWake, "1")
	}
	if route.Gated {
		caddyhttp.SetVar(r.Context(), VarGate, "1")
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
func (EdgeHold) ServeHTTP(w http.ResponseWriter, r *http.Request, next caddyhttp.Handler) error {
	route, _ := caddyhttp.GetVar(r.Context(), VarRoute).(string)
	upstream, _ := caddyhttp.GetVar(r.Context(), VarUpstream).(string)
	if !FleetKind(route) || upstream == "" {
		return next.ServeHTTP(w, r)
	}
	if wake, _ := caddyhttp.GetVar(r.Context(), VarWake).(string); wake == "1" {
		return next.ServeHTTP(w, r)
	}
	shared.mu.Lock()
	prober, recheck, cap := shared.prober, shared.holdRecheck, shared.holdCap
	shared.mu.Unlock()
	if prober == nil || prober.Healthy(upstream) {
		return next.ServeHTTP(w, r)
	}
	// Held before any byte is sent (POSTs are never sent early). On
	// recovery the request proxies; on timeout return a 503 error so
	// the static handle_errors renders the starting page — proxying
	// anyway would stack the hold cap on top of lb_try_duration.
	if !prober.WaitHealthy(upstream, recheck, cap) {
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
		t := shared.tab.Load()
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
		if t.Exact == nil {
			t.Exact = make(map[string]Route)
		}
		if err := t.Validate(); err != nil {
			return caddy.APIError{HTTPStatus: http.StatusBadRequest, Err: err}
		}
		// Generations are monotonic (persisted in the file): an older
		// table landing last would un-publish newer routes.
		if cur := shared.tab.Load(); cur != nil && t.Generation < cur.Generation {
			return caddy.APIError{
				HTTPStatus: http.StatusConflict,
				Err:        fmt.Errorf("edge: generation %d older than current %d", t.Generation, cur.Generation),
			}
		}
		shared.mu.Lock()
		log := shared.log
		var curGen uint64
		var hasCur bool
		if cur := shared.tab.Load(); cur != nil {
			curGen, hasCur = cur.Generation, true
		}
		shared.mu.Unlock()
		// No-op re-pushes (the runner re-pushes every tick as a backstop)
		// stay quiet; only a new generation logs at info, so the lane can
		// assert pushes happened and operators can see real changes.
		if hasCur && t.Generation == curGen {
			if log != nil {
				log.Debug("edge_routes: table re-push (unchanged)",
					zap.Uint64("generation", t.Generation))
			}
			return writeJSON(w, map[string]any{
				"generation": t.Generation,
				"routes":     len(t.Exact) + len(t.Wildcards),
			})
		}
		shared.swap(&t)
		if log != nil {
			log.Info("edge_routes: table pushed",
				zap.Uint64("generation", t.Generation),
				zap.Int("exact", len(t.Exact)),
				zap.Int("wildcards", len(t.Wildcards)))
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
