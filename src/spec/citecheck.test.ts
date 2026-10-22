import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { defaultSeams } from "../seam/exec.js";
import { sha256 } from "./check.js";
import { excerptOf, parseCheckouts } from "./citecheck.js";
import { fixtureCopy, spec } from "./testkit.testkit.js";

const MEMBER = "fixture-owner/fixture-app";
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const lines = (prefix: string, count: number): string => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n") + "\n";

interface World {
  readonly spec: string;
  readonly member: string;
  readonly first: string;
  readonly checkouts: string;
}

function world(origin = `https://github.com/${MEMBER}.git`): World {
  const member = mkdtempSync(join(tmpdir(), "nen-spec-member-"));
  git(member, "init", "-q", "-b", "main");
  git(member, "config", "user.email", "fixture@example.invalid");
  git(member, "config", "user.name", "Fixture");
  git(member, "config", "commit.gpgsign", "false");
  mkdirSync(join(member, "app"));
  writeFileSync(join(member, "app", "List.kt"), lines("list", 30));
  git(member, "add", ".");
  git(member, "commit", "-q", "-m", "one");
  git(member, "remote", "add", "origin", origin);
  const first = git(member, "rev-parse", "HEAD");
  const specRepo = fixtureCopy();
  mkdirSync(join(specRepo, "nen"));
  writeFileSync(join(specRepo, "nen", "repos.json"), JSON.stringify({ consumers: [], product_codes: { FX: MEMBER } }));
  const checkouts = join(mkdtempSync(join(tmpdir(), "nen-spec-checkouts-")), "checkouts");
  writeFileSync(checkouts, `# member checkouts\n${MEMBER}\t${member}\n`);
  return { spec: specRepo, member, first, checkouts };
}

function folder(w: World, body: string, name = "005-cite"): string {
  mkdirSync(join(w.spec, "specs", name), { recursive: true });
  writeFileSync(join(w.spec, "specs", name, "spec.md"), body);
  return `specs/${name}`;
}

const cite = (sha: string, range = "10-12", path = "app/List.kt", code = "FX"): string => `[src: ${code}:${path}:${range} @ ${sha} · observed]`;

describe("nen spec cite-check", () => {
  it("resolves every range at its own sha in the member checkout the checkouts file names", async () => {
    const w = world();
    const short = w.first.slice(0, 8);
    const dir = folder(w, `- **FR-001**: a ${cite(short)}\n- **FR-002**: b ${cite(w.first, "29-30")}\n\`\`\`\n${cite("deadbeef")} is source data\n\`\`\`\n`);
    const run = await spec(["cite-check", "--folder", dir, "--checkouts", w.checkouts], w.spec, defaultSeams(), true);
    expect(run.code).toBe(0);
    const report = run.json();
    expect(Object.keys(report)).toEqual(["contract", "repo", "folder", "checkouts", "at", "verifyExcerpt", "members", "citations", "counts"]);
    expect(report["contract"]).toBe("nen.spec.cite-check/v0.1");
    expect(report["members"]).toEqual([{ code: "FX", repo: MEMBER, path: w.member, verdict: "verified", reason: null, at: null }]);
    expect(report["counts"]).toEqual({ total: 2, resolves: 2, failing: 0, excerptMismatch: 0, stale: 0 });
  });

  it("names each way a range fails and exits 1", async () => {
    const w = world();
    const dir = folder(w, [
      `- **FR-001**: ${cite(w.first, "29-31")}`,
      `- **FR-002**: ${cite(w.first, "1-2", "app/Missing.kt")}`,
      `- **FR-003**: ${cite("deadbeef")}`,
      `- **FR-004**: ${cite(w.first, "1-2", "app/List.kt", "ZZ")}`,
      "- **FR-005**: [src: FX:app/List.kt:9 @ 0123abcd · observed]",
      "",
    ].join("\n"));
    const run = await spec(["cite-check", "--folder", dir, "--checkouts", w.checkouts], w.spec, defaultSeams(), true);
    expect(run.code).toBe(1);
    const verdicts = (run.json()["citations"] as { verdict: string }[]).map((entry) => entry.verdict);
    expect(verdicts).toEqual(["out-of-range", "missing-path", "missing-commit", "unresolved-member", "malformed"]);
    const text = await spec(["cite-check", "--folder", dir, "--checkouts", w.checkouts], w.spec, defaultSeams());
    expect(text.out.join("\n")).toContain("0 resolve, 5 failing");
    expect(text.out.join("\n")).toContain("member ZZ (unresolved) unresolved");
  });

  it("refuses a checkout whose origin is another repository, and one with no line", async () => {
    const w = world("https://github.com/fixture-owner/elsewhere.git");
    const dir = folder(w, `- **FR-001**: ${cite(w.first)}\n`);
    const run = await spec(["cite-check", "--folder", dir, "--checkouts", w.checkouts], w.spec, defaultSeams(), true);
    expect(run.code).toBe(1);
    expect((run.json()["members"] as { reason: string }[])[0]?.reason).toContain("origin reads fixture-owner/elsewhere");
    writeFileSync(w.checkouts, "# none\n");
    const none = await spec(["cite-check", "--folder", dir, "--checkouts", w.checkouts], w.spec, defaultSeams(), true);
    expect((none.json()["members"] as { reason: string }[])[0]?.reason).toContain("has no line for fixture-owner/fixture-app");
  });

  it("compares the excerpt hash a sidecar inventory row carries, and reports rows it lacks", async () => {
    const w = world();
    const good = sha256(excerptOf(lines("list", 30), 10, 12) ?? "");
    mkdirSync(join(w.spec, "capture", "FX"), { recursive: true });
    writeFileSync(join(w.spec, "capture", "FX", "inventory.json"), JSON.stringify({
      rows: [
        { id: "r1", path: "app/List.kt", lines: "10-12", sha: w.first, excerptSha256: good },
        { id: "r2", path: "app/List.kt", lines: [1, 2], sha: w.first, excerptSha256: "0".repeat(64) },
        { id: "r3", path: "app/List.kt", lines: "3-4", sha: w.first },
      ],
    }));
    const dir = folder(w, [`- **FR-001**: ${cite(w.first.slice(0, 10))}`, `- **FR-002**: ${cite(w.first, "1-2")}`, `- **FR-003**: ${cite(w.first, "3-4")}`, `- **FR-004**: ${cite(w.first, "5-6")}`, ""].join("\n"));
    const run = await spec(["cite-check", "--folder", dir, "--checkouts", w.checkouts, "--verify-excerpt"], w.spec, defaultSeams(), true);
    expect(run.code).toBe(1);
    expect((run.json()["citations"] as { excerpt: string }[]).map((entry) => entry.excerpt)).toEqual(["match", "mismatch", "no-hash", "no-row"]);
    expect(run.json()["counts"]).toMatchObject({ excerptMismatch: 1, failing: 0 });
  });

  it("exits 1 on an inventory it cannot read as rows -- never 'no row'", async () => {
    const w = world();
    mkdirSync(join(w.spec, "capture", "FX"), { recursive: true });
    writeFileSync(join(w.spec, "capture", "FX", "inventory.json"), "{ not json");
    const dir = folder(w, `- **FR-001**: ${cite(w.first)}\n`);
    const run = await spec(["cite-check", "--folder", dir, "--checkouts", w.checkouts, "--verify-excerpt"], w.spec, defaultSeams());
    expect(run.code).toBe(1);
    expect(run.err.join("\n")).toContain("could not read capture/FX/inventory.json");
  });

  it("with --at HEAD, reports a range that reads differently now as a [STALE] candidate and rewrites nothing", async () => {
    const w = world();
    const dir = folder(w, `- **FR-001**: ${cite(w.first, "10-12")}\n- **FR-002**: ${cite(w.first, "20-21")}\n`);
    const changed = lines("list", 30).replace("list 11\n", "list eleven\n");
    writeFileSync(join(w.member, "app", "List.kt"), changed);
    git(w.member, "commit", "-q", "-am", "two");
    const run = await spec(["cite-check", "--folder", dir, "--checkouts", w.checkouts, "--at", "HEAD"], w.spec, defaultSeams(), true);
    expect(run.code).toBe(0);
    expect((run.json()["citations"] as { stale: boolean }[]).map((entry) => entry.stale)).toEqual([true, false]);
    expect(run.json()["counts"]).toMatchObject({ stale: 1 });
    expect((run.json()["members"] as { at: string }[])[0]?.at).toBe(git(w.member, "rev-parse", "HEAD"));
    const unknown = await spec(["cite-check", "--folder", dir, "--checkouts", w.checkouts, "--at", "abcdef1"], w.spec, defaultSeams(), true);
    expect(unknown.code).toBe(1);
    expect((unknown.json()["citations"] as { stale: unknown }[]).map((entry) => entry.stale)).toEqual([null, null]);
  });

  it.each([
    [["cite-check", "--checkouts", "/x"], "--folder is required"],
    [["cite-check", "--folder", "specs/001-sample-feature"], "--checkouts is required"],
    [["cite-check", "--folder", "specs/001-sample-feature", "--checkouts", "/nonexistent/checkouts"], "could not be read"],
    [["cite-check", "--folder", "specs/001-sample-feature", "--checkouts", "/x", "--at", "main"], "neither HEAD nor"],
  ])("%j exits 2", async (argv, words) => {
    const run = await spec(argv, fixtureCopy(), defaultSeams());
    expect(run.code).toBe(2);
    expect(run.err.join("\n")).toContain(words);
  });

  it("exits 1 on a folder that is not there", async () => {
    const w = world();
    const run = await spec(["cite-check", "--folder", "specs/404-none", "--checkouts", w.checkouts], w.spec, defaultSeams());
    expect(run.code).toBe(1);
  });
});

describe("the checkouts file", () => {
  it("reads tab-separated lines and skips comments and blanks", () => {
    expect([...parseCheckouts("# c\n\nfixture-owner/a\t/abs/a path\r\n", "f")]).toEqual([["fixture-owner/a", "/abs/a path"]]);
  });
  it.each(["fixture-owner/a /abs", "fixture-owner/a\trelative", "not-a-slug\t/abs", "o/..\t/abs", "o/a\t/abs\no/a\t/abs2", "o/a\t"])("refuses %j by line", (text) => {
    expect(() => parseCheckouts(text, "f")).toThrow(VerbUsageError);
  });
});

describe("excerptOf", () => {
  it("is lines l1..l2 each ending in a newline, and null past the end", () => {
    expect(excerptOf("a\nb\nc\n", 2, 3)).toBe("b\nc\n");
    expect(excerptOf("a\nb\nc", 3, 3)).toBe("c\n");
    expect(excerptOf("a\n", 1, 2)).toBeNull();
    expect(excerptOf("a\n", 2, 1)).toBeNull();
  });
});
