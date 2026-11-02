### Fixed

- `Response.clone()` works on a streaming body (celld patch `0004`, celld `0.6.3-noite.2`): the clone and the original each get the whole body, as on Cloudflare. It used to throw `Cannot clone a streaming response before consumption`, so a Worker that caches a copy of a streamed response (Void's ISR on server-rendered pages) answered 500.
