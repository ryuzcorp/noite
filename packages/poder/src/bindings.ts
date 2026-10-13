import { isRecord, isString, isVarValue } from "./guards.ts";
// Reads binding declarations out of a parsed wrangler.json(c) or a
// cloudflare.config.ts-style object into a BindingsConfig. Unknown shapes
// pass through where recognizable and are ignored otherwise.
import type {
  BindingsConfig,
  D1Binding,
  DurableObjectBinding,
  KvBinding,
  R2Binding,
} from "./types.ts";

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: binding entries carry caller-defined wrangler fields.
type EntryRecord = Record<string, unknown>;
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- contract: worker vars are caller-defined.
type VarsRecord = Record<string, string | number | boolean | object>;

const stringField = (
  record: EntryRecord,
  ...names: string[]
): string | null => {
  for (const name of names) {
    const value: unknown = record[name];
    if (isString(value) && value.length > 0) {
      return value;
    }
  }
  return null;
};

const pushD1 = (out: D1Binding[], record: EntryRecord): void => {
  const binding = stringField(record, "binding");
  const databaseName = stringField(
    record,
    "database_name",
    "databaseName",
    "name",
    "database_id",
    "databaseId"
  );
  if (binding !== null && databaseName !== null) {
    const entry: D1Binding = { binding, databaseName };
    const migrationsDir = stringField(
      record,
      "migrations_dir",
      "migrationsDir"
    );
    if (migrationsDir !== null) {
      entry.migrationsDir = migrationsDir;
    }
    out.push(entry);
  }
};

const pushR2 = (out: R2Binding[], record: EntryRecord): void => {
  const binding = stringField(record, "binding");
  const bucketName = stringField(record, "bucket_name", "bucketName", "name");
  if (binding !== null && bucketName !== null) {
    out.push({ binding, bucketName });
  }
};

const pushKv = (out: KvBinding[], record: EntryRecord): void => {
  const binding = stringField(record, "binding");
  const id = stringField(record, "id", "namespace_id", "namespaceId");
  if (binding !== null && id !== null) {
    out.push({ binding, id });
  }
};

const pushDurableObject = (
  out: DurableObjectBinding[],
  record: EntryRecord
): void => {
  const binding = stringField(record, "binding", "name");
  const className = stringField(
    record,
    "class_name",
    "className",
    "exportName"
  );
  if (binding !== null && className !== null) {
    out.push({ binding, className });
  }
};

const scanBindingsItem = (config: BindingsConfig, item: EntryRecord): void => {
  if ("class_name" in item || "className" in item) {
    config.durableObjects ??= [];
    pushDurableObject(config.durableObjects, item);
  } else if ("bucket_name" in item || "bucketName" in item) {
    config.r2 ??= [];
    pushR2(config.r2, item);
  } else if (
    "database_name" in item ||
    "databaseName" in item ||
    "database_id" in item
  ) {
    config.d1 ??= [];
    pushD1(config.d1, item);
  } else if ("namespace_id" in item || ("binding" in item && "id" in item)) {
    config.kv ??= [];
    pushKv(config.kv, item);
  }
};

const scanArrayItem = (
  config: BindingsConfig,
  key: string,
  item: EntryRecord
): void => {
  if (key === "d1_databases" || key === "d1") {
    config.d1 ??= [];
    pushD1(config.d1, item);
  } else if (key === "r2_buckets" || key === "r2") {
    config.r2 ??= [];
    pushR2(config.r2, item);
  } else if (key === "kv_namespaces" || key === "kv") {
    config.kv ??= [];
    pushKv(config.kv, item);
  } else if (key === "durableObjects" || key === "durable_objects") {
    config.durableObjects ??= [];
    pushDurableObject(config.durableObjects, item);
  } else if (key === "bindings") {
    scanBindingsItem(config, item);
  }
};

const scanArray = (
  config: BindingsConfig,
  key: string,
  items: unknown[]
): void => {
  for (const item of items) {
    if (isRecord(item)) {
      scanArrayItem(config, key, item);
    }
  }
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: wrangler config values are caller-defined.
const scanVars = (config: BindingsConfig, value: EntryRecord): void => {
  if (config.vars !== undefined) {
    return;
  }
  const vars: VarsRecord = {};
  for (const [name, entry] of Object.entries(value)) {
    if (isVarValue(entry)) {
      vars[name] = entry;
    }
  }
  config.vars = vars;
};

const scanValue = (
  config: BindingsConfig,
  key: string,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: wrangler config values are caller-defined.
  value: unknown
): void => {
  if (Array.isArray(value)) {
    scanArray(config, key, value);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (key === "durable_objects" && Array.isArray(value["bindings"])) {
    scanValue(config, "bindings", value["bindings"]);
    return;
  }
  if (key === "worker" || key === "env") {
    for (const [innerKey, inner] of Object.entries(value)) {
      scanValue(config, innerKey, inner);
    }
    return;
  }
  if (key === "vars") {
    scanVars(config, value);
  }
};

/** Parses a wrangler.json(c)-style config (or the `cf` config object) into bindings. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- contract: wrangler config is caller-defined JSON.
export const readBindings = (config: unknown): BindingsConfig => {
  const out: BindingsConfig = {};
  if (!isRecord(config)) {
    return out;
  }
  const { worker } = config;
  const root = isRecord(worker) ? { ...config, ...worker } : config;
  for (const [key, value] of Object.entries(root)) {
    if (key === "worker") {
      continue;
    }
    scanValue(out, key, value);
  }
  return out;
};
