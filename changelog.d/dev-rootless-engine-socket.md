### Fixed

- **`make up`/`make dev`/`make dev-host` start on rootless Podman again.** Since Sandbox containers mount the host engine socket, a host without `/var/run/docker.sock` failed with `statfs /var/run/docker.sock: no such file or directory`: Podman refuses a missing bind source where Docker creates a directory. With `DOCKER_SOCKET` unset and no host socket, the Makefile now mounts `/dev/null` in its place and sets `NOITE_SANDBOX=0` (unless already set); Sandbox containers need a rootful engine anyway. Hosts with a Docker socket, or an explicit `DOCKER_SOCKET`, are unchanged.
