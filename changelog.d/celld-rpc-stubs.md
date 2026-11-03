### Added

- celld patch `0007` (celld `0.6.3-noite.4`, pinned in a following change once published): RPC stubs and byte streams cross isolates on one node, as on Cloudflare.
  - A Durable Object can return an RPC stub or a `ReadableStream` to the calling Worker, and a Worker can pass a `ReadableStream` or `AbortSignal` into a Durable Object call.
  - Stubs live as long as the invocation holding them.
  - Void's managed sandbox (`exec()` processes and their output) depends on this.
