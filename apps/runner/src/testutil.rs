//! Test-only helpers shared by the runner's integration-style tests.
//!
//! The S3 stand-in answers every LIST with an empty `ListObjectsV2` page, so
//! the S3 side of purge/rename/environment teardown is a no-op instead of a
//! dial to RustFS. Object bodies and deletes are never reached by the tests
//! that use it (an empty listing short-circuits both).

/// Spawn the in-process LIST-only S3 stub and return its endpoint URL.
pub async fn spawn_s3_stub() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind s3 stub");
    let addr = listener.local_addr().expect("stub addr");
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                break;
            };
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut buf = vec![0u8; 8192];
                let _ = sock.read(&mut buf).await;
                let body = concat!(
                    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
                    "<ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">",
                    "<Name>noite</Name><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>",
                    "</ListBucketResult>"
                );
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
            });
        }
    });
    format!("http://{addr}")
}

/// Whether any live process still carries `marker` in its command line.
/// Process-group kill tests use it to prove no grandchild survived: a
/// lingering zombie's cmdline reads empty, so only a truly live process
/// matches.
pub fn live_cmdline_has(marker: &str) -> bool {
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return false;
    };
    dir.flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .chars()
                .all(|c| c.is_ascii_digit())
        })
        .filter_map(|entry| std::fs::read(entry.path().join("cmdline")).ok())
        .any(|raw| String::from_utf8_lossy(&raw).contains(marker))
}

/// Poll until no live process carries `marker`, up to `timeout`. A single
/// /proc scan right after a group SIGKILL races the kernel: the killed
/// grandchild keeps its cmdline until its exit finishes tearing down its
/// address space, so an immediate scan can still see it. Between scans the
/// loop only yields to the scheduler — never sleeps — so the reaping task
/// and the kernel get a chance to run while the wait stays purely
/// condition-driven. Returns true once the marker is gone.
pub async fn wait_for_cmdline_gone(marker: &str, timeout: std::time::Duration) -> bool {
    let start = std::time::Instant::now();
    loop {
        if !live_cmdline_has(marker) {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        tokio::task::yield_now().await;
    }
}
