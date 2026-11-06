### Security

- Telemetry DuckDB now receives its SQL on stdin instead of `-c` on the command line. That SQL carries the platform store keys, and `/proc/<pid>/cmdline` is world-readable while tenant build processes share the container's PID namespace, so a build script that sampled the runner's children could have captured them. Every interpolated store field and every object key in the compaction and glob SQL is now a quoted DuckDB literal with doubled quotes, so a credential containing a quote can no longer end a statement.
