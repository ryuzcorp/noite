### Operator action required

- A wrong S3 bucket name (or endpoint path) now refuses the boot loudly instead of starting with an empty database. If the runner logs `runner state restore failed for bucket <name>` (or the meta-download equivalent naming your bucket), fix `NOITE_S3_BUCKET`/`S3_ENDPOINT` (or the provider-side path) and restart — do not let it boot past the error, and if it already did once on this build, restore the snapshot from bucket versioning before writing new data.

### Fixed

- A misconfigured object-store boot no longer starts with an empty database that the next upload writes over the good snapshot. "Missing object" is now a typed marker attached only when the store answers 404 / `NoSuchKey` for the key itself; a `NoSuchBucket` answer (wrong bucket, often HTTP 404) is a hard configuration error that fails `restore_if_missing` and state `claim` with the bucket named, and the git WAL maps it to a failed read instead of a missing manifest. Key names or messages containing `404`/`NotFound`/`NoSuchKey` on 5xx or transport failures never count as missing.
