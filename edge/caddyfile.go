// Caddyfile support for the noite edge module.
package edge

import (
	"github.com/caddyserver/caddy/v2/caddyconfig/caddyfile"
	"github.com/caddyserver/caddy/v2/caddyconfig/httpcaddyfile"
	"github.com/caddyserver/caddy/v2/modules/caddyhttp"
)

func parseCaddyfile(h httpcaddyfile.Helper) (caddyhttp.MiddlewareHandler, error) {
	e := new(EdgeRoutes)
	if err := parseInto(e, h.Dispenser); err != nil {
		return nil, err
	}
	return e, nil
}

func parseInto(e *EdgeRoutes, d *caddyfile.Dispenser) error {
	d.Next() // consume directive name
	for d.NextBlock(0) {
		switch d.Val() {
		case "table":
			if !d.NextArg() {
				return d.ArgErr()
			}
			e.TablePath = d.Val()
		default:
			return d.Errf("edge_routes: unknown option %q", d.Val())
		}
	}
	if d.NextArg() {
		return d.ArgErr()
	}
	return nil
}
