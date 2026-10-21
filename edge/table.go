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

// FleetKinds need the readiness hold: their upstream is a tenant fleet that
// may be restarting while the route exists.
func FleetKind(kind string) bool {
	return kind == KindTenant || kind == KindCustom || kind == KindEnv
}

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

func validKind(kind string) bool {
	switch kind {
	case KindControl, KindAPI, KindGit, KindTenant, KindCustom,
		KindEnv, KindEnvPark, KindPreview, KindFallback, KindDeny:
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
		if err := r.validate(); err != nil {
			return fmt.Errorf("edge: host %q: %w", host, err)
		}
	}
	for i, w := range t.Wildcards {
		if !strings.HasPrefix(w.Suffix, ".") || len(w.Suffix) < 2 {
			return fmt.Errorf("edge: wildcard %d has bad suffix %q", i, w.Suffix)
		}
		if err := w.Route.validate(); err != nil {
			return fmt.Errorf("edge: wildcard %q: %w", w.Suffix, err)
		}
	}
	return nil
}

func (r Route) validate() error {
	if !validKind(r.Kind) {
		return fmt.Errorf("unknown kind %q", r.Kind)
	}
	if r.Kind == KindDeny {
		if r.Upstream != "" || r.Rewrite != "" {
			return fmt.Errorf("deny route must not set upstream or rewrite")
		}
		return nil
	}
	if r.Upstream == "" {
		return fmt.Errorf("missing upstream")
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
		if strings.HasSuffix(host, w.Suffix) && len(w.Suffix) > bestLen {
			bestLen = len(w.Suffix)
			best = w.Route
		}
	}
	if bestLen < 0 {
		return Route{}, false
	}
	return best, true
}
