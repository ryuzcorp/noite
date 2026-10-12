//! The checkout's bindings as Poder's `BindingsConfig`: the static reader's
//! `PreviewBinding` list reshaped for `createPoder`. Secrets and the assets
//! binding have no Poder form — the harness reports the first and wires the
//! second around Poder's `env` — so neither lands here.

import type { PreviewBinding } from "./config";
import type { LiteralObject, LiteralValue } from "./literal";

/** One D1 binding, as `@noitenow/poder`'s `BindingsConfig` takes it. */
export interface PoderD1 {
  binding: string;
  databaseName: string;
  migrationsDir?: string;
}

/** One R2 binding, as `@noitenow/poder`'s `BindingsConfig` takes it. */
export interface PoderR2 {
  binding: string;
  bucketName: string;
}

/** One KV binding, as `@noitenow/poder`'s `BindingsConfig` takes it. */
export interface PoderKv {
  binding: string;
  id: string;
}

/** One Durable Object binding, as `@noitenow/poder`'s `BindingsConfig` takes
 * it. `className` is the Worker's export holding the class. */
export interface PoderDurableObject {
  binding: string;
  className: string;
}

/** A plain `var` the Worker reads: what `vars` in a Wrangler config and the
 * `text`/`json` builders in a `cf` config can declare. */
export type PoderVar =
  | string
  | number
  | boolean
  | LiteralObject
  | LiteralValue[];

/** The bindings half of `createPoder`'s options. Mirrored here rather than
 * imported so this app typechecks against the contract; the field names
 * follow `@noitenow/poder` exactly. */
export interface PoderBindings {
  vars?: Record<string, PoderVar>;
  d1?: PoderD1[];
  r2?: PoderR2[];
  kv?: PoderKv[];
  durableObjects?: PoderDurableObject[];
}

/** A `text`/`json` value the Worker can read as a plain `var`. */
const isVarValue = (value: LiteralValue): value is PoderVar =>
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean" ||
  (typeof value === "object" && value !== null);

/** The checkout's bindings as Poder's `BindingsConfig`. A binding without a
 * named store falls back to its own name. */
export const poderBindings = (
  bindings: readonly PreviewBinding[]
): PoderBindings => {
  const vars: Record<string, PoderVar> = {};
  const d1: PoderD1[] = [];
  const r2: PoderR2[] = [];
  const kv: PoderKv[] = [];
  const durableObjects: PoderDurableObject[] = [];
  for (const binding of bindings) {
    switch (binding.kind) {
      case "d1": {
        const entry: PoderD1 = {
          binding: binding.name,
          databaseName: binding.resource ?? binding.name,
        };
        if (binding.migrationsDir !== undefined) {
          entry.migrationsDir = binding.migrationsDir;
        }
        d1.push(entry);
        break;
      }
      case "r2": {
        r2.push({
          binding: binding.name,
          bucketName: binding.resource ?? binding.name,
        });
        break;
      }
      case "kv": {
        kv.push({
          binding: binding.name,
          id: binding.resource ?? binding.name,
        });
        break;
      }
      case "durable-object": {
        durableObjects.push({
          binding: binding.name,
          className: binding.resource ?? binding.name,
        });
        break;
      }
      case "text":
      case "json": {
        const value = binding.value ?? null;
        if (isVarValue(value)) {
          vars[binding.name] = value;
        }
        break;
      }
      default: {
        break;
      }
    }
  }
  const out: PoderBindings = {};
  if (Object.keys(vars).length > 0) {
    out.vars = vars;
  }
  if (d1.length > 0) {
    out.d1 = d1;
  }
  if (r2.length > 0) {
    out.r2 = r2;
  }
  if (kv.length > 0) {
    out.kv = kv;
  }
  if (durableObjects.length > 0) {
    out.durableObjects = durableObjects;
  }
  return out;
};
