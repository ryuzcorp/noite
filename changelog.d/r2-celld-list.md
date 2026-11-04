### Changed

- The R2 storage browser lists, previews and downloads through the `celld r2` CLI (`list --delimiter / --page`, `head`, `get`) instead of walking the bucket over S3 with its own copy of celld's key codec. Folders, paging and prefix navigation behave as before; the codec, the direct-S3 listing and its per-file HEAD fan-out are deleted.
