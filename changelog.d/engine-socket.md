### Added

- **Sandbox containers run on the host engine.** The image ships the `docker` CLI (pinned `DOCKER_VERSION`, signed apt repo) and compose mounts the host daemon socket (`DOCKER_SOCKET`, default `/var/run/docker.sock`) with `DOCKER_HOST` for celld; fleets inherit the env. Apps using the Sandbox container class (the agent template) now deploy and start on installs whose host runs Docker; rootless-podman hosts point `DOCKER_SOCKET`/`DOCKER_HOST` at their socket.
