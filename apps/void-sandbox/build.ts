/**
 * Image-build bundler for the sandbox controller (`bun ./build.ts`).
 *
 * Compiles `worker.ts` plus `src/` into the fixed single-file `dist/worker.js`
 * and records `dist/meta.json` (`void` version, controller protocol, bundle
 * sha256). The `void/_sandbox-container` and `@cloudflare/sandbox` npm
 * modules are bundled in; `cloudflare:*` and `node:*` imports stay external
 * for the deploy bundler and the runtime to provide (the rendered controller
 * config needs the `nodejs_compat` flag — see SPEC.md "Void sandbox
 * controller"). The build reads only the package's own lockfile, so the same
 * tree always produces the same bytes.
 *
 * Build-time only: never imported by the worker, never shipped.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CONTROLLER_PROTOCOL, VOID_VERSION } from "./src/meta.ts";

export interface ControllerBundle {
  readonly source: string;
  readonly sha256: string;
}

export interface BundleMeta {
  readonly bundleSha256: string;
  readonly controllerProtocol: number;
  readonly void: string;
}

/** Bundle the controller in memory. Fails loudly on any resolve error. */
export const buildControllerBundle = async (): Promise<ControllerBundle> => {
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "worker.ts")],
    external: ["cloudflare:workers", "node:os"],
    format: "esm",
    minify: true,
    target: "node",
  });

  if (!result.success) {
    throw new Error(
      `Sandbox controller build failed:\n${result.logs.join("\n")}`
    );
  }

  const [output] = result.outputs;

  if (result.outputs.length !== 1 || output === undefined) {
    throw new Error(
      `Sandbox controller build emitted ${result.outputs.length} files, expected 1.`
    );
  }

  const source = await output.text();

  return { sha256: createHash("sha256").update(source).digest("hex"), source };
};

/** Bundle and write `worker.js` + `meta.json` into `outdir` (`dist/`). */
export const writeControllerBundle = async (
  outdir: string = path.join(import.meta.dir, "dist")
): Promise<{ readonly metaPath: string; readonly workerPath: string }> => {
  const bundle = await buildControllerBundle();
  mkdirSync(outdir, { recursive: true });
  const workerPath = path.join(outdir, "worker.js");
  const metaPath = path.join(outdir, "meta.json");

  const meta: BundleMeta = {
    bundleSha256: bundle.sha256,
    controllerProtocol: CONTROLLER_PROTOCOL,
    void: VOID_VERSION,
  };

  writeFileSync(workerPath, bundle.source);
  writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

  return { metaPath, workerPath };
};

if (import.meta.main) {
  const { metaPath, workerPath } = await writeControllerBundle();
  console.log(`wrote ${workerPath} + ${metaPath}`);
}
