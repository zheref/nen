// The family end to end, through ../index.ts's runFamily: flags, the exit-code
// table, the declaration read from a scratch --repo, and files written where
// the flags say. Every gh answer is scripted; no test here opens a socket.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { findCommand } from "../cli/registry.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { isUnder, makeRunnerCommand, RUNNER_SUBCOMMANDS, RUNNER_SUBCOMMAND_FLAGS } from "./command.js";
import { defaultBranchArgv } from "./preflight.js";
import { DESKTOP_POOL_BODY, FIXTURES, inventoryCalls, POLICY_BODY, runnersAnswer, TARGET, windowsServicesCall } from "./testkit.js";
import { runnersArgv } from "./inventory.js";

const COMMAND = makeRunnerCommand({ sleep: () => {}, version: "0.0.0-test" });

interface Outcome {
  readonly code: number;
  readonly out: string;
  readonly err: string;
  readonly seams: ScriptedSeams;
}

async function run(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  platform: NodeJS.Platform = "win32",
  env: Readonly<Record<string, string>> = { HOME: "/home/maintainer" },
): Promise<Outcome> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const seams = new ScriptedSeams(script, { platform, env });
  const code = await runFamily(COMMAND, ["runner", ...argv], null, false, io, seams);
  return { code, out: out.join("\n"), err: err.join("\n"), seams };
}

/** A scratch consumer checkout: the fixture runners block, and nen's own registry. */
function consumer(runners: unknown = POLICY_BODY): string {
  const root = mkdtempSync(join(tmpdir(), "nen-runner-"));
  mkdirSync(join(root, "nen"), { recursive: true });
  writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify(runners === null ? {} : { runners }));
  writeFileSync(join(root, "nen", "repos.json"), readFileSync(join(process.cwd(), "nen", "repos.json"), "utf8"));
  return root;
}

describe("nen runner -- the family", () => {
  it("is registered, and every verb's flags are declared", () => {
    expect(findCommand("runner")?.name).toBe("runner");
    expect(Object.keys(RUNNER_SUBCOMMAND_FLAGS).sort()).toEqual([...RUNNER_SUBCOMMANDS].sort());
    for (const flags of Object.values(RUNNER_SUBCOMMAND_FLAGS)) {
      for (const flag of flags) expect([...(COMMAND.flags.values ?? []), ...(COMMAND.flags.booleans ?? [])]).toContain(flag);
    }
  });

  it("refuses a flag another verb owns, naming its owner, at exit 2", async () => {
    const result = await run(["plan", "--force"]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/--force is not a 'runner plan' flag \(it belongs to runner workflow\)/);
  });

  it("refuses an unknown subcommand at exit 2", async () => {
    expect((await run(["register"])).code).toBe(2);
  });
});

describe("nen runner inventory", () => {
  it("groups the recorded runners by the declared pools under --json", async () => {
    const root = consumer();
    const result = await run(["inventory", "--target", "zheref/nen", "--repo", root, "--json"], inventoryCalls());
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(Object.keys(report)).toEqual(["target", "runners", "downloads", "pools", "unpooled"]);
    expect(report.pools.find((pool: { id: string }) => pool.id === "macos-arm64")).toEqual({
      id: "macos-arm64",
      labels: ["self-hosted", "macOS", "ARM64"],
      runners: ["RJ2-NNR1", "RJ2-NNR2", "RJ2-NNR3"],
      online: 3,
      free: 3,
    });
  });

  it("falls back to --repo's origin when --target is absent, and groups nothing without --repo", async () => {
    const result = await run(["inventory"], [
      { match: "git remote get-url origin", result: { stdout: "https://github.com/zheref/nen.git\n" } },
      ...inventoryCalls(),
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^zheref\/nen: 3 self-hosted runner\(s\)/);
    expect(result.out).not.toMatch(/^pool /m);
  });

  it("is exit 1 naming admin on a 403, with the token redacted, and exit 5 without gh", async () => {
    const forbidden = await run(["inventory", "--target", "zheref/nen"], [
      { match: `gh ${runnersArgv(TARGET, 1).join(" ")}`, result: { code: 1, stderr: "HTTP 403 for https://x:ghp_abcdefghijklmnopqrstuvwxyz0123@api.github.com" } },
    ]);
    expect(forbidden.code).toBe(1);
    expect(forbidden.err).toMatch(/needs admin on zheref\/nen/);
    expect(forbidden.err).not.toMatch(/ghp_/);
    const missing = await run(["inventory", "--target", "zheref/nen"], [{ match: `gh ${runnersArgv(TARGET, 1).join(" ")}`, result: { spawnFailed: true, stderr: "ENOENT" } }]);
    expect(missing.code).toBe(5);
    expect(missing.err).toMatch(/'gh' could not be started/);
  });

  it("refuses a malformed --target, and --pool without a runners block, at exit 2", async () => {
    expect((await run(["inventory", "--target", "not-a-slug"])).code).toBe(2);
    const bare = await run(["inventory", "--target", "zheref/nen", "--repo", consumer(null), "--pool", "windows-x64"]);
    expect(bare.code).toBe(2);
    expect(bare.err).toMatch(/declares no 'runners' block/);
  });
});

describe("nen runner plan", () => {
  const flags = ["plan", "--target", "zheref/nen", "--pool", "windows-x64", "--machine-code", "nz", "--count", "3", "--service-account", "lordzheref"];

  it("derives the consumer code from repos.json, writes --out, and prints the plan", async () => {
    const root = consumer();
    const result = await run([...flags, "--repo", root, "--out", "plan.json", "--json"], [...inventoryCalls(), windowsServicesCall()]);
    expect(result.code, result.err).toBe(0);
    const plan = JSON.parse(result.out);
    expect(plan.contract).toBe("nen.runner.plan/v0.2");
    expect(plan.consumerCode).toBe("NN");
    expect(plan.machineCode).toBe("NZ");
    expect(plan.runners.map((runner: { name: string }) => runner.name)).toEqual(["NZ-NNR1", "NZ-NNR2", "NZ-NNR3"]);
    // --out resolves against --repo, like every other path flag.
    expect(JSON.parse(readFileSync(join(root, "plan.json"), "utf8"))).toEqual(plan);
  });

  it.each([
    [["--machine-code"], /--machine-code is required/],
    [["--count"], /--count is required/],
    [["--pool"], /--pool is required/],
  ])("refuses a missing %s at exit 2", async (drop, pattern) => {
    const argv = [...flags, "--repo", consumer()];
    const index = argv.indexOf(drop[0] as string);
    argv.splice(index, 2);
    const result = await run(argv);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(pattern);
  });

  it("refuses a bad count, an unknown pool and no runners block at exit 2, before any gh call", async () => {
    const root = consumer();
    for (const [argv, pattern] of [
      [[...flags, "--repo", root].map((token) => (token === "3" ? "20" : token)), /from 1 to 16/],
      [[...flags, "--repo", root].map((token) => (token === "3" ? "three" : token)), /whole number/],
      [[...flags, "--repo", root].map((token) => (token === "windows-x64" ? "gpu-x64" : token)), /no pool 'gpu-x64'.*windows-x64, macos-arm64, linux-x64/],
      [[...flags, "--repo", consumer(null)], /declares no 'runners' block/],
    ] as const) {
      const result = await run(argv, inventoryCalls());
      expect(result.code, result.err).toBe(2);
      expect(result.err).toMatch(pattern);
    }
  });

  it("warns on stderr, at exit 0, when the account already serves a repository of different visibility -- the plan unchanged (#330)", async () => {
    const root = consumer();
    const result = await run([...flags, "--repo", root, "--out", "plan.json", "--json"], [
      ...inventoryCalls(),
      windowsServicesCall([{ Name: "actions.runner.zheref-KroWindows.NZ-KWIR1", StartName: ".\\lordzheref" }]),
      { match: "gh api --method GET repos/zheref/nen", result: { stdout: '{"full_name":"zheref/nen","visibility":"public"}' } },
      { match: "gh api --method GET repos/zheref/KroWindows", result: { stdout: '{"full_name":"zheref/KroWindows","visibility":"private"}' } },
    ]);
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.out);
    expect(plan.identity).toBe(".\\lordzheref");
    expect(Object.keys(plan)).not.toContain("warnings");
    expect(JSON.parse(readFileSync(join(root, "plan.json"), "utf8"))).toEqual(plan);
    expect(result.err.split("\n")).toEqual([
      expect.stringMatching(/^nen runner plan: warning: \.\\lordzheref already runs 1 runner service\(s\) on this host for repositories whose visibility differs from zheref\/nen's \(public\) or cannot be told/),
      "nen runner plan:   actions.runner.zheref-KroWindows.NZ-KWIR1 -- zheref/KroWindows, private",
      expect.stringMatching(/^nen runner plan: recommended: a local account for zheref\/nen alone, e.g\. --service-account runner-nen /),
    ]);
  });

  it("asks for --consumer-code when the registry does not name the target", async () => {
    const result = await run(["plan", "--target", "zheref/other", "--pool", "windows-x64", "--machine-code", "NZ", "--count", "1", "--repo", consumer()]);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/Pass --consumer-code/);
  });
});

describe("nen runner script", () => {
  async function planned(root: string, account: string | null = "lordzheref"): Promise<void> {
    const argv = ["plan", "--target", "zheref/nen", "--pool", "windows-x64", "--machine-code", "NZ", "--count", "3", "--repo", root, "--out", "plan.json"];
    if (account !== null) argv.push("--service-account", account);
    expect((await run(argv, [...inventoryCalls(), windowsServicesCall()])).code).toBe(0);
  }

  it("writes the Windows script and names the elevated launch line", async () => {
    const root = consumer();
    await planned(root);
    const result = await run(["script", "--repo", root, "--plan", "plan.json", "--out", "register.ps1", "--json"]);
    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(result.out);
    expect(Object.keys(report)).toEqual(["os", "out", "runners", "identity", "mode", "dailyAccount", "needsElevation", "launch", "written", "scriptSha256", "summary"]);
    expect(report).toMatchObject({ os: "Windows", runners: ["NZ-NNR1", "NZ-NNR2", "NZ-NNR3"], identity: ".\\lordzheref", mode: "service", dailyAccount: false, needsElevation: true, written: true });
    expect(report.launch).toBe(`powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','${report.out}'"`);
    const golden = readFileSync(join(FIXTURES, "register.windows.golden.ps1"), "utf8").replace(/\r\n/g, "\n");
    expect(readFileSync(join(root, "register.ps1"), "utf8")).toBe(golden);
    // Additive (#312): the rendered bytes' SHA-256, and where the run leaves its one summary line.
    expect(report.scriptSha256).toBe(createHash("sha256").update(golden, "utf8").digest("hex"));
    expect(report.summary).toBe("C:\\GithubRunners\\nen-runners\\_jusshin\\register-*.summary");
  });

  it("refuses an --out under the plan's runner root at exit 2, naming the profile location instead (#312)", async () => {
    const root = consumer();
    await planned(root);
    for (const out of ["C:\\GithubRunners\\nen-runners\\_jusshin\\register.ps1", "c:/githubrunners/register.ps1"]) {
      const refused = await run(["script", "--repo", root, "--plan", "plan.json", "--out", out]);
      expect(refused.code, out).toBe(2);
      expect(refused.err).toContain("under the plan's runner root 'C:\\GithubRunners'");
      expect(refused.err).toContain("%LOCALAPPDATA%\\nen\\jusshin\\");
    }
    expect(isUnder("C:\\GithubRunnersX\\register.ps1", "C:\\GithubRunners", "Windows")).toBe(false);
    expect(isUnder("/opt/actions-runners/nen-runners/register.sh", "/opt/actions-runners", "Linux")).toBe(true);
    expect(isUnder("/opt/Actions-Runners/register.sh", "/opt/actions-runners", "Linux")).toBe(false);
    expect(isUnder("/Users/me/Actions-Runners/register.sh", "/Users/me/actions-runners", "macOS")).toBe(true);
    expect(isUnder("/home/me/.local/state/nen/jusshin/register.sh", "/opt/actions-runners", "Linux")).toBe(false);
  });

  it("plans an interactive pool as the daily account, then renders it only with --accept-daily-account (#333)", async () => {
    const root = consumer({ ...POLICY_BODY, pools: [...POLICY_BODY.pools, DESKTOP_POOL_BODY] });
    const argv = ["plan", "--target", "zheref/nen", "--pool", "windows-x64-desktop", "--machine-code", "NZ", "--count", "1", "--repo", root, "--service-account", "Zhere", "--out", "plan.json"];
    const planned = await run(argv, [...inventoryCalls(), windowsServicesCall()], "win32", { USERNAME: "zhere" });
    expect(planned.code, planned.err).toBe(0);
    expect(planned.out).toMatch(/^mode: interactive/m);
    expect(planned.out).toMatch(/warning: \.\\Zhere is the account computing this plan -- your own daily account/);
    expect(JSON.parse(readFileSync(join(root, "plan.json"), "utf8"))).toMatchObject({ mode: "interactive", dailyAccount: true });

    const refused = await run(["script", "--repo", root, "--plan", "plan.json", "--out", "register.ps1"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/as \.\\Zhere, the account that computed or is rendering it -- your own daily account..*--accept-daily-account/);
    expect(existsSync(join(root, "register.ps1"))).toBe(false);

    const accepted = await run(["script", "--repo", root, "--plan", "plan.json", "--out", "register.ps1", "--accept-daily-account", "--json"]);
    expect(accepted.code, accepted.err).toBe(0);
    expect(JSON.parse(accepted.out)).toMatchObject({ mode: "interactive", dailyAccount: true, identity: ".\\Zhere" });
    const text = readFileSync(join(root, "register.ps1"), "utf8");
    expect(text).toContain("Register-ScheduledTask");
    expect(text).not.toContain("'--runasservice'");
  });

  it("re-checks the daily account at render time: a plan computed elsewhere is refused on the identity's own Windows session", async () => {
    const root = consumer({ ...POLICY_BODY, pools: [...POLICY_BODY.pools, DESKTOP_POOL_BODY] });
    const argv = ["plan", "--target", "zheref/nen", "--pool", "windows-x64-desktop", "--machine-code", "NZ", "--count", "1", "--repo", root, "--service-account", "zhere", "--out", "plan.json"];
    expect((await run(argv, [...inventoryCalls(), windowsServicesCall()], "win32", {})).code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "plan.json"), "utf8"))).toMatchObject({ dailyAccount: false });
    const refused = await run(["script", "--repo", root, "--plan", "plan.json", "--out", "register.ps1"], [], "win32", { USERNAME: "ZHERE" });
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/your own daily account/);
    expect((await run(["script", "--repo", root, "--plan", "plan.json", "--out", "register.ps1"], [], "win32", { USERNAME: "someone" })).code).toBe(0);
  });

  it("refuses --accept-daily-account on any other runner verb", async () => {
    const refused = await run(["plan", "--pool", "windows-x64", "--accept-daily-account"]);
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/--accept-daily-account is not a 'runner plan' flag \(it belongs to runner script\)/);
  });

  it("writes nothing under --dry-run", async () => {
    const root = consumer();
    await planned(root);
    const result = await run(["script", "--repo", root, "--plan", "plan.json", "--out", "dry.ps1", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/\(dry run\) would write/);
    expect(existsSync(join(root, "dry.ps1"))).toBe(false);
  });

  it("refuses a plan whose identity is still 'ask', a Windows --out that is not a plain .ps1, and a file that is not a plan", async () => {
    const root = consumer();
    await planned(root, null);
    const ask = await run(["script", "--repo", root, "--plan", "plan.json", "--out", "register.ps1"]);
    expect(ask.code).toBe(2);
    expect(ask.err).toMatch(/identity is 'ask'/);
    await planned(root);
    expect((await run(["script", "--repo", root, "--plan", "plan.json", "--out", "register.sh"])).code).toBe(2);
    expect((await run(["script", "--repo", root, "--plan", "plan.json", "--out", "my scripts/register.ps1"])).code).toBe(2);
    writeFileSync(join(root, "junk.json"), "{}");
    const junk = await run(["script", "--repo", root, "--plan", "junk.json", "--out", "register.ps1"]);
    expect(junk.code).toBe(2);
    expect(junk.err).toMatch(/not a runner plan this build can render/);
    expect((await run(["script", "--repo", root, "--plan", "missing.json", "--out", "register.ps1"])).code).toBe(2);
  });
});

describe("nen runner verify", () => {
  it("exits 1 on a partial pass and 0 when all are online", async () => {
    const list = `gh ${runnersArgv(TARGET, 1).join(" ")}`;
    const partial = await run(["verify", "--target", "zheref/nen", "--expect", "NZ-NNR1,NZ-NNR2", "--labels", "self-hosted,Windows,X64"], [
      { match: list, result: { stdout: runnersAnswer([{ name: "NZ-NNR1" }]) } },
    ]);
    expect(partial.code).toBe(1);
    expect(partial.out).toMatch(/NZ-NNR2 .*missing/);
    const whole = await run(["verify", "--target", "zheref/nen", "--expect", "NZ-NNR1,NZ-NNR2", "--wait", "30", "--json"], [
      { match: list, result: { stdout: runnersAnswer([{ name: "NZ-NNR1" }, { name: "NZ-NNR2" }]) } },
    ]);
    expect(whole.code).toBe(0);
    expect(Object.keys(JSON.parse(whole.out))).toEqual(["target", "ok", "attempts", "waitedSeconds", "runners"]);
  });

  it("refuses an empty --expect and a non-numeric --wait at exit 2", async () => {
    expect((await run(["verify", "--target", "zheref/nen", "--expect", ","])).code).toBe(2);
    expect((await run(["verify", "--target", "zheref/nen", "--expect", "A", "--wait", "soon"])).code).toBe(2);
  });
});

describe("nen runner workflow", () => {
  const template = join(FIXTURES, "runner-preflight.template.yml");

  it("renders into the pool's preflight file by default, then refuses to clobber a changed one without --force", async () => {
    const root = consumer();
    const first = await run(["workflow", "--repo", root, "--target", "zheref/nen", "--pool", "windows-x64", "--template", template, "--json"]);
    expect(first.code, first.err).toBe(0);
    const out = join(root, ".github", "workflows", "runner-preflight-windows-x64.yml");
    expect(JSON.parse(first.out)).toMatchObject({ out, pool: "windows-x64", written: true, unchanged: false });
    expect(readFileSync(out, "utf8")).toMatch(/runs-on: \[self-hosted, Windows, X64\]/);

    const again = await run(["workflow", "--repo", root, "--target", "zheref/nen", "--pool", "windows-x64", "--template", template]);
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/already matches/);

    writeFileSync(out, "name: hand-edited\n");
    const refused = await run(["workflow", "--repo", root, "--target", "zheref/nen", "--pool", "windows-x64", "--template", template]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(/exists and differs from the rendering in \d+ line\(s\)\. Nothing was written; pass --force/);
    const dry = await run(["workflow", "--repo", root, "--target", "zheref/nen", "--pool", "windows-x64", "--template", template, "--force", "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("name: hand-edited\n");
    const forced = await run(["workflow", "--repo", root, "--target", "zheref/nen", "--pool", "windows-x64", "--template", template, "--force"]);
    expect(forced.code).toBe(0);
    expect(readFileSync(out, "utf8")).toMatch(/if: github\.repository == 'zheref\/nen'/);
  });

  it("is exit 1 on a leftover placeholder or invalid YAML, writing nothing, and exit 2 on an unreadable template", async () => {
    const root = consumer();
    writeFileSync(join(root, "bad.yml"), "name: @@POOL_ID@@\non: @@TRIGGER@@\n");
    const leftover = await run(["workflow", "--repo", root, "--target", "zheref/nen", "--pool", "windows-x64", "--template", "bad.yml"]);
    expect(leftover.code).toBe(1);
    expect(leftover.err).toMatch(/still carries @@TRIGGER@@/);
    writeFileSync(join(root, "broken.yml"), "name: [@@POOL_ID@@\n");
    const broken = await run(["workflow", "--repo", root, "--target", "zheref/nen", "--pool", "windows-x64", "--template", "broken.yml"]);
    expect(broken.code).toBe(1);
    expect(broken.err).toMatch(/not valid YAML/);
    expect(existsSync(join(root, ".github"))).toBe(false);
    expect((await run(["workflow", "--repo", root, "--target", "zheref/nen", "--pool", "windows-x64", "--template", "nope.yml"])).code).toBe(2);
  });
});

describe("nen runner preflight and enable -- the two writes", () => {
  it("require --target by name: a write never falls back to the checkout's remote", async () => {
    const preflight = await run(["preflight", "--workflow", "runner-preflight-windows-x64.yml"]);
    expect(preflight.code).toBe(2);
    expect(preflight.err).toMatch(/--target owner\/name is required: this verb writes to GitHub/);
    expect((await run(["enable", "--pool", "windows-x64", "--after-run", "1", "--repo", consumer()])).code).toBe(2);
  });

  it("dispatches nothing under preflight --dry-run", async () => {
    const result = await run(["preflight", "--target", "zheref/nen", "--workflow", "runner-preflight-windows-x64.yml", "--dry-run", "--json"], [
      { match: `gh ${defaultBranchArgv(TARGET).join(" ")}`, result: { stdout: '{"defaultBranchRef":{"name":"main"}}' } },
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out);
    expect(Object.keys(report)).toEqual(["target", "workflow", "ref", "runId", "url", "status", "conclusion", "runnerName", "runnerOs", "jobs", "verdict", "detail", "dryRun"]);
    expect(report.verdict).toBe("dry-run");
    expect((await run(["preflight", "--target", "zheref/nen", "--workflow", "../x.yml"])).code).toBe(2);
  });

  it("refuses to enable a pool with no enableVariable, a bad run id and a bad value, at exit 2", async () => {
    const root = consumer();
    const ungated = await run(["enable", "--target", "zheref/nen", "--repo", root, "--pool", "macos-arm64", "--after-run", "901"]);
    expect(ungated.code).toBe(2);
    expect(ungated.err).toMatch(/not variable-gated, so there is nothing to enable/);
    expect((await run(["enable", "--target", "zheref/nen", "--repo", root, "--pool", "windows-x64", "--after-run", "latest"])).code).toBe(2);
    expect((await run(["enable", "--target", "zheref/nen", "--repo", root, "--pool", "windows-x64", "--after-run", "901", "--value", "ONLINE!"])).code).toBe(2);
  });

  // #319's second reproduction (zheref/KroWindows run 36958789239): a green
  // `push` run of the pool's own preflight, on a branch that was never merged,
  // certified the pool under --dry-run. The workflow file is byte-identical to
  // the default branch's here, so only the event and the branch can refuse it.
  it("refuses a green push run on an unmerged branch, naming the event and the branch, and sets nothing (#319)", async () => {
    const file = ".github/workflows/runner-preflight-windows-x64.yml";
    const result = await run(["enable", "--target", "zheref/nen", "--repo", consumer(), "--pool", "windows-x64", "--after-run", "901", "--dry-run", "--json"], [
      {
        match: "gh api --method GET repos/zheref/nen/actions/runs/901",
        result: { stdout: JSON.stringify({ status: "completed", conclusion: "success", path: file, event: "push", head_branch: "codex/kurapika/runner-preflight", head_sha: "b".repeat(40), html_url: "u" }) },
      },
      {
        match: "gh api --method GET repos/zheref/nen/actions/runs/901/jobs?per_page=100",
        result: { stdout: JSON.stringify({ jobs: [{ name: "preflight", status: "completed", conclusion: "success", runner_name: "NZ-NNR4", labels: ["self-hosted", "Windows", "X64"] }] }) },
      },
      { match: `gh ${defaultBranchArgv(TARGET).join(" ")}`, result: { stdout: '{"defaultBranchRef":{"name":"main"}}' } },
      { match: `gh api --method GET repos/zheref/nen/contents/${file}?ref=${"b".repeat(40)}`, result: { stdout: '{"sha":"1111"}' } },
      { match: `gh api --method GET repos/zheref/nen/contents/${file}?ref=main`, result: { stdout: '{"sha":"1111"}' } },
      { match: "gh variable get NEN_WINDOWS_RUNNER --repo zheref/nen", result: { code: 1, stderr: "variable NEN_WINDOWS_RUNNER was not found" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/run 901 on zheref\/nen is not a green preflight of pool windows-x64/);
    expect(result.err).toMatch(/it was triggered by 'push', not workflow_dispatch/);
    expect(result.err).toMatch(/it ran on 'codex\/kurapika\/runner-preflight', not the default branch 'main'/);
    const report = JSON.parse(result.out);
    expect(report).toMatchObject({ target: "zheref/nen", pool: "windows-x64", runId: 901, refused: true });
    expect(report.problems.map((problem: { check: string }) => problem.check)).toEqual(["event", "branch"]);
    expect(result.seams.calls.some((call) => call.args[0] === "variable" && call.args[1] === "set")).toBe(false);
  });
});
