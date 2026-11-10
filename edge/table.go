// Route table schema and lookup for the noite edge module.
//
// The runner is the sole writer: it builds this table from its DB rows,
// writes it atomically to the file the module loads, and pushes the same
// bytes to the module's admin endpoint. Requests see either the old or the
// new table, never a mix.
package edge

import (
	"fmt"
	"strings"
)

// Route kinds. Every kind except "deny" proxies to Upstream; per-request
// behavior differences (wake/gate hops, trace, frame headers, rewrites,
// the starting page) are stock Caddy directives in the static config,
// branched on the kind the module publishes as {http.vars.edge_route}.
const (
	KindControl  = "control"
	KindAPI      = "api"
	KindGit      = "git"
	KindTenant   = "tenant"
	KindCustom   = "custom"
	KindEnv      = "env"
	KindEnvPark  = "env-parked"
	KindPreview  = "preview"
	KindFallback = "fallback"
	KindDeny     = "deny"
)

// Shape is the closed set of routing behaviors a wire kind has.
//
// The static Caddyfile still branches on the kind string, which the module
// publishes as {http.vars.edge_route}; Shape is what the Go handlers branch
// on instead of re-inferring behavior from that string.
type Shape uint8

const (
	// ShapeDeny answers 404 to every request before any hop or limit.
	ShapeDeny Shape = iota
	// ShapeProxy is the control plane, the API and git smart-HTTP: a plain
	// local reverse proxy with no readiness hold.
	ShapeProxy
	// ShapeFleet is a tenant app or custom domain: a fleet upstream that
	// may be restarting while the route exists.
	ShapeFleet
	// ShapeEnv is a live environment: a fleet upstream that can also be
	// gated (forward_auth /v1/edge/env-gate) and woken.
	ShapeEnv
	// ShapeParked is a live environment with no fleet port yet: the
	// runner's fallback page, no readiness hold.
	ShapeParked
	// ShapePreview is the pod preview host on the control plane.
	ShapePreview
	// ShapeFallback is the per-app and per-base wildcard fallback page.
	ShapeFallback
)

// shapeOf maps a wire kind to its shape; ok is false for a kind this build
// does not know (a newer runner, or a hand-written table).
func shapeOf(kind string) (Shape, bool) {
	switch kind {
	case KindControl, KindAPI, KindGit:
		return ShapeProxy, true
	case KindTenant, KindCustom:
		return ShapeFleet, true
	case KindEnv:
		return ShapeEnv, true
	case KindEnvPark:
		return ShapeParked, true
	case KindPreview:
		return ShapePreview, true
	case KindFallback:
		return ShapeFallback, true
	case KindDeny:
		return ShapeDeny, true
	}
	return ShapeDeny, false
}

// Mode is a route's behavior, derived once from its wire fields by
// Route.mode. It is the single answer to "does this route deny, hold, wake
// or gate?", so no handler re-infers behavior from the kind string.
//
//	stateDiagram-v2
//	    [*] --> Deny: kind=deny
//	    [*] --> Proxy: kind=control|api|git
//	    [*] --> Fleet: kind=tenant|custom
//	    [*] --> Env: kind=env
//	    [*] --> Parked: kind=env-parked
//	    [*] --> Preview: kind=preview
//	    [*] --> Fallback: kind=fallback
//
// Only a Fleet or an awake Env holds; Asleep wakes; Gated gates. Validate
// refuses every wire combination those rules cannot express.
type Mode struct {
	shape  Shape
	kind   string
	asleep bool
	gated  bool
}

// mode derives the route's behavior. An unknown kind never reaches here: a
// table is validated before it is installed. It maps to Deny anyway, so the
// impossible case fails closed instead of proxying.
func (r Route) mode() Mode {
	m := Mode{kind: r.Kind, asleep: r.Asleep, gated: r.Gated}
	if shape, ok := shapeOf(r.Kind); ok {
		m.shape = shape
	}
	return m
}

// Kind is the wire kind the static config branches on.
func (m Mode) Kind() string { return m.kind }

// Deny reports whether the route answers 404 before any hop or limit.
func (m Mode) Deny() bool { return m.shape == ShapeDeny }

// Hold reports whether the request must wait for its upstream's readiness
// probe. Only an awake fleet or environment is held: the wake hop and the
// env gate wait for the fleet themselves, and the other shapes have no
// fleet to wait for.
func (m Mode) Hold() bool {
	return (m.shape == ShapeFleet || m.shape == ShapeEnv) && !m.asleep
}

// Wake reports whether the static config must run the wake hop.
func (m Mode) Wake() bool { return m.asleep }

// Gate reports whether the static config must run the env gate.
func (m Mode) Gate() bool { return m.gated }

// Route is one host's edge behavior, fully resolved by the runner.
type Route struct {
	Kind string `json:"kind"`
	// Upstream is "127.0.0.1:port". Empty for KindDeny.
	Upstream string `json:"upstream,omitempty"`
	// Rewrite is a URI rewrite applied by the static config before
	// proxying ("/v1/edge/fallback", "/v1/git{uri}").
	Rewrite string `json:"rewrite,omitempty"`
	// Per-client zone (0 = off). Limits mirror caddy.rs guard_lines:
	// budget = ceil(rpm/6) per 10 s window, IPv6 /64 collapse.
	ClientRPM  uint32 `json:"client_rpm,omitempty"`
	ClientZone string `json:"client_zone,omitempty"`
	// Shared per-app zone (0 = off).
	AppRPM  uint32 `json:"app_rpm,omitempty"`
	AppZone string `json:"app_zone,omitempty"`
	// Asleep/Gated publish {http.vars.edge_wake}/{http.vars.edge_gate}
	// for the static forward_auth hops.
	Asleep bool `json:"asleep,omitempty"`
	Gated  bool `json:"gated,omitempty"`
}

// Wildcard matches every host under Suffix (which includes the leading
// dot, e.g. ".myapp.noite.localhost"). Longest suffix wins.
type Wildcard struct {
	Suffix string `json:"suffix"`
	Route  Route  `json:"route"`
}

// Table is the whole pushed route table.
type Table struct {
	Generation uint64           `json:"generation"`
	Exact      map[string]Route `json:"exact"`
	Wildcards  []Wildcard       `json:"wildcards"`
}

// validUpstream admits only loopback upstreams: the runner's upstreams
// are compile-time constants (control/api/fleets on 127.0.0.1).
func validUpstream(upstream string) bool {
	host, port, err := splitHostPort(upstream)
	if err != nil || host != "127.0.0.1" || port == "" {
		return false
	}
	for _, c := range port {
		if c < '0' || c > '9' {
			return false
		}
	}
	n := 0
	for _, c := range port {
		n = n*10 + int(c-'0')
		if n > 65535 {
			return false
		}
	}
	return n > 0
}

// rewritesKind reports the kinds the static config rewrites: git's smart
// HTTP path and the runner's fallback page.
func rewritesKind(kind string) bool {
	switch kind {
	case KindGit, KindEnvPark, KindFallback:
		return true
	}
	return false
}

// Validate rejects a malformed table so the old one keeps serving.
func (t *Table) Validate() error {
	for host, r := range t.Exact {
		if strings.TrimSpace(host) == "" {
			return fmt.Errorf("edge: exact route with empty host")
		}
		if host != strings.ToLower(host) {
			return fmt.Errorf("edge: host %q must be lowercase", host)
		}
		if err := r.validate(); err != nil {
			return fmt.Errorf("edge: host %q: %w", host, err)
		}
	}
	for i, w := range t.Wildcards {
		if !strings.HasPrefix(w.Suffix, ".") || len(w.Suffix) < 2 {
			return fmt.Errorf("edge: wildcard %d has bad suffix %q", i, w.Suffix)
		}
		if w.Suffix != strings.ToLower(w.Suffix) {
			return fmt.Errorf("edge: wildcard %q must be lowercase", w.Suffix)
		}
		if err := w.Route.validate(); err != nil {
			return fmt.Errorf("edge: wildcard %q: %w", w.Suffix, err)
		}
	}
	return nil
}

// validate is the one place a wire Route is refused. Every check answers
// the same question Route.mode does later: which behavior can this
// combination express? A field no shape can act on is a runner bug, and
// silently ignoring it would leave the route doing something other than
// what its table says.
func (r Route) validate() error {
	shape, ok := shapeOf(r.Kind)
	if !ok {
		return fmt.Errorf("unknown kind %q", r.Kind)
	}
	if shape == ShapeDeny {
		if r.Upstream != "" || r.Rewrite != "" {
			return fmt.Errorf("deny route must not set upstream or rewrite")
		}
		if r.Asleep || r.Gated {
			return fmt.Errorf("deny route must not sleep or gate")
		}
		if r.ClientRPM > 0 || r.AppRPM > 0 {
			return fmt.Errorf("deny route must not set rate limits")
		}
		return nil
	}
	if !validUpstream(r.Upstream) {
		return fmt.Errorf("upstream %q must be 127.0.0.1:<port>", r.Upstream)
	}
	if r.ClientRPM > 1<<30 || r.AppRPM > 1<<30 {
		return fmt.Errorf("rpm out of range")
	}
	if r.ClientRPM > 0 && r.ClientZone == "" {
		return fmt.Errorf("client_rpm without client_zone")
	}
	if r.AppRPM > 0 && r.AppZone == "" {
		return fmt.Errorf("app_rpm without app_zone")
	}
	if r.Asleep && !(shape == ShapeFleet || shape == ShapeEnv || shape == ShapeParked) {
		return fmt.Errorf("kind %q must not be asleep", r.Kind)
	}
	if r.Gated && !(shape == ShapeEnv || shape == ShapeParked) {
		return fmt.Errorf("kind %q must not be gated", r.Kind)
	}
	if r.Rewrite != "" && !rewritesKind(r.Kind) {
		return fmt.Errorf("kind %q must not set rewrite", r.Kind)
	}
	return nil
}

// normalizeHost strips any port, lowercases, and trims a trailing dot,
// mirroring how the runner builds table keys.
func normalizeHost(host string) string {
	if h, _, err := splitHostPort(host); err == nil {
		host = h
	}
	host = strings.ToLower(host)
	return strings.TrimSuffix(host, ".")
}

// splitHostPort splits host:port, rejecting a bare host the way the table keys assume.
func splitHostPort(hostport string) (string, string, error) {
	// Avoid net.SplitHostPort: it rejects bare hosts without a port,
	// which is the common case here.
	if i := strings.LastIndex(hostport, ":"); i >= 0 && !strings.Contains(hostport[i:], "]") {
		if strings.Count(hostport, ":") == 1 {
			return hostport[:i], hostport[i+1:], nil
		}
	}
	return hostport, "", fmt.Errorf("no port")
}

// Lookup returns the route for host: exact first, then longest suffix.
// Suffixes match exactly one label (like Caddy's `*.base`): the remainder
// must be a single non-empty label, so `a.b.base` never matches `.base`.
// Environment and preview suffixes need no multi-label match: labels never
// contain dots (the runner's labeler folds everything else to `-`).
func (t *Table) Lookup(host string) (Route, bool) {
	if t == nil {
		return Route{}, false
	}
	host = normalizeHost(host)
	if r, ok := t.Exact[host]; ok {
		return r, true
	}
	var best Route
	bestLen := -1
	for _, w := range t.Wildcards {
		if len(w.Suffix) <= bestLen || !strings.HasSuffix(host, w.Suffix) {
			continue
		}
		rest := host[:len(host)-len(w.Suffix)]
		if rest == "" || strings.Contains(rest, ".") {
			continue
		}
		bestLen = len(w.Suffix)
		best = w.Route
	}
	if bestLen < 0 {
		return Route{}, false
	}
	return best, true
}
