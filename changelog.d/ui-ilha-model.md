### Changed

- **Control UI on ilha 0.16.3 with `@ilha/model`.** The control UI's islands can now hold their state in one Elm-style model (`@ilha/model` 0.1.1: tagged messages, one pure `update`, Effect commands). `lib/island.tsx` carries an island's inputs through an ilha context, because `defineApp` components take no props. This is groundwork for making the UI's state machines explicit; nothing changes for users yet.
