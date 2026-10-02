import { describe, expect, it } from "vitest";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import {
  candidateRepositories,
  checkNeighbours,
  linuxShowArgv,
  linuxUnitsArgv,
  recommendAccount,
  renderNeighbours,
  repoArgv,
  sameAccount,
  windowsServicesArgv,
} from "./neighbours.js";
import { TARGET, windowsServicesCall } from "./testkit.js";

const repo = (slug: string, visibility: string | null): ScriptedCall => ({
  match: `gh ${repoArgv(slug).join(" ")}`,
  result: visibility === null ? { code: 1, stderr: "HTTP 404: Not Found" } : { stdout: JSON.stringify({ full_name: slug, visibility }) },
});

// Feitan's evidence on #330, reduced: the public zheref/nen planned as the
// account that already runs the private zheref/KroWindows' runners.
const HOST = [
  { Name: "actions.runner.zheref-KroWindows.NZ-KWIR1", StartName: ".\\lordzheref" },
  { Name: "actions.runner.zheref-KroWindows.NZ-KWIR2", StartName: "NZHOST\\LordZheref" },
  { Name: "actions.runner.zheref-bankai-core.NZ-BCR1", StartName: ".\\lordzheref" },
  { Name: "actions.runner.zheref-nen.NZ-NNR1", StartName: ".\\lordzheref" },
  { Name: "actions.runner.zheref-other.NZ-OTR1", StartName: "NT AUTHORITY\\NetworkService" },
];

function windowsHost(script: readonly ScriptedCall[]): ScriptedSeams {
  return new ScriptedSeams(script, { platform: "win32", env: { COMPUTERNAME: "NZHOST" } });
}

describe("checkNeighbours -- one account on one host is one trust domain (#330)", () => {
  it("warns about the services that run as the plan's account for a repository of different visibility, and only those", () => {
    const seams = windowsHost([
      windowsServicesCall(HOST),
      repo("zheref/nen", "public"),
      repo("zheref/KroWindows", "private"),
      repo("zheref/bankai-core", "public"),
    ]);
    const report = checkNeighbours(seams, TARGET, "Windows", ".\\lordzheref");
    expect(report).toEqual({
      status: "checked",
      detail: "3 other runner service(s) on this host run as .\\lordzheref",
      targetVisibility: "public",
      mixed: [
        { service: "actions.runner.zheref-KroWindows.NZ-KWIR1", repository: "zheref/KroWindows", visibility: "private" },
        { service: "actions.runner.zheref-KroWindows.NZ-KWIR2", repository: "zheref/KroWindows", visibility: "private" },
      ],
      recommendedAccount: "runner-nen",
    });
    // One lookup per repository, however many of its services share the account.
    expect(seams.calls.filter((call) => call.args.join(" ") === repoArgv("zheref/KroWindows").join(" "))).toHaveLength(1);
    const lines = renderNeighbours(report, TARGET, ".\\lordzheref");
    expect(lines[0]).toMatch(/^warning: \.\\lordzheref already runs 2 runner service\(s\) on this host for a repository whose visibility differs from zheref\/nen's \(public\)/);
    expect(lines.slice(1, 3)).toEqual([
      "  actions.runner.zheref-KroWindows.NZ-KWIR1 -- zheref/KroWindows, private",
      "  actions.runner.zheref-KroWindows.NZ-KWIR2 -- zheref/KroWindows, private",
    ]);
    expect(lines[3]).toBe("recommended: a local account for zheref/nen alone, e.g. --service-account runner-nen (create it yourself first; nen never creates an account or handles its password).");
  });

  it("says nothing when no other repository's service shares the account, and reads no repository", () => {
    const seams = windowsHost([windowsServicesCall(HOST)]);
    const report = checkNeighbours(seams, TARGET, "Windows", ".\\runner-nen");
    expect(report.status).toBe("checked");
    expect(report.mixed).toEqual([]);
    expect(renderNeighbours(report, TARGET, ".\\runner-nen")).toEqual([]);
    expect(seams.calls.map((call) => call.command)).toEqual(["powershell"]);
  });

  it("reports a repository it cannot resolve, rather than reading 'unknown' as 'the same'", () => {
    const seams = windowsHost([
      windowsServicesCall([{ Name: "actions.runner.ghost-repo.X1", StartName: ".\\lordzheref" }]),
      repo("zheref/nen", "public"),
      repo("ghost/repo", null),
    ]);
    const report = checkNeighbours(seams, TARGET, "Windows", ".\\lordzheref");
    expect(report.mixed).toEqual([{ service: "actions.runner.ghost-repo.X1", repository: null, visibility: null }]);
    expect(renderNeighbours(report, TARGET, ".\\lordzheref")[1]).toBe("  actions.runner.ghost-repo.X1 -- (repository unresolved), visibility unknown");
  });

  it("compares network-service with NT AUTHORITY\\NetworkService, and reads ConvertTo-Json's single object", () => {
    const seams = windowsHost([
      windowsServicesCall([{ Name: "actions.runner.zheref-KroWindows.NZ-KWIR9", StartName: "NT AUTHORITY\\NetworkService" }]),
      repo("zheref/nen", "public"),
      repo("zheref/KroWindows", "private"),
    ]);
    expect(checkNeighbours(seams, TARGET, "Windows", "network-service").mixed).toHaveLength(1);
  });

  it("does not run off the host, on macOS, or with no account -- and says so only when it could have", () => {
    const linux = new ScriptedSeams([], { platform: "linux" });
    const offHost = checkNeighbours(linux, TARGET, "Windows", ".\\lordzheref");
    expect(offHost.status).toBe("off-host");
    expect(renderNeighbours(offHost, TARGET, ".\\lordzheref")).toEqual([
      "note: the shared-account check did not run (this plan was computed on linux, not on the Windows host, so the host's existing runner services were not read). Run 'nen runner plan' on the runner host to have it read.",
    ]);
    expect(checkNeighbours(linux, TARGET, "macOS", "invoking-user").status).toBe("no-account");
    expect(checkNeighbours(linux, TARGET, "Windows", "ask").status).toBe("no-account");
    expect(renderNeighbours(checkNeighbours(linux, TARGET, "Windows", "ask"), TARGET, "ask")).toEqual([]);
    expect(linux.calls).toEqual([]);
  });

  it("is a note, never an exit, when the host cannot be read", () => {
    const seams = windowsHost([{ match: `powershell ${windowsServicesArgv().join(" ")}`, result: { code: 1, stderr: "Access is denied." } }]);
    const report = checkNeighbours(seams, TARGET, "Windows", ".\\lordzheref");
    expect(report.status).toBe("unreadable");
    expect(renderNeighbours(report, TARGET, ".\\lordzheref")[0]).toMatch(/^note: the shared-account check did not run \(powershell could not list services \(Access is denied\.\)\)/);
    const garbled = windowsHost([{ match: `powershell ${windowsServicesArgv().join(" ")}`, result: { stdout: "<xml/>" } }]);
    expect(checkNeighbours(garbled, TARGET, "Windows", ".\\lordzheref").detail).toBe("powershell answered something that is not JSON");
  });

  it("reads a Linux host's units and their User=", () => {
    const units = ["actions.runner.zheref-KroWindows.NZ-KWIR1.service", "actions.runner.zheref-nen.NZ-NNR1.service"];
    const seams = new ScriptedSeams(
      [
        { match: `systemctl ${linuxUnitsArgv().join(" ")}`, result: { stdout: `${units[0]} loaded active running GitHub Actions Runner\n${units[1]} loaded active running GitHub Actions Runner\n` } },
        { match: `systemctl ${linuxShowArgv(units).join(" ")}`, result: { stdout: `Id=${units[0]}\nUser=runner\n\nId=${units[1]}\nUser=runner\n` } },
        repo("zheref/nen", "public"),
        repo("zheref/KroWindows", "private"),
      ],
      { platform: "linux" },
    );
    const report = checkNeighbours(seams, TARGET, "Linux", "runner");
    expect(report.mixed).toEqual([{ service: "actions.runner.zheref-KroWindows.NZ-KWIR1", repository: "zheref/KroWindows", visibility: "private" }]);
    expect(checkNeighbours(seams, TARGET, "Linux", "someone-else").mixed).toEqual([]);
  });
});

describe("the pieces", () => {
  it("matches a Windows logon account in each spelling Windows reports, and a Linux user exactly", () => {
    expect(sameAccount("Windows", ".\\lordzheref", ".\\LordZheref", null)).toBe(true);
    expect(sameAccount("Windows", ".\\lordzheref", "NZHOST\\lordzheref", "nzhost")).toBe(true);
    expect(sameAccount("Windows", ".\\lordzheref", "OTHERHOST\\lordzheref", "nzhost")).toBe(false);
    expect(sameAccount("Windows", ".\\lordzheref", "lordzheref", null)).toBe(true);
    expect(sameAccount("Windows", "network-service", "NT AUTHORITY\\NetworkService", null)).toBe(true);
    expect(sameAccount("Windows", "network-service", "LocalSystem", null)).toBe(false);
    expect(sameAccount("Linux", "runner", "runner", null)).toBe(true);
    expect(sameAccount("Linux", "runner", "Runner", null)).toBe(false);
  });

  it("splits a service name into every owner/name it could mean, the target's owner first", () => {
    expect(candidateRepositories("actions.runner.zheref-bankai-core.NZ-BCR1", TARGET)).toEqual(["zheref/bankai-core", "zheref-bankai/core"]);
    expect(candidateRepositories("actions.runner.some-org-repo.R1", TARGET)).toEqual(["some/org-repo", "some-org/repo"]);
    expect(candidateRepositories("not.a.runner", TARGET)).toEqual([]);
  });

  it("recommends runner-<repo>, folded to what the OS accepts", () => {
    expect(recommendAccount("Windows", TARGET)).toBe("runner-nen");
    expect(recommendAccount("Windows", { owner: "zheref", repo: "KroWindows.Very_Long_Name", slug: "zheref/KroWindows.Very_Long_Name" })).toBe("runner-krowindows-ve");
    expect(recommendAccount("Linux", { owner: "zheref", repo: "KroWindows.Very_Long_Name", slug: "zheref/KroWindows.Very_Long_Name" })).toBe("runner-krowindows-very-long-name");
  });
});
