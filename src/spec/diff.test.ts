import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSeams } from "../seam/exec.js";
import { spec } from "./testkit.testkit.js";

const row = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, kind: id.split(":")[0], path: id.split(":")[1]?.split("#")[0], lines: [1, 3], sha: "a".repeat(40), excerptSha256: "0".repeat(64), tier: "observed", ruleId: "RC-1", ...extra });

function inventoryFile(rows: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}): string {
  const file = join(mkdtempSync(join(tmpdir(), "nen-spec-diff-")), "inventory.json");
  writeFileSync(file, JSON.stringify({ contract: "nen.spec.inventory/v0.1", verdict: "read", origin: "fixture-owner/fixture-app", scenario: "react-uzf-v1", sha: "a".repeat(40), rows, ...extra }));
  return file;
}

describe("nen spec diff", () => {
  it("answers an empty diff for identical inputs, and for inputs that differ only in their commit", async () => {
    const rows = [row("state:src/AFeature.ts"), row("screen:src/APage.tsx")];
    const same = await spec(["diff", "--from", inventoryFile(rows), "--to", inventoryFile(rows)], null, defaultSeams(), true);
    expect(same.code).toBe(0);
    const report = same.json();
    expect(Object.keys(report)).toEqual(["contract", "verdict", "from", "to", "origin", "added", "removed", "changed", "counts", "reason"]);
    expect(report).toMatchObject({ contract: "nen.spec.diff/v0.1", verdict: "identical", added: [], removed: [], changed: [], counts: { added: 0, removed: 0, changed: 0, unchanged: 2 } });
    const later = rows.map((entry) => ({ ...entry, sha: "b".repeat(40) }));
    const moved = await spec(["diff", "--from", inventoryFile(rows), "--to", inventoryFile(later, { sha: "b".repeat(40) })], null, defaultSeams(), true);
    expect(moved.json()).toMatchObject({ verdict: "identical", from: { sha: "a".repeat(40) }, to: { sha: "b".repeat(40) } });
  });

  it("lists added, removed and changed rows by stable id, naming each changed field", async () => {
    const from = inventoryFile([row("state:src/AFeature.ts"), row("screen:src/OldPage.tsx"), row("test:src/a.test.ts#one")]);
    const to = inventoryFile([row("state:src/AFeature.ts", { lines: [1, 4], excerptSha256: "1".repeat(64) }), row("test:src/a.test.ts#one"), row("screen:src/NewPage.tsx")]);
    const run = await spec(["diff", "--from", from, "--to", to], null, defaultSeams(), true);
    expect(run.code).toBe(0);
    const report = run.json();
    expect(report["verdict"]).toBe("differs");
    expect((report["added"] as { id: string }[]).map((entry) => entry.id)).toEqual(["screen:src/NewPage.tsx"]);
    expect((report["removed"] as { id: string }[]).map((entry) => entry.id)).toEqual(["screen:src/OldPage.tsx"]);
    expect(report["changed"]).toEqual([{ id: "state:src/AFeature.ts", fields: { lines: { from: [1, 3], to: [1, 4] }, excerptSha256: { from: "0".repeat(64), to: "1".repeat(64) } } }]);
    const text = await spec(["diff", "--from", from, "--to", to], null, defaultSeams());
    expect(text.out).toEqual([
      `differs: fixture-owner/fixture-app ${"a".repeat(12)} -> ${"a".repeat(12)} -- 1 added, 1 removed, 1 changed, 1 unchanged`,
      "  + screen:src/NewPage.tsx",
      "  - screen:src/OldPage.tsx",
      "  ~ state:src/AFeature.ts (lines, excerptSha256)",
    ]);
  });

  it("says could-not-read, exit 1, for an input that is not an inventory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-spec-diff-"));
    writeFileSync(join(dir, "bad.json"), "{");
    writeFileSync(join(dir, "other.json"), JSON.stringify({ contract: "nen.spec.check/v0.1" }));
    const good = inventoryFile([row("state:src/AFeature.ts")]);
    for (const [bad, why] of [[join(dir, "bad.json"), "as JSON"], [join(dir, "other.json"), "is not a nen.spec.inventory/v0.1 document"], [join(dir, "absent.json"), "could not read"], [inventoryFile([row("a:b"), row("a:b")]), "twice"], [inventoryFile([{ id: "x" }]), "rows[0]"], [inventoryFile([], { verdict: "could-not-read" }), "could not be read"]] as const) {
      const run = await spec(["diff", "--from", bad, "--to", good], null, defaultSeams(), true);
      expect(run.code, bad).toBe(1);
      expect(run.json()).toMatchObject({ verdict: "could-not-read" });
      expect(String(run.json()["reason"])).toContain(why);
    }
  });

  it("refuses two members, a --repo and a missing side at exit 2", async () => {
    const a = inventoryFile([row("state:src/AFeature.ts")]);
    const b = inventoryFile([row("state:src/AFeature.ts")], { origin: "fixture-owner/fixture-web" });
    expect((await spec(["diff", "--from", a, "--to", b], null, defaultSeams())).code).toBe(2);
    expect((await spec(["diff", "--from", a, "--to", a], ".", defaultSeams())).code).toBe(2);
    expect((await spec(["diff", "--from", a], null, defaultSeams())).code).toBe(2);
  });
});
