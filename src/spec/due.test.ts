import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { makeTempDir } from "../testing/tempdir.js";
import { compareVersions, newestRelease, releaseVersion } from "./due.js";
import { git, put } from "./member.testkit.js";
import { spec } from "./testkit.testkit.js";

const sha = (char: string): string => char.repeat(40);
const RECORDED = sha("a");
const NEWER = sha("b");

const PRODUCT_CODES = {
  PI: "acme/port-ios",
  PA: "acme/port-android",
  PW: "acme/port-web",
  PM: "acme/port-mac",
  PX: "acme/port-cli",
  PY: "acme/port-tv",
};

interface FamilyDecl {
  readonly name: string;
  readonly members: readonly { readonly code: keyof typeof PRODUCT_CODES; readonly platform?: string }[];
}

const capture = (code: keyof typeof PRODUCT_CODES, recorded: string, origin: string | null = PRODUCT_CODES[code]): Record<string, string> => ({
  [`capture/${code}/inventory.json`]: `${JSON.stringify({ contract: "nen.spec.inventory/v0.1", verdict: "read", repo: "/checkout", origin, scenario: "react-uzf-v1", sha: recorded, rows: [] }, null, 2)}\n`,
});

/** A committed spec checkout declaring `families` and holding `files`. */
function specRepo(families: readonly FamilyDecl[], files: Readonly<Record<string, string>> = {}): string {
  const root = makeTempDir("nen-spec-due-");
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "commit.gpgsign", "false");
  put(root, {
    "nen/repos.json": `${JSON.stringify({ consumers: [], product_codes: PRODUCT_CODES, families: families.map((family) => ({ name: family.name, spec: { repo: "acme/port-spec" }, members: family.members })) }, null, 2)}\n`,
    ...files,
  });
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "capture");
  return root;
}

const ok = (stdout: string): ScriptedCall["result"] => ({ code: 0, stdout, stderr: "", spawnFailed: false });
const failed = (stderr: string): ScriptedCall["result"] => ({ code: 1, stdout: "", stderr, spawnFailed: false });
const tagsCall = (slug: string, pages: readonly (readonly [string, string])[][]): ScriptedCall => ({
  match: `gh api --paginate --slurp repos/${slug}/tags?per_page=100`,
  result: ok(JSON.stringify(pages.map((page) => page.map(([name, commit]) => ({ name, commit: { sha: commit } }))))),
});
const compareCall = (slug: string, base: string, head: string, status: string, aheadBy: number, behindBy: number): ScriptedCall => ({
  match: `gh api repos/${slug}/compare/${base}...${head}`,
  result: ok(JSON.stringify({ status, ahead_by: aheadBy, behind_by: behindBy })),
});

interface MemberRow {
  code: string;
  repo: string | null;
  platform: string | null;
  capture: { file: string; sha: string | null } | null;
  tag: { name: string; sha: string } | null;
  compare: { status: string; aheadBy: number; behindBy: number } | null;
  state: string;
  reason: string | null;
}
interface FamilyRow {
  name: string;
  answer: string;
  members: MemberRow[];
  reason: string | null;
}
const familiesOf = (report: Record<string, unknown>): FamilyRow[] => report["families"] as FamilyRow[];

describe("nen spec due", () => {
  it("AC-1: names a family due, with the member, its newest tag and the recorded commit, when a release tag is ahead of the capture", async () => {
    const repo = specRepo([{ name: "port", members: [{ code: "PI", platform: "ios" }, { code: "PA", platform: "android" }] }], { ...capture("PI", RECORDED), ...capture("PA", sha("c")) });
    const seams = new ScriptedSeams([
      tagsCall("acme/port-ios", [[["v1.2.0", RECORDED], ["v1.3.0", NEWER]]]),
      compareCall("acme/port-ios", RECORDED, NEWER, "ahead", 4, 0),
      tagsCall("acme/port-android", [[["v2.0.0", sha("c")]]]),
    ]);
    const run = await spec(["due"], repo, seams, true);
    expect(run.code).toBe(1);
    const report = run.json();
    expect(Object.keys(report)).toEqual(["contract", "verdict", "repo", "families", "counts", "reason"]);
    expect(report).toMatchObject({ contract: "nen.spec.due/v0.1", verdict: "due", counts: { due: 1, current: 0, "no-capture": 0, "not-decided": 0 } });
    const [family] = familiesOf(report);
    expect(Object.keys(family as object)).toEqual(["name", "answer", "members", "reason"]);
    expect(family?.answer).toBe("due");
    expect(Object.keys(family?.members[0] as object)).toEqual(["code", "repo", "platform", "capture", "tag", "compare", "state", "reason"]);
    expect(family?.members[0]).toMatchObject({ code: "PI", repo: "acme/port-ios", platform: "ios", capture: { file: "capture/PI/inventory.json", sha: RECORDED }, tag: { name: "v1.3.0", sha: NEWER }, compare: { status: "ahead", aheadBy: 4, behindBy: 0 }, state: "due" });
    // The tag on the recorded commit itself needs no compare call: it is current.
    expect(family?.members[1]).toMatchObject({ code: "PA", tag: { name: "v2.0.0", sha: sha("c") }, compare: null, state: "current" });
    const human = await spec(["due"], repo, seams);
    expect(human.out[1]).toBe("  port: due -- due a recapture: released since the capture -- PI v1.3.0");
    expect(human.out[2]).toBe(`    PI acme/port-ios due · newest v1.3.0 (${NEWER.slice(0, 12)}) · recorded ${RECORDED.slice(0, 12)} -- v1.3.0 (${NEWER.slice(0, 12)}) is 4 commit(s) ahead of the recorded ${RECORDED.slice(0, 12)}`);
  });

  it("AC-1: a diverged release tag is due too, naming how far ahead and behind", async () => {
    const repo = specRepo([{ name: "port", members: [{ code: "PI" }] }], capture("PI", RECORDED));
    const seams = new ScriptedSeams([tagsCall("acme/port-ios", [[["v1.3.0", NEWER]]]), compareCall("acme/port-ios", RECORDED, NEWER, "diverged", 2, 3)]);
    const member = familiesOf((await spec(["due"], repo, seams, true)).json())[0]?.members[0];
    expect(member).toMatchObject({ state: "due", compare: { status: "diverged", aheadBy: 2, behindBy: 3 } });
    expect(member?.reason).toContain("2 ahead, 3 behind");
  });

  it("AC-2: says current and exits 0 when no member released since the capture", async () => {
    const repo = specRepo([{ name: "port", members: [{ code: "PI" }, { code: "PA" }] }], { ...capture("PI", RECORDED), ...capture("PA", RECORDED) });
    const seams = new ScriptedSeams([
      tagsCall("acme/port-ios", [[["v1.3.0", NEWER]]]),
      compareCall("acme/port-ios", RECORDED, NEWER, "behind", 0, 5),
      tagsCall("acme/port-android", [[["v0.9.0", sha("d")]]]),
      compareCall("acme/port-android", RECORDED, sha("d"), "identical", 0, 0),
    ]);
    const run = await spec(["due"], repo, seams, true);
    expect(run.code).toBe(0);
    expect(run.json()).toMatchObject({ verdict: "current", counts: { due: 0, current: 1, "no-capture": 0, "not-decided": 0 } });
    expect(familiesOf(run.json())[0]?.members.map((member) => `${member.code} ${member.state} ${member.compare?.status ?? "-"}`)).toEqual(["PI current behind", "PA current identical"]);
    const human = await spec(["due"], repo, seams);
    expect(human.code).toBe(0);
    expect(human.out).toEqual(["current: 1 family(ies) -- 0 due · 1 current · 0 no-capture · 0 not-decided", "  port: current -- no member released since the capture"]);
  });

  it("AC-2: a member with no release tag at all is current for that member", async () => {
    const repo = specRepo([{ name: "port", members: [{ code: "PI" }] }], capture("PI", RECORDED));
    const seams = new ScriptedSeams([tagsCall("acme/port-ios", [[]])]);
    const run = await spec(["due"], repo, seams, true);
    expect(run.code).toBe(0);
    expect(familiesOf(run.json())[0]?.members[0]).toMatchObject({ state: "current", tag: null, compare: null, reason: "no v<major>.<minor>.<patch> release tag (0 tag(s) read), so nothing was released since the capture" });
  });

  it("AC-3: says no capture exists, never current, and reads no tags, when no member has a capture", async () => {
    const repo = specRepo([{ name: "port", members: [{ code: "PI" }, { code: "PA" }] }]);
    const seams = new ScriptedSeams([]);
    const run = await spec(["due"], repo, seams, true);
    expect(run.code).toBe(1);
    expect(run.json()).toMatchObject({ verdict: "no-capture", counts: { "no-capture": 1, current: 0 } });
    const [family] = familiesOf(run.json());
    expect(family?.answer).toBe("no-capture");
    expect(family?.reason).toContain("no capture exists");
    expect(family?.members.map((member) => member.state)).toEqual(["no-capture", "no-capture"]);
    expect(seams.calls).toEqual([]);
  });

  it("AC-4: a member whose tags cannot be read is not read, and the family not decided", async () => {
    const repo = specRepo([{ name: "port", members: [{ code: "PI" }, { code: "PA" }] }], { ...capture("PI", RECORDED), ...capture("PA", RECORDED) });
    const seams = new ScriptedSeams([
      tagsCall("acme/port-ios", [[["v1.3.0", NEWER]]]),
      compareCall("acme/port-ios", RECORDED, NEWER, "ahead", 1, 0),
      { match: "gh api --paginate --slurp repos/acme/port-android/tags?per_page=100", result: failed("HTTP 404: Not Found") },
    ]);
    const run = await spec(["due"], repo, seams, true);
    expect(run.code).toBe(1);
    expect(run.json()).toMatchObject({ verdict: "not-decided", counts: { "not-decided": 1, due: 0, current: 0 } });
    const [family] = familiesOf(run.json());
    expect(family?.answer).toBe("not-decided");
    // The due member is still named in its row and in the reason.
    expect(family?.members[0]).toMatchObject({ code: "PI", state: "due", tag: { name: "v1.3.0" } });
    expect(family?.members[1]).toMatchObject({ code: "PA", state: "not-read", capture: { sha: RECORDED }, reason: "gh api repos/acme/port-android/tags failed: HTTP 404: Not Found" });
    expect(family?.reason).toBe("not decided: PA not read; due already: PI v1.3.0");
  });

  it("AC-4: a compare that fails, or answers no status, leaves the member not read", async () => {
    const repo = specRepo([{ name: "port", members: [{ code: "PI" }, { code: "PA" }] }], { ...capture("PI", RECORDED), ...capture("PA", RECORDED) });
    const seams = new ScriptedSeams([
      tagsCall("acme/port-ios", [[["v1.3.0", NEWER]]]),
      { match: `gh api repos/acme/port-ios/compare/${RECORDED}...${NEWER}`, result: failed("HTTP 422: No common ancestor") },
      tagsCall("acme/port-android", [[["v1.3.0", NEWER]]]),
      { match: `gh api repos/acme/port-android/compare/${RECORDED}...${NEWER}`, result: ok(JSON.stringify({ status: "unknown" })) },
    ]);
    const [family] = familiesOf((await spec(["due"], repo, seams, true)).json());
    expect(family?.answer).toBe("not-decided");
    expect(family?.members.map((member) => `${member.state} ${member.tag?.name ?? "-"}`)).toEqual(["not-read v1.3.0", "not-read v1.3.0"]);
    expect(family?.members[0]?.reason).toContain("HTTP 422");
  });

  it("AC-4: a capture entry absent beside a sibling's, malformed, or of another origin is not read -- the family never current", async () => {
    const repo = specRepo(
      [
        { name: "absent", members: [{ code: "PI" }, { code: "PA" }] },
        { name: "malformed", members: [{ code: "PW" }] },
        { name: "foreign", members: [{ code: "PM" }] },
      ],
      { ...capture("PI", RECORDED), "capture/PW/inventory.json": "{ not json", ...capture("PM", RECORDED, "acme/port-other") },
    );
    const seams = new ScriptedSeams([tagsCall("acme/port-ios", [[["v1.0.0", RECORDED]]])]);
    const run = await spec(["due"], repo, seams, true);
    expect(run.code).toBe(1);
    const families = familiesOf(run.json());
    expect(families.map((family) => `${family.name} ${family.answer}`)).toEqual(["absent not-decided", "malformed not-decided", "foreign not-decided"]);
    expect(families[0]?.members.map((member) => `${member.code} ${member.state}`)).toEqual(["PI current", "PA not-read"]);
    expect(families[0]?.members[1]).toMatchObject({ capture: null, reason: "capture/PA/inventory.json does not exist while a sibling member's capture does, so this member's recorded commit is unknown" });
    expect(families[1]?.members[0]).toMatchObject({ state: "not-read", capture: { file: "capture/PW/inventory.json", sha: null } });
    expect(families[1]?.members[0]?.reason).toContain("could not read capture/PW/inventory.json as JSON");
    expect(families[2]?.members[0]?.reason).toBe("capture/PM/inventory.json records origin acme/port-other, not acme/port-mac, so it is not this member's capture");
    // Only the readable member's tags were asked for.
    expect(seams.calls.map((call) => call.args.join(" "))).toEqual(["api --paginate --slurp repos/acme/port-ios/tags?per_page=100"]);
  });

  it("SC-1: every declared family appears with one of the four answers, the counts sum to them, and --family reports one", async () => {
    const repo = specRepo(
      [
        { name: "port-due", members: [{ code: "PI" }] },
        { name: "port-current", members: [{ code: "PW" }] },
        { name: "port-new", members: [{ code: "PM" }] },
        { name: "port-split", members: [{ code: "PX" }, { code: "PY" }] },
      ],
      { ...capture("PI", RECORDED), ...capture("PW", RECORDED), ...capture("PX", RECORDED), ...capture("PY", RECORDED) },
    );
    const seams = new ScriptedSeams([
      tagsCall("acme/port-ios", [[["v1.3.0", NEWER]]]),
      compareCall("acme/port-ios", RECORDED, NEWER, "ahead", 1, 0),
      tagsCall("acme/port-web", [[["v0.1.0", RECORDED]]]),
      tagsCall("acme/port-cli", [[["v3.0.0", RECORDED]]]),
      { match: "gh api --paginate --slurp repos/acme/port-tv/tags?per_page=100", result: ok("not json") },
    ]);
    const run = await spec(["due"], repo, seams, true);
    expect(run.code).toBe(1);
    const report = run.json();
    const families = familiesOf(report);
    expect(families.map((family) => `${family.name} ${family.answer}`)).toEqual(["port-due due", "port-current current", "port-new no-capture", "port-split not-decided"]);
    const counts = report["counts"] as Record<string, number>;
    expect(counts).toEqual({ due: 1, current: 1, "no-capture": 1, "not-decided": 1 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(families.length);
    expect(report["verdict"]).toBe("not-decided");

    const one = await spec(["due", "--family", "port-current"], repo, seams, true);
    expect(one.code).toBe(0);
    expect(familiesOf(one.json()).map((family) => family.name)).toEqual(["port-current"]);
    expect(one.json()["counts"]).toEqual({ due: 0, current: 1, "no-capture": 0, "not-decided": 0 });

    const undeclared = await spec(["due", "--family", "port-gone"], repo, seams, true);
    expect(undeclared.code).toBe(2);
    expect(undeclared.err.join("\n")).toContain("--family 'port-gone' is not declared in nen/repos.json families[]");
    expect((await spec(["due", "--family", "Not A Slug"], repo, seams, true)).code).toBe(2);
  });

  it("AC-4: a v* tag outside vMAJOR.MINOR.PATCH (calendar version, v1.2, floating v1, build metadata) leaves the member not read, never current", async () => {
    for (const odd of ["v2026.01.15", "v1.2", "v1", "v1.2.3+build.5", "vnext", "V1.2.3"]) {
      const repo = specRepo([{ name: "port", members: [{ code: "PW" }] }], capture("PW", RECORDED));
      const seams = new ScriptedSeams([tagsCall("acme/port-web", [[["v1.0.0", RECORDED], [odd, sha("9")]]])]);
      const run = await spec(["due"], repo, seams, true);
      expect(run.code, odd).toBe(1);
      const [family] = familiesOf(run.json());
      expect(family?.answer, odd).toBe("not-decided");
      expect(family?.members[0]?.state, odd).toBe("not-read");
      expect(family?.members[0]?.reason, odd).toContain(odd);
    }
  });

  it("AC-4: every other unread path is not read and the family not decided, exit 1 (the decision table's rows)", async () => {
    const cases: readonly { readonly why: string; readonly files: Record<string, string>; readonly calls: ScriptedCall[]; readonly reason: RegExp }[] = [
      { why: "capture with no sha", files: { "capture/PW/inventory.json": JSON.stringify({ contract: "nen.spec.inventory/v0.1", verdict: "read", origin: "acme/port-web", rows: [] }) }, calls: [], reason: /records no sha/ },
      { why: "capture sha that is not hex", files: capture("PW", "not-a-commit"), calls: [], reason: /not a 7-40 character hex commit/ },
      { why: "capture with no origin", files: capture("PW", RECORDED, null), calls: [], reason: /origin \(none\)/ },
      { why: "tags that are not JSON", files: capture("PW", RECORDED), calls: [{ match: "gh api --paginate --slurp repos/acme/port-web/tags?per_page=100", result: ok("<html>") }], reason: /not JSON/ },
      { why: "tags that are not a list", files: capture("PW", RECORDED), calls: [{ match: "gh api --paginate --slurp repos/acme/port-web/tags?per_page=100", result: ok(JSON.stringify({ message: "x" })) }], reason: /not a list/ },
      { why: "a tag entry without a commit sha", files: capture("PW", RECORDED), calls: [{ match: "gh api --paginate --slurp repos/acme/port-web/tags?per_page=100", result: ok(JSON.stringify([[{ name: "v1.0.0" }]])) }], reason: /is not \{name, commit/ },
      { why: "a compare that is not JSON", files: capture("PW", RECORDED), calls: [tagsCall("acme/port-web", [[["v1.1.0", NEWER]]]), { match: `gh api repos/acme/port-web/compare/${RECORDED}...${NEWER}`, result: ok("nope") }], reason: /not JSON/ },
      { why: "a compare with an unknown status", files: capture("PW", RECORDED), calls: [tagsCall("acme/port-web", [[["v1.1.0", NEWER]]]), compareCall("acme/port-web", RECORDED, NEWER, "weird", 1, 0)], reason: /answered no \{status/ },
      { why: "gh that cannot start", files: capture("PW", RECORDED), calls: [{ match: "gh api --paginate --slurp repos/acme/port-web/tags?per_page=100", result: { code: 127, stdout: "", stderr: "", spawnFailed: true } }], reason: /could not be started/ },
    ];
    for (const { why, files, calls, reason } of cases) {
      const repo = specRepo([{ name: "port", members: [{ code: "PW" }] }], files);
      const run = await spec(["due"], repo, new ScriptedSeams(calls), true);
      expect(run.code, why).toBe(1);
      const [family] = familiesOf(run.json());
      expect(family?.answer, why).toBe("not-decided");
      expect(family?.members[0]?.state, why).toBe("not-read");
      expect(family?.members[0]?.reason, why).toMatch(reason);
    }
  });

  it("AC-4 / SC-1: a capture path that cannot be read (capture/<CODE> is a file) is one member not read, and the other families still report", async () => {
    const repo = specRepo(
      [
        { name: "broken", members: [{ code: "PW" }] },
        { name: "fine", members: [{ code: "PI" }] },
      ],
      { "capture/PW": "a file where a directory should be", ...capture("PI", RECORDED) },
    );
    const run = await spec(["due"], repo, new ScriptedSeams([tagsCall("acme/port-ios", [[["v1.0.0", RECORDED]]])]), true);
    expect(run.code).toBe(1);
    const families = familiesOf(run.json());
    expect(families.map((family) => `${family.name} ${family.answer}`)).toEqual(["broken not-decided", "fine current"]);
    expect(families[0]?.members[0]?.reason).toBe("capture/PW is not a directory, so capture/PW/inventory.json cannot be read");
  });

  it("matches a capture's origin to the registry's repository without case", async () => {
    const repo = specRepo([{ name: "port", members: [{ code: "PW" }] }], capture("PW", RECORDED, "ACME/Port-Web"));
    const run = await spec(["due"], repo, new ScriptedSeams([tagsCall("acme/port-web", [[["v1.0.0", RECORDED]]])]), true);
    expect(run.code).toBe(0);
    expect(familiesOf(run.json())[0]?.answer).toBe("current");
  });

  it("orders tags by semver (v1.10.0 above v1.9.0), ignoring prereleases and tags that are not v*, across every page", async () => {
    const repo = specRepo([{ name: "port", members: [{ code: "PW" }] }], capture("PW", RECORDED));
    const seams = new ScriptedSeams([
      tagsCall("acme/port-web", [
        [["v1.9.0", sha("1")], ["v2.0.0-rc.1", sha("2")], ["nightly", sha("3")]],
        [["v1.10.0", NEWER], ["release-9.0.0", sha("5")], ["2026.01.15", sha("6")]],
      ]),
      compareCall("acme/port-web", RECORDED, NEWER, "ahead", 7, 0),
    ]);
    const member = familiesOf((await spec(["due"], repo, seams, true)).json())[0]?.members[0];
    expect(member).toMatchObject({ state: "due", tag: { name: "v1.10.0", sha: NEWER } });
  });

  it("the comparator: release tags only, by numeric precedence", () => {
    expect(releaseVersion("v1.2.3")).toEqual([1n, 2n, 3n]);
    for (const name of ["v1.2.3-rc.1", "v1.2.3+build.5", "v1.2", "1.2.3", "v01.2.3", "vnext", "v1.2.3.4"]) expect(releaseVersion(name), name).toBeNull();
    expect(compareVersions([1n, 10n, 0n], [1n, 9n, 0n])).toBe(1);
    expect(compareVersions([2n, 0n, 0n], [10n, 0n, 0n])).toBe(-1);
    expect(compareVersions([1n, 2n, 3n], [1n, 2n, 3n])).toBe(0);
    expect(newestRelease([{ name: "v0.9.0", sha: "x" }, { name: "v0.10.0-beta", sha: "y" }, { name: "v0.10.0", sha: "z" }])?.name).toBe("v0.10.0");
    expect(newestRelease([{ name: "v1.0.0-rc.1", sha: "x" }, { name: "latest", sha: "y" }])).toBeNull();
  });

  it("an unreadable registry is could-not-read with its document, exit 1", async () => {
    const repo = makeTempDir("nen-spec-due-bare-");
    put(repo, { "nen/repos.json": "{ not json" });
    const run = await spec(["due"], repo, new ScriptedSeams([]), true);
    expect(run.code).toBe(1);
    expect(run.json()).toMatchObject({ contract: "nen.spec.due/v0.1", verdict: "could-not-read", families: [], counts: { due: 0, current: 0, "no-capture": 0, "not-decided": 0 } });
    expect(String(run.json()["reason"])).toContain("nen/repos.json could not be read");
  });

  it("a registry declaring no family is no-family, never current", async () => {
    const run = await spec(["due"], specRepo([]), new ScriptedSeams([]), true);
    expect(run.code).toBe(1);
    expect(run.json()).toMatchObject({ verdict: "no-family", families: [] });
  });

  it("refuses the write flags it does not own", async () => {
    const repo = specRepo([{ name: "port", members: [{ code: "PI" }] }]);
    for (const flag of ["--write", "--dry-run"]) expect((await spec(["due", flag], repo, new ScriptedSeams([]), true)).code, flag).toBe(2);
    expect((await spec(["due", "--folder", "specs/001-a"], repo, new ScriptedSeams([]), true)).code).toBe(2);
  });

  it("AC-5 / SC-2: writes nothing, and every GitHub call it makes is a read-only gh api GET", async () => {
    const repo = specRepo(
      [
        { name: "port", members: [{ code: "PI" }, { code: "PA" }] },
        { name: "port-new", members: [{ code: "PM" }] },
      ],
      { ...capture("PI", RECORDED), ...capture("PA", RECORDED) },
    );
    const seams = new ScriptedSeams([
      tagsCall("acme/port-ios", [[["v1.3.0", NEWER]]]),
      compareCall("acme/port-ios", RECORDED, NEWER, "ahead", 1, 0),
      { match: "gh api --paginate --slurp repos/acme/port-android/tags?per_page=100", result: failed("HTTP 500") },
    ]);
    const files = (dir: string, prefix = ""): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry): string[] => {
        const path = `${prefix}${entry.name}`;
        if (entry.isDirectory()) return entry.name === ".git" && prefix === "" ? [] : files(join(dir, entry.name), `${path}/`);
        return [path];
      });
    const snapshot = (): Record<string, string> => Object.fromEntries(files(repo).sort().map((path): [string, string] => [path, createHash("sha256").update(readFileSync(join(repo, path))).digest("hex")]));
    const status = (): string => git(repo, "status", "--porcelain", "--untracked-files=all");
    const statusBefore = status();
    const before = snapshot();
    const head = git(repo, "rev-parse", "HEAD");
    await spec(["due"], repo, seams, true);
    await spec(["due"], repo, seams);
    expect(snapshot()).toEqual(before);
    expect(status()).toBe(statusBefore);
    expect(statusBefore).toBe("");
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(seams.calls.length).toBeGreaterThan(0);
    for (const call of seams.calls) {
      expect(call.command).toBe("gh");
      expect(call.args[0]).toBe("api");
      for (const flag of ["-X", "--method", "-f", "-F", "--field", "--raw-field", "--input"]) expect(call.args, `${call.args.join(" ")} carries ${flag}`).not.toContain(flag);
    }
  });
});
