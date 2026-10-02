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
import { launchLine, REFUSED_PASSWORD_CHARACTERS, REFUSED_PASSWORD_PATTERN, renderScript } from "./script.js";
import { FIXTURES, lf, planFor } from "./testkit.js";

const VERSION = "0.0.0-test";

function golden(name: string, text: string): void {
  const path = join(FIXTURES, name);
  if (process.env["NEN_UPDATE_GOLDEN"] === "1") writeFileSync(path, text);
  expect(text).toBe(lf(readFileSync(path, "utf8")));
}

/** The last index before `end` whose line satisfies `predicate`, or -1. */
function lastBefore(lines: readonly string[], end: number, predicate: (line: string) => boolean): number {
  for (let index = end - 1; index >= 0; index--) if (predicate(lines[index] ?? "")) return index;
  return -1;
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
      expect(line, line).not.toMatch(/\$token|\$secure|\$configArgs|\$bstr|ACTIONS_RUNNER_INPUT_/);
    }
    // The plain text exists only inside a BSTR that a finally zeroes: once for the rule check, once for the call.
    expect(code.filter((line) => line.includes("[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)"))).toHaveLength(2);
    expect(windows.text).not.toContain("$plain =");
    expect(windows.text).toContain("$token = $null");
  });

  it("puts no secret on config.cmd's command line: both travel as ACTIONS_RUNNER_INPUT_* and are cleared in a finally (#312)", () => {
    for (const line of code.filter((candidate) => candidate.includes("$configArgs"))) {
      expect(line, line).not.toMatch(/--token|--windowslogonpassword|\$token|PtrToStringBSTR/);
    }
    expect(windows.text).not.toMatch(/'--token'|'--windowslogonpassword'/);
    const at = (needle: string): number => code.findIndex((line) => line.includes(needle));
    const stop = code.findIndex((line) => line.trim() === "Stop-Log");
    const setToken = at("$env:ACTIONS_RUNNER_INPUT_TOKEN = $token");
    const setPassword = at("$env:ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)");
    const call = at("& .\\config.cmd @configArgs *> $null");
    const clearToken = at("[Environment]::SetEnvironmentVariable('ACTIONS_RUNNER_INPUT_TOKEN', $null, 'Process')");
    const clearPassword = at("[Environment]::SetEnvironmentVariable('ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD', $null, 'Process')");
    const restart = code.findIndex((line, index) => index > call && line.trim() === "Start-Log");
    expect(stop).toBeGreaterThan(0);
    expect(setToken).toBeGreaterThan(stop);
    expect(setPassword).toBeGreaterThan(setToken);
    expect(call).toBeGreaterThan(setPassword);
    expect(code[clearToken - 1]?.trim()).toBe("} finally {");
    expect(clearToken).toBeGreaterThan(call);
    expect(clearPassword).toBe(clearToken + 1);
    expect(restart).toBeGreaterThan(clearPassword);
    // Each is set exactly once: no other path reaches the environment.
    expect(code.filter((line) => line.includes("$env:ACTIONS_RUNNER_INPUT_"))).toHaveLength(2);
  });

  it("never replays config.cmd's output into the transcript: its exit code and a fixed line only (#312)", () => {
    expect(windows.text).not.toContain("Hide-Secret");
    expect(windows.text).not.toMatch(/config: \{0\}/);
    expect(code.filter((line) => line.includes("config.cmd @configArgs"))).toEqual(["                & .\\config.cmd @configArgs *> $null"]);
    expect(windows.text).toContain("'jusshin: config.cmd exited {0} for {1}; its own (masked) log is under {2}\\_diag.' -f $code, $name, $dir");
  });

  it("mints the registration token inside the script, per runner, with gh", () => {
    expect(windows.text).toContain("& gh api -X POST ('repos/{0}/actions/runners/registration-token' -f $Target) --jq .token");
    expect(windows.text).toContain("$configArgs = @('--unattended', '--url', $RepoUrl, '--name', $name, '--labels', $Labels, '--work', '_work', '--runasservice')");
    expect(windows.text).toContain("$configArgs += @('--windowslogonaccount', $Identity)");
  });

  it("refuses a password carrying any refused metacharacter before its first use, naming the rule (#312)", () => {
    expect(REFUSED_PASSWORD_CHARACTERS).toBe(`& | < > ^ % " ' or a line break`);
    expect(windows.text).toContain(`$PasswordRule = '& | < > ^ % " '' or a line break'`);
    expect(windows.text).toContain(`    if ($Plain -match '[&|<>^%"''\\r\\n]') { return 'it carries a refused character' }`);
    const pattern = new RegExp(REFUSED_PASSWORD_PATTERN);
    for (const character of ["&", "|", "<", ">", "^", "%", '"', "'", "\n", "\r"]) {
      expect(pattern.test(`Synth${character}etic`), JSON.stringify(character)).toBe(true);
    }
    expect(pattern.test("Synthetic-Pass_word.1!@#$*()")).toBe(false);
    // Checked right after the prompt: before the download and before the one use.
    const at = (needle: string): number => code.findIndex((line) => line.includes(needle));
    const check = at("$refusal = Test-Password ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr))");
    expect(check).toBeGreaterThan(at("Read-Host -AsSecureString"));
    expect(check).toBeLessThan(at("Invoke-WebRequest"));
    expect(check).toBeLessThan(at("$env:ACTIONS_RUNNER_INPUT_WINDOWSLOGONPASSWORD"));
    expect(windows.text).toMatch(/is refused: \{1\}\. The rule: a service-account password carries none of \{2\}[^\n]*\$PasswordRule\)\n[^\n]*\n\s*Close-Run 1/);
  });

  it("refuses each metacharacter under Windows PowerShell's own -match, where there is one (#312)", () => {
    if (!hasTool("powershell", ["-NoProfile", "-Command", "exit 0"])) return;
    const start = windows.text.indexOf("function Test-Password {");
    const fn = windows.text.slice(start, windows.text.indexOf("\n}\n", start) + 3);
    const dir = mkdtempSync(join(tmpdir(), "nen-runner-pw-"));
    const path = join(dir, "rule.ps1");
    writeFileSync(
      path,
      [
        fn,
        "$cases = @(38, 124, 60, 62, 94, 37, 34, 39, 10, 13) | ForEach-Object { 'Synth' + [char]$_ + 'etic' }",
        "$cases += @('Synthetic-Pass_word.1!@#$*()', ' lead', 'trail ', '')",
        "foreach ($case in $cases) { if ($null -eq (Test-Password $case)) { 'accept' } else { 'refuse' } }",
      ].join("\n"),
    );
    const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual([...Array<string>(10).fill("refuse"), "accept", "refuse", "refuse", "refuse"]);
  });

  it("locks the runner root down, in order, before the transcript, gh and any download (#312)", () => {
    const at = (predicate: (line: string) => boolean): number => code.findIndex(predicate);
    const order = [
      at((line) => line.includes("Close-Run 3")),
      at((line) => line.includes("Invoke-Icacls @($Root, '/setowner', $AdminsSid)")),
      at((line) => line.includes("Invoke-Icacls @($Root, '/inheritance:r', '/grant:r', ($SystemSid + ':(OI)(CI)F'), ($AdminsSid + ':(OI)(CI)F'))")),
      at((line) => line.includes("foreach ($dir in @($ProjectDir, $WorkDir, $PkgDir)) {")),
      at((line) => line.includes("Invoke-Icacls @($dir, '/setowner', $AdminsSid)")),
      at((line) => line.includes("Invoke-Icacls @($dir, '/reset')")),
      at((line) => line.includes("Invoke-Icacls @($PkgDir, '/inheritance:r', '/grant:r', ($SystemSid + ':(OI)(CI)F'), ($AdminsSid + ':(OI)(CI)F'))")),
      at((line) => line.includes("Invoke-Icacls @($WorkDir, '/grant', ($Me + ':(OI)(CI)RX'))")),
      at((line) => line.trim() === "Start-Log"),
      at((line) => line.includes("Get-Command gh")),
      at((line) => line.includes("Invoke-WebRequest")),
      at((line) => line.includes("Expand-Archive")),
      at((line) => line.includes("& .\\config.cmd")),
    ];
    for (const [index, position] of order.entries()) {
      expect(position, `step ${index}`).toBeGreaterThan(0);
      if (index > 0) expect(position, `step ${index}`).toBeGreaterThan(order[index - 1] ?? Infinity);
    }
    expect(windows.text).toContain("$SystemSid = '*S-1-5-18'");
    expect(windows.text).toContain("$AdminsSid = '*S-1-5-32-544'");
    expect(windows.text).toContain("$PkgDir = Join-Path $WorkDir 'pkg'");
    expect(windows.text).toContain("$zip = Join-Path $PkgDir $ZipName");
    // A failed icacls stops the run: nothing is downloaded into an unlocked root.
    expect(windows.text).toMatch(/function Invoke-Icacls \{[\s\S]*?Close-Run 1\n {4}\}\n\}/);
  });

  it("re-hashes the package immediately before EVERY Expand-Archive (#312)", () => {
    const extractions = code.flatMap((line, index): number[] => (line.includes("Expand-Archive") ? [index] : []));
    expect(extractions.length).toBeGreaterThan(0);
    for (const extraction of extractions) {
      const guard = lastBefore(code, extraction, (line) => line.includes("if (-not (Test-Package $zip)) {"));
      expect(guard).toBeGreaterThan(0);
      const between = code.slice(guard, extraction);
      expect(between.length).toBeLessThanOrEqual(5);
      expect(between.join("\n")).toContain("Close-Run 6");
    }
    expect(windows.text).toContain("return ((Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash -eq $Sha256)");
  });

  it("empties a pending runner folder before extracting into it: nothing that predates the lockdown is trusted", () => {
    expect(windows.text).toContain("if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }");
  });

  it("treats a configured folder with no service, or no registration, as stale: emptied, re-registered, never skipped (#319)", () => {
    expect(windows.text).toContain("$stale = Get-StaleReason $runner.Name ($null -ne $service) $script:Listed");
    expect(windows.text).toContain("$pending += @{ Name = $runner.Name; Dir = $runner.Dir; Replace = ($script:Listed -contains $runner.Name) }");
    expect(windows.text).toContain("$code = Invoke-Quiet 'sc.exe' @('delete', $serviceName)");
    expect(windows.text).toContain("if ($runner.Replace) { $configArgs += '--replace' }");
    // The skip is reached only after the stale check, and an unreadable runner list never skips.
    expect(windows.text).toMatch(/if \(-not \$script:ListOk\) \{[\s\S]*?\$script:Failed\+\+[\s\S]*?if \(\$null -eq \$stale\) \{[\s\S]*?\$script:Skipped\+\+/);
    if (!hasTool("powershell", ["-NoProfile", "-Command", "exit 0"])) return;
    const start = windows.text.indexOf("function Get-StaleReason {");
    const fn = windows.text.slice(start, windows.text.indexOf("\n}\n", start) + 3);
    const dir = mkdtempSync(join(tmpdir(), "nen-runner-stale-"));
    const path = join(dir, "stale.ps1");
    writeFileSync(
      path,
      [
        fn,
        "$cases = @(",
        "    (Get-StaleReason 'NZ-NNR1' $true @('NZ-NNR1', 'NZ-NNR2')),",
        "    (Get-StaleReason 'NZ-NNR1' $false @('nz-nnr1')),",
        "    (Get-StaleReason 'NZ-NNR1' $true @('NZ-NNR2')),",
        "    (Get-StaleReason 'NZ-NNR1' $false @())",
        ")",
        "foreach ($case in $cases) { if ($null -eq $case) { Write-Output '<stands>' } else { Write-Output $case } }",
      ].join("\n"),
    );
    const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual([
      "<stands>",
      "its service is absent",
      "GitHub no longer lists its registration",
      "its service is absent and GitHub no longer lists its registration",
    ]);
  });

  it("grants the service account read-and-execute on the root and project folder only, never inherited", () => {
    expect(windows.text).toContain("foreach ($dir in @($Root, $ProjectDir))");
    expect(windows.text).toContain("('{0}:(RX)' -f $Account)");
    expect(windows.text).not.toMatch(/icacls[^\n]*\/T/);
    // Only SYSTEM, Administrators and the elevated user's read on _jusshin inherit.
    for (const line of code.filter((candidate) => /\(OI\)|\(CI\)/.test(candidate))) {
      expect(line, line).toMatch(/\$SystemSid \+ ':\(OI\)\(CI\)F'|\$Me \+ ':\(OI\)\(CI\)RX'/);
    }
  });

  it("writes the one summary line, and only it, to _jusshin\\register-<ts>.summary (#312)", () => {
    expect(windows.text).toContain("$script:SummaryPath = Join-Path $WorkDir ('register-{0}.summary' -f $script:Stamp)");
    expect(windows.text).toContain("$script:LogPath = Join-Path $WorkDir ('register-{0}.log' -f $script:Stamp)");
    const writes = code.filter((line) => /Set-Content|Add-Content|Out-File/.test(line));
    expect(writes).toEqual(["            Set-Content -LiteralPath $script:SummaryPath -Value $summary -Encoding Ascii"]);
    if (!hasTool("powershell", ["-NoProfile", "-Command", "exit 0"])) return;
    const start = windows.text.indexOf("function Close-Run {");
    const fn = windows.text.slice(start, windows.text.indexOf("\n}\n", start) + 3);
    const dir = mkdtempSync(join(tmpdir(), "nen-runner-summary-"));
    const summary = join(dir, "register-20260930-120000.summary");
    const path = join(dir, "close.ps1");
    writeFileSync(
      path,
      [
        "$script:Registered = 2",
        "$script:Skipped = 1",
        "$script:Failed = 0",
        "$script:Transcribing = $false",
        `$script:SummaryPath = '${summary}'`,
        fn,
        "Close-Run 0",
      ].join("\n"),
    );
    const result = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(summary, "utf8")).toBe("jusshin: 2 registered, 1 skipped, 0 failed\r\n");
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
    // The token reaches config.sh through the service user's environment, fed by a builtin over stdin (#312).
    expect(linux.text).toContain(
      `printf '%s\\n' "$token" | sudo -u "$SERVICE_USER" bash -c 'IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN; export ACTIONS_RUNNER_INPUT_TOKEN; exec ./config.sh --unattended --url "$1" --name "$2" --labels "$3" --work _work "\${@:4}"' jusshin "$REPO_URL" "$name" "$LABELS" \${replace[@]+"\${replace[@]}"}`,
    );
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

  it("never echoes the token, never puts it on a command line, and never uses xtrace (#312)", () => {
    // The one printf that carries it writes into the pipe to the service user's shell, never to the log.
    const pipe = /^ {2}if ! \(cd "\$dir" && printf '%s\\n' "\$token" \| sudo -u "\$SERVICE_USER" bash -c /;
    for (const text of [linux.text, mac.text]) {
      for (const line of text.split("\n").filter((candidate) => /\becho\b|printf/.test(candidate) && !pipe.test(candidate))) {
        expect(line, line).not.toContain("$token");
      }
      for (const line of text.split("\n").filter((candidate) => !candidate.trimStart().startsWith("#"))) {
        expect(line, line).not.toContain("--token");
      }
      expect(text).not.toMatch(/set -[a-z]*x/);
    }
    expect(linux.text.split("\n").filter((line) => pipe.test(line))).toHaveLength(1);
    expect(mac.text).toContain('ACTIONS_RUNNER_INPUT_TOKEN="$token" ./config.sh --unattended --url "$REPO_URL" --name "$name" --labels "$LABELS" --work _work');
  });

  it("hands the token to config.sh through its environment for real, where there is a bash (#312)", () => {
    if (!hasTool("bash", ["-c", "exit 0"])) return;
    const dir = mkdtempSync(join(tmpdir(), "nen-runner-sh-"));
    // A stand-in config.sh that reports what it received: the token in its environment, none on argv.
    writeFileSync(join(dir, "config.sh"), '#!/usr/bin/env bash\nprintf "env=%s argv=%s\\n" "$ACTIONS_RUNNER_INPUT_TOKEN" "$*"\n');
    const line = mac.text.split("\n").find((candidate) => candidate.includes('ACTIONS_RUNNER_INPUT_TOKEN="$token" ./config.sh')) ?? "";
    const call = line.replace(/^ {2}if ! /, "").replace(/; then$/, "");
    const result = spawnSync("bash", ["-c", `dir=${JSON.stringify(dir.replace(/\\/g, "/"))}; token='t&k|n'; REPO_URL=u; name=n; LABELS=l; chmod +x "$dir/config.sh"; ${call}`], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("env=t&k|n argv=--unattended --url u --name n --labels l --work _work");
  });

  it("re-hashes the archive immediately before every extraction, and writes the summary file (#312)", () => {
    for (const text of [linux.text, mac.text]) {
      const lines = text.split("\n");
      const extractions = lines.flatMap((line, index): number[] => (/\btar xzf\b/.test(line) ? [index] : []));
      expect(extractions.length).toBeGreaterThan(0);
      for (const extraction of extractions) {
        const guard = lastBefore(lines, extraction, (line) => line.trim() === "if ! verify_archive; then");
        expect(guard).toBeGreaterThan(0);
        expect(extraction - guard).toBeLessThanOrEqual(6);
        expect(lines.slice(guard, extraction).join("\n")).toContain("finish 6");
      }
      expect(text).toContain('summary_file="$WORK_DIR/register-$stamp.summary"');
      expect(text).toContain(`if [ -n "$summary_file" ]; then printf '%s\\n' "$summary" > "$summary_file" || true; fi`);
    }
    if (!hasTool("bash", ["-c", "exit 0"])) return;
    const start = linux.text.indexOf("finish() {");
    const finish = linux.text.slice(start, linux.text.indexOf("\n}\n", start) + 3);
    const dir = mkdtempSync(join(tmpdir(), "nen-runner-summary-sh-"));
    const file = `${dir.replace(/\\/g, "/")}/register-20260930-120000.summary`;
    const result = spawnSync("bash", ["-c", `${finish}\nregistered=2; skipped=1; failed=0; summary_file=${JSON.stringify(file)}; finish 0`], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("jusshin: 2 registered, 1 skipped, 0 failed\n");
  });

  it("treats a configured directory with no service, or no registration, as stale on both (#319)", () => {
    expect(linux.text).toContain('service_present() { [ -n "$(systemctl list-unit-files "${SERVICE_PREFIX}$1.service" --no-legend 2>/dev/null)" ]; }');
    expect(linux.text).toContain('gh_run() { as_invoker gh "$@"; }');
    expect(mac.text).toContain('service_present() { [ -f "$HOME/Library/LaunchAgents/${SERVICE_PREFIX}$1.plist" ]; }');
    expect(mac.text).toContain('gh_run() { gh "$@"; }');
    for (const text of [linux.text, mac.text]) {
      expect(text).toContain('reason="$(stale_reason "$name" "$has_service" "$listed")"');
      expect(text).toContain('case "$replace_names" in *" $name "*) replace=(--replace) ;; esac');
      // The skip is reached only after the stale check, and an unreadable runner list never skips.
      expect(text).toMatch(/if \[ "\$listed_ok" != 1 \]; then[\s\S]*?failed=\$\(\(failed \+ 1\)\)[\s\S]*?if \[ -z "\$reason" \]; then[\s\S]*?skipped=\$\(\(skipped \+ 1\)\)/);
    }
    if (!hasTool("bash", ["-c", "exit 0"])) return;
    const start = linux.text.indexOf("stale_reason() {");
    const fn = linux.text.slice(start, linux.text.indexOf("\n}\n", start) + 3);
    const probe = [
      fn,
      'listed="$(printf "NZ-NNR1\\nNZ-NNR2")"',
      'for args in "NZ-NNR1 1" "NZ-NNR1 0" "NZ-NNR3 1" "NZ-NNR3 0"; do set -- $args; r="$(stale_reason "$1" "$2" "$listed")"; echo "${r:-<stands>}"; done',
      'echo "$(stale_reason NZ-NNR1 1 "")"',
    ].join("\n");
    const result = spawnSync("bash", ["-c", probe], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "<stands>",
      "its service is absent",
      "GitHub no longer lists its registration",
      "its service is absent and GitHub no longer lists its registration",
      "GitHub no longer lists its registration",
    ]);
  });

  it("passes --replace to config.sh only for a stale runner GitHub still lists, where there is a bash (#319)", () => {
    if (!hasTool("bash", ["-c", "exit 0"])) return;
    const dir = mkdtempSync(join(tmpdir(), "nen-runner-replace-"));
    writeFileSync(join(dir, "config.sh"), '#!/usr/bin/env bash\nprintf "argv=%s\\n" "$*"\n');
    const lines = mac.text.split("\n");
    const at = lines.findIndex((candidate) => candidate.includes('ACTIONS_RUNNER_INPUT_TOKEN="$token" ./config.sh'));
    const call = (lines[at] ?? "").replace(/^ {2}if ! /, "").replace(/; then$/, "");
    const pick = [lines[at - 2], lines[at - 1]].join("\n");
    const script = (replaceNames: string): string =>
      `set -u; dir=${JSON.stringify(dir.replace(/\\/g, "/"))}; token=t; REPO_URL=u; name=NZ-NNR1; LABELS=l; replace_names=${JSON.stringify(replaceNames)}; chmod +x "$dir/config.sh"\n${pick}\n${call}`;
    expect(spawnSync("bash", ["-c", script(" NZ-NNR1 ")], { encoding: "utf8" }).stdout.trim()).toBe("argv=--unattended --url u --name NZ-NNR1 --labels l --work _work --replace");
    expect(spawnSync("bash", ["-c", script(" ")], { encoding: "utf8" }).stdout.trim()).toBe("argv=--unattended --url u --name NZ-NNR1 --labels l --work _work");
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
    // Written to the maintainer's own profile, never under the runner root (#312).
    expect(launchLine("Windows", "C:\\Users\\maintainer\\AppData\\Local\\nen\\jusshin\\register.ps1")).toBe(
      "powershell -NoProfile -ExecutionPolicy Bypass -Command \"Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\\Users\\maintainer\\AppData\\Local\\nen\\jusshin\\register.ps1'\"",
    );
    expect(launchLine("Linux", "/tmp/register.sh")).toBe("sudo bash /tmp/register.sh");
    expect(launchLine("macOS", "/tmp/register.sh")).toBe("bash /tmp/register.sh");
  });
});
