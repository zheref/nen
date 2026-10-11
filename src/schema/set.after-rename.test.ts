// src/schema/set.after-rename.test.ts -- a failure AFTER the rename is
// reported as written (Nobunaga N3, zheref/nen#338): the new text is on disk,
// so `schema set` never says "nothing was written" about it.

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../cli/args.js";
import type { AtomicHooks } from "../edit/atomic.js";
import { runSchemaSet, SCHEMA_SET_FLAGS } from "./set.js";

const WORKFLOW = readFileSync(join(process.cwd(), "nen", "workflow.json"), "utf8");
const temps: string[] = [];
afterEach((): void => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function attempt(hooks: (root: string) => AtomicHooks): { code: number; doc: Record<string, unknown>; root: string } {
  const root = mkdtempSync(join(tmpdir(), "nen-set-after-"));
  temps.push(root);
  mkdirSync(join(root, "nen"));
  writeFileSync(join(root, "nen", "workflow.json"), WORKFLOW);
  const out: string[] = [];
  const args = parseArgs(["schema", "set", "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "85"], SCHEMA_SET_FLAGS);
  const code = runSchemaSet(args, root, true, { out: (line): void => void out.push(line), err: (): void => undefined }, process.platform, hooks(root));
  return { code, doc: JSON.parse(out.join("\n")) as Record<string, unknown>, root };
}

describe("schema set -- after the rename", () => {
  it.skipIf(process.platform === "win32")("a rename that landed elsewhere is read-back-mismatch, written: true", () => {
    const { code, doc } = attempt((root) => ({
      afterRename: (): void => {
        const path = join(root, "nen", "workflow.json");
        renameSync(path, join(root, "kept"));
        writeFileSync(path, WORKFLOW);
      },
    }));
    expect(code).toBe(1);
    expect(doc).toMatchObject({ ok: false, written: true, failure: { code: "read-back-mismatch", message: expect.stringContaining("landed elsewhere") as unknown } });
  });

  it("a file that is gone on the read-back is read-back-mismatch, written: true", () => {
    const { code, doc } = attempt((root) => ({
      afterRename: (): void => {
        rmSync(join(root, "nen", "workflow.json"));
      },
    }));
    expect(code).toBe(1);
    expect(doc).toMatchObject({ ok: false, written: true, failure: { code: "read-back-mismatch" } });
  });
});
