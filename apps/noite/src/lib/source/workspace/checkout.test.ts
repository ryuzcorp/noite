import { describe, expect, test } from "bun:test";

import { Nodepod } from "@r1ck404/nodepod/headless";
import type { NodepodFS } from "@r1ck404/nodepod/headless";

import type { TreeEntry } from "../../runner";
import {
  checkout,
  clearJournal,
  objectPath,
  readBase,
  readJournal,
  readObject,
  readTar,
  writeBase,
  writeJournal,
} from "./checkout";
import { gitBlobSha } from "./git";
import { OBJECTS_DIR } from "./types";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** One tar header block, fields and all — including the checksum, which is the
 * one field tar's own reader would refuse to skip. */
const header = (
  name: string,
  mode: number,
  size: number,
  type: string,
  link = ""
): Uint8Array => {
  const block = new Uint8Array(512);

  const put = (text: string, start: number, length: number): void => {
    block.set(ENCODER.encode(text).subarray(0, length), start);
  };

  put(name, 0, 100);
  put(`${mode.toString(8).padStart(7, "0")}\u0000`, 100, 8);
  put("0000000\u0000", 108, 8);
  put("0000000\u0000", 116, 8);
  put(`${size.toString(8).padStart(11, "0")}\u0000`, 124, 12);
  put("00000000000\u0000", 136, 12);
  put("        ", 148, 8);
  put(type, 156, 1);
  put(link, 157, 100);
  put("ustar\u0000", 257, 6);
  put("00", 263, 2);
  let sum = 0;

  for (const byte of block) {
    sum += byte;
  }

  put(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, 8);

  return block;
};

/** One entry: its header, its body, and the padding to the next block. */
const block = (
  name: string,
  mode: number,
  body: string,
  type = "0",
  link = ""
): Uint8Array => {
  const data = ENCODER.encode(body);
  const padding = (512 - (data.byteLength % 512)) % 512;
  const out = new Uint8Array(512 + data.byteLength + padding);
  out.set(header(name, mode, data.byteLength, type, link), 0);
  out.set(data, 512);

  return out;
};

/** One pax record, `<length> <key>=<value>\n` — the length counts itself, and
 * the reader's only question is which key the record carries. */
const paxRecord = (key: string, value: string): string => {
  const body = ` ${key}=${value}\n`;
  let total = body.length + 1;

  while (String(total).length + body.length !== total) {
    total = body.length + String(total).length;
  }

  return `${total}${body}`;
};

/** The blocks of an archive, followed by the two zero blocks that end it. */
const archive = (...parts: Uint8Array[]): Uint8Array => {
  const end = new Uint8Array(1024);

  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, end.byteLength)
  );

  let offset = 0;

  for (const part of [...parts, end]) {
    out.set(part, offset);
    offset += part.byteLength;
  }

  return out;
};

const LONG_NAME = "deep/a-name-that-did-not-fit-a-header-field.txt";

describe("the tar reader", () => {
  test("reads regular files, their bytes and their mode", () => {
    const entries = readTar(
      archive(
        block("README.md", 0o644, "# hi\n"),
        block("bin/run.sh", 0o755, "echo hi\n")
      )
    );

    expect(entries.map((entry) => entry.name)).toEqual([
      "README.md",
      "bin/run.sh",
    ]);
    expect(DECODER.decode(entries[0]?.bytes)).toBe("# hi\n");
    expect(entries[0]?.gitMode).toBe("100644");
    expect(entries[1]?.gitMode).toBe("100755");
  });

  test("a symlink arrives as its target, which is the blob git committed", () => {
    const entries = readTar(
      archive(block("link.md", 0o777, "", "2", "docs/README.md"))
    );

    expect(entries[0]?.gitMode).toBe("120000");
    expect(DECODER.decode(entries[0]?.bytes)).toBe("docs/README.md");
  });

  test("a directory header is not an entry", () => {
    expect(readTar(archive(block("src/", 0o755, "", "5")))).toEqual([]);
  });

  test("a pax path record overrides the truncated header name", () => {
    const entries = readTar(
      archive(
        block("paxheader", 0o644, paxRecord("path", LONG_NAME), "x"),
        block("deep/a-name-tha", 0o644, "long\n")
      )
    );

    expect(entries.map((entry) => entry.name)).toEqual([LONG_NAME]);
    expect(DECODER.decode(entries[0]?.bytes)).toBe("long\n");
  });

  test("a GNU long name does the same for the entry after it", () => {
    const entries = readTar(
      archive(
        block("longname", 0o644, LONG_NAME, "L"),
        block("./long", 0o644, "x")
      )
    );

    expect(entries.map((entry) => entry.name)).toEqual([LONG_NAME]);
  });

  test("an empty or truncated archive holds no file", () => {
    expect(readTar(new Uint8Array(1024))).toEqual([]);
    expect(readTar(new Uint8Array([1, 2, 3]))).toEqual([]);
  });
});

/** A booted pod's filesystem, torn down however the test ends. */
const withPod = async (
  run: (fs: NodepodFS) => Promise<void>
): Promise<void> => {
  const pod = await Nodepod.boot();

  try {
    await run(pod.fs);
  } finally {
    await pod.teardown();
  }
};

/** The listing the runner would send for `files` (path and text pairs). */
const listing = (files: readonly [string, string][]): Promise<TreeEntry[]> =>
  Promise.all(
    files.map(async ([path, text]): Promise<TreeEntry> => {
      const bytes = ENCODER.encode(text);

      return {
        mode: "100644",
        path,
        sha: await gitBlobSha(bytes),
        size: bytes.byteLength,
      };
    })
  );

const BRANCH = archive(
  block("README.md", 0o644, "# hi\n"),
  block("src/main.ts", 0o755, "export {};\n"),
  block("link.md", 0o777, "", "2", "README.md"),
  block("src/", 0o755, "", "5"),
  block("empty/", 0o755, "", "5")
);

const LISTED: readonly [string, string][] = [
  ["README.md", "# hi\n"],
  ["src/main.ts", "export {};\n"],
  ["link.md", "README.md"],
];

describe("the base index and the journal", () => {
  test("a base index round-trips with its keys in order", async () => {
    await withPod(async (fs) => {
      expect(await readBase(fs)).toBeNull();
      await writeBase(fs, {
        baseSha: "abc",
        entries: {
          "README.md": { mode: "100755", sha: "1" },
          "src/z.ts": { mode: "100644", sha: "2" },
        },
      });
      const held = await readBase(fs);
      expect(held?.baseSha).toBe("abc");
      expect(Object.keys(held?.entries ?? {})).toEqual([
        "README.md",
        "src/z.ts",
      ]);
      expect(held?.entries["src/z.ts"]?.sha).toBe("2");
      const raw = await fs.readFile("/home/.noite/base.json", "utf-8");
      expect(raw.indexOf("README.md")).toBeLessThan(raw.indexOf("src/z.ts"));
    });
  });

  test("a base index that is not one is refused, not guessed at", async () => {
    await withPod(async (fs) => {
      await fs.mkdir("/home/.noite", { recursive: true });
      await fs.writeFile("/home/.noite/base.json", "not json");
      await expect(readBase(fs)).rejects.toThrow("base.json is not valid JSON");
      await fs.writeFile("/home/.noite/base.json", '{"baseSha":1}');
      await expect(readBase(fs)).rejects.toThrow("does not hold a base index");
    });
  });

  test("an absent journal is an empty one, and clearing removes the file", async () => {
    await withPod(async (fs) => {
      expect(await readJournal(fs)).toEqual({});
      await writeJournal(fs, { "src/new.ts": "src/old.ts" });
      expect(await readJournal(fs)).toEqual({ "src/new.ts": "src/old.ts" });
      await writeJournal(fs, {});
      expect(await fs.exists("/home/.noite/moves.json")).toBe(false);
      await writeJournal(fs, { "a.ts": "z.ts", "b.ts": "a.ts" });
      await clearJournal(fs);
      expect(await readJournal(fs)).toEqual({});
    });
  });
});

describe("checking a branch out", () => {
  test("writes the checkout, the base index and the blob cache", async () => {
    await withPod(async (fs) => {
      const files = await listing(LISTED);
      await checkout(fs, {
        fetchArchive: () => Promise.resolve(BRANCH),
        files,
        sha: "tip",
      });
      expect(await fs.readFile("/home/project/README.md", "utf-8")).toBe(
        "# hi\n"
      );
      expect(await fs.readFile("/home/project/src/main.ts", "utf-8")).toBe(
        "export {};\n"
      );
      // A symlink is materialized as the text git committed for it.
      expect(await fs.readFile("/home/project/link.md", "utf-8")).toBe(
        "README.md"
      );
      // A directory header alone makes no directory: git cannot store an empty
      // one, so an empty directory is never part of the branch.
      expect(await fs.exists("/home/project/empty")).toBe(false);
      const base = await readBase(fs);
      expect(base?.baseSha).toBe("tip");
      expect(Object.keys(base?.entries ?? {}).toSorted()).toEqual([
        "README.md",
        "link.md",
        "src/main.ts",
      ]);
      expect(base?.entries["link.md"]?.mode).toBe("120000");
      expect(base?.entries["src/main.ts"]?.mode).toBe("100755");
      expect(await readJournal(fs)).toEqual({});
      const blob = await readObject(fs, files[0]?.sha ?? "missing");
      expect(DECODER.decode(blob ?? new Uint8Array())).toBe("# hi\n");
      expect(await readObject(fs, "0".repeat(40))).toBeNull();
      expect(objectPath("x")).toBe(`${OBJECTS_DIR}/x`);
    });
  });

  test("replaces whatever the project held, and leaves the rest of the pod", async () => {
    await withPod(async (fs) => {
      await fs.mkdir("/home/project/old", { recursive: true });
      await fs.writeFile("/home/project/old/stale.ts", "stale\n");
      await fs.writeFile("/home/elsewhere.txt", "keep\n");
      await checkout(fs, {
        fetchArchive: () => Promise.resolve(BRANCH),
        files: await listing(LISTED),
        sha: "tip",
      });
      expect(await fs.exists("/home/project/old")).toBe(false);
      expect(await fs.readFile("/home/elsewhere.txt", "utf-8")).toBe("keep\n");
    });
  });

  test("an archive that carries no file is refused before the tree is wiped", async () => {
    await withPod(async (fs) => {
      await fs.writeFile("/home/project/kept.txt", "kept\n");
      await expect(
        checkout(fs, {
          fetchArchive: () => Promise.resolve(new Uint8Array(1024)),
          files: await listing(LISTED),
          sha: "tip",
        })
      ).rejects.toThrow("the archive held no files");
      expect(await fs.readFile("/home/project/kept.txt", "utf-8")).toBe(
        "kept\n"
      );
    });
  });

  test("a refused archive surfaces its own message and touches nothing", async () => {
    await withPod(async (fs) => {
      await fs.writeFile("/home/project/kept.txt", "kept\n");
      await expect(
        checkout(fs, {
          fetchArchive: () =>
            Promise.reject(
              new Error(
                "archive failed: 413 repository too large for Code mode: more than 5000 files"
              )
            ),
          files: await listing(LISTED),
          sha: "tip",
        })
      ).rejects.toThrow(
        "repository too large for Code mode: more than 5000 files"
      );
      expect(await fs.readFile("/home/project/kept.txt", "utf-8")).toBe(
        "kept\n"
      );
    });
  });
});
