import { describe, expect, it } from "vitest";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { CertificationRefusal, enablePool, renderEnable, variableGetArgv, variableSetArgv } from "./enable.js";
import { contentsArgv, defaultBranchArgv, jobsArgv, runArgv } from "./preflight.js";
import { pool, TARGET } from "./testkit.js";

const at = (argv: readonly string[]): string => `gh ${argv.join(" ")}`;
const WINDOWS = { ...pool("windows-x64"), enableVariable: "NEN_WINDOWS_RUNNER" };
const FILE = ".github/workflows/runner-preflight-windows-x64.yml";
const HEAD = "a".repeat(40);

/** The default branch and the workflow's blob at the run's head and at the default branch. */
function provenance(blobs: { readonly head?: ScriptedCall["result"]; readonly main?: ScriptedCall["result"] } = {}): ScriptedCall[] {
  return [
    { match: at(defaultBranchArgv(TARGET)), result: { stdout: '{"defaultBranchRef":{"name":"main"}}' } },
    { match: at(contentsArgv(TARGET, FILE, HEAD)), result: blobs.head ?? { stdout: '{"sha":"1111"}' } },
    { match: at(contentsArgv(TARGET, FILE, "main")), result: blobs.main ?? { stdout: '{"sha":"1111"}' } },
  ];
}

function greenRun(overrides: Record<string, unknown> = {}, job: Record<string, unknown> = {}, blobs: Parameters<typeof provenance>[0] = {}): ScriptedCall[] {
  return [
    {
      match: at(runArgv(TARGET, 901)),
      result: { stdout: JSON.stringify({ status: "completed", conclusion: "success", path: FILE, html_url: "u", event: "workflow_dispatch", head_branch: "main", head_sha: HEAD, ...overrides }) },
    },
    {
      match: at(jobsArgv(TARGET, 901)),
      result: { stdout: JSON.stringify({ jobs: [{ name: "preflight", status: "completed", conclusion: "success", runner_name: "NZ-NNR1", labels: ["self-hosted", "Windows", "X64"], ...job }] }) },
    },
    ...provenance(blobs),
  ];
}

describe("enablePool -- the variable is written only after a green preflight of THIS pool", () => {
  it("sets the variable, reads it back, and reports the previous value", () => {
    const seams = new ScriptedSeams([
      ...greenRun(),
      { match: at(variableGetArgv(TARGET, "NEN_WINDOWS_RUNNER")), result: { code: 1, stderr: "variable NEN_WINDOWS_RUNNER was not found" } },
      { match: at(variableGetArgv(TARGET, "NEN_WINDOWS_RUNNER")), result: { stdout: "online\n" } },
      { match: at(variableSetArgv(TARGET, "NEN_WINDOWS_RUNNER", "online")), result: {} },
    ]);
    const report = enablePool(seams, TARGET, WINDOWS, 901, "online", false);
    expect(report).toEqual({ target: "zheref/nen", pool: "windows-x64", variable: "NEN_WINDOWS_RUNNER", value: "online", previous: null, runId: 901, changed: true, dryRun: false });
    expect(seams.calls.map((call) => call.args.slice(0, 2).join(" "))).toEqual(["api --method", "api --method", "repo view", "api --method", "api --method", "variable get", "variable set", "variable get"]);
    expect(renderEnable(report)[0]).toBe("NEN_WINDOWS_RUNNER=online on zheref/nen (was unset); pool windows-x64 proved by run 901.");
  });

  it("is idempotent: a variable already holding the value is not written", () => {
    const seams = new ScriptedSeams([...greenRun(), { match: at(variableGetArgv(TARGET, "NEN_WINDOWS_RUNNER")), result: { stdout: "online" } }]);
    const report = enablePool(seams, TARGET, WINDOWS, 901, "online", false);
    expect(report.changed).toBe(false);
    expect(seams.calls.some((call) => call.args[1] === "set")).toBe(false);
    expect(renderEnable(report)[0]).toMatch(/already reads 'online'/);
  });

  it("writes nothing under --dry-run, after still certifying the run", () => {
    const seams = new ScriptedSeams([...greenRun(), { match: at(variableGetArgv(TARGET, "NEN_WINDOWS_RUNNER")), result: { stdout: "offline" } }]);
    const report = enablePool(seams, TARGET, WINDOWS, 901, "online", true);
    expect(report).toMatchObject({ changed: true, dryRun: true, previous: "offline" });
    expect(seams.calls.some((call) => call.args[1] === "set")).toBe(false);
    expect(renderEnable(report).join("\n")).toMatch(/\(dry run\) would set NEN_WINDOWS_RUNNER=online[\s\S]*would run: gh variable set NEN_WINDOWS_RUNNER --body online --repo zheref\/nen/);
  });

  it.each([
    ["another workflow file", greenRun({ path: ".github/workflows/ci.yml" }), /not \.github\/workflows\/runner-preflight-windows-x64\.yml/],
    ["a run still in progress", greenRun({ status: "in_progress", conclusion: null }), /not completed/],
    ["a failed run", greenRun({ conclusion: "failure" }), /concluded 'failure'/],
    ["a green run on ANOTHER pool's labels", greenRun({}, { labels: ["self-hosted", "macOS", "ARM64"] }), /did not ask for pool windows-x64's labels \(missing Windows, X64\)/],
    ["a skipped job", greenRun({}, { conclusion: "skipped" }), /job 'preflight' concluded 'skipped'/],
    ["a push run (#319)", greenRun({ event: "push" }), /triggered by 'push', not workflow_dispatch/],
    ["a dispatch on another branch (#319)", greenRun({ head_branch: "feature/x" }), /ran on 'feature\/x', not the default branch 'main'/],
    ["an edited copy of the workflow (#319)", greenRun({}, {}, { head: { stdout: '{"sha":"2222"}' } }), /at aaaaaaaaaaaa is blob 2222, not the default branch's blob 1111/],
    ["a head that does not carry the workflow (#319)", greenRun({}, {}, { head: { code: 1, stderr: "HTTP 404: Not Found" } }), /at aaaaaaaaaaaa is absent, not the default branch's blob 1111/],
    ["a workflow the default branch does not carry (#319)", greenRun({}, {}, { main: { code: 1, stderr: "HTTP 404: Not Found" } }), /is not on the default branch 'main'/],
    ["a run naming no head_sha (#319)", greenRun({ head_sha: "" }), /names no head_sha/],
  ])("refuses %s, and sets nothing", (_case, calls, pattern) => {
    const seams = new ScriptedSeams(calls);
    expect(() => enablePool(seams, TARGET, WINDOWS, 901, "online", false)).toThrow(pattern);
    expect(() => enablePool(seams, TARGET, WINDOWS, 901, "online", false)).toThrow(expect.objectContaining({ exitCode: 1 }));
    expect(seams.calls.some((call) => call.args[0] === "variable")).toBe(false);
  });

  it("refuses a run with no jobs", () => {
    const seams = new ScriptedSeams([greenRun()[0] as ScriptedCall, { match: at(jobsArgv(TARGET, 901)), result: { stdout: '{"jobs":[]}' } }, ...provenance()]);
    expect(() => enablePool(seams, TARGET, WINDOWS, 901, "online", false)).toThrow(/it has no jobs/);
  });

  it("names every refusing check on the refusal, in order (#319)", () => {
    const seams = new ScriptedSeams(greenRun({ event: "push", head_branch: "feature/x" }, {}, { head: { stdout: '{"sha":"2222"}' } }));
    let refusal: unknown;
    try {
      enablePool(seams, TARGET, WINDOWS, 901, "online", true);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(CertificationRefusal);
    expect((refusal as CertificationRefusal).problems.map((problem) => problem.check)).toEqual(["event", "branch", "blob"]);
  });

  it("is exit 1 when a workflow blob cannot be read, or answers something unreadable", () => {
    const refused = new ScriptedSeams(greenRun({}, {}, { head: { code: 1, stderr: "HTTP 403: Resource not accessible" } }));
    expect(() => enablePool(refused, TARGET, WINDOWS, 901, "online", false)).toThrow(/reading \.github\/workflows\/runner-preflight-windows-x64\.yml at a{40}.*needs admin/);
    const garbled = new ScriptedSeams(greenRun({}, {}, { main: { stdout: "<html>" } }));
    expect(() => enablePool(garbled, TARGET, WINDOWS, 901, "online", false)).toThrow(/answered something that is not JSON/);
  });

  it("is exit 1 when the read-back disagrees, or when reading the variable is refused", () => {
    const disagree = new ScriptedSeams([
      ...greenRun(),
      { match: at(variableGetArgv(TARGET, "NEN_WINDOWS_RUNNER")), result: { stdout: "offline" } },
      { match: at(variableGetArgv(TARGET, "NEN_WINDOWS_RUNNER")), result: { stdout: "offline" } },
      { match: at(variableSetArgv(TARGET, "NEN_WINDOWS_RUNNER", "online")), result: {} },
    ]);
    expect(() => enablePool(disagree, TARGET, WINDOWS, 901, "online", false)).toThrow(/reading it back answered 'offline'/);
    const forbidden = new ScriptedSeams([...greenRun(), { match: at(variableGetArgv(TARGET, "NEN_WINDOWS_RUNNER")), result: { code: 1, stderr: "HTTP 403: Resource not accessible" } }]);
    expect(() => enablePool(forbidden, TARGET, WINDOWS, 901, "online", false)).toThrow(/needs admin on zheref\/nen/);
    const setRefused = new ScriptedSeams([
      ...greenRun(),
      { match: at(variableGetArgv(TARGET, "NEN_WINDOWS_RUNNER")), result: { stdout: "offline" } },
      { match: at(variableSetArgv(TARGET, "NEN_WINDOWS_RUNNER", "online")), result: { code: 1, stderr: "boom" } },
    ]);
    expect(() => enablePool(setRefused, TARGET, WINDOWS, 901, "online", false)).toThrow(/setting the repository variable NEN_WINDOWS_RUNNER failed on zheref\/nen: boom/);
  });
});
