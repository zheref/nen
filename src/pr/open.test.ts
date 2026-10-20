// src/pr/open.test.ts -- `nen pr open`, through the real dispatch and the
// fake seam: every refusal before the create, the one-per-head rule, the one
// create.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { prCommand } from "./command.js";
import { OPEN_CONTRACT } from "./open.js";
import { FULL_REACH_ROW, privateListRow, PRIVATE_LIST_PAGE, SCOPES_CALL, UNREADABLE_PRIVATE_LIST, visibilityRow, withPrivateTarget } from "../issue/privacy.testkit.js";

const SHA = "abc123abc123abc123abc123abc123abc123abc1";
const ON_WORK = { match: "git symbolic-ref --short HEAD", result: { stdout: "feature/work\n" } };
const TRACKED = { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { stdout: "origin/feature/work\n" } };
const LOCAL = { match: "git rev-parse feature/work", result: { stdout: `${SHA}\n` } };
const REMOTE = { match: "git ls-remote origin refs/heads/feature/work", result: { stdout: `${SHA}\trefs/heads/feature/work\n` } };
const NONE_OPEN = { match: "gh pr list --repo zheref/nen --head feature/work --state open --json number,url", result: { stdout: "[]\n" } };
const PUSHED: readonly ScriptedCall[] = [ON_WORK, TRACKED, LOCAL, REMOTE, NONE_OPEN];

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly seams: ScriptedSeams;
}

/** A temp checkout holding a title file and a body file. */
function repo(title = "feat: the thing\n"): { root: string; titleFile: string; bodyFile: string } {
  const root = mkdtempSync(join(tmpdir(), "nen-pr-open-"));
  writeFileSync(join(root, "title.txt"), title, "utf8");
  writeFileSync(join(root, "body.md"), "## Why\n\nBecause.\n", "utf8");
  return { root, titleFile: "title.txt", bodyFile: join(root, "body.md") };
}

/**
 * `guard`: by default the private-name guard's visibility read (zheref/nen#363)
 * answers "private" and is not recorded (../issue/privacy.testkit.ts); the
 * guard's own tests pass "scripted" and script both reads.
 */
async function capture(
  root: string,
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  json = false,
  guard: "private-target" | "scripted" = "private-target",
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const seams = new ScriptedSeams(script);
  const code = await runFamily(
    prCommand,
    ["pr", "open", "--target", "zheref/nen", "--base", "main", "--title-file", "title.txt", "--body-file", "body.md", ...argv],
    root,
    json,
    io,
    guard === "scripted" ? seams : withPrivateTarget(seams, "zheref/nen"),
  );
  return { code, out, err, seams };
}

/** The guard's verdict on a private target: skipped, nothing read. */
const SKIPPED_PRIVATE = { result: "skipped-private-target", targetVisibility: "private", listSize: null, owners: null, hits: [], error: null };

const calls = (seams: ScriptedSeams): readonly string[] => seams.calls.map((call): string => [call.command, ...call.args].join(" "));
// The body travels on stdin since zheref/nen#363 (`--body-file -`): the bytes
// the private-name guard checked, never a path gh would re-read. The parameter
// is kept so every call site still says which file the body came from.
const createArgv = (_bodyFile: string, draft = false): string =>
  `gh pr create --repo zheref/nen --base main --head feature/work --title feat: the thing --body-file -${draft ? " --draft" : ""}`;

describe("nen pr open -- refusals before anything is created", () => {
  it("refuses a missing --target, --base, --title-file or --body-file at exit 2", async () => {
    const { root } = repo();
    const io: Io = { out: (): void => {}, err: (): void => {} };
    for (const argv of [
      ["pr", "open", "--base", "main", "--title-file", "title.txt", "--body-file", "body.md"],
      ["pr", "open", "--target", "zheref/nen", "--title-file", "title.txt", "--body-file", "body.md"],
      ["pr", "open", "--target", "zheref/nen", "--base", "main", "--body-file", "body.md"],
      ["pr", "open", "--target", "zheref/nen", "--base", "main", "--title-file", "title.txt"],
    ]) {
      expect(await runFamily(prCommand, argv, root, false, io, new ScriptedSeams([])), argv.join(" ")).toBe(2);
    }
  });

  it("refuses an empty title file and a missing body file at exit 2, before any git call", async () => {
    const { root } = repo("\n\n");
    const empty = await capture(root, []);
    expect(empty.code).toBe(2);
    expect(empty.err.join("\n")).toMatch(/no non-empty line/);
    expect(empty.seams.calls).toEqual([]);
    const { root: other } = repo();
    const missing = await capture(other, ["--body-file", "nope.md"]);
    expect(missing.code).toBe(2);
    expect(missing.seams.calls).toEqual([]);
  });

  it("refuses a detached HEAD with no --head, at exit 2", async () => {
    const { root } = repo();
    const result = await capture(root, [], [{ match: "git symbolic-ref --short HEAD", result: { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref" } }]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/HEAD is detached/);
  });

  it("refuses a head with no upstream, at exit 2, naming the publish verb", async () => {
    const { root } = repo();
    const result = await capture(root, [], [ON_WORK, { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { code: 128 } }]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/has no upstream/);
    expect(result.err.join("\n")).toMatch(/nen wc publish --set-upstream/);
  });

  it("refuses when origin holds nothing at the head, or a different sha, at exit 2", async () => {
    const { root } = repo();
    // The remote asked is the UPSTREAM's, never a hard-coded origin (N7).
    const fork = await capture(root, [], [
      ON_WORK,
      { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { stdout: "fork/feature/work\n" } },
      LOCAL,
      { match: "git ls-remote fork refs/heads/feature/work", result: { stdout: "" } },
    ]);
    expect(fork.code).toBe(2);
    expect(fork.err.join("\n")).toMatch(/fork holds nothing at 'refs\/heads\/feature\/work'/);
    expect(calls(fork.seams).some((call): boolean => call.includes("ls-remote origin"))).toBe(false);
    const nothing = await capture(root, [], [ON_WORK, TRACKED, LOCAL, { match: "git ls-remote origin refs/heads/feature/work", result: { stdout: "" } }]);
    expect(nothing.code).toBe(2);
    expect(nothing.err.join("\n")).toMatch(/origin holds nothing at 'refs\/heads\/feature\/work'/);
    const stale = await capture(root, [], [ON_WORK, TRACKED, LOCAL, { match: "git ls-remote origin refs/heads/feature/work", result: { stdout: "0000000000000000000000000000000000000000\trefs/heads/feature/work\n" } }]);
    expect(stale.code).toBe(2);
    expect(stale.err.join("\n")).toMatch(/is not what origin holds/);
    for (const result of [nothing, stale]) expect(calls(result.seams).some((call): boolean => call.startsWith("gh"))).toBe(false);
  });

  it("exits 1 naming the pull request already open for the head, creating nothing", async () => {
    const { root } = repo();
    const result = await capture(root, [], [
      ON_WORK, TRACKED, LOCAL, REMOTE,
      { match: "gh pr list --repo zheref/nen --head feature/work --state open --json number,url", result: { stdout: JSON.stringify([{ number: 231, url: "https://github.com/zheref/nen/pull/231" }]) } },
    ], true);
    expect(result.code).toBe(1);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc).toMatchObject({ contract: OPEN_CONTRACT, number: 231, url: "https://github.com/zheref/nen/pull/231", head: "feature/work", existing: true, dryRun: false });
    expect(calls(result.seams).some((call): boolean => call.startsWith("gh pr create"))).toBe(false);
  });
});

describe("nen pr open -- the create", () => {
  it("--dry-run prints the gh pr create argv, asks every question, creates nothing", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(root, ["--dry-run", "--draft"], PUSHED, true);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(doc)).toEqual(["contract", "number", "url", "head", "base", "draft", "dryRun", "existing", "assignees", "me", "assigned", "privateNameCheck"]);
    expect(doc).toEqual({ contract: OPEN_CONTRACT, number: null, url: null, head: "feature/work", base: "main", draft: true, dryRun: true, existing: false, assignees: [], me: null, assigned: null, privateNameCheck: SKIPPED_PRIVATE });
    expect(calls(result.seams)).toEqual([
      "git symbolic-ref --short HEAD",
      "git rev-parse --abbrev-ref feature/work@{upstream}",
      "git rev-parse feature/work",
      "git ls-remote origin refs/heads/feature/work",
      "gh pr list --repo zheref/nen --head feature/work --state open --json number,url",
    ]);
    const text = await capture(root, ["--dry-run"], PUSHED);
    expect(text.out).toEqual(["would run: gh pr create --repo zheref/nen --base main --head feature/work --title \"feat: the thing\" --body-file -"]);
    void bodyFile;
  });

  it("creates through gh pr create and reads the number out of the url gh printed", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(root, [], [...PUSHED, { match: createArgv(bodyFile), result: { stdout: "https://github.com/zheref/nen/pull/232\n" } }], true);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({ contract: OPEN_CONTRACT, number: 232, url: "https://github.com/zheref/nen/pull/232", head: "feature/work", base: "main", draft: false, dryRun: false, existing: false, assignees: [], me: null, assigned: null, privateNameCheck: SKIPPED_PRIVATE });
    const text = await capture(root, ["--draft"], [...PUSHED, { match: createArgv(bodyFile, true), result: { stdout: "https://github.com/zheref/nen/pull/233\n" } }]);
    expect(text.out).toEqual(["opened zheref/nen#233: https://github.com/zheref/nen/pull/233 (draft)"]);
  });

  it("--head names the branch instead of asking git which one is out", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(root, ["--head", "feature/work"], [TRACKED, LOCAL, REMOTE, NONE_OPEN, { match: createArgv(bodyFile), result: { stdout: "https://github.com/zheref/nen/pull/234\n" } }]);
    expect(result.code).toBe(0);
    expect(calls(result.seams)).not.toContain("git symbolic-ref --short HEAD");
  });

  it("a create that prints no pull request url is exit 1, never reported as opened", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(root, [], [...PUSHED, { match: createArgv(bodyFile), result: { stdout: "Warning: something\n" } }]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/returned no pull request URL/);
  });

  it("refuses open's own flags on the other pr subcommands", async () => {
    const { root } = repo();
    const io: Io = { out: (): void => {}, err: (): void => {} };
    for (const argv of [
      ["pr", "fetch", "--target", "zheref/nen", "--pr", "1", "--title-file", "t"],
      ["pr", "fetch", "--target", "zheref/nen", "--pr", "1", "--draft"],
      ["pr", "fetch", "--target", "zheref/nen", "--pr", "1", "--head", "x"],
    ]) {
      expect(await runFamily(prCommand, argv, root, false, io, new ScriptedSeams([])), argv.join(" ")).toBe(2);
    }
  });
});

describe("nen pr open --assignee (zheref/nen#293)", () => {
  const USER = (login: string): ScriptedCall => ({ match: `gh api --method GET users/${login}`, result: { stdout: JSON.stringify({ login, type: "User" }) } });
  const ASSIGNABLE = (login: string): ScriptedCall => ({ match: `gh api --method GET repos/zheref/nen/assignees/${login}`, result: { code: 0, stdout: "" } });
  const ME_IS = (login: string): ScriptedCall => ({ match: "gh api --method GET user", result: { stdout: JSON.stringify({ login }) } });
  const READ_BACK = (number: number, logins: readonly string[]): ScriptedCall => ({
    match: `gh pr view ${number} --repo zheref/nen --json assignees`,
    result: { stdout: JSON.stringify({ assignees: logins.map((login) => ({ login })) }) },
  });

  it("opens assigned in one call, and reads the assignment back", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(root, ["--assignee", "zheref"], [
      ON_WORK, TRACKED, LOCAL, REMOTE, USER("zheref"), ASSIGNABLE("zheref"), NONE_OPEN,
      { match: `${createArgv(bodyFile)} --assignee zheref`, result: { stdout: "https://github.com/zheref/nen/pull/240\n" } },
      READ_BACK(240, ["zheref"]),
    ], true);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ number: 240, assignees: ["zheref"], me: null, assigned: ["zheref"] });
  });

  it("resolves @me through GET /user, states the login, and never passes @me to gh", async () => {
    const { root, bodyFile } = repo();
    const script = [
      ON_WORK, TRACKED, LOCAL, REMOTE, ME_IS("zheref"), USER("zheref"), ASSIGNABLE("zheref"), USER("octo-cat"), ASSIGNABLE("octo-cat"), NONE_OPEN,
      { match: `${createArgv(bodyFile)} --assignee zheref,octo-cat`, result: { stdout: "https://github.com/zheref/nen/pull/241\n" } },
      READ_BACK(241, ["octo-cat", "zheref"]),
    ];
    const result = await capture(root, ["--assignee", "@me,octo-cat"], script);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "@me resolved to 'zheref' (the login of the token running this verb).",
      "opened zheref/nen#241: https://github.com/zheref/nen/pull/241",
      "assigned (read back): octo-cat, zheref",
    ]);
    expect(calls(result.seams).some((call): boolean => call.includes("@me"))).toBe(false);
    const json = await capture(root, ["--assignee", "@me,octo-cat"], script, true);
    expect(JSON.parse(json.out.join("\n"))).toMatchObject({ assignees: ["zheref", "octo-cat"], me: "zheref" });
  });

  it("folds @me and the same login typed out into one assignee", async () => {
    const { root } = repo();
    const result = await capture(root, ["--assignee", "@me,ZHEREF", "--dry-run"], [
      ON_WORK, TRACKED, LOCAL, REMOTE, ME_IS("zheref"), USER("zheref"), ASSIGNABLE("zheref"),
      // GitHub answers a login in any case with its canonical spelling.
      { match: "gh api --method GET users/ZHEREF", result: { stdout: JSON.stringify({ login: "zheref" }) } },
      ASSIGNABLE("zheref"), NONE_OPEN,
    ]);
    expect(result.code).toBe(0);
    expect(result.out.at(-1)).toBe("would run: gh pr create --repo zheref/nen --base main --head feature/work --title \"feat: the thing\" --body-file - --assignee zheref");
  });

  it("fails BEFORE the create, naming an unknown login and one that cannot be assigned", async () => {
    const { root } = repo();
    const result = await capture(root, ["--assignee", "ghost,outsider"], [
      ON_WORK, TRACKED, LOCAL, REMOTE,
      { match: "gh api --method GET users/ghost", result: { code: 1, stderr: "gh: Not Found (HTTP 404)" } },
      USER("outsider"),
      { match: "gh api --method GET repos/zheref/nen/assignees/outsider", result: { code: 1, stderr: "gh: Not Found (HTTP 404)" } },
    ]);
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/'ghost' is not a GitHub user/);
    expect(err).toMatch(/'outsider' exists but cannot be assigned on zheref\/nen/);
    expect(err).toMatch(/Nothing was opened/);
    expect(calls(result.seams).some((call): boolean => call.startsWith("gh pr create") || call.startsWith("gh pr list"))).toBe(false);
  });

  it("a lookup that could not be made is exit 1, nothing opened -- never read as 'checked'", async () => {
    const { root } = repo();
    const result = await capture(root, ["--assignee", "zheref"], [
      ON_WORK, TRACKED, LOCAL, REMOTE,
      { match: "gh api --method GET users/zheref", result: { code: 1, stderr: "HTTP 502: Bad gateway" } },
    ]);
    expect(result.code).toBe(1);
    expect(calls(result.seams).some((call): boolean => call.startsWith("gh pr create"))).toBe(false);
  });

  it("refuses a malformed, empty or duplicated --assignee at exit 2 before any call", async () => {
    const { root } = repo();
    for (const value of ["", "a,,b", "bad_login", "-x", "zheref,ZHEREF", "a b"]) {
      const result = await capture(root, ["--assignee", value], []);
      expect(result.code, value).toBe(2);
      expect(result.seams.calls, value).toEqual([]);
    }
  });

  it("a read-back missing an assignee is exit 1, the opened pull request still named", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(root, ["--assignee", "zheref"], [
      ON_WORK, TRACKED, LOCAL, REMOTE, USER("zheref"), ASSIGNABLE("zheref"), NONE_OPEN,
      { match: `${createArgv(bodyFile)} --assignee zheref`, result: { stdout: "https://github.com/zheref/nen/pull/242\n" } },
      READ_BACK(242, []),
    ], true);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ number: 242, assigned: [] });
    expect(result.err.join("\n")).toMatch(/does not show 'zheref' assigned/);
  });

  it("a read-back that fails is exit 1, assigned null, and the assignment NOT confirmed (N1)", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(root, ["--assignee", "zheref"], [
      ON_WORK, TRACKED, LOCAL, REMOTE, USER("zheref"), ASSIGNABLE("zheref"), NONE_OPEN,
      { match: `${createArgv(bodyFile)} --assignee zheref`, result: { stdout: "https://github.com/zheref/nen/pull/244\n" } },
      { match: "gh pr view 244 --repo zheref/nen --json assignees", result: { code: 1, stderr: "HTTP 502: Bad gateway" } },
    ], true);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ number: 244, assignees: ["zheref"], assigned: null });
    expect(result.err.join("\n")).toMatch(/NOT confirmed/);
  });

  it("a create that exits 1 after printing a url, then an empty read-back, names both (N1)", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(root, ["--assignee", "zheref"], [
      ON_WORK, TRACKED, LOCAL, REMOTE, USER("zheref"), ASSIGNABLE("zheref"), NONE_OPEN,
      { match: `${createArgv(bodyFile)} --assignee zheref`, result: { code: 1, stdout: "https://github.com/zheref/nen/pull/245\n", stderr: "could not assign user" } },
      READ_BACK(245, []),
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("opened zheref/nen#245: https://github.com/zheref/nen/pull/245");
    const err = result.err.join("\n");
    expect(err).toMatch(/the read-back does not show 'zheref' assigned/);
    expect(err).toMatch(/'gh pr create' exited 1 after printing .*could not assign user.*the pull request exists/);
  });

  it("a create that exits non-zero after printing a url is reported opened, at exit 1", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(root, [], [...PUSHED, { match: createArgv(bodyFile), result: { code: 1, stdout: "https://github.com/zheref/nen/pull/243\n", stderr: "could not add label" } }]);
    expect(result.code).toBe(1);
    expect(result.out).toEqual(["opened zheref/nen#243: https://github.com/zheref/nen/pull/243"]);
    expect(result.err.join("\n")).toMatch(/the pull request exists/);
  });

  it("is refused on the other pr subcommands", async () => {
    const io: Io = { out: (): void => {}, err: (): void => {} };
    const { root } = repo();
    expect(await runFamily(prCommand, ["pr", "fetch", "--target", "zheref/nen", "--pr", "1", "--assignee", "x"], root, false, io, new ScriptedSeams([]))).toBe(2);
  });
});

describe("nen pr open -- the private-name guard (zheref/nen#363)", () => {
  const LIST = privateListRow(["acme/hidden-thing", "acme/vault"]);
  const PUBLIC = visibilityRow("zheref/nen", "public");

  it("a private name in the body on a PUBLIC target refuses with exit 4 before ANY other call, and never prints the name", async () => {
    const { root } = repo();
    writeFileSync(join(root, "body.md"), "## Why\n\nPorted from the vault.\n", "utf8");
    const result = await capture(root, [], [PUBLIC, FULL_REACH_ROW, LIST], false, "scripted");
    expect(result.code).toBe(4);
    expect(calls(result.seams)).toEqual(["gh api repos/zheref/nen", SCOPES_CALL, PRIVATE_LIST_PAGE]);
    const all = [...result.out, ...result.err].join("\n");
    expect(all).toContain("nen pr open: body:3: private repository #2");
    expect(all).not.toMatch(/vault/i);
  });

  it("a private name in the TITLE refuses too, and --json is { opened: false, privateNameCheck }", async () => {
    const { root } = repo("feat: the hidden-thing port\n");
    const result = await capture(root, ["--dry-run"], [PUBLIC, FULL_REACH_ROW, LIST], true, "scripted");
    expect(result.code).toBe(4);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc).toMatchObject({ contract: OPEN_CONTRACT, dryRun: true, opened: false });
    expect((doc["privateNameCheck"] as { hits: unknown[] }).hits).toEqual([{ field: "title", line: 1, index: 1, normalised: false, ignored: false, ignoredBy: null }]);
  });

  it("a PRIVATE target is not checked -- the list is never read -- and the body bytes go to gh on stdin", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(
      root,
      [],
      [visibilityRow("zheref/nen", "private"), ...PUSHED, { match: createArgv(bodyFile), result: { stdout: "https://github.com/zheref/nen/pull/250\n" } }],
      false,
      "scripted",
    );
    expect(result.code).toBe(0);
    expect(calls(result.seams)).not.toContain(PRIVATE_LIST_PAGE);
    const create = result.seams.calls.find((call): boolean => call.args[0] === "pr" && call.args[1] === "create");
    expect(create?.stdin).toBe("## Why\n\nBecause.\n");
  });

  it("an unreadable private list fails closed (exit 1): nothing asked of git, nothing opened", async () => {
    const { root } = repo();
    const result = await capture(root, [], [PUBLIC, FULL_REACH_ROW, UNREADABLE_PRIVATE_LIST], false, "scripted");
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/nen pr open: private-name check could not run/);
    expect(calls(result.seams)).toEqual(["gh api repos/zheref/nen", SCOPES_CALL, PRIVATE_LIST_PAGE]);
  });

  it("--skip-private-name-check reads nothing for the guard, opens, and is named", async () => {
    const { root, bodyFile } = repo();
    const result = await capture(
      root,
      ["--skip-private-name-check"],
      [...PUSHED, { match: createArgv(bodyFile), result: { stdout: "https://github.com/zheref/nen/pull/251\n" } }],
      false,
      "scripted",
    );
    expect(result.code).toBe(0);
    expect(result.err.join("\n")).toMatch(/SKIPPED by --skip-private-name-check/);
  });
});
