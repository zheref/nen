import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSeams } from "../seam/exec.js";
import { fenceFor, scenarioSentence } from "./tasks.js";
import { memberRepo } from "./member.testkit.js";
import { spec } from "./testkit.testkit.js";

const SPEC = [
  "# Feature Specification: List",
  "",
  "## User Scenarios & Testing",
  "",
  "### US-1 — A user opens the list (Priority: P1)",
  "",
  "1. **Given** an empty list, **When** the user opens it, **Then** the empty state shows. [src: FA:app/T.kt:1-2 @ 0123abcd · declared]",
  "2. **Given** a full list, **When** the user opens it, **Then** the rows show ``like this``. [src: FA:app/T.kt:3-4 @ 0123abcd · declared]",
  "",
  "### US-2 — A user sorts the list (Priority: [NEEDS RULING])",
  "",
  "1. **Given** a list, **When** the user sorts it, **Then** the order holds. [UNVERIFIED]",
  "",
  "## Requirements",
  "",
  "- **FR-001**: The system MUST show the empty state. [src: FA:app/L.kt:1-2 @ 0123abcd · observed]",
  "- **FR-002**: The system MUST keep the order. [NEEDS CLARIFICATION: which order?]",
  "- **SC-001**: The list opens. [NEEDS RULING]",
  "",
].join("\n");

const TASKS = [
  "# Tasks: List",
  "",
  "## Phase 1: Setup",
  "",
  "- [x] T001 Create the module",
  "",
  "## Phase 2: Foundational",
  "",
  "- [ ] T002 Wire the store",
  "",
  "## Phase 3: User Story 1 - Open the list (Priority: P1)",
  "",
  "### Platform: web",
  "",
  "- [ ] T003 [US1] Build the page for FR-001 and SC-001",
  "- [x] T004 [US1] delivered — #12 FR-001",
  "",
  "### Platform: android",
  "",
  "- [ ] T005 [US1] Build the screen for FR-001, depends on T006",
  "",
  "## Phase 4: User Story 2 - Sort",
  "",
  "- [ ] T006 [US2] [platform:android] Sort for FR-002",
  "",
].join("\n");

function folder(spec_: string, tasks: string | null): string {
  const member = memberRepo({ "specs/002-list/spec.md": spec_, ...(tasks === null ? {} : { "specs/002-list/tasks.md": tasks }) });
  return member.root;
}

describe("nen spec tasks groups", () => {
  it("groups by story and platform, states each group, and orders them by dependency", async () => {
    const repo = folder(SPEC, TASKS);
    const run = await spec(["tasks", "groups", "--folder", "specs/002-list"], repo, defaultSeams(), true);
    expect(run.code).toBe(0);
    const report = run.json();
    expect(Object.keys(report)).toEqual(["contract", "verdict", "repo", "folder", "spec", "groups", "order", "reason"]);
    expect(report).toMatchObject({ contract: "nen.spec.tasks/v0.1", verdict: "grouped" });
    expect(String(report["spec"])).toMatch(/^specs\/002-list@[0-9a-f]{40}$/);
    const groups = report["groups"] as { id: string; state: string; tasks: string[]; dependsOn: string[]; title: string | null }[];
    expect(groups.map((group) => `${group.id} ${group.state} ${group.tasks.join(",")} <- ${group.dependsOn.join(",")}`)).toEqual([
      "phase-1 captured T001 <- ",
      "phase-2 open T002 <- ",
      "US1/web clarifying T003,T004 <- phase-1,phase-2",
      "US1/android open T005 <- phase-1,phase-2,US2/android",
      "US2/android clarifying T006 <- phase-1,phase-2",
    ]);
    expect(report["order"]).toEqual(["phase-1", "phase-2", "US1/web", "US2/android", "US1/android"]);
    expect(groups[2]?.title).toBe("spec: A user opens the list (F002/US1 · web)");
  });

  it("renders a story group as an issue body quoting the scenarios as fenced source data", async () => {
    const repo = folder(SPEC, TASKS);
    const run = await spec(["tasks", "groups", "--folder", "specs/002-list", "--group", "US1/web"], repo, defaultSeams());
    expect(run.code).toBe(0);
    const body = run.out.join("\n");
    expect(body).toMatch(/^Spec: specs\/002-list@[0-9a-f]{40}$/m);
    expect(body).toContain("Requirements: F002-FR-001 · Success criteria: F002-SC-001");
    expect(body).toContain("- AC-1: Given an empty list, When the user opens it, Then the empty state shows. (F002-AC-001)");
    expect(body).toContain("- AC-2: Given a full list, When the user opens it, Then the rows show ``like this``. (F002-AC-002)");
    expect(body).toContain("```source-data\n1. **Given** an empty list");
    expect(body).toContain("- **SC-001**: The list opens. [NEEDS RULING]\n```");
  });

  it("refuses a cycle and an unknown dependency, exit 1", async () => {
    const cyclic = TASKS.replace("- [ ] T006 [US2] [platform:android] Sort for FR-002", "- [ ] T006 [US2] [platform:android] Sort, depends on T005").replace("T005 [US1] Build the screen for FR-001, depends on T006", "T005 [US1] Build the screen, depends on T006");
    const run = await spec(["tasks", "groups", "--folder", "specs/002-list"], folder(SPEC, cyclic), defaultSeams(), true);
    expect(run.code).toBe(1);
    expect(run.json()["verdict"]).toBe("refused");
    expect(String(run.json()["reason"])).toContain("cycle");
    const unknown = await spec(["tasks", "groups", "--folder", "specs/002-list"], folder(SPEC, "- [ ] T001 [US1] x, depends on T099\n"), defaultSeams(), true);
    expect(String(unknown.json()["reason"])).toContain("T099, which tasks.md does not define");
  });

  it("says could-not-read without a tasks.md, and refuses a bad action or group at exit 2", async () => {
    const repo = folder(SPEC, null);
    const run = await spec(["tasks", "groups", "--folder", "specs/002-list"], repo, defaultSeams(), true);
    expect(run.code).toBe(1);
    expect(run.json()).toMatchObject({ verdict: "could-not-read" });
    const full = folder(SPEC, TASKS);
    expect((await spec(["tasks", "--folder", "specs/002-list"], full, defaultSeams())).code).toBe(2);
    expect((await spec(["tasks", "list", "--folder", "specs/002-list"], full, defaultSeams())).code).toBe(2);
    expect((await spec(["tasks", "groups", "--folder", "specs/002-list", "--group", "US9/web"], full, defaultSeams())).code).toBe(2);
    expect((await spec(["tasks", "groups", "--folder", "specs/002-list", "--group", "phase-1"], full, defaultSeams())).code).toBe(2);
  });

  it("fences longer than any backtick run and strips a scenario to its sentence", () => {
    expect(fenceFor("a ```` b")).toBe("`````");
    expect(fenceFor("plain")).toBe("```");
    expect(scenarioSentence("3. **Given** a, **When** b, **Then** c. [src: FA:a.kt:1-2 @ 0123abcd · declared] [STALE @ 0123abcd]")).toBe("Given a, When b, Then c.");
  });
});

describe("nen spec tasks groups in a plain directory", () => {
  it("pins no sha when the spec repository is not a git checkout", async () => {
    const repo = mkdtempSync(join(tmpdir(), "nen-spec-tasks-"));
    mkdirSync(join(repo, "specs", "002-list"), { recursive: true });
    writeFileSync(join(repo, "specs", "002-list", "spec.md"), SPEC);
    writeFileSync(join(repo, "specs", "002-list", "tasks.md"), TASKS);
    const run = await spec(["tasks", "groups", "--folder", "specs/002-list", "--group", "US1/web"], repo, defaultSeams());
    expect(run.out[0]).toBe("Spec: specs/002-list@<unread>");
  });
});
