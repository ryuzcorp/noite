### Changed

- R2 reads detect a missing key from `celld r2 head|get --json`'s `{"error":"not_found","bucket":...,"key":...}` object on stdout instead of matching the English stderr, so the detection no longer depends on celld's human message. The `object not found` bail the service maps to 404 is unchanged, as is a found key's `get` bytes.

### Operator action required

- Requires celld `v0.6.3-ryuzcorp.7` for the not_found object; against an older celld a missing key surfaces as a step error instead of 404.
