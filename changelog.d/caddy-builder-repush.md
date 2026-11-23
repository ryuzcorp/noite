### Changed

- The Caddy build stage follows Docker's re-push of `caddy:2.11.9-builder` (`sha256:cda07fe9d82728c7ac44d844306d435e98131423dc7b114f05a8a8ecfff94707`). The re-push only adds a linux/riscv64 leg. The amd64 and arm64 manifests Noite builds from are unchanged, and Caddy is still 2.11.9.
