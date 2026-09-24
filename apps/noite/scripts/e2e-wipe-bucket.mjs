#!/usr/bin/env bun
/** Empty one fleet bucket prefix (e2e lane freshness). No-op when the
 * bucket does not exist yet. Runs from apps/noite so the workspace S3
 * client dependency resolves. */
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";

const bucket = process.env.E2E_WIPE_BUCKET ?? "noite-e2e";
// Refuse anything that doesn't look like a lane bucket: wiping `noite`
// would destroy dev data. The lane always passes its own -e2e bucket.
if (!bucket.endsWith("-e2e")) {
  throw new Error(`refusing to wipe non-lane bucket ${bucket}`);
}
const endpoint = process.env.E2E_S3_ENDPOINT ?? "http://127.0.0.1:9000";
const s3 = new S3Client({
  credentials: {
    accessKeyId: process.env.RUSTFS_ACCESS_KEY ?? "noiteaccess",
    secretAccessKey:
      process.env.RUSTFS_SECRET_KEY ?? "noitesecretnoitesecretnoite12",
  },
  endpoint,
  forcePathStyle: true,
  region: process.env.AWS_REGION ?? "us-east-1",
});

let continuation;
for (;;) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- cursor pagination is sequential by construction
  const listed = await s3
    .send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuation,
        MaxKeys: 1000,
      })
    )
    .catch((error) => {
      if (error?.name === "NoSuchBucket") {
        return null;
      }
      throw error;
    });
  if (!listed) {
    console.log(`bucket ${bucket} missing — nothing to wipe`);
    break;
  }
  const objects = listed.Contents ?? [];
  if (objects.length > 0) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- one delete per listed page; pages stream
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: objects.map((o) => ({ Key: o.Key })) },
      })
    );
    console.log(`deleted ${objects.length} keys from s3://${bucket}`);
  }
  if (!listed.IsTruncated) {
    break;
  }
  continuation = listed.NextContinuationToken;
}
