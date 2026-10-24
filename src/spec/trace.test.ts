import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSeams } from "../seam/exec.js";
import { spec } from "./testkit.testkit.js";

function familyRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "nen-spec-trace-"));
  mkdirSync(join(repo, "nen"));
  writeFileSync(join(repo, "nen", "repos.json"), JSON.stringify({
    consumers: [],
    product_codes: { FA: "fixture-owner/fixture-android", FW: "fixture-owner/fixture-web" },
    families: [{ name: "fixture-family", spec: { repo: "fixture-owner/fixture-spec" }, members: [{ code: "FA" }, { code: "FW" }] }],
  }));
  mkdirSync(join(repo, "specs", "001-list"), { recursive: true });
  writeFileSync(join(repo, "specs", "001-list", "spec.md"), "# Feature Specification: List\n\n- **FR-001**: Shows. [src: FA:a.kt:1-2 @ 0123abcd · observed] [src: FA:b.kt:1-2 @ 0123abcd · observed]\n- **SC-001**: Opens. [NEEDS RULING]\n");
  writeFileSync(join(repo, "specs", "001-list", "tasks.md"), "- [ ] T001 [US1] FR-001 page\n- [ ] T002 [US1] FR-001 screen\n");
  writeFileSync(join(repo, "specs", "001-list", "parity.md"), "| FR | FW |\n|---|---|\n| FR-001 | absent — searched src/ |\n");
  return repo;
}

describe("nen spec trace", () => {
  it("regenerates traceability.md, reports it current, then reports a hand edit as drift and refuses to overwrite it", async () => {
    const repo = familyRepo();
    const absent = await spec(["trace", "--family", "fixture-family"], repo, defaultSeams(), true);
    expect(absent.code).toBe(1);
    expect(Object.keys(absent.json())).toEqual(["contract", "verdict", "repo", "family", "members", "path", "rows", "action", "reason"]);
    expect(absent.json()).toMatchObject({ contract: "nen.spec.trace/v0.1", verdict: "absent", members: ["FA", "FW"], path: "specs/traceability.md", action: "none" });
    expect(absent.json()["rows"]).toEqual([
      { folder: "specs/001-list", id: "F001-FR-001", cells: { FA: "2 citation(s)", FW: "absent" }, tasks: ["T001", "T002"], markers: 0 },
      { folder: "specs/001-list", id: "F001-SC-001", cells: { FA: "—", FW: "—" }, tasks: [], markers: 1 },
    ]);
    const dry = await spec(["trace", "--family", "fixture-family", "--write", "--dry-run"], repo, defaultSeams(), true);
    expect(dry.json()["action"]).toBe("would-write");
    const written = await spec(["trace", "--family", "fixture-family", "--write"], repo, defaultSeams(), true);
    expect(written.code).toBe(0);
    expect(written.json()["action"]).toBe("written");
    const text = readFileSync(join(repo, "specs", "traceability.md"), "utf8");
    expect(text.split("\n").slice(1, 6)).toEqual(["# Traceability — fixture-family", "", "| Requirement | FA | FW | Tasks | Open markers |", "|---|---|---|---|---|", "| F001-FR-001 | 2 citation(s) | absent | T001, T002 | 0 |"]);
    const current = await spec(["trace", "--family", "fixture-family"], repo, defaultSeams(), true);
    expect(current.code).toBe(0);
    expect(current.json()["verdict"]).toBe("current");
    writeFileSync(join(repo, "specs", "traceability.md"), text.replace("| 0 |", "| zero |"));
    const drift = await spec(["trace", "--family", "fixture-family", "--write"], repo, defaultSeams(), true);
    expect(drift.code).toBe(1);
    expect(drift.json()).toMatchObject({ verdict: "hand-edited", action: "refused" });
    expect(readFileSync(join(repo, "specs", "traceability.md"), "utf8")).toContain("| zero |");
  });

  it("reports stale after a folder changes, and could-not-read for a folder with no spec.md", async () => {
    const repo = familyRepo();
    await spec(["trace", "--family", "fixture-family", "--write"], repo, defaultSeams(), true);
    writeFileSync(join(repo, "specs", "001-list", "spec.md"), "# Feature Specification: List\n\n- **FR-001**: Shows. [UNVERIFIED]\n");
    expect((await spec(["trace", "--family", "fixture-family"], repo, defaultSeams(), true)).json()["verdict"]).toBe("stale");
    mkdirSync(join(repo, "specs", "002-empty"));
    const gone = await spec(["trace", "--family", "fixture-family", "--write"], repo, defaultSeams(), true);
    expect(gone.code).toBe(1);
    expect(gone.json()).toMatchObject({ verdict: "could-not-read", action: "refused" });
  });

  it("says could-not-read, with a --json document, when the spec repository's registry cannot be read (Nobunaga F2)", async () => {
    const repo = familyRepo();
    writeFileSync(join(repo, "nen", "repos.json"), "{");
    const run = await spec(["trace", "--family", "fixture-family"], repo, defaultSeams(), true);
    expect(run.code).toBe(1);
    expect(run.json()).toMatchObject({ contract: "nen.spec.trace/v0.1", verdict: "could-not-read", members: [] });
    expect(String(run.json()["reason"])).toContain("nen/repos.json could not be read");
  });

  it("refuses an undeclared family and --dry-run without --write at exit 2", async () => {
    const repo = familyRepo();
    expect((await spec(["trace", "--family", "other"], repo, defaultSeams())).code).toBe(2);
    expect((await spec(["trace", "--family", "fixture-family", "--dry-run"], repo, defaultSeams())).code).toBe(2);
    expect((await spec(["trace"], repo, defaultSeams())).code).toBe(2);
  });
});
