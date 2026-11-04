// Opt-in host smoke. No tool/template installation is part of this test.
import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { checkTaxonomy } from "../schema/taxonomy.js";
import { shuCommand } from "../shu/command.js";
import { scaffoldInit } from "./init.js";
import { scaffoldNew } from "./new.js";
import { executeNative } from "./native-exec.js";

for (const [stack, tool, hosts] of [
  ["gradle-android", "android", ["darwin", "linux", "win32"]],
  ["dotnet-winui", "dotnet", ["win32"]],
] as const) {
  const seams = defaultSeams();
  const probe = seams.run(tool, ["--version"]);
  const reason = probe.spawnFailed ? "tool missing" : !hosts.some(host => host === seams.platform) ? "host unsupported" : seams.env.NEN_NATIVE_SMOKE !== "1" ? "explicit NEN_NATIVE_SMOKE=1 consent absent" : null;
  if (reason !== null) console.info(`native smoke ${stack}: skipped: ${reason}; generated-tree schema check and build dry-run not performed`);
  it.skipIf(reason !== null)(`${stack} native smoke${reason === null ? "" : ` — skipped: ${reason}`}`, async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "nen-native-smoke-")), "FixtureApp");
    const planned = scaffoldNew({ stack, name: "FixtureApp", dir, platform: seams.platform, runNative: true });
    expect(planned.nativeExecution).toBeDefined();
    expect(executeNative(planned.nativeExecution!, seams).exitCode).toBe(0);
    expect(scaffoldInit({ root: dir, platform: seams.platform, directories: [], stack, hook: { agentTrailer: "Fixture-Agent", runTrailer: null, markerEnvVar: "FIXTURE_AUTOMATED" } }).exitCode).toBe(0);
    const report = checkTaxonomy({ repoFlag: dir, run: seams.run });
    expect(report.checks.filter(row => row.required && !row.ok)).toEqual([]);
    const out: string[] = []; const err: string[] = [];
    const code = await runFamily(shuCommand, ["shu", "build", "--dry-run", "--json"], dir, true, { out: line => out.push(line), err: line => err.push(line) }, seams);
    expect(code, err.join("\n")).toBe(0);
    expect(JSON.parse(out.join("\n"))).toBeDefined();
  });
}
