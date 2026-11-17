### Fixed

- PR CI now fails when a page-reachable module statically imports a Node builtin (`node:async_hooks`, a bare `fs`, …): the browser resolves those to stubs that throw at module load and kill the whole island chunk (the #371 storage-page outage, which the fast PR suite missed). The guard walks the source import graph from the pages — not the built output, where the incident's specifier was already stubbed away and a grep would have passed.
