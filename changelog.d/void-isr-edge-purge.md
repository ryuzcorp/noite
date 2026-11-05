### Fixed

- Void ISR revalidation (`revalidate()`) now purges the app's `caches.default` L1 entries as well as the KV keys: every purged KV key — the base key and every `#rw=` variant, across all deployment ids — also deletes its html and json edge URLs, mirroring Void's self-host purge (best effort per entry, so a degraded Cache API never fails the KV purge). Previously pages served from L1 stayed stale after revalidation. Fleets run `CELLD_CACHE_SCOPE=deployment` so the cohosted proxy shares the app's edge cache, like a Cloudflare zone; the control node keeps celld's default scope.
