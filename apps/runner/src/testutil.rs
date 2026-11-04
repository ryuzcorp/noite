//! Test-only helpers shared by the runner's integration-style tests.
//!
//! The S3 stand-in answers every LIST with an empty `ListObjectsV2` page, so
//! the S3 side of purge/rename/environment teardown is a no-op instead of a
//! dial to RustFS. Object bodies and deletes are never reached by the tests
//! that use it (an empty listing short-circuits both).

/// A scratch directory that removes itself on drop — including on a
/// failing assert (test threads unwind), so a failing run never piles
/// leaked fixtures into `/tmp` for the next run to trip over. Every test
/// helper that builds a temp dir returns this instead of a bare path.
pub struct TempDir {
    path: std::path::PathBuf,
}

impl TempDir {
    /// Create a fresh unique directory under the system temp dir. `prefix`
    /// names the owning test area (`noite-void-migrate-cap-total`, ...).
    pub fn new(prefix: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "{prefix}-{}-{}",
            std::process::id(),
            crate::models::new_id()
        ));
        std::fs::create_dir_all(&path).expect("test scratch dir");
        Self { path }
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

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

/// SIGKILL every live process whose command line contains `marker`, except
/// this test binary itself. Best-effort: a pid that exits mid-scan is
/// already gone, which is the goal. Group-kill tests pair this with a
/// pid-unique marker so the sweep can only ever hit their own sleepers —
/// never a concurrently running test binary's.
pub fn kill_cmdline(marker: &str) {
    #[cfg(unix)]
    {
        let Ok(dir) = std::fs::read_dir("/proc") else {
            return;
        };
        let self_pid = std::process::id().to_string();
        for entry in dir.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == self_pid || !name.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let Ok(raw) = std::fs::read(entry.path().join("cmdline")) else {
                continue;
            };
            if !String::from_utf8_lossy(&raw).contains(marker) {
                continue;
            }
            if let Ok(pid) = name.parse::<i32>() {
                // SAFETY: SIGKILL to a scanned pid; ESRCH on a pid that just
                // exited is fine.
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = marker;
    }
}

/// Kills the marker's processes when dropped: group-kill tests hold one so
/// their sleepers die on every exit path — pass, fail or panic — instead of
/// lingering as year-long orphans that poison later runs' /proc scans.
pub struct KillMarkerOnDrop {
    marker: String,
}

impl KillMarkerOnDrop {
    pub fn new(marker: &str) -> Self {
        Self {
            marker: marker.to_string(),
        }
    }
}

impl Drop for KillMarkerOnDrop {
    fn drop(&mut self) {
        kill_cmdline(&self.marker);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn temp_dir_removes_itself_on_drop() {
        let path = {
            let guard = TempDir::new("noite-tempdir-drop");
            let path = guard.path().to_path_buf();
            assert!(path.is_dir(), "guard creates the dir");
            std::fs::write(path.join("file.txt"), "x").unwrap();
            path
        };
        assert!(!path.exists(), "drop removes the dir and its files");
    }

    /// The marker sweep kills a live sleeper carrying the marker: the
    /// mechanism the group-kill guards rely on.
    #[test]
    fn kill_cmdline_kills_its_marker() {
        let marker = format!("31339{}", std::process::id());
        let mut child = std::process::Command::new("sleep")
            .arg(&marker)
            .spawn()
            .expect("spawn sleeper");
        assert!(live_cmdline_has(&marker), "sleeper is visible");
        kill_cmdline(&marker);
        let start = std::time::Instant::now();
        while live_cmdline_has(&marker) {
            assert!(
                start.elapsed() < std::time::Duration::from_secs(5),
                "sleeper survived the sweep"
            );
            std::thread::yield_now();
        }
        let _ = child.try_wait();
    }

    /// A failing assert unwinds the test thread: the guard must still clean
    /// up, or every failing run piles fixtures into `/tmp` for the next run.
    #[test]
    fn temp_dir_removes_itself_on_panic() {
        let slot: std::rc::Rc<std::cell::RefCell<Option<std::path::PathBuf>>> =
            std::rc::Rc::new(std::cell::RefCell::new(None));
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let guard = TempDir::new("noite-tempdir-panic");
            *slot.borrow_mut() = Some(guard.path().to_path_buf());
            panic!("boom");
        }));
        assert!(caught.is_err(), "the panic happened");
        let path = slot.borrow().clone().expect("path recorded");
        assert!(!path.exists(), "unwind still removes the dir");
    }
}
