//! Durable compaction (spec T3.5) of completed hours, and the watermark that
//! keeps it from running twice.
//!
//! A fold never publishes an object the reader refuses: the inputs and the
//! real output are checked against the reader's cap, and a refused hour is
//! kept raw (sources untouched, never failed). Known residual: a *refused
//! refold* — an existing compacted file plus more than ~96 MiB of late
//! flushes — is left raw with the late sources still shadowed by the
//! canonical rule, because publishing an oversized file would hide the whole
//! hour instead. It needs a firehose hour plus a lost compaction pass, and
//! the sources are never deleted.

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parquet::basic::{Compression, ConvertedType, Repetition, Type as PhysicalType, ZstdLevel};
use parquet::data_type::{BoolType, ByteArray, ByteArrayType, Int32Type, Int64Type};
use parquet::file::properties::WriterProperties;
use parquet::file::reader::{FileReader, SerializedFileReader};
use parquet::file::writer::{SerializedFileWriter, SerializedRowGroupWriter};
use parquet::record::Field;
use parquet::schema::types::Type;
use sqlx::SqlitePool;

use crate::config::Config;
use crate::db;
use crate::host::s3;

use super::parquet_io::{self, Fetched};
use super::plan::telemetry_prefix;
use super::MetricsState;

/// Split one hour directory's keys into `(already_compacted, foldable
/// sources)`. A compacted file plus extra sources means a flush landed after
/// (or during) the last compaction: the extras are late arrivals, not
/// leftovers, and must be folded in — never deleted unread.
fn compaction_plan(keys: &[String], target: &str) -> (bool, Vec<String>) {
    let has_target = keys.iter().any(|k| k == target);
    let sources = keys
        .iter()
        .filter(|k| k.as_str() != target)
        .cloned()
        .collect();
    (has_target, sources)
}

/// What one pass over an hour directory must do: `None` when there is nothing
/// to fold, otherwise the exact input list for the re-COPY. The existing
/// target always leads the inputs when it exists, so a flush that landed
/// between COPY and delete — or after a completed compaction — is folded
/// into the compacted file instead of being destroyed unread.
fn compaction_inputs(keys: &[String], target: &str) -> Option<Vec<String>> {
    let (has_target, sources) = compaction_plan(keys, target);
    if has_target {
        if sources.is_empty() {
            return None;
        }
        let mut inputs = Vec::with_capacity(sources.len() + 1);
        inputs.push(target.to_string());
        inputs.extend(sources);
        Some(inputs)
    } else if sources.len() < 2 {
        None
    } else {
        Some(sources)
    }
}

/// `yyyy/mm/dd/hh` for a timestamp, as celld partitions telemetry.
pub(super) fn hour_dir(us: i64) -> String {
    chrono::DateTime::from_timestamp_micros(us.max(0))
        .map(|t| t.format("%Y/%m/%d/%H").to_string())
        .unwrap_or_default()
}

/// Rewrite the last completed hour of one fleet's telemetry into one zstd file
/// per node directory, exactly as the docs prescribe ("Run a compaction job on
/// a maintenance node... Run the job once an hour, for the hour that just
/// ended. Do not compact the current hour... Delete the source files after
/// the copy lands"). celld never compacts its own files and we flush every
/// `otel_flush_ms` (120 objects per hour per signal per node at the 30 s
/// default), so without this job a fleet's bucket grows to thousands of tiny
/// files per hour and every ingest listing and decode walks them all.
///
/// Sources are deleted only after `head-object` proves the compacted file
/// exists, so a failed copy can never lose spans. The root comes from
/// [`telemetry_prefix`], so the control fleet's `control/telemetry/...` is
/// compacted exactly like a tenant fleet's.
///
/// An hour directory whose fold would exceed the reader's object cap is left
/// untouched and reported as kept raw: the sources stay readable (each is
/// below the cap), so the reader still shows the hour, and the caller must not
/// mark it compacted.
pub(super) async fn compact_fleet(
    cfg: &Config,
    slug: &str,
    hour: &str,
) -> anyhow::Result<CompactionReport> {
    let mut report = CompactionReport::default();
    let prefix = telemetry_prefix(slug);
    for kind in ["traces", "logs"] {
        let root = format!("{prefix}/telemetry/{kind}/");
        let listing = s3::s3_list_delimited(cfg, &cfg.s3_bucket, &root).await?;
        let v: serde_json::Value = serde_json::from_str(listing.trim()).unwrap_or_default();
        let nodes: Vec<String> = v
            .pointer("/CommonPrefixes")
            .and_then(|p| p.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|o| o.pointer("/Prefix").and_then(|x| x.as_str()))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        for node in nodes {
            let dir = format!("{node}{hour}/");
            let listing = s3::s3_list_delimited(cfg, &cfg.s3_bucket, &dir).await?;
            let v: serde_json::Value = serde_json::from_str(listing.trim()).unwrap_or_default();
            let keys: Vec<String> = v
                .pointer("/Contents")
                .and_then(|p| p.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|o| o.pointer("/Key").and_then(|x| x.as_str()))
                        .filter(|k| k.ends_with(".parquet"))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let target = format!("{dir}compacted.parquet");
            // Nothing to fold: a lone compacted file is stable, and one
            // source is already one file.
            let Some(inputs) = compaction_inputs(&keys, &target) else {
                continue;
            };
            match copy_union(cfg, &dir, &target, &inputs).await? {
                FoldOutcome::Folded => {
                    s3::s3_rm_dir_except(cfg, &cfg.s3_bucket, &dir, "compacted.parquet").await?;
                    report.folded += 1;
                }
                FoldOutcome::KeptRaw => report.kept_raw += 1,
            }
        }
    }
    Ok(report)
}

/// Rows buffered before one row group is written. A batch this size is a few
/// hundred kilobytes of telemetry: folding an hour never holds the whole hour
/// in memory, and the compacted file still has few row groups for the ingest
/// to read.
const FOLD_BATCH_ROWS: usize = 8192;

/// Largest input set one fresh fold accepts. The output is a re-compression of
/// the same rows, so it lands within a few percent of the input bytes; keeping
/// the inputs well below the reader's [`parquet_io::MAX_OBJECT_BYTES`] means
/// the published file stays readable. At the 30 s flush default an hour is
/// ~120 objects of a few MB, so this bound is only reached by a firehose node —
/// exactly the hour the old DuckDB compaction could fold into a file the new
/// reader would refuse.
const MAX_FOLD_INPUT_BYTES: u64 = 160 * 1024 * 1024;

/// Input budget for a refold, which also carries the hour's existing
/// compacted file. That file was published below the reader's cap, and a late
/// flush must still fold into it — otherwise the canonical rule (a directory
/// with `compacted.parquet` is read from that file alone) would hide the late
/// rows. The output check below still guarantees the promoted file is
/// readable.
const MAX_REFOLD_INPUT_BYTES: u64 = parquet_io::MAX_OBJECT_BYTES as u64;

/// Why one hour directory cannot be folded into a file the reader accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FoldRefusal {
    /// The inputs alone are past [`MAX_FOLD_INPUT_BYTES`].
    InputsTooLarge(u64),
    /// The folded file is past [`parquet_io::MAX_OBJECT_BYTES`].
    OutputTooLarge(u64),
}

/// Whether a fold must be skipped. `output_bytes` is `None` before the fold
/// runs (the input check), `Some` after it. A refusal means the sources stay
/// in place and the hour is recorded as kept raw — never as failed, so it
/// cannot wedge the hours behind it.
fn fold_refusal(
    input_bytes: u64,
    output_bytes: Option<u64>,
    input_budget: u64,
) -> Option<FoldRefusal> {
    if input_bytes > input_budget {
        return Some(FoldRefusal::InputsTooLarge(input_bytes));
    }
    output_bytes
        .filter(|bytes| *bytes > parquet_io::MAX_OBJECT_BYTES as u64)
        .map(FoldRefusal::OutputTooLarge)
}

/// What one hour directory's fold did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FoldOutcome {
    /// The compacted object was written and proved with a HEAD.
    Folded,
    /// The fold was skipped (see [`FoldRefusal`]); every source is untouched.
    KeptRaw,
}

/// What one fleet hour's compaction pass did.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct CompactionReport {
    /// Node directories folded into a compacted file.
    pub(super) folded: usize,
    /// Node directories left raw because folding them would produce an object
    /// the reader refuses.
    pub(super) kept_raw: usize,
}

/// The local files of one fold. `Drop` removes whatever is still on disk on
/// every path — a failed fetch, a failed fold, a panicking decode task, a
/// failed upload — because each attempt uses fresh UUID paths, so leaked
/// spools or a partial output would accumulate on the work volume.
struct FoldWork {
    work: PathBuf,
    id: uuid::Uuid,
    spools: Vec<PathBuf>,
    out: PathBuf,
}

impl FoldWork {
    fn new(work: &Path) -> Self {
        let id = uuid::Uuid::new_v4();
        Self {
            work: work.to_path_buf(),
            id,
            spools: Vec::new(),
            out: work.join(format!("{id}-fold.parquet")),
        }
    }

    /// Reserve one spool path, owned by the guard from this instant (a failed
    /// write still has its partial file removed on drop).
    fn spool(&mut self, index: usize) -> PathBuf {
        let path = self.work.join(format!("{}-{index}.parquet", self.id));
        self.spools.push(path.clone());
        path
    }

    /// Remove the spools once the fold has read them; the output stays owned
    /// until the function returns.
    fn clear_spools(&mut self) {
        for path in self.spools.drain(..) {
            let _ = std::fs::remove_file(path);
        }
    }
}

impl Drop for FoldWork {
    fn drop(&mut self) {
        for path in self.spools.iter().chain(std::iter::once(&self.out)) {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Fold the union of `inputs` into `target`, proved with a HEAD before the
/// caller deletes anything. The old implementation was a DuckDB
/// `COPY (SELECT * FROM read_parquet([…], union_by_name=true) …)`; this is the
/// same operation on the Parquet writer, because the runner may not call
/// DuckDB anymore.
///
/// Every input column is preserved (union by name), so an hour that spans a
/// celld upgrade keeps both shapes. Row order inside the file is not
/// significant: every read filters on the event timestamp, never on position.
///
/// When `target` is itself one of the inputs (a re-fold of late arrivals), the
/// fold goes to a staging key first: writing the file it reads would corrupt
/// the hour. The staging key never ends in `.parquet`, so neither the ingest
/// listing nor another compact pass sees it mid-write; the final
/// `rm_dir_except` (keep `compacted.parquet`) removes it with the folded
/// sources.
///
/// A refused refold is the one residual: the existing `compacted.parquet` plus
/// more than ~96 MiB of late flushes would exceed [`MAX_REFOLD_INPUT_BYTES`],
/// so the hour is kept raw and the canonical rule (a directory with
/// `compacted.parquet` is read from that file alone) still shadows those late
/// sources. Reaching it needs a firehose hour plus a lost compaction pass, and
/// the alternative — publishing an object over the reader's cap — is worse;
/// the sources are never deleted, so a later fix can recover them.
async fn copy_union(
    cfg: &Config,
    dir: &str,
    target: &str,
    inputs: &[String],
) -> anyhow::Result<FoldOutcome> {
    let refold = inputs.iter().any(|k| k == target);
    let input_budget = if refold {
        MAX_REFOLD_INPUT_BYTES
    } else {
        MAX_FOLD_INPUT_BYTES
    };
    let dest = if refold {
        format!("{dir}compacted.staging-{}", uuid::Uuid::new_v4())
    } else {
        target.to_string()
    };
    let work = crate::host::exec::work_root(cfg).join("telemetry-compact");
    tokio::fs::create_dir_all(&work).await?;
    let mut guard = FoldWork::new(&work);
    let input_bytes = match spool_inputs(cfg, inputs, &mut guard, input_budget).await? {
        Spool::Ready { bytes } => bytes,
        Spool::TooLarge(bytes) => {
            tracing::warn!(
                dir = %dir,
                inputs = inputs.len(),
                bytes,
                cap = input_budget,
                "telemetry hour left raw: its inputs exceed the fold budget"
            );
            return Ok(FoldOutcome::KeptRaw);
        }
    };
    let folded = {
        let sources = guard.spools.clone();
        let out = guard.out.clone();
        tokio::task::spawn_blocking(move || fold_files(&sources, &out))
            .await
            .map_err(|e| anyhow::anyhow!("compaction fold task: {e}"))?
    };
    guard.clear_spools();
    folded?;
    // The reader refuses an object over `MAX_OBJECT_BYTES`; never publish one.
    // The check is on the real file, not the input sum: the union's nullable
    // levels and row-group layout can move the size either way.
    let output_bytes = tokio::fs::metadata(&guard.out)
        .await
        .map_err(|e| anyhow::anyhow!("folded object {}: {e}", guard.out.display()))?
        .len();
    if let Some(refusal) = fold_refusal(input_bytes, Some(output_bytes), input_budget) {
        tracing::warn!(
            dir = %dir,
            bytes = output_bytes,
            refusal = ?refusal,
            "telemetry hour left raw: the folded object would not be readable"
        );
        return Ok(FoldOutcome::KeptRaw);
    }
    s3::s3_cp_upload(cfg, &guard.out, &dest).await?;
    if !s3::s3_object_exists(cfg, &cfg.s3_bucket, &dest).await {
        anyhow::bail!("compacted object missing after copy: {dest}");
    }
    if refold {
        // Publish complete-over-complete: the staging object is whole (HEAD
        // proved), so promoting it keeps a compacted file in the hour at
        // every instant — a crash leaves the old target plus staging, which
        // the next pass re-folds instead of deleting.
        s3::s3_copy_key(cfg, &cfg.s3_bucket, &dest, target).await?;
        if !s3::s3_object_exists(cfg, &cfg.s3_bucket, target).await {
            anyhow::bail!("compacted object missing after promote: {target}");
        }
    }
    Ok(FoldOutcome::Folded)
}

/// The local copies one fold reads.
enum Spool {
    /// The inputs were spooled into the guard's paths.
    Ready { bytes: u64 },
    /// The inputs are past the fold budget (or one is past the reader's cap):
    /// folding cannot produce a readable object. The guard drops the spools.
    TooLarge(u64),
}

/// Download every input to a local file so each object is fetched once and the
/// output schema is known before the first row is written. The guard owns the
/// spool paths from the moment they are reserved, so an error, a refusal or a
/// missing object never leaves a partial spool behind. A missing object fails
/// the fold (the hour is retried, never marked compacted with data skipped);
/// an oversized input is not an error — the hour is kept raw so its sources
/// stay readable.
async fn spool_inputs(
    cfg: &Config,
    inputs: &[String],
    guard: &mut FoldWork,
    input_budget: u64,
) -> anyhow::Result<Spool> {
    let mut bytes = 0_u64;
    for (index, key) in inputs.iter().enumerate() {
        let path = guard.spool(index);
        let body = match parquet_io::fetch(cfg, key).await? {
            Fetched::Body(body) => body,
            Fetched::Missing => anyhow::bail!("compaction input vanished: {key}"),
            Fetched::TooLarge(size) => {
                tracing::warn!(
                    file = %key,
                    bytes = size,
                    cap = parquet_io::MAX_OBJECT_BYTES,
                    "compaction input over the decode cap; the hour stays raw"
                );
                return Ok(Spool::TooLarge(size));
            }
        };
        bytes += body.len() as u64;
        tokio::fs::write(&path, &body)
            .await
            .map_err(|e| anyhow::anyhow!("spool {key}: {e}"))?;
        if fold_refusal(bytes, None, input_budget).is_some() {
            return Ok(Spool::TooLarge(bytes));
        }
    }
    Ok(Spool::Ready { bytes })
}

/// One output column: its name and the physical kind every input agrees on.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ColumnKind {
    Bool,
    Int32,
    Int64,
    Str,
}

struct OutField {
    name: String,
    kind: ColumnKind,
    /// The unsigned annotation every input agrees on (`UTINYINT`,
    /// `USMALLINT`, …). celld's `kind` and `http_status` carry one, and the
    /// old DuckDB `COPY` preserved it, so a compacted file keeps the same
    /// column types. Dropped when the inputs disagree or an `INT32` widens to
    /// `INT64`.
    logical: Option<ConvertedType>,
}

/// One cell of a folded row.
#[derive(Debug, PartialEq, Eq)]
enum Cell {
    Null,
    Bool(bool),
    Int(i32),
    Long(i64),
    Str(String),
}

/// The union of every input's columns, in first-seen order. Types widen
/// (`INT32` + `INT64` → `INT64`); any other disagreement fails the fold
/// instead of guessing.
fn merge_schema(fields: &mut Vec<OutField>, root: &Type) -> anyhow::Result<()> {
    for field in root.get_fields() {
        if field.is_group() {
            anyhow::bail!(
                "telemetry column {} is nested; only flat columns are supported",
                field.name()
            );
        }
        let (kind, logical) = match field.get_physical_type() {
            PhysicalType::BOOLEAN => (ColumnKind::Bool, None),
            PhysicalType::INT32 => match field.get_basic_info().converted_type() {
                ConvertedType::UINT_8 => (ColumnKind::Int32, Some(ConvertedType::UINT_8)),
                ConvertedType::UINT_16 => (ColumnKind::Int32, Some(ConvertedType::UINT_16)),
                // A UINT_32 value does not fit INT32 (`cell_from` widens it
                // to i64), so the column folds as INT64 and the annotation —
                // an INT32 logical type — is dropped.
                ConvertedType::UINT_32 => (ColumnKind::Int64, None),
                _ => (ColumnKind::Int32, None),
            },
            PhysicalType::INT64 => match field.get_basic_info().converted_type() {
                ConvertedType::UINT_64 => (ColumnKind::Int64, Some(ConvertedType::UINT_64)),
                _ => (ColumnKind::Int64, None),
            },
            // The output always annotates text as UTF-8 (see `output_schema`).
            PhysicalType::BYTE_ARRAY => (ColumnKind::Str, None),
            other => anyhow::bail!(
                "telemetry column {} has unsupported physical type {other:?}",
                field.name()
            ),
        };
        match fields
            .iter_mut()
            .find(|existing| existing.name == field.name())
        {
            Some(existing) => match (existing.kind, kind) {
                (a, b) if a == b => {
                    // Same width: keep the annotation only while every input
                    // agrees on it. A mismatch widens to the plain signed
                    // type, which every reader projects by name.
                    if existing.logical != logical {
                        existing.logical = None;
                    }
                }
                (ColumnKind::Int32, ColumnKind::Int64) | (ColumnKind::Int64, ColumnKind::Int32) => {
                    existing.kind = ColumnKind::Int64;
                    existing.logical = None;
                }
                _ => anyhow::bail!(
                    "telemetry column {} has conflicting types across an hour",
                    field.name()
                ),
            },
            None => fields.push(OutField {
                name: field.name().to_string(),
                kind,
                logical,
            }),
        }
    }
    Ok(())
}

/// The output schema: every column optional, so a file that predates one keeps
/// folding and a reader can always project it by name.
fn output_schema(fields: &[OutField]) -> anyhow::Result<Type> {
    let mut children = Vec::with_capacity(fields.len());
    for field in fields {
        let builder = match field.kind {
            ColumnKind::Bool => Type::primitive_type_builder(&field.name, PhysicalType::BOOLEAN),
            ColumnKind::Int32 => {
                let builder = Type::primitive_type_builder(&field.name, PhysicalType::INT32);
                match field.logical {
                    Some(logical) => builder.with_converted_type(logical),
                    None => builder,
                }
            }
            ColumnKind::Int64 => {
                let builder = Type::primitive_type_builder(&field.name, PhysicalType::INT64);
                match field.logical {
                    Some(logical) => builder.with_converted_type(logical),
                    None => builder,
                }
            }
            ColumnKind::Str => Type::primitive_type_builder(&field.name, PhysicalType::BYTE_ARRAY)
                .with_converted_type(ConvertedType::UTF8),
        };
        children.push(Arc::new(
            builder.with_repetition(Repetition::OPTIONAL).build()?,
        ));
    }
    Ok(Type::group_type_builder("celld_telemetry")
        .with_fields(children)
        .build()?)
}

/// Read every spooled file and write the union to `out`, one row group per
/// [`FOLD_BATCH_ROWS`] rows.
fn fold_files(sources: &[PathBuf], out: &Path) -> anyhow::Result<()> {
    let mut fields: Vec<OutField> = Vec::new();
    let mut readers = Vec::with_capacity(sources.len());
    for path in sources {
        let reader = SerializedFileReader::new(
            File::open(path).map_err(|e| anyhow::anyhow!("open {}: {e}", path.display()))?,
        )
        .map_err(|e| anyhow::anyhow!("parquet open {}: {e}", path.display()))?;
        merge_schema(
            &mut fields,
            reader
                .metadata()
                .file_metadata()
                .schema_descr()
                .root_schema(),
        )?;
        readers.push(reader);
    }
    if fields.is_empty() {
        anyhow::bail!("compaction inputs have no columns");
    }
    let properties = Arc::new(
        WriterProperties::builder()
            .set_compression(Compression::ZSTD(ZstdLevel::default()))
            .build(),
    );
    let mut writer = SerializedFileWriter::new(
        BufWriter::new(
            File::create(out).map_err(|e| anyhow::anyhow!("create {}: {e}", out.display()))?,
        ),
        Arc::new(output_schema(&fields)?),
        properties,
    )?;
    let mut columns: Vec<Vec<Cell>> = fields
        .iter()
        .map(|_| Vec::with_capacity(FOLD_BATCH_ROWS))
        .collect();
    let mut buffered = 0_usize;
    for reader in &readers {
        for row in reader.get_row_iter(None)? {
            let row = row?;
            let cells: Vec<(&str, &Field)> = row
                .get_column_iter()
                .map(|(name, field)| (name.as_str(), field))
                .collect();
            for (index, field) in fields.iter().enumerate() {
                let cell = match cells.iter().find(|(name, _)| *name == field.name.as_str()) {
                    Some((_, value)) => cell_from(value)?,
                    None => Cell::Null,
                };
                columns[index].push(cell);
            }
            buffered += 1;
            if buffered >= FOLD_BATCH_ROWS {
                write_row_group(&mut writer, &fields, &mut columns)?;
                buffered = 0;
            }
        }
    }
    if buffered > 0 {
        write_row_group(&mut writer, &fields, &mut columns)?;
    }
    writer.close()?;
    Ok(())
}

fn cell_from(field: &Field) -> anyhow::Result<Cell> {
    Ok(match field {
        Field::Null => Cell::Null,
        Field::Bool(value) => Cell::Bool(*value),
        Field::Int(value) => Cell::Int(*value),
        Field::Short(value) => Cell::Int(i32::from(*value)),
        Field::Byte(value) => Cell::Int(i32::from(*value)),
        Field::Long(value) => Cell::Long(*value),
        // celld's `kind` and `http_status` are UTINYINT/USMALLINT: the
        // record API surfaces them as unsigned fields, and every real trace
        // object carries both. Without these arms an hour with one real
        // trace file could never fold.
        Field::UByte(value) => Cell::Int(i32::from(*value)),
        Field::UShort(value) => Cell::Int(i32::from(*value)),
        Field::UInt(value) => Cell::Long(i64::from(*value)),
        Field::ULong(value) => {
            Cell::Long(i64::try_from(*value).map_err(|_| {
                anyhow::anyhow!("telemetry integer column does not fit i64: {value}")
            })?)
        }
        Field::Str(value) => Cell::Str(value.clone()),
        Field::Bytes(value) => Cell::Str(
            std::str::from_utf8(value.data())
                .map_err(|e| anyhow::anyhow!("telemetry text column is not UTF-8: {e}"))?
                .to_string(),
        ),
        other => anyhow::bail!("unsupported telemetry cell type: {other:?}"),
    })
}

fn write_row_group<W: Write + Send>(
    writer: &mut SerializedFileWriter<W>,
    fields: &[OutField],
    columns: &mut [Vec<Cell>],
) -> anyhow::Result<()> {
    let mut group = writer.next_row_group()?;
    for (field, cells) in fields.iter().zip(columns.iter()) {
        write_column(&mut group, field, cells)?;
    }
    group.close()?;
    for cells in columns.iter_mut() {
        cells.clear();
    }
    Ok(())
}

fn write_column<W: Write + Send>(
    group: &mut SerializedRowGroupWriter<'_, W>,
    field: &OutField,
    cells: &[Cell],
) -> anyhow::Result<()> {
    let mut column = group
        .next_column()?
        .ok_or_else(|| anyhow::anyhow!("parquet writer ran out of columns"))?;
    match field.kind {
        ColumnKind::Bool => {
            let mut values = Vec::with_capacity(cells.len());
            let mut levels = Vec::with_capacity(cells.len());
            for cell in cells {
                match cell {
                    Cell::Null => levels.push(0),
                    Cell::Bool(value) => {
                        levels.push(1);
                        values.push(*value);
                    }
                    other => anyhow::bail!("column {}: expected bool, got {other:?}", field.name),
                }
            }
            column
                .typed::<BoolType>()
                .write_batch(&values, Some(&levels), None)?;
        }
        ColumnKind::Int32 => {
            let mut values = Vec::with_capacity(cells.len());
            let mut levels = Vec::with_capacity(cells.len());
            for cell in cells {
                match cell {
                    Cell::Null => levels.push(0),
                    Cell::Int(value) => {
                        levels.push(1);
                        values.push(*value);
                    }
                    other => anyhow::bail!("column {}: expected int32, got {other:?}", field.name),
                }
            }
            column
                .typed::<Int32Type>()
                .write_batch(&values, Some(&levels), None)?;
        }
        ColumnKind::Int64 => {
            let mut values = Vec::with_capacity(cells.len());
            let mut levels = Vec::with_capacity(cells.len());
            for cell in cells {
                match cell {
                    Cell::Null => levels.push(0),
                    Cell::Long(value) => {
                        levels.push(1);
                        values.push(*value);
                    }
                    Cell::Int(value) => {
                        levels.push(1);
                        values.push(i64::from(*value));
                    }
                    other => anyhow::bail!("column {}: expected int64, got {other:?}", field.name),
                }
            }
            column
                .typed::<Int64Type>()
                .write_batch(&values, Some(&levels), None)?;
        }
        ColumnKind::Str => {
            let mut values = Vec::with_capacity(cells.len());
            let mut levels = Vec::with_capacity(cells.len());
            for cell in cells {
                match cell {
                    Cell::Null => levels.push(0),
                    Cell::Str(value) => {
                        levels.push(1);
                        values.push(ByteArray::from(value.as_bytes().to_vec()));
                    }
                    other => anyhow::bail!("column {}: expected text, got {other:?}", field.name),
                }
            }
            column
                .typed::<ByteArrayType>()
                .write_batch(&values, Some(&levels), None)?;
        }
    }
    column.close()?;
    Ok(())
}

/// One completed hour's durable compaction state. The unit of progress is the
/// hour, not a per-fleet high-water mark: a failed hour can never be skipped,
/// because only *that hour* is marked when its fold succeeds.
///
/// stateDiagram-v2
///   [*] --> Pending
///   Pending --> Compacted: fold ok
///   Pending --> Failed: fold error
///   Pending --> KeptRaw: fold would not be readable
///   Failed --> Pending: retry window elapsed
///   Failed --> Compacted: fold ok on retry
///
/// `KeptRaw` is terminal: the hour's inputs exceed the fold budget (or a
/// single input exceeds the reader's cap), so a retry cannot succeed. Its
/// sources stay in the bucket and the reader still reads them; the hour is
/// skipped like a compacted one, so it can never wedge the hours behind it.
#[derive(Debug, Clone, Default)]
pub(super) struct CompactionState {
    hours: HashMap<String, HourState>,
    /// The newest hour of the contiguous finished run (compacted or kept
    /// raw). Compaction schedules from `done + 1` and stops at the first hour
    /// that is not ready, so a failure can never be jumped over.
    done: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum HourState {
    Compacted,
    /// The fold failed; retried once this instant has passed. An hour in this
    /// state is never treated as done.
    Failed {
        retry_at: std::time::Instant,
    },
    /// The hour cannot be folded into an object the reader accepts; its
    /// sources stay readable and it is never retried.
    KeptRaw,
}

/// How long a failed hour waits before the next attempt. Same shape as the
/// ingest backoff: long enough that a broken bucket does not burn every pass,
/// short enough that a transient S3 error heals within minutes.
const COMPACTION_RETRY_BACKOFF: std::time::Duration = std::time::Duration::from_secs(120);

impl CompactionState {
    /// Restore the durable per-hour marks loaded at boot.
    pub(super) fn restored(hours: impl IntoIterator<Item = String>) -> Self {
        let hours: HashMap<String, HourState> = hours
            .into_iter()
            .map(|hour| (hour, HourState::Compacted))
            .collect();
        let done = hours.keys().max().cloned();
        Self { hours, done }
    }

    fn next_after(done: &str) -> Option<String> {
        chrono::NaiveDateTime::parse_from_str(&format!("{done}:00:00"), "%Y/%m/%d/%H:%M:%S")
            .ok()
            .and_then(|at| at.checked_add_signed(chrono::Duration::hours(1)))
            .map(|at| at.format("%Y/%m/%d/%H").to_string())
    }

    fn is_due(&self, hour: &str, now: std::time::Instant) -> bool {
        match self.hours.get(hour) {
            None => true,
            Some(HourState::Compacted | HourState::KeptRaw) => false,
            Some(HourState::Failed { retry_at }) => retry_at <= &now,
        }
    }

    /// Transition `Pending -> Compacted`. The cursor advances only when the
    /// folded hour is exactly the next one, so a write can never skip an
    /// earlier hour.
    fn folded(&mut self, hour: &str) {
        self.hours.insert(hour.to_string(), HourState::Compacted);
        self.advance_from(hour);
    }

    /// Transition `Pending -> KeptRaw`. Terminal: the hour needs no further
    /// work and must not hold up the hours behind it.
    fn kept_raw(&mut self, hour: &str) {
        self.hours.insert(hour.to_string(), HourState::KeptRaw);
        self.advance_from(hour);
    }

    /// Move the contiguous `done` cursor over `hour` and over any following
    /// hours that are already finished (compacted or kept raw), so a kept-raw
    /// hour never re-opens the scheduling walk for the rest of the run.
    fn advance_from(&mut self, hour: &str) {
        let earlier = self.hours.keys().any(|h| h.as_str() < hour);
        let advances = match &self.done {
            Some(done) => Self::next_after(done).as_deref() == Some(hour),
            // A first fold only opens the cursor when nothing earlier is
            // still tracked (a failed earlier hour must stay ahead of it).
            None => !earlier,
        };
        if advances {
            self.done = Some(hour.to_string());
        }
        while let Some(done) = self.done.clone() {
            let Some(next) = Self::next_after(&done) else {
                break;
            };
            if matches!(
                self.hours.get(&next),
                Some(HourState::Compacted | HourState::KeptRaw)
            ) {
                self.done = Some(next);
            } else {
                break;
            }
        }
    }

    /// Transition `Pending -> Failed`. A failed hour is retried after
    /// [`COMPACTION_RETRY_BACKOFF`]; it never becomes `Compacted`.
    fn failed(&mut self, hour: &str, now: std::time::Instant) {
        self.hours.insert(
            hour.to_string(),
            HourState::Failed {
                retry_at: now + COMPACTION_RETRY_BACKOFF,
            },
        );
    }

    /// Drop marks older than the retention window (they can never be due).
    fn prune_before(&mut self, hour: &str) {
        self.hours.retain(|h, _| h.as_str() >= hour);
        if self.done.as_deref().is_some_and(|done| done < hour) {
            self.done = Some(hour.to_string());
        }
    }
}

/// Completed hours that still need a fold, oldest first. Scheduling starts
/// after the contiguous `done` cursor (or the last 25 hours on a fresh fleet)
/// and stops at the first non-ready hour: a failed hour blocks the hours
/// behind it until its retry, so the cursor can never skip it. A kept-raw
/// hour is finished work, not a failure, so it never blocks the walk. Bounded
/// so one pass cannot name the whole retention; unparseable input compacts
/// nothing.
pub(super) fn uncompacted_hours(
    state: &CompactionState,
    current: &str,
    cfg: &Config,
) -> Vec<String> {
    let parse = |h: &str| {
        chrono::NaiveDateTime::parse_from_str(&format!("{h}:00:00"), "%Y/%m/%d/%H:%M:%S").ok()
    };
    let Some(current_dt) = parse(current) else {
        return Vec::new();
    };
    let floor =
        chrono::Utc::now().naive_utc() - chrono::Duration::days(cfg.telemetry_retention_days);
    let mut start = match state.done.as_deref().and_then(parse) {
        Some(done) => done + chrono::Duration::hours(1),
        // No mark: only the recent past, not the whole retention.
        None => current_dt - chrono::Duration::hours(25),
    };
    if start < floor {
        start = floor;
    }
    let now = std::time::Instant::now();
    let mut hours = Vec::new();
    while start < current_dt && hours.len() < 48 {
        let hour = start.format("%Y/%m/%d/%H").to_string();
        if matches!(
            state.hours.get(&hour),
            Some(HourState::Compacted | HourState::KeptRaw)
        ) {
            // Finished work (a compacted or kept-raw hour, the latter only
            // possible below the cursor).
        } else if state.is_due(&hour, now) {
            hours.push(hour);
        } else {
            // A failed hour is backing off: later hours wait their turn.
            break;
        }
        let Some(next) = start.checked_add_signed(chrono::Duration::hours(1)) else {
            break;
        };
        start = next;
    }
    hours
}

/// Transition `Pending -> Failed` for one hour: it is retried after the
/// backoff and, crucially, is not marked compacted.
pub(super) fn mark_failed(state: &mut MetricsState, slug: &str, hour: &str) {
    state
        .compacted
        .entry(slug.to_string())
        .or_default()
        .failed(hour, std::time::Instant::now());
}

/// Transition `Pending -> KeptRaw` for one hour: the fold cannot produce a
/// readable object, the sources stay in the bucket, and later hours must not
/// wait behind it.
pub(super) fn mark_kept_raw(state: &mut MetricsState, slug: &str, hour: &str) {
    state
        .compacted
        .entry(slug.to_string())
        .or_default()
        .kept_raw(hour);
}

/// Drop in-memory marks that fell out of the retention window.
pub(super) fn prune_marks(state: &mut MetricsState, oldest_hour: &str) {
    for fleet in state.compacted.values_mut() {
        fleet.prune_before(oldest_hour);
    }
}

pub(super) async fn mark_compacted(
    pool: &SqlitePool,
    state: &mut MetricsState,
    slug: &str,
    hour: &str,
) {
    if let Err(e) = db::mark_hour_compacted(pool, slug, hour).await {
        tracing::warn!(error = %e, "compaction mark");
        return;
    }
    state
        .compacted
        .entry(slug.to_string())
        .or_default()
        .folded(hour);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uncompacted_hours_never_names_the_running_hour() {
        let _env = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let cfg = crate::config::Config::from_env().expect("config");
        // Hours relative to now: the retention floor (`Utc::now() - retention`)
        // moves with the wall clock, so fixed dates rot — the hardcoded
        // 2026/09/29 started failing exactly 30 days later (2026-10-29).
        let now = chrono::Utc::now().naive_utc();
        let hour = |dt: chrono::NaiveDateTime| dt.format("%Y/%m/%d/%H").to_string();
        let current = hour(now);
        let done = hour(now - chrono::Duration::hours(2));
        let mut state = CompactionState::default();
        state.folded(&done);
        // Compacted two hours back → only the previous hour is pending; a
        // marked hour is never named again.
        assert_eq!(
            uncompacted_hours(&state, &current, &cfg),
            vec![hour(now - chrono::Duration::hours(1))]
        );
        state.folded(&hour(now - chrono::Duration::hours(1)));
        assert!(uncompacted_hours(&state, &current, &cfg).is_empty());
        // Garbage input compacts nothing.
        assert!(uncompacted_hours(&state, "not-an-hour", &cfg).is_empty());
    }

    /// P1: a failed hour must never be skipped because a later hour folded.
    /// The old per-fleet watermark advanced past the failure, so `h` was
    /// never revisited. Per-hour state keeps `h` due and only marks `h + 1`.
    #[test]
    fn a_failed_hour_stays_due_when_a_later_hour_folds() {
        let _env = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let cfg = crate::config::Config::from_env().expect("config");
        let now = chrono::Utc::now().naive_utc();
        let hour = |dt: chrono::NaiveDateTime| dt.format("%Y/%m/%d/%H").to_string();
        let current = hour(now);
        let failed = hour(now - chrono::Duration::hours(2));
        let later = hour(now - chrono::Duration::hours(1));
        let mut state = CompactionState::default();
        state.failed(&failed, std::time::Instant::now());
        state.folded(&later);
        // The failed hour is retried once its backoff elapses; the folded
        // hour is never named.
        let pending = uncompacted_hours(&state, &current, &cfg);
        assert!(!pending.contains(&later), "{pending:?}");
        // Backoff elapses (injected by rebuilding the failure with a past
        // retry instant through the same transition).
        state.hours.insert(
            failed.clone(),
            HourState::Failed {
                retry_at: std::time::Instant::now(),
            },
        );
        assert!(uncompacted_hours(&state, &current, &cfg).contains(&failed));
    }

    /// Folding an hour only marks that hour: an older failed hour is still
    /// pending, and a gap below the newest mark is revisited.
    #[test]
    fn folding_never_advances_a_watermark_past_a_gap() {
        let _env = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let cfg = crate::config::Config::from_env().expect("config");
        let now = chrono::Utc::now().naive_utc();
        let hour = |dt: chrono::NaiveDateTime| dt.format("%Y/%m/%d/%H").to_string();
        let current = hour(now);
        let gap = hour(now - chrono::Duration::hours(3));
        let older = hour(now - chrono::Duration::hours(4));
        let mut state = CompactionState::default();
        state.folded(&older);
        state.folded(&hour(now - chrono::Duration::hours(2)));
        state.folded(&hour(now - chrono::Duration::hours(1)));
        let pending = uncompacted_hours(&state, &current, &cfg);
        assert!(
            pending.contains(&gap),
            "the hole below the newest mark is due"
        );
        assert!(
            !pending.contains(&hour(now - chrono::Duration::hours(1))),
            "a compacted hour is never scheduled again"
        );
    }

    #[test]
    fn compaction_plan_prefers_the_compacted_file() {
        let dir = "fleets/blog/telemetry/traces/node/2026/01/01/00/";
        let target = format!("{dir}compacted.parquet");
        let src = |n: &str| format!("{dir}{n}.parquet");
        // Nothing compacted yet: every file is a source.
        let (has, sources) = compaction_plan(&[src("a"), src("b")], &target);
        assert!(!has);
        assert_eq!(sources.len(), 2);
        // A finished compaction leaves exactly the compacted file.
        let (has, sources) = compaction_plan(std::slice::from_ref(&target), &target);
        assert!(has);
        assert!(sources.is_empty());
        // A flush that landed after (or during) the last compaction leaves
        // both: the extras are late arrivals, folded back in — never deleted
        // unread.
        let (has, sources) = compaction_plan(&[target.clone(), src("a")], &target);
        assert!(has);
        assert_eq!(sources, vec![src("a")]);
    }

    /// Late sources are re-folded, never dropped: a pass over
    /// `[compacted, late]` must COPY both into the target. The old code
    /// deleted `late` here, so spans flushed mid-pass were destroyed unread —
    /// this test fails on that behavior (no inputs to copy).
    #[test]
    fn late_sources_are_refolded_not_deleted() {
        let dir = "fleets/blog/telemetry/traces/node/2026/01/01/00/";
        let target = format!("{dir}compacted.parquet");
        let src = |n: &str| format!("{dir}{n}.parquet");
        // A flush landing between COPY and delete, or after a completed
        // compaction: the target leads the COPY inputs, the late source
        // follows — every byte stays in the hour.
        let inputs = compaction_inputs(&[target.clone(), src("late")], &target)
            .expect("late source must be folded");
        assert_eq!(inputs, vec![target.clone(), src("late")]);
        // Stable hour: nothing to do.
        assert!(compaction_inputs(std::slice::from_ref(&target), &target).is_none());
        // One source is already one file: nothing to do.
        assert!(compaction_inputs(std::slice::from_ref(&src("only")), &target).is_none());
        // Fresh hour: every source is folded.
        let inputs = compaction_inputs(&[src("a"), src("b")], &target).expect("fresh fold");
        assert_eq!(inputs, vec![src("a"), src("b")]);
    }

    /// Write one test input with the same writer primitives the fold uses:
    /// a schema of `fields` and `rows` cells. Returns after `close`.
    fn write_input(path: &Path, fields: &[OutField], rows: Vec<Vec<Cell>>) {
        let properties = Arc::new(WriterProperties::builder().build());
        let mut writer = SerializedFileWriter::new(
            BufWriter::new(File::create(path).expect("test input")),
            Arc::new(output_schema(fields).expect("schema")),
            properties,
        )
        .expect("writer");
        let mut columns: Vec<Vec<Cell>> = fields.iter().map(|_| Vec::new()).collect();
        for row in rows {
            for (column, cell) in columns.iter_mut().zip(row) {
                column.push(cell);
            }
        }
        write_row_group(&mut writer, fields, &mut columns).expect("row group");
        writer.close().expect("close");
    }

    fn read_cells(path: &Path) -> Vec<Vec<String>> {
        let reader = SerializedFileReader::new(File::open(path).expect("open")).expect("read");
        reader
            .get_row_iter(None)
            .expect("rows")
            .map(|row| {
                row.expect("row")
                    .get_column_iter()
                    .map(|(name, field)| match field {
                        Field::Null => format!("{name}=null"),
                        Field::Str(value) => format!("{name}={value}"),
                        Field::Long(value) => format!("{name}={value}"),
                        Field::Int(value) => format!("{name}={value}"),
                        Field::Bool(value) => format!("{name}={value}"),
                        other => format!("{name}={other:?}"),
                    })
                    .collect()
            })
            .collect()
    }

    /// The fold is a union by name: a column only one input carries is kept
    /// (null in the rows that lack it), a wider integer widens, and the row
    /// order of every input survives. This is the `union_by_name=true` the
    /// old DuckDB `COPY` relied on.
    #[test]
    fn fold_keeps_every_input_column_and_row() {
        let guard = crate::testutil::TempDir::new("noite-compact-fold");
        let old = guard.path().join("old.parquet");
        let new = guard.path().join("new.parquet");
        let out = guard.path().join("folded.parquet");
        write_input(
            &old,
            &[
                OutField {
                    name: "name".to_string(),
                    kind: ColumnKind::Str,
                    logical: None,
                },
                OutField {
                    name: "start".to_string(),
                    kind: ColumnKind::Int32,
                    logical: None,
                },
            ],
            vec![
                vec![Cell::Str("a".to_string()), Cell::Int(1)],
                vec![Cell::Str("b".to_string()), Cell::Int(2)],
            ],
        );
        write_input(
            &new,
            &[
                OutField {
                    name: "name".to_string(),
                    kind: ColumnKind::Str,
                    logical: None,
                },
                OutField {
                    name: "start".to_string(),
                    kind: ColumnKind::Int64,
                    logical: None,
                },
                OutField {
                    name: "cell".to_string(),
                    kind: ColumnKind::Str,
                    logical: None,
                },
            ],
            vec![
                vec![
                    Cell::Str("c".to_string()),
                    Cell::Long(3),
                    Cell::Str("node-1".to_string()),
                ],
                vec![Cell::Str("d".to_string()), Cell::Long(4), Cell::Null],
            ],
        );
        fold_files(&[old, new], &out).expect("fold");
        let rows = read_cells(&out);
        assert_eq!(
            rows,
            vec![
                vec![
                    "name=a".to_string(),
                    "start=1".to_string(),
                    "cell=null".to_string()
                ],
                vec![
                    "name=b".to_string(),
                    "start=2".to_string(),
                    "cell=null".to_string()
                ],
                vec![
                    "name=c".to_string(),
                    "start=3".to_string(),
                    "cell=node-1".to_string()
                ],
                vec![
                    "name=d".to_string(),
                    "start=4".to_string(),
                    "cell=null".to_string()
                ],
            ]
        );
    }

    #[test]
    fn a_conflicting_column_type_fails_the_fold_instead_of_guessing() {
        let mut fields = vec![OutField {
            name: "ok".to_string(),
            kind: ColumnKind::Bool,
            logical: None,
        }];
        let schema = Type::group_type_builder("x")
            .with_fields(vec![Arc::new(
                Type::primitive_type_builder("ok", PhysicalType::BYTE_ARRAY)
                    .with_repetition(Repetition::OPTIONAL)
                    .build()
                    .expect("field"),
            )])
            .build()
            .expect("schema");
        let error = merge_schema(&mut fields, &schema).expect_err("conflict must fail");
        assert!(error.to_string().contains("conflicting types"), "{error}");
        // INT32/INT64 widen instead.
        let mut fields = vec![OutField {
            name: "ok".to_string(),
            kind: ColumnKind::Int32,
            logical: None,
        }];
        let wider = Type::group_type_builder("x")
            .with_fields(vec![Arc::new(
                Type::primitive_type_builder("ok", PhysicalType::INT64)
                    .with_repetition(Repetition::OPTIONAL)
                    .build()
                    .expect("field"),
            )])
            .build()
            .expect("schema");
        merge_schema(&mut fields, &wider).expect("widen");
        assert_eq!(fields[0].name, "ok");
    }

    /// Regenerate the `folded` differential fixture consumed by
    /// `otel::tests::real_celld_fixtures_match_the_duckdb_rows`: the union of
    /// the two committed real celld objects per signal, written by
    /// `fold_files`. The expected rows beside it come from the old DuckDB
    /// tag-3/tag-4 query over exactly this output (see the fixture's
    /// `expected.json`). Run:
    /// `cargo test --locked write_folded_fixture -- --ignored`.
    #[test]
    #[ignore = "regenerates the committed folded differential fixture"]
    fn write_folded_fixture() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/otel");
        for (kind, inputs) in [
            (
                "logs",
                vec![
                    root.join("prod/logs/1794577873709403-6f71c41f.parquet"),
                    root.join("env/logs/1794577876549734-73049318.parquet"),
                ],
            ),
            (
                "traces",
                vec![
                    root.join("prod/traces/1794577873683359-c06bd8cf.parquet"),
                    root.join("env/traces/1794577876522388-4fc8076d.parquet"),
                ],
            ),
        ] {
            let dir = root.join("folded").join(kind);
            std::fs::create_dir_all(&dir).expect("fixture dir");
            fold_files(&inputs, &dir.join("compacted.parquet")).expect("fold fixture");
        }
    }

    /// celld writes `kind` as UTINYINT and `http_status` as USMALLINT; the
    /// record API hands those back as `UByte`/`UShort`, which a fold must
    /// accept. Before these arms every real trace hour failed with
    /// "unsupported telemetry cell type: UByte(1)" and was retried forever,
    /// so no trace hour could ever be compacted.
    #[test]
    fn folding_real_celld_traces_accepts_the_unsigned_columns() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/otel");
        let inputs = vec![
            root.join("prod/traces/1794577873683359-c06bd8cf.parquet"),
            root.join("env/traces/1794577876522388-4fc8076d.parquet"),
        ];
        let guard = crate::testutil::TempDir::new("noite-fold-unsigned");
        let out = guard.path().join("folded.parquet");
        fold_files(&inputs, &out).expect("fold two real celld trace objects");
        let reader = SerializedFileReader::new(File::open(&out).expect("open folded"))
            .expect("parsed folded");
        // The unsigned annotations survive: celld's `kind` stays UTINYINT and
        // `http_status` stays USMALLINT, so the compacted file's types match
        // its inputs (as DuckDB's `COPY` did).
        let schema = reader.metadata().file_metadata().schema_descr();
        let converted = |name: &str| {
            schema
                .root_schema()
                .get_fields()
                .iter()
                .find(|field| field.name() == name)
                .map(|field| field.get_basic_info().converted_type())
        };
        assert_eq!(converted("kind"), Some(ConvertedType::UINT_8));
        assert_eq!(converted("http_status"), Some(ConvertedType::UINT_16));
        let rows: Vec<_> = reader
            .get_row_iter(None)
            .expect("rows")
            .collect::<Result<_, _>>()
            .expect("decoded rows");
        assert_eq!(rows.len(), 9, "4 + 5 rows survive the union");
        // And the record API hands the values back with those shapes.
        assert!(rows.iter().all(|row| {
            row.get_column_iter()
                .any(|(name, field)| name == "kind" && matches!(field, Field::UByte(_)))
        }));
    }

    /// Every unsigned width celld (or a foreign writer) can produce folds into
    /// the signed cell the writer stores; a `ULong` past `i64::MAX` fails
    /// instead of silently wrapping.
    #[test]
    fn cell_from_accepts_every_unsigned_width() {
        assert_eq!(cell_from(&Field::UByte(255)).expect("u8"), Cell::Int(255));
        assert_eq!(
            cell_from(&Field::UShort(65_535)).expect("u16"),
            Cell::Int(65_535)
        );
        assert_eq!(
            cell_from(&Field::UInt(u32::MAX)).expect("u32"),
            Cell::Long(i64::from(u32::MAX))
        );
        assert_eq!(
            cell_from(&Field::ULong(i64::MAX as u64)).expect("u64"),
            Cell::Long(i64::MAX)
        );
        assert!(cell_from(&Field::ULong(u64::MAX)).is_err());
    }

    /// A fold that cannot produce an object the reader accepts is refused
    /// before anything is published: the inputs budget keeps the output under
    /// the reader's cap, and the output check catches a fold that still grows
    /// past it.
    #[test]
    fn a_fold_that_would_produce_an_unreadable_object_is_refused() {
        assert_eq!(
            fold_refusal(MAX_FOLD_INPUT_BYTES, None, MAX_FOLD_INPUT_BYTES),
            None
        );
        assert_eq!(
            fold_refusal(MAX_FOLD_INPUT_BYTES + 1, None, MAX_FOLD_INPUT_BYTES),
            Some(FoldRefusal::InputsTooLarge(MAX_FOLD_INPUT_BYTES + 1))
        );
        // An output over the reader's cap is refused even when the inputs fit,
        // so compaction can never publish an object the ingest skips.
        assert_eq!(
            fold_refusal(
                1024,
                Some(parquet_io::MAX_OBJECT_BYTES as u64 + 1),
                MAX_FOLD_INPUT_BYTES
            ),
            Some(FoldRefusal::OutputTooLarge(
                parquet_io::MAX_OBJECT_BYTES as u64 + 1
            ))
        );
        assert_eq!(
            fold_refusal(
                1024,
                Some(parquet_io::MAX_OBJECT_BYTES as u64),
                MAX_FOLD_INPUT_BYTES
            ),
            None
        );
        // The fresh-fold budget leaves headroom under the reader cap, while a
        // refold may use the whole cap for its inputs (the existing compacted
        // file plus a late flush) and still has to pass the output check.
        assert!(MAX_FOLD_INPUT_BYTES < parquet_io::MAX_OBJECT_BYTES as u64);
        assert_eq!(MAX_REFOLD_INPUT_BYTES, parquet_io::MAX_OBJECT_BYTES as u64);
        assert_eq!(
            fold_refusal(MAX_REFOLD_INPUT_BYTES, None, MAX_REFOLD_INPUT_BYTES),
            None
        );
        assert_eq!(
            fold_refusal(MAX_REFOLD_INPUT_BYTES + 1, None, MAX_REFOLD_INPUT_BYTES),
            Some(FoldRefusal::InputsTooLarge(MAX_REFOLD_INPUT_BYTES + 1))
        );
    }

    /// A kept-raw hour is finished work: it is never scheduled again and it
    /// never blocks the hours behind it (the old failed-hour rule would have
    /// wedged that fleet's compaction until retention).
    #[test]
    fn a_kept_raw_hour_never_blocks_the_hours_after_it() {
        let _env = crate::config::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let cfg = crate::config::Config::from_env().expect("config");
        let now = chrono::Utc::now().naive_utc();
        let hour = |dt: chrono::NaiveDateTime| dt.format("%Y/%m/%d/%H").to_string();
        let current = hour(now);
        let older = hour(now - chrono::Duration::hours(3));
        let raw = hour(now - chrono::Duration::hours(2));
        let newer = hour(now - chrono::Duration::hours(1));
        let mut state = CompactionState::default();
        state.folded(&older);
        state.kept_raw(&raw);
        // The raw hour is not named again, and the walk continues to the next
        // hour instead of breaking on it.
        assert_eq!(
            uncompacted_hours(&state, &current, &cfg),
            vec![newer.clone()]
        );
        // The cursor moved past it, so the run stays contiguous: folding the
        // next hour does not leave a walk from the raw hour on every pass.
        state.folded(&newer);
        assert!(uncompacted_hours(&state, &current, &cfg).is_empty());
        assert_eq!(state.done.as_deref(), Some(newer.as_str()));
    }

    /// A UINT_32 column (a foreign or future writer; celld writes only
    /// UTINYINT/USMALLINT) must fold: its values do not fit INT32, so the
    /// column widens to INT64 and the INT32 logical annotation is dropped.
    /// Before this the schema said INT32 while `cell_from` produced a `Long`,
    /// and every such fold failed with "expected int32, got Long".
    #[test]
    fn a_uint32_column_folds_as_int64() {
        let guard = crate::testutil::TempDir::new("noite-fold-uint32");
        let input = guard.path().join("in.parquet");
        let out = guard.path().join("out.parquet");
        write_input(
            &input,
            &[OutField {
                name: "requests".to_string(),
                kind: ColumnKind::Int32,
                logical: Some(ConvertedType::UINT_32),
            }],
            vec![vec![Cell::Int(4_000_000_000_u32 as i32)]],
        );
        fold_files(std::slice::from_ref(&input), &out).expect("a UINT_32 column must fold");
        let reader =
            SerializedFileReader::new(File::open(&out).expect("open folded")).expect("parsed");
        let field = reader
            .metadata()
            .file_metadata()
            .schema_descr()
            .root_schema()
            .get_fields()
            .iter()
            .find(|field| field.name() == "requests")
            .expect("column");
        assert_eq!(field.get_physical_type(), PhysicalType::INT64);
        assert_eq!(field.get_basic_info().converted_type(), ConvertedType::NONE);
        let rows: Vec<_> = reader
            .get_row_iter(None)
            .expect("rows")
            .collect::<Result<_, _>>()
            .expect("decoded rows");
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].get_column_iter().next().map(|(_, value)| value),
            Some(&Field::Long(4_000_000_000))
        );
    }

    /// Every path through a fold removes its local files: the guard owns the
    /// spools from the moment they are reserved and the output for the whole
    /// call, so a failed fold, a panicking task or a failed upload cannot leak
    /// UUID-named files onto the work volume.
    #[test]
    fn a_failed_fold_leaves_no_local_files_behind() {
        let dir = crate::testutil::TempDir::new("noite-fold-cleanup");
        let work = dir.path().join("telemetry-compact");
        std::fs::create_dir_all(&work).expect("work dir");
        let bad = dir.path().join("bad.parquet");
        std::fs::write(&bad, b"not parquet").expect("bad source");
        let mut guard = FoldWork::new(&work);
        // A fetched spool and a partial output a failed fold left behind.
        let spool = guard.spool(0);
        std::fs::write(&spool, b"spool").expect("spool");
        std::fs::write(&guard.out, b"partial").expect("partial output");
        assert!(fold_files(std::slice::from_ref(&bad), &guard.out).is_err());
        drop(guard);
        assert_eq!(
            std::fs::read_dir(&work).expect("read work").count(),
            0,
            "the spool and the partial output are gone"
        );
        // The guard owns only the fold's files: an unrelated file survives.
        std::fs::write(work.join("unrelated"), b"keep").expect("unrelated");
        drop(FoldWork::new(&work));
        assert!(work.join("unrelated").exists());
    }
}
