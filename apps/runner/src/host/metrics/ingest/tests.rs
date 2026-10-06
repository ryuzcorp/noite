    use super::super::new_state;
    use super::super::plan::{back_off_ingest, ingest_backed_off};
    use super::*;

    const H: i64 = 1_767_225_600_000_000; // 2026-01-01T00:00:00Z in micros
    const HOUR_US: i64 = 3_600_000_000;

    // -----------------------------------------------------------------------
    // Write-layer tests. DuckDB is not on the dev host, so these drive
    // `commit_chunk` directly with the rows `ingest_all` would return: the
    // aggregation itself is exercised by the e2e lanes, the idempotency and
    // watermark rules here.
    // -----------------------------------------------------------------------

    #[test]
    fn canonical_file_list_prefers_compacted_directories() {
        let sql = canonical_file_list_sql("SELECT file FROM glob('s3://b/x/*.parquet')");
        assert!(sql.contains("compacted.parquet"), "{sql}");
        assert!(sql.contains("NOT IN"), "{sql}");
        assert!(sql.contains("compacted_dirs"), "{sql}");
    }

    async fn test_pool(name: &str) -> (SqlitePool, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("noite-metrics-{name}-{}", crate::models::new_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let url = format!("sqlite:{}?mode=rwc", dir.join("noite.sqlite").display());
        let pool = db::connect(&url).await.expect("connect");
        (pool, dir)
    }

    fn slug_id() -> HashMap<String, String> {
        HashMap::from([("blog".to_string(), "app1".to_string())])
    }

    fn log_row(ts_us: i64, body: &str, trace: &str) -> errors::LogRow {
        errors::LogRow {
            slug: "blog".to_string(),
            ts_us,
            body: body.to_string(),
            trace_id: trace.to_string(),
        }
    }

    fn rows_hour1() -> IngestRows {
        IngestRows {
            minutes: vec![
                (
                    "blog".to_string(),
                    "2026-01-01T00:05:00Z".to_string(),
                    10,
                    5_000,
                    0,
                ),
                (
                    "blog".to_string(),
                    "2026-01-01T00:06:00Z".to_string(),
                    4,
                    2_000,
                    1,
                ),
            ],
            spans: vec![(
                "blog".to_string(),
                "2026-01-01T00:00:00Z".to_string(),
                "celld.fetch".to_string(),
                0,
                14,
                7_000,
                1,
                300,
            )],
            logs: vec![log_row(H + 5 * 60_000_000, "hello", "t1")],
            errors: Vec::new(),
        }
    }

    fn rows_hour2() -> IngestRows {
        IngestRows {
            minutes: vec![(
                "blog".to_string(),
                "2026-01-01T01:10:00Z".to_string(),
                7,
                3_000,
                0,
            )],
            spans: vec![(
                "blog".to_string(),
                "2026-01-01T01:00:00Z".to_string(),
                "celld.fetch".to_string(),
                0,
                7,
                3_000,
                0,
                100,
            )],
            logs: vec![log_row(H + HOUR_US + 10 * 60_000_000, "world", "t2")],
            errors: vec![errors::SpanErrorRow {
                slug: "blog".to_string(),
                error: "rejected: TypeError: boom [at f (worker.js:1:1)]".to_string(),
                name: "celld.fetch".to_string(),
                cell: String::new(),
                trace_id: "t-err".to_string(),
                count: 1,
                first_us: H + HOUR_US + 1_000_000,
                last_us: H + HOUR_US + 1_000_000,
            }],
        }
    }

    /// A chunk of the control fleet's own telemetry, keyed on the reserved
    /// slug exactly as the ingest emits it (`ingest_all` derives the slug from
    /// the `control/telemetry/...` path).
    fn rows_control_hour() -> IngestRows {
        let control = crate::host::control::SLUG.to_string();
        IngestRows {
            minutes: vec![(control.clone(), "2026-01-01T00:05:00Z".to_string(), 9, 4_500, 0)],
            spans: vec![(
                control.clone(),
                "2026-01-01T00:00:00Z".to_string(),
                "celld.fetch".to_string(),
                0,
                9,
                4_500,
                0,
                200,
            )],
            logs: vec![errors::LogRow {
                slug: control.clone(),
                ts_us: H + 5 * 60_000_000,
                body: "control plane log".to_string(),
                trace_id: "ct-1".to_string(),
            }],
            errors: vec![errors::SpanErrorRow {
                slug: control,
                error: "rejected: TypeError: boom [at handler (worker.js:3:1)]".to_string(),
                name: "celld.fetch".to_string(),
                cell: String::new(),
                trace_id: "ct-err".to_string(),
                count: 2,
                first_us: H + 1_000_000,
                last_us: H + 2_000_000,
            }],
        }
    }

    fn combined(a: IngestRows, b: IngestRows) -> IngestRows {
        IngestRows {
            minutes: [a.minutes, b.minutes].concat(),
            spans: [a.spans, b.spans].concat(),
            logs: [a.logs, b.logs].concat(),
            errors: [a.errors, b.errors].concat(),
        }
    }

    /// Deterministic dump of every table the ingest writes.
    async fn dump(pool: &SqlitePool) -> Vec<String> {
        let mut out = Vec::new();
        let metrics: Vec<(String, String, i64, i64, i64, i64)> = sqlx::query_as(
            "SELECT app_id, bucket_ts, requests, errors, latency_ms, cpu_ms FROM metrics.app_metric ORDER BY bucket_ts",
        )
        .fetch_all(pool)
        .await
        .expect("app_metric");
        out.extend(metrics.iter().map(|r| format!("metric {r:?}")));
        let spans: Vec<SpanRow> = sqlx::query_as(
            "SELECT app_id, bucket_hour, name, kind, n, ms, err, qwait_ms FROM metrics.app_span_stat ORDER BY bucket_hour, name, kind",
        )
        .fetch_all(pool)
        .await
        .expect("span");
        out.extend(spans.iter().map(|r| format!("span {r:?}")));
        let logs: Vec<(String, i64, String)> =
            sqlx::query_as("SELECT app_id, ts_us, body FROM metrics.app_log ORDER BY ts_us, body")
                .fetch_all(pool)
                .await
                .expect("log");
        out.extend(logs.iter().map(|r| format!("log {r:?}")));
        let hours: Vec<(String, String, String, i64)> = sqlx::query_as(
            "SELECT app_id, fingerprint, bucket_hour, n FROM metrics.app_error_hour ORDER BY fingerprint, bucket_hour",
        )
        .fetch_all(pool)
        .await
        .expect("error_hour");
        out.extend(hours.iter().map(|r| format!("errhour {r:?}")));
        let events: Vec<(String, String, i64, String)> = sqlx::query_as(
            "SELECT app_id, fingerprint, ts_us, trace_id FROM metrics.app_error_event ORDER BY fingerprint, ts_us",
        )
        .fetch_all(pool)
        .await
        .expect("error_event");
        out.extend(events.iter().map(|r| format!("errevent {r:?}")));
        let issues: Vec<(String, String, i64, i64, i64)> = sqlx::query_as(
            "SELECT app_id, fingerprint, count, first_seen_us, last_seen_us FROM metrics.app_error_issue ORDER BY fingerprint",
        )
        .fetch_all(pool)
        .await
        .expect("error_issue");
        out.extend(issues.iter().map(|r| format!("issue {r:?}")));
        out
    }

    /// A chunk pass whose behaviour per call is scripted: a fleet in `fail`
    /// fails alone, `idle` returns the no-files error.
    struct FakePass {
        fail: HashSet<String>,
        idle: bool,
    }

    impl ChunkPass for FakePass {
        async fn pass(&self, bounds: &[(String, i64, i64)]) -> anyhow::Result<IngestRows> {
            if self.idle {
                anyhow::bail!("duckdb: No files found that match the pattern");
            }
            if bounds
                .iter()
                .any(|(slug, _, _)| self.fail.contains(slug.as_str()))
            {
                anyhow::bail!("simulated telemetry ingest error");
            }
            let mut rows = IngestRows::empty();
            for (slug, _, _) in bounds {
                rows.minutes.push((
                    slug.clone(),
                    "2026-01-01T00:05:00Z".to_string(),
                    1,
                    1_000,
                    0,
                ));
            }
            Ok(rows)
        }
    }

    #[tokio::test]
    async fn a_healthy_shared_pass_is_one_result() {
        let pass = FakePass {
            fail: HashSet::new(),
            idle: false,
        };
        let bounds = vec![
            ("a".to_string(), H, H + HOUR_US),
            ("b".to_string(), H, H + HOUR_US),
        ];
        let results = collect_chunk_results(&pass, &bounds).await;
        assert_eq!(results.len(), 1);
        assert!(results[0].1.is_ok());
    }

    #[tokio::test]
    async fn an_empty_window_is_a_successful_chunk() {
        let pass = FakePass {
            fail: HashSet::new(),
            idle: true,
        };
        let results = collect_chunk_results(&pass, &[("a".to_string(), H, H + HOUR_US)]).await;
        assert_eq!(results.len(), 1);
        assert!(
            results[0].1.is_ok(),
            "no files means nothing to read, not an error"
        );
    }

    #[tokio::test]
    async fn a_broken_fleet_does_not_hold_the_healthy_one() {
        let (pool, dir) = test_pool("isolation").await;
        let mut state = new_state();
        let slug_id = HashMap::from([
            ("good".to_string(), "app-good".to_string()),
            ("bad".to_string(), "app-bad".to_string()),
        ]);
        let bounds = vec![
            ("good".to_string(), H, H + HOUR_US),
            ("bad".to_string(), H, H + HOUR_US),
        ];
        let pass = FakePass {
            fail: HashSet::from(["bad".to_string()]),
            idle: false,
        };
        let results = collect_chunk_results(&pass, &bounds).await;
        // The shared pass failed, so it was retried per fleet: one result each.
        assert_eq!(results.len(), 2);
        for (chunk, result) in results {
            match result {
                Ok(rows) => {
                    commit_chunk(
                        &pool,
                        &mut state,
                        &slug_id,
                        &HashMap::new(),
                        &chunk,
                        rows,
                        0,
                    )
                    .await
                    .expect("commit the healthy fleet");
                }
                Err(_) => {
                    for (slug, from, _) in &chunk {
                        back_off_ingest(&mut state, slug, *from);
                    }
                }
            }
        }
        assert_eq!(
            state.watermark.get("good"),
            Some(&(H + HOUR_US)),
            "the healthy fleet must advance"
        );
        assert_eq!(
            state.watermark.get("bad"),
            None,
            "the broken fleet must hold"
        );
        assert!(
            ingest_backed_off(&state, "bad", H),
            "the broken fleet backs off"
        );
        let written: Vec<(String, i64)> =
            sqlx::query_as("SELECT app_id, requests FROM metrics.app_metric ORDER BY app_id")
                .fetch_all(&pool)
                .await
                .expect("app_metric");
        assert_eq!(written, vec![("app-good".to_string(), 1)]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn reingesting_a_window_is_idempotent_and_a_partial_retry_converges() {
        let full = rows_hour1();
        let bounds = vec![("blog".to_string(), H, H + HOUR_US)];
        let sha = HashMap::new();

        // A: the chunk written once.
        let (pool_a, dir_a) = test_pool("idem-a").await;
        let mut state_a = new_state();
        commit_chunk(
            &pool_a,
            &mut state_a,
            &slug_id(),
            &sha,
            &bounds,
            full.clone(),
            0,
        )
        .await
        .expect("write");
        let once = dump(&pool_a).await;
        assert!(!once.is_empty(), "the chunk must have written rows");
        // Re-reading the same window changes nothing.
        commit_chunk(
            &pool_a,
            &mut state_a,
            &slug_id(),
            &sha,
            &bounds,
            full.clone(),
            0,
        )
        .await
        .expect("re-read");
        assert_eq!(dump(&pool_a).await, once, "re-read must be a no-op");

        // B: a partial write (half the rows, no logs) that is retried with the
        // whole chunk — the failure mode a crash mid-pass leaves behind.
        let (pool_b, dir_b) = test_pool("idem-b").await;
        let mut state_b = new_state();
        let mut partial = full.clone();
        partial.minutes.truncate(1);
        partial.logs.clear();
        commit_chunk(&pool_b, &mut state_b, &slug_id(), &sha, &bounds, partial, 0)
            .await
            .expect("partial");
        commit_chunk(&pool_b, &mut state_b, &slug_id(), &sha, &bounds, full, 0)
            .await
            .expect("retry");
        assert_eq!(
            dump(&pool_b).await,
            once,
            "a retry must converge on the single write"
        );

        // The watermark moved to the chunk's end, not the cutoff.
        assert_eq!(state_a.watermark.get("blog"), Some(&(H + HOUR_US)));
        for dir in [dir_a, dir_b] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[tokio::test]
    async fn catch_up_in_hour_chunks_equals_one_continuous_pass() {
        let sha = HashMap::new();
        // A: both hours in one window.
        let (pool_a, dir_a) = test_pool("catchup-a").await;
        let mut state_a = new_state();
        commit_chunk(
            &pool_a,
            &mut state_a,
            &slug_id(),
            &sha,
            &[("blog".to_string(), H, H + 2 * HOUR_US)],
            combined(rows_hour1(), rows_hour2()),
            0,
        )
        .await
        .expect("continuous");
        // B: hour by hour, the way the tick catches up.
        let (pool_b, dir_b) = test_pool("catchup-b").await;
        let mut state_b = new_state();
        commit_chunk(
            &pool_b,
            &mut state_b,
            &slug_id(),
            &sha,
            &[("blog".to_string(), H, H + HOUR_US)],
            rows_hour1(),
            0,
        )
        .await
        .expect("hour 1");
        commit_chunk(
            &pool_b,
            &mut state_b,
            &slug_id(),
            &sha,
            &[("blog".to_string(), H + HOUR_US, H + 2 * HOUR_US)],
            rows_hour2(),
            0,
        )
        .await
        .expect("hour 2");
        assert_eq!(dump(&pool_b).await, dump(&pool_a).await);
        for dir in [dir_a, dir_b] {
            let _ = std::fs::remove_dir_all(dir);
        }
    }

    #[tokio::test]
    async fn control_telemetry_is_keyed_on_the_reserved_slug_without_an_app_row() {
        let (pool, dir) = test_pool("control").await;
        let mut state = new_state();
        let slug_id = HashMap::from([(
            crate::host::control::SLUG.to_string(),
            crate::host::control::SLUG.to_string(),
        )]);
        let bounds = vec![(crate::host::control::SLUG.to_string(), H, H + HOUR_US)];
        let sha = HashMap::new();
        commit_chunk(
            &pool,
            &mut state,
            &slug_id,
            &sha,
            &bounds,
            rows_control_hour(),
            0,
        )
        .await
        .expect("commit the control chunk");
        let once = dump(&pool).await;
        assert!(!once.is_empty(), "control telemetry must be written");
        let metrics: Vec<(String, i64)> =
            sqlx::query_as("SELECT app_id, requests FROM metrics.app_metric ORDER BY app_id")
                .fetch_all(&pool)
                .await
                .expect("app_metric");
        assert_eq!(metrics, vec![(crate::host::control::SLUG.to_string(), 9)]);
        let issues: Vec<(String, i64)> =
            sqlx::query_as("SELECT app_id, count FROM metrics.app_error_issue ORDER BY app_id")
                .fetch_all(&pool)
                .await
                .expect("app_error_issue");
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].0, crate::host::control::SLUG);
        // The reserved key has NO app row: every path that iterates apps
        // (reconcile, Caddy, sleep, purge, list_apps) stays blind to it.
        assert!(db::list_apps(&pool).await.expect("list_apps").is_empty());
        assert!(!crate::lifecycle::slug_ok(crate::host::control::SLUG));
        // A replay (the retry/reingest path) is exact, never additive.
        commit_chunk(
            &pool,
            &mut state,
            &slug_id,
            &sha,
            &bounds,
            rows_control_hour(),
            0,
        )
        .await
        .expect("replay the control chunk");
        assert_eq!(dump(&pool).await, once, "a re-read must be a no-op");
        assert_eq!(
            state.watermark.get(crate::host::control::SLUG),
            Some(&(H + HOUR_US))
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_failed_write_holds_the_watermark() {
        let (pool, dir) = test_pool("fail").await;
        let mut state = new_state();
        state.watermark.insert("blog".to_string(), H);
        // A dead pool makes every writer inside commit_chunk fail.
        pool.close().await;
        let result = commit_chunk(
            &pool,
            &mut state,
            &slug_id(),
            &HashMap::new(),
            &[("blog".to_string(), H, H + HOUR_US)],
            rows_hour1(),
            0,
        )
        .await;
        assert!(result.is_err(), "the failed pass must report an error");
        assert_eq!(
            state.watermark.get("blog"),
            Some(&H),
            "a failed pass must not advance the watermark"
        );
        let _ = std::fs::remove_dir_all(dir);
    }
