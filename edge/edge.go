package edge

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
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
	caddy.RegisterModule(new(EdgeAdmin))
	httpcaddyfile.RegisterHandlerDirective("edge_routes", parseCaddyfile)
}

// liveEdge is the provisioned HTTP handler the admin API delegates to.
// There is exactly one in the static config.
var liveEdge atomic.Pointer[EdgeRoutes]

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

// EdgeRoutes holds the pushed route table and serves it per request.
type EdgeRoutes struct {
	// TablePath is the JSON file the runner writes atomically and the
	// module loads in Provision (restart persistence without a manual step).
	TablePath string `json:"table,omitempty"`

	tab    atomic.Pointer[Table]
	lim    *Limiter
	prober *Prober
	log    *zap.Logger
	// Hold timing (defaults set in Provision; tests inject shorts).
	holdRecheck time.Duration
	holdCap     time.Duration
}

// CaddyModule returns the Caddy module information.
func (*EdgeRoutes) CaddyModule() caddy.ModuleInfo {
	return caddy.ModuleInfo{
		ID:  "http.handlers.edge_routes",
		New: func() caddy.Module { return new(EdgeRoutes) },
	}
}

// Provision loads the table file (written by the runner before Caddy
// starts; a missing file starts empty and converges on the first push).
func (e *EdgeRoutes) Provision(ctx caddy.Context) error {
	e.log = ctx.Logger()
	e.lim = NewLimiter(nil)
	e.prober = NewProber(ProbeEvery, ProbeTimeout, nil)
	e.holdRecheck = HoldRecheck
	e.holdCap = HoldCap
	if e.TablePath == "" {
		return fmt.Errorf("edge_routes: table path is required")
	}
	liveEdge.Store(e)
	t, err := loadTable(e.TablePath)
	if err != nil {
		e.log.Warn("edge_routes: starting with an empty table", zap.Error(err))
		t = &Table{Exact: make(map[string]Route)}
	}
	e.swap(t)
	return nil
}

// Cleanup stops the readiness probers.
func (e *EdgeRoutes) Cleanup() error {
	if e.prober != nil {
		e.prober.Stop()
	}
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

// swap installs a table and converges the prober and limiter state.
func (e *EdgeRoutes) swap(t *Table) {
	e.tab.Store(t)
	keep := make(map[string]bool)
	fleet := make(map[string]bool)
	for _, r := range t.Exact {
		if r.ClientZone != "" {
			keep[r.ClientZone] = true
		}
		if r.AppZone != "" {
			keep[r.AppZone] = true
		}
		if FleetKind(r.Kind) && r.Upstream != "" {
			fleet[r.Upstream] = true
		}
	}
	for _, w := range t.Wildcards {
		r := w.Route
		if r.ClientZone != "" {
			keep[r.ClientZone] = true
		}
		if r.AppZone != "" {
			keep[r.AppZone] = true
		}
		if FleetKind(r.Kind) && r.Upstream != "" {
			fleet[r.Upstream] = true
		}
	}
	e.prober.Track(fleet)
	e.lim.Sweep(keep, time.Hour)
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
	t := e.tab.Load()
	if t == nil {
		http.Error(w, "edge starting", http.StatusServiceUnavailable)
		return nil
	}
	route, ok := t.Lookup(r.Host)
	if !ok {
		// No route (empty table during the boot gap): a plain 503, not a
		// proxy to an empty upstream.
		http.Error(w, "edge starting", http.StatusServiceUnavailable)
		return nil
	}
	if route.Kind == KindDeny {
		http.Error(w, "not found", http.StatusNotFound)
		return nil
	}
	if route.ClientRPM > 0 {
		clientIP, _ := caddyhttp.GetVar(r.Context(), caddyhttp.ClientIPVarKey).(string)
		if allowed, retry := e.lim.Allow(route.ClientZone, route.ClientRPM, ClientKey(clientIP)); !allowed {
			w.Header().Set("Retry-After", fmt.Sprintf("%d", int(retry.Seconds())))
			http.Error(w, "rate limited", http.StatusTooManyRequests)
			return nil
		}
	}
	if route.AppRPM > 0 {
		if allowed, retry := e.lim.Allow(route.AppZone, route.AppRPM, "all"); !allowed {
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
	if FleetKind(route.Kind) && !e.prober.Healthy(route.Upstream) {
		// Held before any byte is sent (POSTs are never sent early). On
		// recovery the request proxies; on timeout return a 503 error so
		// the static handle_errors renders the starting page — proxying
		// anyway would stack the hold cap on top of lb_try_duration.
		if !e.prober.WaitHealthy(route.Upstream, e.holdRecheck, e.holdCap) {
			return caddyhttp.Error(http.StatusServiceUnavailable, fmt.Errorf("edge: upstream %s not ready", route.Upstream))
		}
	}
	return next.ServeHTTP(w, r)
}

// EdgeAdmin exposes the privileged table-push endpoint on the
// loopback-only admin API. Caddy only discovers admin routes on modules in
// the admin.api.* namespace, so this is a separate module ID delegating to
// the provisioned HTTP handler. A tenant that could reach it could hijack
// other apps' hosts; reachability is closed by the nft egress policy
// (hostile suite covers it).
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

// handleAdmin serves GET/POST by delegating to the live HTTP handler,
// which owns the table, prober and limiter state.
func handleAdmin(w http.ResponseWriter, r *http.Request) error {
	e := liveEdge.Load()
	if e == nil {
		return caddy.APIError{
			HTTPStatus: http.StatusServiceUnavailable,
			Err:        fmt.Errorf("edge: handler not provisioned yet"),
		}
	}
	return e.handleAdmin(w, r)
}

func (e *EdgeRoutes) handleAdmin(w http.ResponseWriter, r *http.Request) error {
	switch r.Method {
	case http.MethodGet:
		t := e.tab.Load()
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
		e.swap(&t)
		e.log.Info("edge_routes: table pushed",
			zap.Uint64("generation", t.Generation),
			zap.Int("exact", len(t.Exact)),
			zap.Int("wildcards", len(t.Wildcards)))
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

// _ caddy.Provisioner = (*EdgeRoutes)(nil)
// _ caddy.CleanerUpper = (*EdgeRoutes)(nil)
// _ caddy.Validator = (*EdgeRoutes)(nil)
var (
	_ caddy.Provisioner           = (*EdgeRoutes)(nil)
	_ caddy.CleanerUpper          = (*EdgeRoutes)(nil)
	_ caddy.Validator             = (*EdgeRoutes)(nil)
	_ caddy.AdminRouter           = (*EdgeAdmin)(nil)
	_ caddyhttp.MiddlewareHandler = (*EdgeRoutes)(nil)
)
