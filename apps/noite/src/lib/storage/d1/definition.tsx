//! The Definition view: the table's columns, indexes, foreign keys and the
//! CREATE statement from sqlite_master, all read from the schema resource.

import type { D1Index, D1TableSchema } from "../../runner";
import { CopyButton } from "../../ui/copy-button";

const SqlBlock = ({ sql }: { sql: string }) => (
  <div class="relative">
    <CopyButton
      class="btn btn-square btn-ghost btn-sm absolute top-2 right-2"
      iconOnly
      label="Copy CREATE statement"
      value={sql}
    />
    <pre class="bg-base-200 dark:bg-base-300/60 rounded-box m-0 overflow-x-auto p-3 font-mono text-xs">
      {sql}
    </pre>
  </div>
);

const IndexRow = ({ index }: { index: D1Index }) => (
  <tr>
    <td class="font-mono text-xs">{index.name}</td>
    <td>{index.unique ? "yes" : "no"}</td>
    <td class="font-mono text-xs">{index.columns.join(", ")}</td>
  </tr>
);

export const TableDefinition = ({ schema }: { schema: D1TableSchema }) => (
  <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
    <section class="flex flex-col gap-2">
      <h2 class="m-0 text-sm font-semibold tracking-wide uppercase opacity-60">
        Columns
      </h2>
      <div class="overflow-x-auto">
        <table class="table-sm table w-full">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Nullable</th>
              <th>Default</th>
              <th>PK</th>
            </tr>
          </thead>
          <tbody>
            {schema.columns.map((column) => (
              <tr key={column.name}>
                <td class="font-medium">
                  <span class="inline-flex items-center gap-1">
                    {column.name}
                    {schema.locked[column.name] ? (
                      <span class="badge badge-sm font-normal opacity-70">
                        {schema.locked[column.name]}
                      </span>
                    ) : null}
                  </span>
                </td>
                <td class="font-mono text-xs opacity-70">
                  {column.type === "" ? "—" : column.type}
                </td>
                <td class="opacity-70">{column.notNull ? "no" : "yes"}</td>
                <td class="font-mono text-xs opacity-70">
                  {column.defaultValue ?? "—"}
                </td>
                <td>
                  {column.pk > 0 ? (
                    <span class="badge badge-sm">{column.pk}</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>

    <section class="flex flex-col gap-2">
      <h2 class="m-0 text-sm font-semibold tracking-wide uppercase opacity-60">
        Indexes
      </h2>
      {schema.indexes.length === 0 ? (
        <p class="m-0 text-sm opacity-60">No indexes.</p>
      ) : (
        <div class="overflow-x-auto">
          <table class="table-sm table w-full">
            <thead>
              <tr>
                <th>Name</th>
                <th>Unique</th>
                <th>Columns</th>
              </tr>
            </thead>
            <tbody>
              {schema.indexes.map((index) => (
                <IndexRow key={index.name} index={index} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>

    <section class="flex flex-col gap-2">
      <h2 class="m-0 text-sm font-semibold tracking-wide uppercase opacity-60">
        Foreign keys
      </h2>
      {schema.foreignKeys.length === 0 ? (
        <p class="m-0 text-sm opacity-60">No foreign keys.</p>
      ) : (
        <div class="overflow-x-auto">
          <table class="table-sm table w-full">
            <thead>
              <tr>
                <th>From</th>
                <th>References</th>
              </tr>
            </thead>
            <tbody>
              {schema.foreignKeys.map((key) => (
                <tr key={`${key.from}:${key.table}.${key.to}`}>
                  <td class="font-mono text-xs">{key.from}</td>
                  <td class="font-mono text-xs">
                    {key.table}.{key.to}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>

    <section class="flex flex-col gap-2">
      <h2 class="m-0 text-sm font-semibold tracking-wide uppercase opacity-60">
        CREATE statement
      </h2>
      {schema.sql === null ? (
        <p class="m-0 text-sm opacity-60">
          No CREATE statement found for this table.
        </p>
      ) : (
        <SqlBlock sql={schema.sql} />
      )}
    </section>
  </div>
);
