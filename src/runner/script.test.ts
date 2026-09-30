// The three host scripts, held byte-for-byte to golden files and to the
// properties the golden files cannot state on their own: PowerShell 5.1
// syntax only, the password asked once and never echoed, the transcript
// stopped around the one call that carries the secrets, traverse grants that
// are not recursive, and a script each interpreter's own parser accepts.
//
// Regenerate the goldens with NEN_UPDATE_GOLDEN=1 after a deliberate change.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launchLine, renderScript } from "./script.js";
import { FIXTURES, lf, planFor } from "./testkit.js";

const VERSION = "0.0.0-test";

function golden(name: string, text: string): void {
  const path = join(FIXTURES, name);
  if (process.env["NEN_UPDATE_GOLDEN"] === "1") writeFileSync(path, text);
  expect(text).toBe(lf(readFileSync(path, "utf8")));
}

function hasTool(command: string, args: readonly string[]): boolean {
  const probe = spawnSync(command, [...args], { encoding: "utf8" });
  return probe.error === undefined && probe.status === 0;
}

const windows = renderScript(planFor("windows-x64"), VERSION);
const linux = renderScript(planFor("linux-x64"), VERSION);
const mac = renderScript(planFor("macos-arm64"), VERSION);

describe("renderScript -- golden files, one per host OS", () => {
  it("renders the Windows PowerShell script for NZ-NNR1..3 as .\\lordzheref", () => {
    expect(windows.os).toBe("Windows");
    expect(windows.needsElevation).toBe(true);
    golden("register.windows.golden.ps1", windows.text);
  });

  it("renders the Linux bash script", () => {
    expect(linux.needsElevation).toBe(true);
    golden("register.linux.golden.txt", linux.text);
  });

  it("renders the macOS bash script", () => {
    expect(mac.needsElevation).toBe(false);
    golden("register.macos.golden.txt", mac.text);
  });

  it("is deterministic: the same plan renders the same bytes", () => {
    expect(renderScript(planFor("windows-x64"), VERSION).text).toBe(windows.text);
  });
});

describe("the Windows script -- PowerShell 5.1, and the secrets never leave the process", () => {
  const lines = windows.text.split("\n");
  const code = lines.filter((line) => !line.trimStart().startsWith("#"));

  it("carries the header, the plan's facts and the do-not-edit line", () => {
    expect(lines[1]).toBe(`# rendered by nen ${VERSION} runner script -- do not edit; re-run nen runner script`);
    expect(windows.text).toMatch(/^# target: {3}zheref\/nen$/m);
    expect(windows.text).toMatch(/^# runners: {2}NZ-NNR1, NZ-NNR2, NZ-NNR3$/m);
    expect(windows.text).toMatch(/^# identity: \.\\lordzheref$/m);
  });

  it("is ASCII and uses no PowerShell 7-only operator", () => {
    expect(/^[\x00-\x7F]*$/.test(windows.text)).toBe(true);
    for (const line of code) {
      expect(line, line).not.toMatch(/&&|\|\||\?\?|\?\./);
      expect(line, line).not.toMatch(/\s\?\s[^:]+\s:\s/);
    }
  });

  it("asks for the password exactly once, as a SecureString, and never echoes it or the token", () => {
    expect(code.filter((line) => line.includes("Read-Host -AsSecureString"))).toHaveLength(1);
    for (const line of code.filter((candidate) => /Write-Host|Write-Output|Out-File|Set-Content|Add-Content/.test(candidate))) {
      expect(line, line).not.toMatch(/\$plain|\$token|\$secure|\$configArgs|\$bstr/);
    }
    // The plain text exists only between the BSTR conversion and the finally that clears it.
    expect(windows.text).toContain("[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)");
    expect(windows.text).toContain("$plain = $null");
    expect(windows.text).toContain("$token = $null");
  });

  it("stops the transcript before the config.cmd call and restarts it after", () => {
    const stop = code.findIndex((line) => line.trim() === "Stop-Log");
    const config = code.findIndex((line) => line.includes("& .\\config.cmd @configArgs"));
    const password = code.findIndex((line) => line.includes("'--windowslogonpassword', $plain"));
    const restart = code.findIndex((line, index) => index > config && line.trim() === "Start-Log");
    expect(stop).toBeGreaterThan(0);
    expect(password).toBeGreaterThan(stop);
    expect(config).toBeGreaterThan(password);
    expect(restart).toBeGreaterThan(config);
    // config.cmd's own output is replayed with both secrets masked.
    expect(windows.text).toContain("Hide-Secret ([string]$_) @($token, $plain)");
  });

  it("mints the registration token inside the script, per runner, with gh", () => {
    expect(windows.text).toContain("& gh api -X POST ('repos/{0}/actions/runners/registration-token' -f $Target) --jq .token");
    expect(windows.text).toContain("'--unattended', '--url', $RepoUrl, '--token', $token, '--name', $name, '--labels', $Labels, '--work', '_work', '--runasservice'");
    expect(windows.text).toContain("$configArgs += @('--windowslogonaccount', $Identity)");
  });

  it("grants read-and-execute on the root and project folder only, never recursively", () => {
    expect(windows.text).toContain("foreach ($dir in @($Root, $ProjectDir))");
    expect(windows.text).toContain("('{0}:(RX)' -f $Account)");
    expect(windows.text).not.toMatch(/icacls[^\n]*\/T/);
    expect(windows.text).not.toMatch(/\(OI\)|\(CI\)/);
  });

  it("asserts elevation (3), gh (5), the package hash (6), and the one summary line", () => {
    expect(windows.text).toContain("IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)");
    expect(windows.text).toMatch(/run elevated[\s\S]*Close-Run 3/);
    expect(windows.text).toMatch(/'gh auth status'[\s\S]*Close-Run 5/);
    expect(windows.text).toMatch(/SHA-256 check[\s\S]*Close-Run 6/);
    expect(windows.text).toContain("'jusshin: {0} registered, {1} skipped, {2} failed'");
    expect(windows.text).toContain("if ($Code -ne 0 -and $Host.Name -eq 'ConsoleHost' -and [Environment]::UserInteractive)");
    expect(windows.text).toContain("Get-Service -Name ($ServicePrefix + '*')");
    expect(windows.text).toContain("$ServicePrefix = 'actions.runner.zheref-nen.'");
  });

  it("omits the account flags and the password prompt's account for network-service", () => {
    const network = renderScript(planFor("windows-x64", { serviceAccount: "network-service" }), VERSION).text;
    expect(network).toContain("$Identity = 'network-service'");
    expect(network).toContain("$Account = ''");
    // Every account-dependent step is gated on $Account, so none runs.
    expect(network).toMatch(/if \(\$Account -ne ''\) \{ \$configArgs \+= @\('--windowslogonaccount', \$Identity\) \}/);
  });

  it("parses under Windows PowerShell's own parser, where there is one", () => {
    if (!hasTool("powershell", ["-NoProfile", "-Command", "exit 0"])) return;
    const dir = mkdtempSync(join(tmpdir(), "nen-runner-ps-"));
    const path = join(dir, "register.ps1");
    writeFileSync(path, windows.text);
    const result = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${path}', [ref]$null, [ref]$e); exit $e.Count`,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

describe("the bash scripts -- Linux under sudo, macOS as the user", () => {
  it("carries the em-dash header line on both", () => {
    expect(linux.text.split("\n")[2]).toBe(`# rendered by nen ${VERSION} runner script — do not edit; re-run nen runner script`);
    expect(mac.text.split("\n")[2]).toBe(`# rendered by nen ${VERSION} runner script — do not edit; re-run nen runner script`);
  });

  it("runs config.sh as the service user and gh as the invoking user on Linux, then svc.sh install <user>", () => {
    expect(linux.text).toContain("SERVICE_USER='runner'");
    expect(linux.text).toContain('sudo -u "$SERVICE_USER" ./config.sh --unattended --url "$REPO_URL" --token "$token" --name "$name" --labels "$LABELS" --work _work');
    expect(linux.text).toContain('token="$(as_invoker gh api -X POST "repos/$TARGET/actions/runners/registration-token" --jq .token 2>/dev/null)"');
    expect(linux.text).toContain('./svc.sh install "$SERVICE_USER" && ./svc.sh start && ./svc.sh status');
    expect(linux.text).toContain('echo "$SHA256  $archive" | sha256sum -c - >/dev/null 2>&1');
    expect(linux.text).toContain('systemctl list-units "${SERVICE_PREFIX}*" --all --no-pager || true');
  });

  it("refuses root on macOS, checks the LaunchAgent's PID, and never approves Background Task Management", () => {
    expect(mac.text).toMatch(/if \[ "\$\(id -u\)" -eq 0 \]; then[\s\S]*finish 3/);
    expect(mac.text).toContain('launchctl print "gui/$(id -u)/$label"');
    expect(mac.text).toContain("Login Items");
    expect(mac.text).toContain("shasum -a 256 -c -");
    // "not with sudo" is in the header; no COMMAND elevates.
    expect(mac.text.split("\n").filter((line) => !line.startsWith("#") && line.includes("sudo"))).toEqual([]);
  });

  it("never echoes the token, and never uses xtrace", () => {
    for (const text of [linux.text, mac.text]) {
      for (const line of text.split("\n").filter((candidate) => /\becho\b|printf/.test(candidate))) {
        expect(line, line).not.toContain("$token");
      }
      expect(text).not.toMatch(/set -[a-z]*x/);
    }
  });

  it("parses under bash -n, where there is a bash", () => {
    if (!hasTool("bash", ["-c", "exit 0"])) return;
    for (const text of [linux.text, mac.text]) {
      const result = spawnSync("bash", ["-n"], { input: text, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    }
  });
});

describe("launchLine -- the one command the caller runs", () => {
  it("opens Windows through a UAC prompt, and runs bash elsewhere", () => {
    expect(launchLine("Windows", "C:\\GithubRunners\\nen-runners\\_jusshin\\register.ps1")).toBe(
      "powershell -NoProfile -ExecutionPolicy Bypass -Command \"Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\\GithubRunners\\nen-runners\\_jusshin\\register.ps1'\"",
    );
    expect(launchLine("Linux", "/tmp/register.sh")).toBe("sudo bash /tmp/register.sh");
    expect(launchLine("macOS", "/tmp/register.sh")).toBe("bash /tmp/register.sh");
  });
});
