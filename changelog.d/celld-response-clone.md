### Fixed

- `Response.clone()` works on a streaming body (celld patch `0004`): the clone and the original each get the whole body, as on Cloudflare. It used to throw `Cannot clone a streaming response before consumption`, so a Worker that caches a copy of a streamed response (Void's ISR on server-rendered pages) answered 500. `Request.clone()` and `Response.clone()` now also refuse a body that was partly read through its reader, as on Cloudflare, instead of cloning the remainder.
