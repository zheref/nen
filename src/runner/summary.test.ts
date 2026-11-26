import { mkdirSync, readFileSync, readSync, renameSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../testing/tempdir.js";
import { runFamily } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { runnerCommand } from "./command.js";
import { launchTime, localSummaryRoot, readSummary, readSummaryPlan, renderSummary } from "./summary.js";
import { planFor } from "./testkit.js";
import { renderScript } from "./script.js";

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
  it.runIf(process.platform === "win32")("reads through metadata-only parent ACLs without elevation (NN#647)", () => {
    const f = fixture();
    summary(f.dir, "register-permissions.summary", 2);
    const plan = readSummaryPlan(f.plan, "win32");
    const grantLines = renderScript(plan, "0.0.0-test").text.split("\n")
      .filter((line) => /Invoke-Icacls @\(\$(Root|ProjectDir), '\/grant',/.test(line));
    expect(grantLines).toHaveLength(2);
    const ps = (source: string, saved = ""): ReturnType<typeof spawnSync> => spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", source], {
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, NEN_SUMMARY_ROOT: f.root, NEN_SUMMARY_PROJECT: plan.projectDir, NEN_SUMMARY_SAVED: saved },
    });
    const preamble = "$ErrorActionPreference = 'Stop'; $Root = $env:NEN_SUMMARY_ROOT; $ProjectDir = $env:NEN_SUMMARY_PROJECT; $WorkDir = Join-Path $ProjectDir '_jusshin'; $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User;";
    // Save every ACL before changing either directory; owner WRITE_DAC permits
    // restoration even while ordinary data/attribute access is restricted.
    const snapshot = ps(`${preamble} @($Root, $ProjectDir, $WorkDir) | ForEach-Object { @{ Path = $_; Sddl = (Get-Acl -LiteralPath $_).Sddl } } | ConvertTo-Json -Compress`);
    expect(snapshot.status, String(snapshot.stderr)).toBe(0);
    const saved = String(snapshot.stdout).trim();
    try {
      const restricted = ps(`${preamble}
        $workAcl = New-Object Security.AccessControl.DirectorySecurity
        $workAcl.SetAccessRuleProtection($true, $false)
        $workAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'ReadAndExecute', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
        Set-Acl -LiteralPath $WorkDir -AclObject $workAcl
        foreach ($p in @($Root, $ProjectDir)) {
          $acl = New-Object Security.AccessControl.DirectorySecurity
          $acl.SetAccessRuleProtection($true, $false)
          $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'Traverse', 'Allow')))
          Set-Acl -LiteralPath $p -AclObject $acl
        }`);
      expect(restricted.status, String(restricted.stderr)).toBe(0);
      expect(readSummary(plan, LAUNCH, "win32").verdict).toBe("unreadable");
      const granted = ps(`${preamble}
        $Me = '*' + $sid.Value
        function Invoke-Icacls { & icacls @args | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'icacls failed' } }
        ${grantLines.join("\n")}`);
      expect(granted.status, String(granted.stderr)).toBe(0);
      expect(readSummary(plan, LAUNCH, "win32")).toMatchObject({ verdict: "read", registered: 2, skipped: 1, failed: 0 });
    } finally {
      const restored = ps(`${preamble}
        foreach ($entry in (ConvertFrom-Json $env:NEN_SUMMARY_SAVED)) {
          $acl = New-Object Security.AccessControl.DirectorySecurity
          $acl.SetSecurityDescriptorSddlForm($entry.Sddl)
          Set-Acl -LiteralPath $entry.Path -AclObject $acl
        }`, saved);
      expect(restored.status, String(restored.stderr)).toBe(0);
    }
  }, 60_000);

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

it("normalizes the planner's stored Windows volume root without probing it", () => {
  const base = planFor("windows-x64");
  expect(localSummaryRoot({ ...base, root: "C:", projectDir: "C:\\nen-runners" })).toBe("C:\\");
  expect(() => localSummaryRoot({ ...base, root: "\\\\server\\share", projectDir: "\\\\server\\share\\nen-runners" })).toThrow(/local drive-letter/);
});
