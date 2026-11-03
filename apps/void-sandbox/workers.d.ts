// Type-only platform declarations for the sandbox controller bundle.
// Dev-time only: nothing imports this file, so it never ships (the image
// build bundles from `worker.ts`, and S3 embeds the prebuilt `dist/worker.js`).
// The `void/_sandbox-container` types reference this package the same way.
// oxlint-disable-next-line typescript/triple-slash-reference -- dependent sources need the platform globals and the virtual `cloudflare:workers` module declaration.
/// <reference types="@cloudflare/workers-types" />
