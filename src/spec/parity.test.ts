import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSeams } from "../seam/exec.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { readCell } from "./parity.js";
import { spec } from "./testkit.testkit.js";

const SHA = "0123abcd";
const cite = (code: string, path = "app/List.kt"): string => `[src: ${code}:${path}:1-4 @ ${SHA} · observed]`;

function family(parityMd: string | null, extraSpec = ""): string {
  const repo = mkdtempSync(join(tmpdir(), "nen-spec-parity-"));
  mkdirSync(join(repo, "nen"));
  writeFileSync(join(repo, "nen", "repos.json"), JSON.stringify({
    consumers: [],
    product_codes: { FA: "fixture-owner/fixture-android", FW: "fixture-owner/fixture-web" },
    families: [{ name: "fixture-family", spec: { repo: "fixture-owner/fixture-spec" }, members: [{ code: "FA", platform: "android" }, { code: "FW", platform: "web" }] }],
  }));
  mkdirSync(join(repo, "specs", "002-list"), { recursive: true });
  writeFileSync(join(repo, "specs", "002-list", "spec.md"), `# Feature Specification: List\n\n- **FR-001**: Shows. ${cite("FA")}\n- **FR-002**: Sorts. ${cite("FA")}\n- **FR-003**: Refreshes. [NEEDS RULING]\n${extraSpec}`);
  if (parityMd !== null) writeFileSync(join(repo, "specs", "002-list", "parity.md"), parityMd);
  return repo;
}

const TABLE = [
  "# Parity",
  "",
  "| FR | FA | FW |",
  "|---|---|---|",
  `| FR-001 | present ${cite("FA")} | mirror ${cite("FW", "src/List.tsx")} |`,
  `| FR-002 | present ${cite("FA")} | differs ${cite("FA")} ${cite("FW", "src/Sort.ts")} |`,
  "| FR-003 | open | absent — searched src/refresh/ |",
  "",
].join("\n");

describe("nen spec parity", () => {
  it("returns one row per requirement and member with its state, handled only when SP-6's evidence is there", async () => {
    const repo = family(TABLE);
    const run = await spec(["parity", "--folder", "specs/002-list"], repo, defaultSeams(), true);
    expect(run.code).toBe(1);
    const report = run.json();
    expect(Object.keys(report)).toEqual(["contract", "verdict", "repo", "scope", "members", "folders", "rows", "counts", "live", "reason"]);
    expect(report).toMatchObject({ contract: "nen.spec.parity/v0.1", verdict: "gaps", members: ["FA", "FW"], folders: ["specs/002-list"], live: null });
    const rows = report["rows"] as { qualified: string; code: string; state: string; handled: boolean; citations: string[] }[];
    expect(rows.map((row) => `${row.qualified} ${row.code} ${row.state} ${row.handled}`)).toEqual([
      "F002-FR-001 FA present true",
      "F002-FR-001 FW mirror true",
      "F002-FR-002 FA present true",
      "F002-FR-002 FW differs false",
      "F002-FR-003 FA open false",
      "F002-FR-003 FW absent false",
    ]);
    expect(rows[3]?.citations).toHaveLength(2);
    expect(report["counts"]).toMatchObject({ present: 2, mirror: 1, differs: 1, open: 1, absent: 1, malformed: 0 });
  });

  it("is handled, exit 0, when every row carries a handling", async () => {
    const repo = family(["| Requirement | FA |", "|---|---|", `| FR-001 | present ${cite("FA")} |`, `| FR-002 | map ${cite("FA")} — UX-13 navigation |`, "| FR-003 | drop-with-note — CL-004 |", ""].join("\n"));
    const run = await spec(["parity", "--folder", "specs/002-list"], repo, defaultSeams(), true);
    expect(run.code, JSON.stringify(run.json()["rows"])).toBe(0);
    expect(run.json()["verdict"]).toBe("handled");
  });

  it("reads the family's members and names a member column or a row that is missing", async () => {
    const repo = family(["| FR | FA |", "|---|---|", `| FR-001 | present ${cite("FA")} |`, ""].join("\n"));
    const run = await spec(["parity", "--family", "fixture-family"], repo, defaultSeams(), true);
    const rows = run.json()["rows"] as { id: string; code: string; finding: string | null }[];
    expect(rows.find((row) => row.id === "FR-001" && row.code === "FW")?.finding).toBe("parity.md has no FW column");
    expect(rows.find((row) => row.id === "FR-002" && row.code === "FA")?.finding).toBe("parity.md has no row for FR-002");
    const none = await spec(["parity", "--folder", "specs/002-list"], family(null), defaultSeams(), true);
    expect((none.json()["rows"] as { finding: string }[])[0]?.finding).toBe("specs/002-list has no parity.md");
  });

  it("holds each state to what it must carry", () => {
    expect(readCell("present", "FA").finding).toContain("no FA citation");
    expect(readCell(`present ${cite("FW")}`, "FA").finding).toContain("no FA citation");
    expect(readCell(`map ${cite("FA")}`, "FA").finding).toContain("no UX-13 category");
    expect(readCell("drop-with-note — decided", "FA").finding).toContain("no CL-nnn ruling");
    expect(readCell("drop-with-note — compose-uzf-v2--react-uzf-v1 PT-3", "FA").finding).toBeNull();
    expect(readCell(`target-only ${cite("FA")}`, "FA").finding).toContain("no CL-nnn or");
    expect(readCell(`target-only ${cite("FA")} — swiftui-tca-uzf-v2--react-uzf-v1 PT-2`, "FA").finding).toBeNull();
    expect(readCell("absent", "FA").finding).toContain("files searched");
    expect(readCell("absent — not needed on web", "FA").finding).toContain("SP-7");
    expect(readCell("absent — not needed, CL-002", "FA").finding).toBeNull();
    expect(readCell("", "FA")).toMatchObject({ state: "open" });
    expect(readCell("ported", "FA")).toMatchObject({ state: null });
  });

  it("reads each row's live issues and pull requests from --target, and names a list it could not read", async () => {
    const repo = family(TABLE);
    const issues = JSON.stringify([{ number: 7, state: "OPEN", body: "Spec: specs/002-list@abc\n- F002-FR-001 shows" }, { number: 8, state: "CLOSED", body: "F002-FR-2 is unpadded and still FR-002" }]);
    const prs = JSON.stringify([{ number: 9, state: "MERGED", body: "Closes #7 · F002-FR-001" }]);
    const ok = (stdout: string): ScriptedCall["result"] => ({ code: 0, stdout, stderr: "", spawnFailed: false });
    const seams = new ScriptedSeams([
      { match: "gh issue list --repo fixture-owner/fixture-android --state all --search F002 in:body --limit 500 --json number,state,body", result: ok(issues) },
      { match: "gh pr list --repo fixture-owner/fixture-android --state all --search F002 in:body --limit 500 --json number,state,body", result: ok(prs) },
      { match: "gh issue list --repo fixture-owner/fixture-web --state all --search F002 in:body --limit 500 --json number,state,body", result: { code: 1, stdout: "", stderr: "HTTP 404", spawnFailed: false } },
      { match: "gh pr list --repo fixture-owner/fixture-web --state all --search F002 in:body --limit 500 --json number,state,body", result: ok("[]") },
    ]);
    const run = await spec(["parity", "--folder", "specs/002-list", "--target", "fixture-owner/fixture-android,fixture-owner/fixture-web"], repo, seams, true);
    const rows = run.json()["rows"] as { qualified: string; issues: unknown; prs: unknown }[];
    expect(rows[0]).toMatchObject({ qualified: "F002-FR-001", issues: [{ repo: "fixture-owner/fixture-android", number: 7, state: "OPEN" }], prs: [{ repo: "fixture-owner/fixture-android", number: 9, state: "MERGED" }] });
    expect(rows[2]).toMatchObject({ qualified: "F002-FR-002", issues: [{ repo: "fixture-owner/fixture-android", number: 8, state: "CLOSED" }], prs: [] });
    expect(rows[4]).toMatchObject({ qualified: "F002-FR-003", issues: [], prs: [] });
    expect(run.json()["live"]).toEqual({ targets: ["fixture-owner/fixture-android", "fixture-owner/fixture-web"], unread: [{ repo: "fixture-owner/fixture-web", reason: "gh issue list failed: HTTP 404" }] });
  });

  it("says could-not-read for a folder it cannot read, and refuses a bad scope at exit 2", async () => {
    const repo = family(TABLE);
    const gone = await spec(["parity", "--folder", "specs/009-none"], repo, defaultSeams(), true);
    expect(gone.code).toBe(1);
    expect(gone.json()).toMatchObject({ verdict: "could-not-read" });
    expect((await spec(["parity"], repo, defaultSeams())).code).toBe(2);
    expect((await spec(["parity", "--folder", "specs/002-list", "--family", "fixture-family"], repo, defaultSeams())).code).toBe(2);
    expect((await spec(["parity", "--family", "other-family"], repo, defaultSeams())).code).toBe(2);
    expect((await spec(["parity", "--folder", "specs/002-list", "--target", "not a slug"], repo, defaultSeams())).code).toBe(2);
  });
});
