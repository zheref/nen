import { describe, expect, it } from "vitest";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import {
  candidateRepositories,
  checkNeighbours,
  linuxShowArgv,
  linuxUnitsArgv,
  powershellPath,
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
  { Name: "actions.runner.zheref-other.NZ-OTR1", StartName: "NT AUTHORITY\\NETWORK SERVICE", Sid: "S-1-5-20" },
];
const HOST_REPOS = [repo("zheref/nen", "public"), repo("zheref/KroWindows", "private"), repo("zheref/bankai-core", "public"), repo("zheref/other", "private")];

function windowsHost(script: readonly ScriptedCall[], env: Record<string, string> = { COMPUTERNAME: "NZHOST" }): ScriptedSeams {
  return new ScriptedSeams(script, { platform: "win32", env });
}

describe("checkNeighbours -- one account on one host is one trust domain (#330)", () => {
  it("warns about the services that run as the plan's account for a repository of different visibility, and only those", () => {
    const seams = windowsHost([windowsServicesCall(HOST), ...HOST_REPOS]);
    const report = checkNeighbours(seams, TARGET, "Windows", ".\\lordzheref");
    expect(report).toMatchObject({
      status: "checked",
      targetVisibility: "public",
      mixed: [
        { service: "actions.runner.zheref-KroWindows.NZ-KWIR1", repository: "zheref/KroWindows", visibility: "private" },
        { service: "actions.runner.zheref-KroWindows.NZ-KWIR2", repository: "zheref/KroWindows", visibility: "private" },
      ],
      stranded: [],
      recommendedAccount: "runner-nen",
    });
    // One lookup per repository, however many of its services share the account.
    expect(seams.calls.filter((call) => call.args.join(" ") === repoArgv("zheref/KroWindows").join(" "))).toHaveLength(1);
    const lines = renderNeighbours(report, TARGET, ".\\lordzheref");
    expect(lines[0]).toMatch(/^warning: \.\\lordzheref already runs 2 runner service\(s\) on this host for repositories whose visibility differs from zheref\/nen's \(public\) or cannot be told/);
    expect(lines.slice(1)).toEqual([
      "  actions.runner.zheref-KroWindows.NZ-KWIR1 -- zheref/KroWindows, private",
      "  actions.runner.zheref-KroWindows.NZ-KWIR2 -- zheref/KroWindows, private",
      "recommended: a local account for zheref/nen alone, e.g. --service-account runner-nen (create it yourself first; nen never creates an account or handles its password).",
    ]);
  });

  it("says that the target's own runners keep a shared account when the advice moves only the new ones (#330 review)", () => {
    // Following the recommendation: plan as runner-nen. NZ-NNR1 stays on lordzheref, which serves KroWindows.
    const seams = windowsHost([windowsServicesCall(HOST), ...HOST_REPOS]);
    const report = checkNeighbours(seams, TARGET, "Windows", ".\\runner-nen");
    expect(report.mixed).toEqual([]);
    expect(report.stranded).toEqual([
      {
        account: ".\\lordzheref",
        services: ["actions.runner.zheref-nen.NZ-NNR1"],
        sharedWith: [
          { service: "actions.runner.zheref-KroWindows.NZ-KWIR1", repository: "zheref/KroWindows", visibility: "private" },
          { service: "actions.runner.zheref-KroWindows.NZ-KWIR2", repository: "zheref/KroWindows", visibility: "private" },
        ],
      },
    ]);
    const lines = renderNeighbours(report, TARGET, ".\\runner-nen");
    expect(lines[0]).toMatch(/^warning: zheref\/nen's existing runner service\(s\) actions\.runner\.zheref-nen\.NZ-NNR1 log on as \.\\lordzheref, .*a new account moves only the runners this plan adds -- these keep \.\\lordzheref until they are removed and registered again under the new account/);
    expect(lines).toHaveLength(3);
  });

  it("says nothing when neither the account nor the target's own runners are shared across visibilities", () => {
    const seams = windowsHost([windowsServicesCall([{ Name: "actions.runner.zheref-nen.NZ-NNR1", StartName: ".\\runner-nen" }, ...HOST.slice(0, 3)]), ...HOST_REPOS]);
    const report = checkNeighbours(seams, TARGET, "Windows", ".\\runner-nen");
    expect(report).toMatchObject({ status: "checked", mixed: [], stranded: [] });
    expect(renderNeighbours(report, TARGET, ".\\runner-nen")).toEqual([]);
    expect(checkNeighbours(windowsHost([windowsServicesCall([])]), TARGET, "Windows", ".\\x").detail).toBe("no runner service on this host");
  });

  it("resolves every service rather than trusting its prefix: zheref/nen.docs is not zheref/nen (#330 review)", () => {
    const seams = windowsHost([
      windowsServicesCall([{ Name: "actions.runner.zheref-nen.docs.NZ-R1", StartName: ".\\lordzheref" }]),
      repo("zheref/nen", "public"),
      repo("zheref/nen.docs", "private"),
    ]);
    expect(checkNeighbours(seams, TARGET, "Windows", ".\\lordzheref").mixed).toEqual([
      { service: "actions.runner.zheref-nen.docs.NZ-R1", repository: "zheref/nen.docs", visibility: "private" },
    ]);
  });

  it("reports a repository it cannot resolve, and a target it cannot read, rather than reading 'unknown' as 'the same'", () => {
    const ghost = windowsHost([windowsServicesCall([{ Name: "actions.runner.ghost-repo.X1", StartName: ".\\lordzheref" }]), repo("zheref/nen", "public"), repo("ghost/repo", null)]);
    const report = checkNeighbours(ghost, TARGET, "Windows", ".\\lordzheref");
    expect(report.mixed).toEqual([{ service: "actions.runner.ghost-repo.X1", repository: null, visibility: null }]);
    expect(renderNeighbours(report, TARGET, ".\\lordzheref")[1]).toBe("  actions.runner.ghost-repo.X1 -- (repository unresolved), visibility unknown");
    const blind = windowsHost([windowsServicesCall([HOST[2] as { Name: string; StartName: string }]), repo("zheref/nen", null), repo("zheref/bankai-core", "public")]);
    const unknown = checkNeighbours(blind, TARGET, "Windows", ".\\lordzheref");
    expect(unknown.targetVisibility).toBeNull();
    expect(unknown.mixed).toHaveLength(1);
    expect(renderNeighbours(unknown, TARGET, ".\\lordzheref")[0]).toMatch(/differs from zheref\/nen's \(unknown\)/);
  });

  it("matches network-service by SID, and by the spaced spelling actions/runner writes (#330 review)", () => {
    const seams = windowsHost([
      windowsServicesCall([{ Name: "actions.runner.zheref-KroWindows.NZ-KWIR9", StartName: "AUTORITE NT\\SERVICE RÉSEAU", Sid: "S-1-5-20" }]),
      repo("zheref/nen", "public"),
      repo("zheref/KroWindows", "private"),
    ]);
    expect(checkNeighbours(seams, TARGET, "Windows", "network-service").mixed).toHaveLength(1);
    expect(sameAccount("Windows", "network-service", { account: "NT AUTHORITY\\NETWORK SERVICE", sid: null }, null)).toBe(true);
    expect(sameAccount("Windows", "network-service", { account: "NT AUTHORITY\\NetworkService", sid: null }, null)).toBe(true);
    expect(sameAccount("Windows", "network-service", { account: "LocalSystem", sid: "S-1-5-18" }, null)).toBe(false);
  });

  it("reads gh's private flag when visibility is absent, and treats gh that will not start or garbled JSON as unresolved", () => {
    const flag = windowsHost([
      windowsServicesCall([{ Name: "actions.runner.zheref-KroWindows.NZ-KWIR1", StartName: ".\\lordzheref" }]),
      { match: `gh ${repoArgv("zheref/nen").join(" ")}`, result: { stdout: '{"full_name":"zheref/nen","private":false}' } },
      { match: `gh ${repoArgv("zheref/KroWindows").join(" ")}`, result: { stdout: "not json" } },
    ]);
    expect(checkNeighbours(flag, TARGET, "Windows", ".\\lordzheref")).toMatchObject({
      targetVisibility: "public",
      mixed: [{ service: "actions.runner.zheref-KroWindows.NZ-KWIR1", repository: null, visibility: null }],
    });
    const noGh = windowsHost([
      windowsServicesCall([{ Name: "actions.runner.zheref-KroWindows.NZ-KWIR1", StartName: ".\\lordzheref" }]),
      { match: `gh ${repoArgv("zheref/nen").join(" ")}`, result: { spawnFailed: true, code: -1 } },
      { match: `gh ${repoArgv("zheref/KroWindows").join(" ")}`, result: { spawnFailed: true, code: -1 } },
    ]);
    expect(checkNeighbours(noGh, TARGET, "Windows", ".\\lordzheref").status).toBe("checked");
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

  it("reads a Linux host's units and their User=, and notes a systemctl that fails", () => {
    const units = ["actions.runner.zheref-KroWindows.NZ-KWIR1.service", "actions.runner.zheref-nen.NZ-NNR1.service"];
    const listed: ScriptedCall = { match: `systemctl ${linuxUnitsArgv().join(" ")}`, result: { stdout: `${units[0]} loaded active running GitHub Actions Runner\n${units[1]} loaded active running GitHub Actions Runner\n` } };
    const seams = new ScriptedSeams(
      [listed, { match: `systemctl ${linuxShowArgv(units).join(" ")}`, result: { stdout: `Id=${units[0]}\nUser=runner\n\nId=${units[1]}\nUser=runner\n` } }, repo("zheref/nen", "public"), repo("zheref/KroWindows", "private")],
      { platform: "linux" },
    );
    expect(checkNeighbours(seams, TARGET, "Linux", "runner").mixed).toEqual([{ service: "actions.runner.zheref-KroWindows.NZ-KWIR1", repository: "zheref/KroWindows", visibility: "private" }]);
    // The target's own runner on 'runner' stays shared with KroWindows when the plan names another user.
    expect(checkNeighbours(seams, TARGET, "Linux", "runner-nen").stranded).toHaveLength(1);
    const broken = new ScriptedSeams([listed, { match: `systemctl ${linuxShowArgv(units).join(" ")}`, result: { code: 1, stderr: "Failed to connect to bus" } }], { platform: "linux" });
    expect(checkNeighbours(broken, TARGET, "Linux", "runner")).toMatchObject({ status: "unreadable", detail: "systemctl could not show units (Failed to connect to bus)" });
    const empty = new ScriptedSeams([{ match: `systemctl ${linuxUnitsArgv().join(" ")}`, result: { stdout: "" } }], { platform: "linux" });
    expect(checkNeighbours(empty, TARGET, "Linux", "runner").detail).toBe("no runner service on this host");
  });
});

describe("the pieces", () => {
  it("matches a Windows logon account in each spelling Windows reports, and a Linux user exactly", () => {
    const as = (account: string): { account: string; sid: null } => ({ account, sid: null });
    expect(sameAccount("Windows", ".\\lordzheref", as(".\\LordZheref"), null)).toBe(true);
    expect(sameAccount("Windows", ".\\lordzheref", as("NZHOST\\lordzheref"), "nzhost")).toBe(true);
    expect(sameAccount("Windows", ".\\lordzheref", as("NZHOST\\lordzheref"), null)).toBe(false);
    expect(sameAccount("Windows", ".\\lordzheref", as("OTHERHOST\\lordzheref"), "nzhost")).toBe(false);
    expect(sameAccount("Windows", ".\\lordzheref", as("lordzheref"), null)).toBe(true);
    expect(sameAccount("Linux", "runner", as("runner"), null)).toBe(true);
    expect(sameAccount("Linux", "runner", as("Runner"), null)).toBe(false);
  });

  it("splits a service name into every owner/name it could mean, the target's owner first", () => {
    expect(candidateRepositories("actions.runner.zheref-bankai-core.NZ-BCR1", TARGET)).toEqual(["zheref/bankai-core", "zheref-bankai/core"]);
    expect(candidateRepositories("actions.runner.some-org-repo.R1", TARGET)).toEqual(["some/org-repo", "some-org/repo"]);
    expect(candidateRepositories("actions.runner.zheref-nen.docs.NZ-R1", TARGET)).toEqual(["zheref/nen.docs", "zheref/nen"]);
    expect(candidateRepositories("not.a.runner", TARGET)).toEqual([]);
  });

  it("recommends runner-<repo>, folded to what the OS accepts", () => {
    expect(recommendAccount("Windows", TARGET)).toBe("runner-nen");
    expect(recommendAccount("Windows", { owner: "zheref", repo: "KroWindows.Very_Long_Name", slug: "zheref/KroWindows.Very_Long_Name" })).toBe("runner-krowindows-ve");
    expect(recommendAccount("Linux", { owner: "zheref", repo: "KroWindows.Very_Long_Name", slug: "zheref/KroWindows.Very_Long_Name" })).toBe("runner-krowindows-very-long-name");
  });

  it("starts Windows PowerShell by its full path when the host names its system root", () => {
    expect(powershellPath({ SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellPath({})).toBe("powershell");
  });
});
