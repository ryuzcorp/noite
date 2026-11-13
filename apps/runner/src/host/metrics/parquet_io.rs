//! Parquet primitives shared by the telemetry ingest and compaction.
//!
//! celld's telemetry schema is flat primitives (see `celld`'s
//! `telemetry.rs`), so the native record API is enough: the `arrow` feature
//! would pull the whole arrow stack into the runner image for no benefit.
//! Every read projects only the columns its caller uses, which keeps a row
//! group's decode bounded by the object size instead of the object's size
//! times the schema width.

use anyhow::Context;
use bytes::Bytes;
use parquet::file::reader::SerializedFileReader;
use parquet::record::Field;
use parquet::schema::types::Type;

use crate::config::Config;
use crate::host::s3;

/// Largest telemetry object the ingest will decode. A flush is one object per
/// signal per node (`CELLD_OTEL_FLUSH_MS`, 30 s by default); even a firehose
/// node's 30 s of spans sits far below this, so a bigger object means a
/// corrupt or foreign file, and buffering it whole would be the only way to
/// read it. Skipping it with a warning keeps the tick bounded; the skip is
/// logged, never silent.
pub(super) const MAX_OBJECT_BYTES: usize = 256 * 1024 * 1024;

/// One fetched object: a body, a key that vanished between the listing and
/// the read, or one too large to decode.
pub(super) enum Fetched {
    Body(Bytes),
    Missing,
    TooLarge(u64),
}

/// Fetch one telemetry object through the runner's S3 client. A HEAD first
/// means an oversized object is refused before its body is buffered at all;
/// the streaming cap inside [`s3::s3_get_object`] covers a store that reports
/// the wrong length.
pub(super) async fn fetch(cfg: &Config, key: &str) -> anyhow::Result<Fetched> {
    if let Some(head) = s3::s3_head_object(cfg, &cfg.s3_bucket, key).await {
        if head.size > MAX_OBJECT_BYTES as i64 {
            return Ok(Fetched::TooLarge(head.size as u64));
        }
    }
    match s3::s3_get_object(cfg, key, MAX_OBJECT_BYTES).await? {
        Some(body) => Ok(Fetched::Body(body)),
        None => Ok(Fetched::Missing),
    }
}

/// `parquet`'s reader over an in-memory object. The buffer stays alive for the
/// whole scan (its column chunks are decoded from it on demand), which is why
/// the object cap bounds the read's memory.
pub(super) fn open(body: Bytes) -> anyhow::Result<SerializedFileReader<Bytes>> {
    SerializedFileReader::new(body).context("parquet open")
}

/// The file's root schema as a projection of `wanted`, in `wanted` order.
/// Columns a file does not carry (pre-0.6.1 logs have no `severity_text`) are
/// simply absent — the caller reads fields by name, never by position.
/// `None` means the file carries none of them and can be skipped whole.
pub(super) fn project(root: &Type, wanted: &[&str]) -> anyhow::Result<Option<Type>> {
    let fields: Vec<_> = wanted
        .iter()
        .filter_map(|name| {
            root.get_fields()
                .iter()
                .find(|field| field.name() == *name)
                .cloned()
        })
        .collect();
    if fields.is_empty() {
        return Ok(None);
    }
    // The projection root keeps the file's own schema name: `RowIter::project`
    // calls `check_contains`, and two schemas only match when their names do.
    let projected = Type::group_type_builder(root.name())
        .with_fields(fields)
        .build()
        .context("parquet projection")?;
    Ok(Some(projected))
}

/// UTF-8 text of a string column, whether the writer annotated it as `STRING`
/// or a store round-trip left it as plain `BYTE_ARRAY`.
pub(super) fn text(field: &Field) -> Option<&str> {
    match field {
        Field::Str(value) => Some(value),
        Field::Bytes(value) => std::str::from_utf8(value.data()).ok(),
        _ => None,
    }
}

/// One signed integer column, whatever width the writer used.
pub(super) fn long(field: &Field) -> Option<i64> {
    match field {
        Field::Long(value) | Field::TimestampMicros(value) => Some(*value),
        Field::Int(value) => Some(i64::from(*value)),
        Field::Short(value) => Some(i64::from(*value)),
        Field::Byte(value) => Some(i64::from(*value)),
        _ => None,
    }
}

/// One boolean column (`ok` on a span).
pub(super) fn boolean(field: &Field) -> Option<bool> {
    match field {
        Field::Bool(value) => Some(*value),
        _ => None,
    }
}
