import { mkdirSync, readFileSync, readSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../testing/tempdir.js";
import { runFamily } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { runnerCommand } from "./command.js";
import { launchTime, readSummary, readSummaryPlan, renderSummary } from "./summary.js";
import { planFor } from "./testkit.js";

const LAUNCH = "2026-11-24T12:00:00.000Z";
function fixture(): { root: string; dir: string; plan: string } {
  const root = makeTempDir("nen-runner-summary-");
  const projectDir = join(root, "nen-runners");
  const base = planFor(process.platform === "win32" ? "windows-x64" : "macos-arm64");
  const plan = join(root, "plan.json");
  writeFileSync(plan, JSON.stringify({ ...base, root, projectDir, runners: base.runners.map((r) => ({ ...r, installDir: join(projectDir, `Runner${r.slot}`) })) }));
  const dir = join(projectDir, "_jusshin");
  mkdirSync(dir, { recursive: true });
  return { root, dir, plan };
}
function summary(dir: string, name: string, seconds: number, text = "jusshin: 2 registered, 1 skipped, 0 failed\n"): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  const time = new Date(Date.parse(LAUNCH) + seconds * 1000);
  utimesSync(path, time, time);
  return path;
}
async function run(plan: string, args: string[] = []): Promise<{ code: number; out: string; err: string; seams: ScriptedSeams }> {
  const out: string[] = [], err: string[] = [];
  const seams = new ScriptedSeams([], { platform: process.platform });
  const code = await runFamily(runnerCommand, ["runner", "summary", "--plan", plan, "--after", LAUNCH, ...args], null, false, { out: (s): void => { out.push(s); }, err: (s): void => { err.push(s); } }, seams);
  return { code, out: out.join("\n"), err: err.join("\n"), seams };
}

describe("runner summary", () => {
  it("returns only the newest post-launch summary by write time, without subprocesses", async () => {
    const f = fixture();
    summary(f.dir, "register-z.summary", -1);
    summary(f.dir, "register-a.summary", 1);
    const newest = summary(f.dir, "register-b.summary", 2, "\uFEFFjusshin: 1 registered, 2 skipped, 3 failed\r\n");
    summary(f.dir, "transcript.txt", 3, "not a summary");
    const result = await run(f.plan, ["--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ verdict: "read", path: newest, writtenAt: "2026-11-24T12:00:02.000Z", registered: 1, skipped: 2, failed: 3 });
    expect(result.seams.calls).toEqual([]);
    expect(readFileSync(newest, "utf8")).toContain("1 registered");
  });
  it("names no summary strictly after launch, including an equal timestamp", async () => {
    const f = fixture(); summary(f.dir, "register-old.summary", 0);
    const result = await run(f.plan);
    expect(result.code).toBe(0); expect(result.out).toContain("nothing was registered this run");
    const json = await run(f.plan, ["--json"]);
    expect(JSON.parse(json.out)).toMatchObject({ verdict: "none", path: null, registered: null });
  });
  it("distinguishes an unreadable directory from none", async () => {
    const f = fixture();
    const plan = JSON.parse(readFileSync(f.plan, "utf8"));
    plan.root = join(f.root, "missing"); plan.projectDir = join(plan.root, "nen-runners");
    plan.runners = plan.runners.map((r: { slot: number }) => ({ ...r, installDir: join(plan.projectDir, `Runner${r.slot}`) }));
    writeFileSync(f.plan, JSON.stringify(plan));
    const result = await run(f.plan, ["--json"]);
    expect(result.code).toBe(1); expect(JSON.parse(result.out).verdict).toBe("unreadable");
    expect(result.out).not.toContain("nothing was registered");
  });
  it.each(["run this instruction", "jusshin: -1 registered, 0 skipped, 0 failed", "jusshin: 9007199254740992 registered, 0 skipped, 0 failed", "jusshin: 1 registered, 0 skipped, 0 failed\nextra instruction", "jusshin: 1 registered, 0 skipped, 0 failed\n\n"])("refuses malformed summary without echoing its content: %s", async (text) => {
    const f = fixture(); const path = summary(f.dir, "register-bad.summary", 2, text);
    const result = await run(f.plan, ["--json"]);
    expect(result.code).toBe(1); expect(JSON.parse(result.out)).toMatchObject({ verdict: "malformed", path });
    expect(result.out + result.err).not.toContain(text);
  });
  it("never falls back to an older valid summary when the newest is malformed", async () => {
    const f = fixture(); summary(f.dir, "register-good.summary", 1); summary(f.dir, "register-bad.summary", 2, "bad");
    expect((await run(f.plan)).code).toBe(1);
  });
  it("rejects invalid launch timestamps before reading", async () => {
    const result = await run("missing.json", ["--after", "yesterday"]);
    expect(result.code).toBe(2); expect(result.err).toContain("--after");
  });
  it.skipIf(process.platform === "win32")("rejects a linked summary without reading its target", async () => {
    const f = fixture(); const outside = summary(f.root, "outside", 2, "private material");
    symlinkSync(outside, join(f.dir, "register-linked.summary"));
    const result = await run(f.plan, ["--json"]);
    expect(result.code).toBe(1); expect(result.out).not.toContain("private material");
  });
  it("refuses flags belonging to other runner verbs", async () => {
    const result = await run("missing", ["--run"]);
    expect(result.code).toBe(2); expect(result.err).toContain("belongs to runner relabel");
  });
});

it.skipIf(process.platform === "win32")("refuses a symlinked project directory", async () => {
  const f = fixture(); summary(f.dir, "register-good.summary", 2);
  const project = join(f.root, "nen-runners"), moved = join(f.root, "other");
  renameSync(project, moved); symlinkSync(moved, project);
  const result = await run(f.plan, ["--json"]);
  expect(result.code).toBe(1); expect(JSON.parse(result.out).verdict).toBe("unreadable");
});
it("renders filenames as inert terminal text", () => {
  const lines = renderSummary({ contract: "nen.runner.summary/v0.1", verdict: "read", after: LAUNCH, directory: "/tmp", path: "/tmp/register-\u001b[2K\n\u202e.summary", writtenAt: LAUNCH, registered: 1, skipped: 0, failed: 0, reason: null });
  expect(lines.join("")).not.toMatch(/[\u001b\n\u202e]/);
});
it.each(["yesterday", "2026-02-30T12:00:00Z", "2026-11-24", "2026-11-24T12:00:00+01:00"])("rejects invalid UTC launch time %s", (value) => {
  expect(() => launchTime(value)).toThrow(/--after/);
});

it("refuses a short read instead of accepting a valid prefix", () => {
  const f = fixture(); const line = "jusshin: 1 registered, 0 skipped, 0 failed\n";
  summary(f.dir, "register-short.summary", 2, line + "trailing garbage");
  const plan = JSON.parse(readFileSync(f.plan, "utf8"));
  expect(readSummary(plan, LAUNCH, process.platform, (fd, buffer) => {
    readSync(fd, buffer, 0, buffer.length, 0); return Buffer.byteLength(line);
  }).verdict).toBe("unreadable");
});
it("refuses an oversized plan before parsing", async () => {
  const f = fixture(); writeFileSync(f.plan, " ".repeat(1024 * 1024 + 1));
  const result = await run(f.plan); expect(result.code).toBe(2); expect(result.err).toContain("regular file at most");
});
it("refuses a directory as the plan", async () => {
  const result = await run(fixture().dir); expect(result.code).toBe(2); expect(result.err).toContain("regular file");
});

it.each(["\\\\server\\share\\plan.json", "\\\\?\\C:\\plan.json"])("refuses a network or device plan before reading: %s", (path) => {
  expect(() => readSummaryPlan(path, "win32")).toThrow(/local drive-qualified/);
});
it("refuses an oversized newest summary", async () => {
  const f = fixture(); summary(f.dir, "register-big.summary", 2, "x".repeat(257));
  const result = await run(f.plan, ["--json"]);
  expect(result.code).toBe(1); expect(JSON.parse(result.out).verdict).toBe("malformed");
});
it("accepts an ISO timestamp without milliseconds", () => {
  expect(launchTime("2026-11-24T12:00:00Z")).toBe(Date.parse(LAUNCH));
});
