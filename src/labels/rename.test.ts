import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import type { Target } from "../github/target.js";
import { listLabelNamesArgv, parseRenameMap, renameArgv, renameLabels } from "./rename.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

describe("parseRenameMap", () => {
  it("parses from=to pairs, in order", () => {
    expect(parseRenameMap("a=b, c=d")).toEqual([
      { from: "a", to: "b" },
      { from: "c", to: "d" },
    ]);
  });

  it("throws on a malformed entry", () => {
    expect(() => parseRenameMap("nonsense")).toThrow(/from=to/);
  });

  it("ignores blank entries from stray commas", () => {
    expect(parseRenameMap("a=b,,c=d")).toEqual([
      { from: "a", to: "b" },
      { from: "c", to: "d" },
    ]);
  });
});

function listResult(names: readonly string[]): { stdout: string } {
  return { stdout: JSON.stringify(names.map((name): unknown => ({ name }))) };
}

describe("renameLabels -- idempotent, associations preserved by construction", () => {
  it("renames a label that still carries its old name", () => {
    const runner = new ScriptedRunner([
      { match: `gh ${listLabelNamesArgv(TARGET).join(" ")}`, result: listResult(["old"]) },
      { match: `gh ${renameArgv(TARGET, { from: "old", to: "new" }).join(" ")}`, result: {} },
    ]);
    const results = renameLabels(runner, TARGET, [{ from: "old", to: "new" }], false);
    expect(results[0]?.status).toBe("renamed");
  });

  it("is idempotent: a mapping already applied is reported done, never retried", () => {
    const runner = new ScriptedRunner([{ match: `gh ${listLabelNamesArgv(TARGET).join(" ")}`, result: listResult(["new"]) }]);
    const results = renameLabels(runner, TARGET, [{ from: "old", to: "new" }], false);
    expect(results[0]?.status).toBe("already-done");
    // Only the list call was made -- no rename attempted against a name that
    // no longer exists.
    expect(runner.calls.length).toBe(1);
  });

  it("fails when neither the old nor the new name exists", () => {
    const runner = new ScriptedRunner([{ match: `gh ${listLabelNamesArgv(TARGET).join(" ")}`, result: listResult([]) }]);
    const results = renameLabels(runner, TARGET, [{ from: "old", to: "new" }], false);
    expect(results[0]?.status).toBe("failed");
  });

  it("dry-run logs the call and never renames", () => {
    const runner = new ScriptedRunner([{ match: `gh ${listLabelNamesArgv(TARGET).join(" ")}`, result: listResult(["old"]) }]);
    const results = renameLabels(runner, TARGET, [{ from: "old", to: "new" }], true);
    expect(results[0]?.status).toBe("would-rename");
    expect(runner.calls.length).toBe(1);
  });

  it("carries a chained mapping through in one invocation (a->b, then b->c)", () => {
    const runner = new ScriptedRunner([
      { match: `gh ${listLabelNamesArgv(TARGET).join(" ")}`, result: listResult(["a"]) },
      { match: `gh ${renameArgv(TARGET, { from: "a", to: "b" }).join(" ")}`, result: {} },
      { match: `gh ${renameArgv(TARGET, { from: "b", to: "c" }).join(" ")}`, result: {} },
    ]);
    const results = renameLabels(
      runner,
      TARGET,
      [{ from: "a", to: "b" }, { from: "b", to: "c" }],
      false,
    );
    expect(results.map((r): string => r.status)).toEqual(["renamed", "renamed"]);
  });

  it("carries gh's own rename failure through, not as a crash", () => {
    const runner = new ScriptedRunner([
      { match: `gh ${listLabelNamesArgv(TARGET).join(" ")}`, result: listResult(["old"]) },
      { match: `gh ${renameArgv(TARGET, { from: "old", to: "new" }).join(" ")}`, result: { code: 1, stderr: "boom" } },
    ]);
    const results = renameLabels(runner, TARGET, [{ from: "old", to: "new" }], false);
    expect(results[0]?.status).toBe("failed");
  });
});
