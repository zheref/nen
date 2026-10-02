import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import { VerbUsageError } from "../cli/command.js";
import { fetchDownloads, fetchRunners } from "./inventory.js";
import {
  computePlan,
  normalizeMachineCode,
  PLAN_CONTRACT,
  renderPlan,
  resolveConsumerCode,
  resolveIdentity,
  resolveRoot,
  runnerVersionOf,
  validatePlan,
  type PlanInputs,
  type RunnerPlan,
} from "./plan.js";
import { inventoryCalls, pool, runnersAnswer, TARGET } from "./testkit.js";

function inputs(overrides: Partial<PlanInputs> = {}, runnersJson?: string): PlanInputs {
  const seams = new ScriptedSeams(inventoryCalls(runnersJson));
  return {
    target: TARGET,
    pool: pool("windows-x64"),
    machineCode: "NZ",
    consumerCode: "NN",
    count: 3,
    root: null,
    serviceAccount: "lordzheref",
    runners: fetchRunners(seams, TARGET),
    downloads: fetchDownloads(seams, TARGET),
    platform: "win32",
    env: {},
    ...overrides,
  };
}

/** The plan the live run computed for NZ on zheref/nen -- the spec's expected shape. */
function nzPlan(): RunnerPlan {
  return computePlan(inputs());
}

describe("computePlan -- the NZ-NNR1..3 plan for zheref/nen's windows-x64 pool", () => {
  it("plans the three lowest free slots under the neutral root, with the verified package", () => {
    const plan = nzPlan();
    expect(plan).toEqual({
      contract: PLAN_CONTRACT,
      target: "zheref/nen",
      pool: "windows-x64",
      os: "Windows",
      arch: "X64",
      mode: "service",
      labels: ["self-hosted", "Windows", "X64"],
      machineCode: "NZ",
      consumerCode: "NN",
      root: "C:\\GithubRunners",
      projectDir: "C:\\GithubRunners\\nen-runners",
      identity: ".\\lordzheref",
      dailyAccount: false,
      runnerVersion: "2.337.0",
      download: {
        os: "win",
        architecture: "x64",
        filename: "actions-runner-win-x64-2.337.0.zip",
        download_url: "https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-win-x64-2.337.0.zip",
        sha256_checksum: "1150692afa94e71f872017e254ea55b6eece1eece3fe7e3a6d4c93d0a1b85cfc",
      },
      runners: [1, 2, 3].map((slot) => ({
        slot,
        name: `NZ-NNR${slot}`,
        installDir: `C:\\GithubRunners\\nen-runners\\Runner${slot}`,
        serviceName: `actions.runner.zheref-nen.NZ-NNR${slot}`,
      })),
      existing: [],
    });
    const text = renderPlan(plan).join("\n");
    expect(text).toMatch(/labels: self-hosted,Windows,X64/);
    expect(text).toMatch(/NZ-NNR3 .*C:\\GithubRunners\\nen-runners\\Runner3/);
    expect(text).toMatch(/already registered for NZ\/NN: \(none\)/);
    expect(text).toMatch(/^mode: service$/m);
    expect(text).not.toMatch(/note:|warning:/);
  });

  it("skips slots this machine and consumer already hold, in any case, and ignores other machines' slots", () => {
    const answer = runnersAnswer([{ name: "NZ-NNR1" }, { name: "nz-NNR3" }, { name: "RJ2-NNR2", labels: ["self-hosted", "macOS", "ARM64"] }]);
    const plan = computePlan(inputs({ count: 2 }, answer));
    expect(plan.runners.map((runner) => runner.name)).toEqual(["NZ-NNR2", "NZ-NNR4"]);
    expect(plan.existing).toEqual(["NZ-NNR1", "nz-NNR3"]);
  });

  it("refuses a count outside 1..16 as usage, and a pool with no download as exit 1", () => {
    expect(() => computePlan(inputs({ count: 0 }))).toThrow(VerbUsageError);
    expect(() => computePlan(inputs({ count: 17 }))).toThrow(/from 1 to 16/);
    expect(() => computePlan(inputs({ downloads: [] }))).toThrow(expect.objectContaining({ exitCode: 1, message: expect.stringMatching(/no runner package for Windows X64/) }));
  });

  it("refuses a download row it cannot plan from", () => {
    const bad = inputs().downloads.map((row) => (row.os === "win" && row.architecture === "x64" ? { ...row, sha256_checksum: "nope" } : row));
    expect(() => computePlan(inputs({ downloads: bad }))).toThrow(/not one this verb can plan from/);
  });

  it("writes Linux and macOS paths with forward slashes, whatever this process is", () => {
    const linux = computePlan(inputs({ pool: pool("linux-x64"), serviceAccount: "runner", count: 1 }));
    expect(linux.root).toBe("/opt/actions-runners");
    expect(linux.runners[0]?.installDir).toBe("/opt/actions-runners/nen-runners/Runner1");
    expect(linux.download.filename).toBe("actions-runner-linux-x64-2.337.0.tar.gz");
    expect(linux.identity).toBe("runner");
    const mac = computePlan(inputs({ pool: pool("macos-arm64"), serviceAccount: null, count: 1, platform: "darwin", env: { HOME: "/Users/zheref" } }));
    expect(mac.root).toBe("/Users/zheref/actions-runners");
    expect(mac.identity).toBe("invoking-user");
    expect(mac.download.filename).toBe("actions-runner-osx-arm64-2.337.0.tar.gz");
    // RJ2-NNR1..3 are this consumer's but another machine's: NZ still starts at 1.
    expect(mac.runners[0]?.name).toBe("NZ-NNR1");
  });
});

describe("computePlan -- an interactive Windows pool (#333)", () => {
  const desktop = (overrides: Partial<PlanInputs> = {}): RunnerPlan =>
    computePlan(inputs({ pool: pool("windows-x64-desktop"), serviceAccount: "kwidesktop", count: 1, env: { USERNAME: "zhere" }, ...overrides }));

  it("carries the mode and the four labels, and says the runner is online only while its identity is signed in", () => {
    const plan = desktop();
    expect(plan).toMatchObject({ mode: "interactive", labels: ["self-hosted", "Windows", "X64", "desktop"], identity: ".\\kwidesktop", dailyAccount: false });
    const text = renderPlan(plan).join("\n");
    expect(text).toMatch(/^labels: self-hosted,Windows,X64,desktop$/m);
    expect(text).toMatch(/^mode: interactive -- a Scheduled Task at the identity's logon starts run\.cmd in its desktop session; no service is installed$/m);
    expect(text).toMatch(/online only while \.\\kwidesktop is signed in to the desktop \(or auto-logged on\); nen never configures auto-logon/);
    expect(text).toMatch(/with that account's profile and credentials/);
    expect(text).toMatch(/use a dedicated local account, never your daily one/);
    expect(text).toMatch(/\| logon task +\|/);
    expect(text).not.toMatch(/warning:/);
  });

  it("flags and warns when the identity is the Windows account computing the plan, in any case", () => {
    const plan = desktop({ serviceAccount: "Zhere" });
    expect(plan.dailyAccount).toBe(true);
    expect(renderPlan(plan).join("\n")).toMatch(
      /warning: \.\\Zhere is the account computing this plan -- your own daily account\..*renders this plan only with --accept-daily-account/,
    );
  });

  it("cannot tell from another host, or without USERNAME, and never flags a service pool", () => {
    expect(desktop({ serviceAccount: "zhere", platform: "darwin" }).dailyAccount).toBe(false);
    expect(desktop({ serviceAccount: "zhere", env: {} }).dailyAccount).toBe(false);
    expect(computePlan(inputs({ serviceAccount: "zhere", env: { USERNAME: "zhere" } })).dailyAccount).toBe(false);
  });

  it("refuses network-service, which cannot log on interactively, and keeps ask until an account is named", () => {
    expect(() => desktop({ serviceAccount: "network-service" })).toThrow(/network-service cannot log on interactively/);
    expect(() => desktop({ serviceAccount: "zhere@outlook.com" })).toThrow(/name the local account Windows created for it/);
    const unnamed = desktop({ serviceAccount: null });
    expect(unnamed.identity).toBe("ask");
    expect(renderPlan(unnamed).join("\n")).toMatch(/online only while the identity is signed in/);
  });
});

describe("resolveRoot -- the flag, the pool's default, the built-in; ~ expanded only on its own host", () => {
  it("takes --root over the pool's default and normalizes separators for the target OS", () => {
    expect(resolveRoot({ pool: pool("windows-x64"), root: "D:/Runners/", platform: "linux", env: {} })).toBe("D:\\Runners");
    expect(resolveRoot({ pool: pool("linux-x64"), root: "/srv/runners/", platform: "win32", env: {} })).toBe("/srv/runners");
  });

  it("refuses ~ it cannot expand, a relative root, and a root with shell metacharacters", () => {
    expect(() => resolveRoot({ pool: pool("macos-arm64"), root: null, platform: "win32", env: { HOME: "/x" } })).toThrow(/cannot expand it for a macOS host from win32/);
    expect(() => resolveRoot({ pool: pool("macos-arm64"), root: null, platform: "darwin", env: {} })).toThrow(/no usable HOME/);
    expect(() => resolveRoot({ pool: pool("linux-x64"), root: "relative/dir", platform: "linux", env: {} })).toThrow(/not an absolute path/);
    expect(() => resolveRoot({ pool: pool("windows-x64"), root: "Runners", platform: "win32", env: {} })).toThrow(/not an absolute Windows path/);
    expect(() => resolveRoot({ pool: pool("windows-x64"), root: "C:\\Run'ners", platform: "win32", env: {} })).toThrow(/not a root nen can render/);
  });
});

describe("identity, codes and version", () => {
  it("stores .\\<account> on Windows, network-service only by that word, and ask when unnamed", () => {
    expect(resolveIdentity("Windows", "lordzheref")).toBe(".\\lordzheref");
    expect(resolveIdentity("Windows", ".\\lordzheref")).toBe(".\\lordzheref");
    expect(resolveIdentity("Windows", "network-service")).toBe("network-service");
    expect(resolveIdentity("Windows", null)).toBe("ask");
    expect(() => resolveIdentity("Windows", "zhere@outlook.com")).toThrow(/not a local account.*Microsoft/);
    expect(() => resolveIdentity("Windows", "DOMAIN\\user")).toThrow(/not a local account/);
    expect(() => resolveIdentity("Windows", "has space")).toThrow(/not a local account name/);
    expect(resolveIdentity("Linux", null)).toBe("ask");
    expect(() => resolveIdentity("Linux", "root")).toThrow(/refused/);
    expect(() => resolveIdentity("Linux", "Bad User")).toThrow(/not a Linux user name/);
    expect(() => resolveIdentity("macOS", "someone")).toThrow(/does not apply to a macOS pool/);
    expect(resolveIdentity("Windows", "kwidesktop", "interactive")).toBe(".\\kwidesktop");
    expect(() => resolveIdentity("Windows", "network-service", "interactive")).toThrow(/cannot log on interactively/);
    for (const builtIn of ["SYSTEM", "LocalSystem", "localservice", "NetworkService", ".\\networkservice"]) {
      expect(() => resolveIdentity("Windows", builtIn, "interactive"), builtIn).toThrow(/built-in service identity, and it cannot log on interactively/);
    }
    expect(resolveIdentity("Windows", "LocalService")).toBe(".\\LocalService");
  });

  it("derives the consumer code from product_codes, or refuses naming the flag", () => {
    expect(resolveConsumerCode(null, { HA: "zheref/hatsu", NN: "zheref/nen" }, TARGET)).toBe("NN");
    expect(resolveConsumerCode(null, { NN: "Zheref/Nen" }, TARGET)).toBe("NN");
    expect(resolveConsumerCode("XX", {}, TARGET)).toBe("XX");
    expect(() => resolveConsumerCode(null, { HA: "zheref/hatsu" }, TARGET)).toThrow(/Pass --consumer-code/);
    expect(() => resolveConsumerCode(null, { NN: "zheref/nen", NE: "zheref/nen" }, TARGET)).toThrow(/2 product_codes keys/);
    expect(() => resolveConsumerCode("N-N", {}, TARGET)).toThrow(/letters and digits only/);
  });

  it("upper-cases and bounds the machine code", () => {
    expect(normalizeMachineCode(" nz ")).toBe("NZ");
    expect(() => normalizeMachineCode("NOSARASHI")).toThrow(/one to eight/);
    expect(() => normalizeMachineCode("N-Z")).toThrow(VerbUsageError);
  });

  it("reads the runner version out of the package name", () => {
    expect(runnerVersionOf("actions-runner-win-x64-2.337.0.zip")).toBe("2.337.0");
    expect(runnerVersionOf("actions-runner-linux-arm64-2.337.0.tar.gz")).toBe("2.337.0");
    expect(runnerVersionOf("something.zip")).toBeNull();
  });
});

describe("validatePlan -- the contract's refusal", () => {
  it("round-trips a computed plan exactly", () => {
    const plan = nzPlan();
    expect(validatePlan(JSON.parse(JSON.stringify(plan)), "<plan>")).toEqual(plan);
  });

  it("round-trips an interactive plan, and refuses network-service or a macOS service in one", () => {
    const plan = computePlan(inputs({ pool: pool("windows-x64-desktop"), serviceAccount: "zhere", env: { USERNAME: "zhere" } }));
    const json = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
    expect(validatePlan(json, "<plan>")).toEqual(plan);
    expect(() => validatePlan({ ...json, identity: "network-service" }, "<plan>")).toThrow(/'identity'/);
    const mac = JSON.parse(JSON.stringify(computePlan(inputs({ pool: pool("macos-arm64"), serviceAccount: null, platform: "darwin", env: { HOME: "/Users/x" } })))) as Record<string, unknown>;
    expect(validatePlan(mac, "<plan>").mode).toBe("interactive");
    expect(() => validatePlan({ ...mac, mode: "service" }, "<plan>")).toThrow(/'mode' is 'service' for a macOS pool/);
  });

  it("still reads a v0.1 plan, as the service plan it was", () => {
    const v01 = JSON.parse(JSON.stringify(nzPlan())) as Record<string, unknown>;
    delete v01["mode"];
    delete v01["dailyAccount"];
    const read = validatePlan({ ...v01, contract: "nen.runner.plan/v0.1" }, "<plan>");
    expect(read).toEqual(nzPlan());
  });

  it("refuses every field that reaches a script when it is not what plan would write", () => {
    const plan = JSON.parse(JSON.stringify(nzPlan())) as Record<string, unknown>;
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["contract", { ...plan, contract: "nen.runner.plan/v9" }, /contract/],
      ["target", { ...plan, target: "zheref/nen'; rm -rf" }, /'target'/],
      ["os", { ...plan, os: "windows" }, /'os'/],
      ["labels", { ...plan, labels: ["self-hosted", "Windows", "X64", "gpu"] }, /'labels'/],
      ["root quote", { ...plan, root: "C:\\Git'Runners" }, /'root'/],
      ["identity", { ...plan, identity: ".\\a'b" }, /'identity'/],
      ["identity on linux", { ...plan, identity: "invoking-user" }, /'identity'/],
      ["url host", { ...plan, download: { ...(plan["download"] as object), download_url: "https://evil.example/x.zip" } }, /download_url/],
      ["sha", { ...plan, download: { ...(plan["download"] as object), sha256_checksum: "abc" } }, /sha256/],
      ["filename", { ...plan, download: { ...(plan["download"] as object), filename: "x.zip" } }, /filename/],
      ["runner name", { ...plan, runners: [{ ...(plan["runners"] as object[])[0], name: "NZ-NNR9" }] }, /runners\[0\]\.name/],
      ["install dir", { ...plan, runners: [{ ...(plan["runners"] as object[])[0], installDir: "C:\\Windows" }] }, /installDir/],
      ["service", { ...plan, runners: [{ ...(plan["runners"] as object[])[0], serviceName: "x" }] }, /serviceName/],
      ["runners empty", { ...plan, runners: [] }, /'runners'/],
      ["project dir", { ...plan, projectDir: "C:\\Elsewhere", runners: [] }, /'runners'|projectDir/],
      ["not an object", [] as unknown as Record<string, unknown>, /not a JSON object/],
      ["mode", { ...plan, mode: "desktop" }, /'mode'/],
      ["mode missing", { ...plan, mode: undefined }, /'mode'/],
      ["interactive labels", { ...plan, mode: "interactive" }, /'labels'.*"desktop"/],
      ["daily account on a service plan", { ...plan, dailyAccount: true }, /'dailyAccount'/],
      ["daily account missing", { ...plan, dailyAccount: undefined }, /'dailyAccount'/],
    ];
    for (const [what, value, pattern] of cases) {
      expect(() => validatePlan(value, "<plan>"), what).toThrow(pattern);
      expect(() => validatePlan(value, "<plan>"), what).toThrow(VerbUsageError);
    }
  });
});
