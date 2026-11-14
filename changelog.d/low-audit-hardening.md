### Security

- The control UI compares the runner token (`/webhook`, `/internal/*`) in constant time instead of with `===`, so response timing on the public control host no longer reveals how much of a guessed token matched.
- `.env.example` now carries the same RustFS dev keys as `docker/compose.yaml`, which the runner refuses to boot with on a non-localhost `BASE_DOMAIN`. It previously shipped different placeholder keys that passed that check, so a copied example file booted a public install with published store keys.
