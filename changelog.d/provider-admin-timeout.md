### Fixed

- MinIO/RustFS admin and AWS IAM calls now time out after 10 s instead of hanging forever. A hung admin call stalled key mint/revoke and the orphan-key sweep, and (before the delete fix) could hold a deleted app's slug. A timeout during the MinIO `auto` probe is now a detection failure that fails the boot, instead of being read as "no admin API" and silently downgrading the install to root keys; a stalled IAM response body is now an error instead of an empty string that parsed as a successful empty listing and hid orphaned keys.

### Operator action required

- None.
