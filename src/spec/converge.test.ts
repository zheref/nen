import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSeams } from "../seam/exec.js";
import { commit, MEMBER_SLUG, memberRepo, numbered } from "./member.testkit.js";
import { fixtureCopy, spec, type Captured } from "./testkit.testkit.js";

interface World {
  readonly spec: string;
  readonly member: string;
  readonly first: string;
  readonly checkouts: string;
  readonly folder: string;
}

function world(tasks: string | null = null): World {
  const member = memberRepo({ "app/List.kt": numbered("list", 30), "app/Other.kt": numbered("other", 5) });
  const specRepo = fixtureCopy();
  mkdirSync(join(specRepo, "nen"));
  writeFileSync(join(specRepo, "nen", "repos.json"), JSON.stringify({ consumers: [], product_codes: { FX: MEMBER_SLUG } }));
  const checkouts = join(mkdtempSync(join(tmpdir(), "nen-spec-checkouts-")), "checkouts");
  writeFileSync(checkouts, `${MEMBER_SLUG}\t${member.root}\n`);
  const folder = "specs/007-converge";
  mkdirSync(join(specRepo, folder), { recursive: true });
  const short = member.sha.slice(0, 10);
  writeFileSync(
    join(specRepo, folder, "spec.md"),
    [
      "# Feature Specification: Converge",
      "",
      `- **FR-001**: The list shows. [src: FX:app/List.kt:10-12 @ ${short} · observed]`,
      `- **FR-002**: The other shows. [src: FX:app/Other.kt:1-2 @ ${short} · observed]`,
      "- **FR-003**: Unknown yet. [NEEDS RULING]",
      "",
    ].join("\n"),
  );
  if (tasks !== null) writeFileSync(join(specRepo, folder, "tasks.md"), tasks);
  return { spec: specRepo, member: member.root, first: member.sha, checkouts, folder };
}

function inventoryAt(sha: string, rows: readonly Record<string, unknown>[] = []): string {
  const file = join(mkdtempSync(join(tmpdir(), "nen-spec-inv-")), "inventory.json");
  writeFileSync(file, JSON.stringify({ contract: "nen.spec.inventory/v0.1", verdict: "read", origin: MEMBER_SLUG, scenario: "compose-uzf-v2", sha, rows }));
  return file;
}

const run = (w: World, inventory: string, ...extra: string[]): Promise<Captured> => spec(["converge", "--folder", w.folder, "--inventory", inventory, "--code", "FX", "--checkouts", w.checkouts, "--date", "2026-10-23", ...extra], w.spec, defaultSeams(), true);
const read = (w: World, name: string): string => readFileSync(join(w.spec, w.folder, name), "utf8");

describe("nen spec converge", () => {
  it("is converged, exit 0, and writes nothing when every cited range reads the same", async () => {
    const w = world();
    const next = commit(w.member, { "app/Unrelated.kt": "x\n" });
    const before = read(w, "spec.md");
    const result = await run(w, inventoryAt(next), "--write");
    expect(result.code).toBe(0);
    const report = result.json();
    expect(Object.keys(report)).toEqual(["contract", "verdict", "repo", "folder", "inventory", "member", "citations", "gaps", "unrequested", "unrequestedReason", "claims", "writes", "action", "counts", "reason"]);
    expect(report).toMatchObject({ contract: "nen.spec.converge/v0.1", verdict: "converged", gaps: [], writes: [], action: "none", counts: { missing: 0, partial: 0, contradicts: 0, unrequested: 0 } });
    expect((report["citations"] as { state: string }[]).map((entry) => entry.state)).toEqual(["current", "current"]);
    expect(String(report["unrequestedReason"])).toContain("capture/FX/inventory.json does not exist");
    expect(read(w, "spec.md")).toBe(before);
  });

  it("classifies moved as partial, changed as contradicts and vanished as missing", async () => {
    const w = world();
    const next = commit(w.member, { "app/List.kt": `new 1\nnew 2\n${numbered("list", 30)}` }, ["app/Other.kt"]);
    const moved = await run(w, inventoryAt(next));
    expect(moved.code).toBe(1);
    const report = moved.json();
    expect(report["citations"]).toMatchObject([
      { id: "FR-001", state: "moved", lines: [10, 12], now: [12, 14], marked: false },
      { id: "FR-002", state: "vanished", now: null },
    ]);
    expect(report["gaps"]).toMatchObject([
      { class: "partial", id: "FR-001", line: 3 },
      { class: "missing", id: "FR-002", line: 4 },
    ]);
    const w2 = world();
    const rewritten = numbered("list", 30).replace("list 11\n", "list eleven\n");
    const changed = await run(w2, inventoryAt(commit(w2.member, { "app/List.kt": rewritten })));
    expect((changed.json()["gaps"] as { class: string; id: string; detail: string }[])[0]).toMatchObject({ class: "contradicts", id: "FR-001" });
    expect((changed.json()["gaps"] as { detail: string }[])[0]?.detail).toContain("never decided here");
  });

  it("only appends under --write, and a second run on the same inputs changes zero bytes", async () => {
    const w = world("# Tasks\n\n## Phase 1: Setup\n\n- [x] T001 Build the list for FR-001\n");
    const next = commit(w.member, { "app/List.kt": `new 1\n${numbered("list", 30)}` });
    const inventory = inventoryAt(next);
    const specBefore = read(w, "spec.md");
    const dry = await run(w, inventory, "--write", "--dry-run");
    expect(dry.json()["action"]).toBe("would-write");
    expect(read(w, "spec.md")).toBe(specBefore);
    const first = await run(w, inventory, "--write");
    expect(first.code).toBe(1);
    expect(first.json()).toMatchObject({ action: "written", claims: [{ line: 5, ids: ["FR-001"] }] });
    const spec1 = read(w, "spec.md");
    const tasks1 = read(w, "tasks.md");
    const short = w.first.slice(0, 10);
    expect(spec1).toBe(specBefore.replace(`@ ${short} · observed]`, `@ ${short} · observed] [STALE @ ${short}]`));
    expect(tasks1).toBe(`# Tasks\n\n## Phase 1: Setup\n\n- [x] T001 Build the list for FR-001\n\n## Phase 2: Convergence 2026-10-23 @ ${next.slice(0, 12)}\n\n- [ ] T002 [partial] FR-001 — 1 moved at ${next.slice(0, 12)}\n`);
    const second = await run(w, inventory, "--write");
    expect(second.json()).toMatchObject({ action: "none", writes: [] });
    expect((second.json()["citations"] as { marked: boolean }[])[0]?.marked).toBe(true);
    expect(read(w, "spec.md")).toBe(spec1);
    expect(read(w, "tasks.md")).toBe(tasks1);
    const check = await spec(["check", "--folder", w.folder], w.spec, defaultSeams(), true);
    expect((check.json()["findings"] as { rule: string }[]).map((finding) => finding.rule)).not.toContain("stale-without-citation");
  });

  it("names new rows in a cited directory as unrequested, against the folder's last capture", async () => {
    const w = world();
    const next = commit(w.member, { "app/Search.kt": "x\n" });
    const old = [{ id: "screen:app/List.kt", kind: "screen", path: "app/List.kt", lines: [1, 30], sha: w.first, excerptSha256: "0".repeat(64), tier: "observed", ruleId: "KT-1" }];
    mkdirSync(join(w.spec, "capture", "FX"), { recursive: true });
    writeFileSync(join(w.spec, "capture", "FX", "inventory.json"), JSON.stringify({ contract: "nen.spec.inventory/v0.1", verdict: "read", origin: MEMBER_SLUG, sha: w.first, rows: old }));
    const added = { id: "screen:app/SearchScreen.kt", kind: "screen", path: "app/SearchScreen.kt", lines: [1, 1], sha: next, excerptSha256: "1".repeat(64), tier: "observed", ruleId: "KT-1" };
    const elsewhere = { ...added, id: "screen:lib/LibScreen.kt", path: "lib/LibScreen.kt" };
    const result = await run(w, inventoryAt(next, [...old, added, elsewhere]));
    expect(result.code).toBe(1);
    expect(result.json()["gaps"]).toMatchObject([{ class: "unrequested", id: "screen:app/SearchScreen.kt", line: null }]);
    expect(result.json()["unrequestedReason"]).toBeNull();
  });

  it("says could-not-read, exit 1, for an inventory, member or folder it cannot read", async () => {
    const w = world();
    const cases: [string[], string][] = [
      [["--inventory", join(w.spec, "absent.json")], "could not read"],
      [["--inventory", inventoryAt("f".repeat(40))], "is not a commit"],
      [["--folder", "specs/999-none"], "does not exist"],
    ];
    for (const [override, why] of cases) {
      const argv = ["converge", "--folder", w.folder, "--inventory", inventoryAt(w.first), "--code", "FX", "--checkouts", w.checkouts];
      for (let index = 0; index < override.length; index += 2) argv[argv.indexOf(override[index] as string) + 1] = override[index + 1] as string;
      const result = await spec(argv, w.spec, defaultSeams(), true);
      expect(result.code, why).toBe(1);
      expect(result.json()).toMatchObject({ verdict: "could-not-read" });
      expect(String(result.json()["reason"])).toContain(why);
    }
    const otherMember = join(mkdtempSync(join(tmpdir(), "nen-spec-inv-")), "inventory.json");
    writeFileSync(otherMember, JSON.stringify({ contract: "nen.spec.inventory/v0.1", origin: "fixture-owner/fixture-web", sha: w.first, rows: [] }));
    const mismatch = await run(w, otherMember);
    expect(String(mismatch.json()["reason"])).toContain("is an inventory of fixture-owner/fixture-web");
  });

  it("refuses --dry-run without --write, a bad --code and a bad --date at exit 2", async () => {
    const w = world();
    const inventory = inventoryAt(w.first);
    expect((await run(w, inventory, "--dry-run")).code).toBe(2);
    expect((await spec(["converge", "--folder", w.folder, "--inventory", inventory, "--code", "fx", "--checkouts", w.checkouts], w.spec, defaultSeams())).code).toBe(2);
    expect((await spec(["converge", "--folder", w.folder, "--inventory", inventory, "--code", "FX", "--checkouts", w.checkouts, "--date", "today"], w.spec, defaultSeams())).code).toBe(2);
  });
});
