// src/edit/atomic.test.ts -- the post-rename failure type (Nobunaga N3,
// zheref/nen#338). The pre-rename checks are pinned in
// ../canon/pin-write.test.ts, which exercises this module through its
// re-exports.

import { afterEach, describe, expect, it } from "vitest";
import { lstatSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkedTarget, TargetChangedError, writeFileAtomic, WrittenButUnverifiedError } from "./atomic.js";

const temps: string[] = [];
afterEach((): void => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function file(): { dir: string; path: string } {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nen-atomic-")));
  temps.push(dir);
  const path = join(dir, "x.json");
  writeFileSync(path, "old\n");
  return { dir, path };
}

function thrown(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

describe("writeFileAtomic -- a failure after the rename is WrittenButUnverifiedError, never TargetChangedError", () => {
  it.skipIf(process.platform === "win32")("landed elsewhere", () => {
    const { dir, path } = file();
    const error = thrown(() =>
      writeFileAtomic(checkedTarget(path, dir, process.platform, lstatSync(path)), "new\n", {
        afterRename: (): void => {
          renameSync(path, join(dir, "kept"));
          writeFileSync(path, "another\n");
        },
      }),
    );
    expect(error).toBeInstanceOf(WrittenButUnverifiedError);
    expect(error).not.toBeInstanceOf(TargetChangedError);
  });

  it("gone after the rename", () => {
    const { dir, path } = file();
    const error = thrown(() =>
      writeFileAtomic(checkedTarget(path, dir, process.platform, lstatSync(path)), "new\n", {
        afterRename: (): void => {
          rmSync(path);
        },
      }),
    );
    expect(error).toBeInstanceOf(WrittenButUnverifiedError);
    expect((error as Error).message).toContain("does not resolve after the rename");
  });
});
