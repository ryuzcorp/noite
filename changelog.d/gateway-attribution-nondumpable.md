### Operator action required

- Single-tenant installs without per-fleet cgroups (the default: no cgroup grant, fleets share the container cgroup) now attribute Sandbox container dials per trust domain instead of per app. Such a dial to a known fleet's container is allowed without identifying the calling fleet — one trusted owner — and the install warns once at boot (`sandbox dials not attributed per app: no per-fleet cgroups`, also on `/ready` and in `make doctor`). Cross-app dials on those installs are no longer refused. Multi-tenancy is unchanged (per-fleet cgroups are mandatory there and unknown attribution stays refused), as is any single-tenant install whose cgroup grant is present.

### Fixed

- Sandbox container dials are attributed by the client socket's cgroup v2 id (netlink `sock_diag`) instead of the pid-fd scan, so they keep working when celld runs non-dumpable (celld `0.6.3-ryuzcorp.9`+, patch `0053`): opening `/proc/<pid>/fd` of a non-dumpable process needs `CAP_SYS_PTRACE` even for the same uid, which made every fleet→container dial unattributable and therefore refused. The pid-fd scan remains as the fallback for dumpable celld and for kernels without the cgroup filter.
