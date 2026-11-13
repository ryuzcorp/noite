### Changed

- **The runner reads celld telemetry Parquet itself.** Errors and Logs no longer come from a DuckDB CLI query: the ingest lists each chunk's hour directories through the S3 client, decodes only the columns it needs with the `parquet` crate (no `arrow`), and keeps the same newest-5000-log-lines and top-200-failed-span-group rules. Watermarks, chunk planning, per-fleet fault isolation, replace semantics and the replay CLI are unchanged.
- **Hourly Parquet compaction is written by the runner.** The scheduled fold that keeps an hour to one object (and deletes the sources only after the copy is proved) now unions the inputs with the Parquet writer instead of `COPY` through DuckDB, preserving every input column by name. DuckDB is no longer invoked by the ingest or the compaction; the binary stays in the image until the follow-up removal.
- `make usage` no longer prints the `[duckdb]` counter section (the runner never runs DuckDB now).
