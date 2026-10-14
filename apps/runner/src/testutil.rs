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
