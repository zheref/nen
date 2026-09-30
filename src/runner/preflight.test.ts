import { describe, expect, it } from "vitest";
import { VerbUsageError } from "../cli/command.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { defaultBranchArgv, dispatchArgv, jobsArgv, osOfLabels, renderPreflight, runArgv, runListArgv, runPreflight } from "./preflight.js";
import { TARGET } from "./testkit.js";

const WORKFLOW = "runner-preflight-windows-x64.yml";
const at = (argv: readonly string[]): string => `gh ${argv.join(" ")}`;

const OLD_RUN = { databaseId: 900, createdAt: "2026-09-30T10:00:00Z", status: "completed", conclusion: "success", headBranch: "main", event: "workflow_dispatch" };
const NEW_RUN = { databaseId: 901, createdAt: "2026-09-30T12:00:00Z", status: "queued", conclusion: "", headBranch: "main", event: "workflow_dispatch" };
const PUSH_RUN = { databaseId: 902, createdAt: "2026-09-30T12:00:01Z", status: "queued", conclusion: "", headBranch: "main", event: "push" };

function run(status: string, conclusion: string | null): string {
  return JSON.stringify({
    id: 901,
    html_url: "https://github.com/zheref/nen/actions/runs/901",
    status,
    conclusion,
    path: `.github/workflows/${WORKFLOW}`,
    head_branch: "main",
  });
}

function jobs(status: string, conclusion: string | null, runner: string | null): string {
  return JSON.stringify({ total_count: 1, jobs: [{ name: "preflight", status, conclusion, runner_name: runner, labels: ["self-hosted", "Windows", "X64"] }] });
}

function base(): ScriptedCall[] {
  return [
    { match: at(defaultBranchArgv(TARGET)), result: { stdout: '{"defaultBranchRef":{"name":"main"}}' } },
    { match: at(runListArgv(TARGET, WORKFLOW)), result: { stdout: JSON.stringify([OLD_RUN]) } },
    { match: at(runListArgv(TARGET, WORKFLOW)), result: { stdout: JSON.stringify([PUSH_RUN, OLD_RUN]) } },
    { match: at(runListArgv(TARGET, WORKFLOW)), result: { stdout: JSON.stringify([NEW_RUN, PUSH_RUN, OLD_RUN]) } },
    { match: at(dispatchArgv(TARGET, WORKFLOW, "main")), result: {} },
  ];
}

describe("runPreflight -- dispatch, find OUR run, wait for its verdict", () => {
  it("finds the new workflow_dispatch run by id, ignores a push run, and reports success with the runner", () => {
    const seams = new ScriptedSeams([
      ...base(),
      { match: at(runArgv(TARGET, 901)), result: { stdout: run("queued", null) } },
      { match: at(runArgv(TARGET, 901)), result: { stdout: run("completed", "success") } },
      { match: at(jobsArgv(TARGET, 901)), result: { stdout: jobs("queued", null, null) } },
      { match: at(jobsArgv(TARGET, 901)), result: { stdout: jobs("completed", "success", "NZ-NNR2") } },
    ]);
    const slept: number[] = [];
    const report = runPreflight(seams, TARGET, { workflow: WORKFLOW, ref: null, waitSeconds: 600, dryRun: false, sleep: (ms) => slept.push(ms) });
    expect(report).toMatchObject({
      verdict: "success",
      runId: 901,
      url: "https://github.com/zheref/nen/actions/runs/901",
      conclusion: "success",
      runnerName: "NZ-NNR2",
      runnerOs: "Windows",
      ref: "main",
    });
    // One 5 s wait while only the push run was new, one 10 s poll while it ran.
    expect(slept).toEqual([5_000, 10_000]);
    expect(seams.calls.filter((call) => call.args[0] === "workflow")).toHaveLength(1);
    expect(renderPreflight(report)[0]).toMatch(/^success: runner-preflight-windows-x64\.yml on zheref\/nen@main -- run 901 succeeded on NZ-NNR2/);
  });

  it("names a job still queued at the deadline: no free runner picked it up", () => {
    const seams = new ScriptedSeams([
      ...base(),
      { match: at(runArgv(TARGET, 901)), result: { stdout: run("queued", null) } },
      { match: at(jobsArgv(TARGET, 901)), result: { stdout: jobs("queued", null, null) } },
    ]);
    const report = runPreflight(seams, TARGET, { workflow: WORKFLOW, ref: "main", waitSeconds: 20, dryRun: false, sleep: () => {} });
    expect(report.verdict).toBe("queued");
    expect(report.detail).toMatch(/^queued 20s -- no free runner picked it up \(self-hosted, Windows, X64\)/);
    expect(report.runnerName).toBeNull();
  });

  it("reports a failed run and an in-progress timeout as failures", () => {
    const failed = new ScriptedSeams([
      ...base(),
      { match: at(runArgv(TARGET, 901)), result: { stdout: run("completed", "failure") } },
      { match: at(jobsArgv(TARGET, 901)), result: { stdout: jobs("completed", "failure", "NZ-NNR1") } },
    ]);
    expect(runPreflight(failed, TARGET, { workflow: WORKFLOW, ref: "main", waitSeconds: 0, dryRun: false, sleep: () => {} }).verdict).toBe("failure");
    const running = new ScriptedSeams([
      ...base(),
      { match: at(runArgv(TARGET, 901)), result: { stdout: run("in_progress", null) } },
      { match: at(jobsArgv(TARGET, 901)), result: { stdout: jobs("in_progress", null, "NZ-NNR1") } },
    ]);
    const report = runPreflight(running, TARGET, { workflow: WORKFLOW, ref: "main", waitSeconds: 0, dryRun: false, sleep: () => {} });
    expect(report.verdict).toBe("timeout");
    expect(report.runnerName).toBe("NZ-NNR1");
  });

  it("refuses at exit 2 a workflow the ref does not carry: merge it first", () => {
    const seams = new ScriptedSeams([
      { match: at(runListArgv(TARGET, WORKFLOW)), result: { stdout: "[]" } },
      { match: at(dispatchArgv(TARGET, WORKFLOW, "main")), result: { code: 1, stderr: "could not find any workflows named runner-preflight-windows-x64.yml" } },
    ]);
    expect(() => runPreflight(seams, TARGET, { workflow: WORKFLOW, ref: "main", waitSeconds: 0, dryRun: false, sleep: () => {} })).toThrow(VerbUsageError);
    expect(() => runPreflight(seams, TARGET, { workflow: WORKFLOW, ref: "main", waitSeconds: 0, dryRun: false, sleep: () => {} })).toThrow(/Merge the preflight workflow first/);
  });

  it("is exit 1 when the dispatch is refused otherwise, or no run appears within 60 s", () => {
    const refused = new ScriptedSeams([
      { match: at(runListArgv(TARGET, WORKFLOW)), result: { stdout: "[]" } },
      { match: at(dispatchArgv(TARGET, WORKFLOW, "main")), result: { code: 1, stderr: "HTTP 422: Workflow does not have 'workflow_dispatch' trigger" } },
    ]);
    expect(() => runPreflight(refused, TARGET, { workflow: WORKFLOW, ref: "main", waitSeconds: 0, dryRun: false, sleep: () => {} })).toThrow(expect.objectContaining({ exitCode: 1 }));
    const silent = new ScriptedSeams([
      { match: at(runListArgv(TARGET, WORKFLOW)), result: { stdout: "[]" } },
      { match: at(dispatchArgv(TARGET, WORKFLOW, "main")), result: {} },
    ]);
    const slept: number[] = [];
    expect(() => runPreflight(silent, TARGET, { workflow: WORKFLOW, ref: "main", waitSeconds: 0, dryRun: false, sleep: (ms) => slept.push(ms) })).toThrow(/no new workflow_dispatch run appeared in 60s/);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(60_000);
  });

  it("dispatches nothing under --dry-run, and still reads the default branch", () => {
    const seams = new ScriptedSeams([{ match: at(defaultBranchArgv(TARGET)), result: { stdout: '{"defaultBranchRef":{"name":"trunk"}}' } }]);
    const report = runPreflight(seams, TARGET, { workflow: WORKFLOW, ref: null, waitSeconds: 600, dryRun: true, sleep: () => {} });
    expect(report.verdict).toBe("dry-run");
    expect(report.detail).toBe(`would run: gh workflow run ${WORKFLOW} --repo zheref/nen --ref trunk`);
    expect(seams.calls).toHaveLength(1);
  });

  it("refuses a repository that answers no default branch", () => {
    const seams = new ScriptedSeams([{ match: at(defaultBranchArgv(TARGET)), result: { stdout: "{}" } }]);
    expect(() => runPreflight(seams, TARGET, { workflow: WORKFLOW, ref: null, waitSeconds: 0, dryRun: true, sleep: () => {} })).toThrow(/pass --ref/);
  });

  it("reads the OS off a job's labels", () => {
    expect(osOfLabels(["self-hosted", "linux", "X64"])).toBe("Linux");
    expect(osOfLabels(["ubuntu-latest"])).toBeNull();
  });
});
