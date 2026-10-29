### Changed

- **App templates live in one repo, `ryuzcorp/noite-templates`.** `ilha-void` and `tanstack-start` are folders (`templates/<id>/`) instead of one repo per template. The creator resolves a template by id against that repo (ref `main`) and imports its folder as one squashed commit. The old `noite-template-ilha` and `noite-template-tanstack-start` repos stay up read-only, so installs on older versions keep creating apps from them.
