import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { wcCommand } from "./command.js";
import { foreignUpstreamRefusal, isTrunk, trackedBranchName, trunkDestinationRefusal } from "./publish.js";

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  // `null` is a real case: the invocation that never typed --repo (zheref/nen#28).
  repoFlag: string | null = BANKAI_REPO,
): Promise<{ code: number; out: string[]; err: string[]; seams: ScriptedSeams }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const scripted = new ScriptedSeams(script);
  const seams: Seams = scripted;
  const code = await runFamily(wcCommand, argv, repoFlag, false, io, seams);
  return { code, out, err, seams: scripted };
}

describe("nen wc classify -- CLI wiring", () => {
  it("reports must-move for a dirty trunk", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "main\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M x.ts\n" } },
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/case: must-move/);
  });

  it("always exits 0 -- a report, not a guard", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "main\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M x.ts\n" } },
    ]);
    expect(result.code).toBe(0);
  });

  // zheref/nen#28: the usage line lists --repo unbracketed, so omitting it is
  // refused by name -- never silently read as "classify the process's cwd".
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["wc", "classify"], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("prints the branch on its own line, on the ordinary path", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "feature/x\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: "" } },
      { match: "git rev-list --count main..HEAD", result: { stdout: "0\n" } },
      { match: "git log main..HEAD --format=%s", result: { stdout: "" } },
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("branch: feature/x");
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["wc", "bogus"])).code).toBe(2);
  });
});

// ── a detached HEAD (zheref/nen#163) ────────────────────────────────────────
//
// A worktree added with `--detach`, a bisect, a rebase step. Each is an
// ORDINARY working copy: the classification is decided by trunk-or-not and
// dirty-or-not, and both are answerable without a branch name. This used to
// refuse at exit 1 -- "the tree is not clean", which it was not saying -- and
// print that prose on stdout under --json.

describe("nen wc classify -- a detached HEAD", () => {
  const DETACHED: readonly ScriptedCall[] = [
    { match: "git symbolic-ref --short HEAD", result: { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref" } },
    { match: "git rev-parse --short HEAD", result: { stdout: "1a2b3c4\n" } },
    { match: "git status --porcelain=v1 -uall", result: { stdout: " M x.ts\n" } },
    { match: "git rev-list --count main..HEAD", result: { stdout: "2\n" } },
    { match: "git log main..HEAD --format=%s", result: { stdout: "second\nfirst\n" } },
  ];

  it("classifies it, at exit 0, saying where HEAD is standing", async () => {
    const result = await capture(["wc", "classify"], DETACHED);
    expect(result.code).toBe(0);
    expect(result.out).toContain("case: on-branch-dirty");
    expect(result.out).toContain("branch: (detached HEAD at 1a2b3c4)");
    expect(result.out.join("\n")).toContain("on a detached HEAD at 1a2b3c4");
  });

  it("--json is ONE document, with branch: null and the sha beside it", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const code = await runFamily(wcCommand, ["wc", "classify"], BANKAI_REPO, true, io, new ScriptedSeams(DETACHED));
    expect(code).toBe(0);
    // Parses at all, which is the half the issue was about: the refusal used to
    // print its prose on stdout under --json.
    const parsed = JSON.parse(out.join("\n")) as { state: Record<string, unknown>; result: Record<string, unknown> };
    expect(parsed.state["branch"]).toBeNull();
    expect(parsed.state["detachedAt"]).toBe("1a2b3c4");
    expect(parsed.state["isTrunk"]).toBe(false);
    expect(parsed.result["case"]).toBe("on-branch-dirty");
    expect(err).toEqual([]);
  });

  it("a CLEAN detached HEAD is on-branch-clean, at exit 0", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref" } },
      { match: "git rev-parse --short HEAD", result: { stdout: "1a2b3c4\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: "" } },
      { match: "git rev-list --count main..HEAD", result: { stdout: "0\n" } },
      { match: "git log main..HEAD --format=%s", result: { stdout: "" } },
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("case: on-branch-clean");
    expect(result.out).toContain("branch: (detached HEAD at 1a2b3c4)");
  });

  it("still exits non-zero, with an EMPTY stdout, when HEAD resolves to no commit at all", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref" } },
      { match: "git rev-parse --short HEAD", result: { code: 128, stderr: "fatal: ambiguous argument 'HEAD'" } },
    ]);
    expect(result.code).not.toBe(0);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/resolves to no commit/);
  });
});

/** A real file on disk holding `content`, for `--message-file` (a real fs read). */
function messageFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-wc-squash-msg-"));
  const path = join(dir, "message.txt");
  writeFileSync(path, content, "utf8");
  return path;
}

const CLEAN = { match: "git status --porcelain=v1 -uall", result: { stdout: "" } };
const MERGE_BASE = { match: "git merge-base main HEAD", result: { stdout: "base0000\n" } };
const ANCESTOR_OK = { match: "git merge-base --is-ancestor main HEAD", result: { code: 0 } };
const NO_UPSTREAM = { match: "git rev-parse --abbrev-ref @{upstream}", result: { code: 1 } };
const TWO_COMMITS = {
  match: "git log base0000..HEAD --format=%H%x09%s",
  result: { stdout: "sha2\tsecond commit\nsha1\tfirst commit\n" },
};
/** The base name from the policy (here: branch.base's default, `main`) passed git's own branch-name rule. */
const NAME_OK = { match: "git check-ref-format --branch main", result: { stdout: "main\n" } };
/** origin/main resolves and holds neither folded commit; local main does not resolve. */
const BASE_CLEAR = [
  { match: "git rev-parse --verify --quiet refs/remotes/origin/main^{commit}", result: { stdout: "originsha\n" } },
  { match: "git rev-list HEAD --not base0000 originsha", result: { stdout: "sha2\nsha1\n" } },
  { match: "git rev-parse --verify --quiet refs/heads/main^{commit}", result: { code: 1 } },
];

describe("nen wc squash -- CLI wiring", () => {
  it("refuses an OMITTED --repo at exit 2, naming the flag", async () => {
    const result = await capture(["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("refuses an OMITTED --onto at exit 2", async () => {
    const result = await capture(["wc", "squash", "--message-file", messageFile("feat: x\n")]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--onto is required/);
  });

  it("refuses an OMITTED --message-file at exit 2", async () => {
    const result = await capture(["wc", "squash", "--onto", "main"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--message-file is required/);
  });

  it("refuses a --message-file that fails Conventional Commits shape, at exit 2, naming every reason", async () => {
    const result = await capture([
      "wc",
      "squash",
      "--onto",
      "main",
      "--message-file",
      messageFile(`bogus: ${"x".repeat(80)}\n`),
    ]);
    expect(result.code).toBe(2);
    const message = result.err.join("\n");
    expect(message).toMatch(/not one of/);
    expect(message).toMatch(/72-character/);
  });

  it("refuses a dirty working tree at exit 2, and never even reads --onto's ancestry", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")],
      [NAME_OK, { match: "git status --porcelain=v1 -uall", result: { stdout: " M dirty.ts\n" } }],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/dirty.ts/);
  });

  it("refuses --onto not an ancestor of HEAD, at exit 2", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")],
      [NAME_OK, CLEAN, MERGE_BASE, { match: "git merge-base --is-ancestor main HEAD", result: { code: 1 } }],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/not an ancestor/);
  });

  it("refuses a folded commit already on the upstream, at exit 2, naming it as already published", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")],
      [
        NAME_OK, CLEAN,
        MERGE_BASE,
        ANCESTOR_OK,
        TWO_COMMITS,
        { match: "git rev-parse --abbrev-ref @{upstream}", result: { stdout: "origin/work\n" } },
        { match: "git fetch origin work", result: { code: 0 } },
        { match: "git merge-base --is-ancestor sha1 origin/work", result: { code: 0 } },
      ],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/already published; squashing would rewrite pushed history/);
  });

  it("exits 0 with one line, not a refusal, when fewer than two commits would fold", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")],
      [NAME_OK, CLEAN, MERGE_BASE, ANCESTOR_OK, { match: "git log base0000..HEAD --format=%H%x09%s", result: { stdout: "" } }],
    );
    expect(result.code).toBe(0);
    expect(result.out).toHaveLength(1);
    expect(result.out[0]).toMatch(/nothing to squash/);
    // baseRefs is [] here; the text says the base check was not performed rather than staying silent.
    expect(result.out[0]).toMatch(/base check: NOT performed\.$/);
  });

  it("--dry-run prints the folded commits and the message, and touches neither reset nor commit", async () => {
    const script = [NAME_OK, CLEAN, MERGE_BASE, ANCESTOR_OK, TWO_COMMITS, NO_UPSTREAM, ...BASE_CLEAR];
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: add a thing\n\nCloses: #4\n"), "--dry-run"],
      script,
    );
    expect(result.code).toBe(0);
    const out = result.out.join("\n");
    expect(out).toMatch(/would fold 2 commit\(s\)/);
    expect(out).toContain("sha1 first commit");
    expect(out).toContain("sha2 second commit");
    expect(out).toContain("feat: add a thing");
    expect(out).toContain("Closes: #4");
  });

  it("performs the real squash: reset --soft then commit -F, in that order, after every refusal has passed", async () => {
    const path = messageFile("feat: add a thing\n");
    const script = [
      NAME_OK, CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      TWO_COMMITS,
      NO_UPSTREAM,
      ...BASE_CLEAR,
      { match: "git reset --soft base0000", result: { code: 0 } },
      { match: `git commit -F ${path}`, result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "newsha00\n" } },
    ];
    const result = await capture(["wc", "squash", "--onto", "main", "--message-file", path], script);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("squashed into newsha00");
  });

  it("--json prints the nen.wc.squash/v0.1 contract, folded oldest-first, newSha set", async () => {
    const path = messageFile("feat: add a thing\n");
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
    const seams: Seams = new ScriptedSeams([
      NAME_OK, CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      TWO_COMMITS,
      NO_UPSTREAM,
      ...BASE_CLEAR,
      { match: "git reset --soft base0000", result: { code: 0 } },
      { match: `git commit -F ${path}`, result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "newsha00\n" } },
    ]);
    const code = await runFamily(wcCommand, ["wc", "squash", "--onto", "main", "--message-file", path], BANKAI_REPO, true, io, seams);
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join("\n")) as Record<string, unknown>;
    expect(parsed["contract"]).toBe("nen.wc.squash/v0.1");
    expect(parsed["onto"]).toBe("main");
    expect(parsed["mergeBase"]).toBe("base0000");
    expect(parsed["folded"]).toEqual(["sha1", "sha2"]);
    expect(parsed["newSha"]).toBe("newsha00");
    expect(parsed["dryRun"]).toBe(false);
    expect(parsed["base"]).toBe("main");
    expect(parsed["baseRefs"]).toEqual(["origin/main"]);
    expect(Object.keys(parsed)).toEqual(["contract", "onto", "mergeBase", "folded", "newSha", "dryRun", "base", "baseRefs"]);
  });

  it("names the base check in text output, and says so when it was NOT performed", async () => {
    const script = [
      NAME_OK, CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      TWO_COMMITS,
      NO_UPSTREAM,
      { match: "git rev-parse --verify --quiet refs/remotes/origin/main^{commit}", result: { code: 1 } },
      { match: "git rev-parse --verify --quiet refs/heads/main^{commit}", result: { code: 1 } },
    ];
    const result = await capture(["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n"), "--dry-run"], script);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/base check: NOT performed -- neither origin\/main nor main resolves here/);
  });

  // zheref/nen#251: a catch-up merge's base commits are refused, and --dry-run reaches the same verdict.
  const BASE_HOLDS_SHA1 = [
    { match: "git rev-parse --verify --quiet refs/remotes/origin/main^{commit}", result: { stdout: "originsha\n" } },
    { match: "git rev-list HEAD --not base0000 originsha", result: { stdout: "sha2\n" } },
    { match: "git rev-parse --verify --quiet refs/heads/main^{commit}", result: { code: 1 } },
  ];
  for (const dryRun of [false, true]) {
    it(`refuses a folded commit already on origin/<base> at exit 2${dryRun ? " under --dry-run --json too" : ""}, and never resets`, async () => {
      const argv = ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")];
      if (dryRun) argv.push("--dry-run");
      const out: string[] = [];
      const err: string[] = [];
      const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
      const seams = new ScriptedSeams([NAME_OK, CLEAN, MERGE_BASE, ANCESTOR_OK, TWO_COMMITS, NO_UPSTREAM, ...BASE_HOLDS_SHA1]);
      const code = await runFamily(wcCommand, argv, BANKAI_REPO, dryRun, io, seams);
      expect(code).toBe(2);
      expect(out).toEqual([]);
      const message = err.join("\n");
      expect(message).toContain("sha1 ('first commit', on origin/main)");
      expect(message).toContain("the base 'main' (branch.base's default -- no nen/workflow.json; checked against origin/main) already holds 1 of the 2 commit(s)");
      expect(seams.calls.some((call): boolean => call.args[0] === "reset" || call.args[0] === "commit")).toBe(false);
    });
  }

  it("--base overrides the workflow's branch.base, held to git's own branch-name rule", async () => {
    const script = [
      { match: "git check-ref-format --branch develop", result: { stdout: "develop\n" } },
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      TWO_COMMITS,
      NO_UPSTREAM,
      { match: "git rev-parse --verify --quiet refs/remotes/origin/develop^{commit}", result: { stdout: "devsha\n" } },
      { match: "git rev-list HEAD --not base0000 devsha", result: { stdout: "sha1\n" } },
      { match: "git rev-parse --verify --quiet refs/heads/develop^{commit}", result: { code: 1 } },
    ];
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--base", "develop", "--message-file", messageFile("feat: x\n")],
      script,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("sha2 ('second commit', on origin/develop)");
    expect(result.err.join("\n")).toContain("(--base; checked against origin/develop)");
  });

  it("refuses a --base git will not accept as a branch name, at exit 2, before any status read", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--base", "bad..name", "--message-file", messageFile("feat: x\n")],
      [{ match: "git check-ref-format --branch bad..name", result: { code: 1, stderr: "fatal: 'bad..name' is not a valid branch name" } }],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--base 'bad\.\.name' is not a branch name git will accept/);
    expect(result.seams.calls.some((call): boolean => call.args[0] === "status")).toBe(false);
  });

  // Review finding on zheref/nen#253: the POLICY's base is held to git's rule
  // too, or a schema-valid name git rejects ('main/') would resolve no ref and
  // the base guard would silently not run.
  it("refuses a policy branch.base git will not accept as a branch name, at exit 1, before any status read", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n")],
      [{ match: "git check-ref-format --branch main", result: { code: 1, stderr: "fatal: 'main' is not a valid branch name" } }],
    );
    expect(result.code).toBe(1);
    const message = result.err.join("\n");
    expect(message).toMatch(/branch\.base's default -- no nen\/workflow\.json 'main' is not a branch name git will accept/);
    expect(message).toMatch(/Fix branch\.base, or pass --base/);
    expect(result.seams.calls.some((call): boolean => call.args[0] === "status")).toBe(false);
  });

  // Review round 2 on zheref/nen#253: the guard builds refs from the name, so
  // only the canonical SHORT name will do. A full ref git passes through
  // unchanged, or a name git rewrites, would resolve nothing and let the
  // squash proceed with the check "not performed".
  it("refuses --base refs/heads/main at exit 2: not a short branch name, before any status read", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--base", "refs/heads/main", "--message-file", messageFile("feat: x\n")],
      [{ match: "git check-ref-format --branch refs/heads/main", result: { stdout: "refs/heads/main\n" } }],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--base 'refs\/heads\/main' is not a short branch name/);
    expect(result.seams.calls.some((call): boolean => call.args[0] === "status")).toBe(false);
  });

  it("refuses a --base git rewrites to another name (@{-1}) at exit 2, naming what git read it as", async () => {
    const result = await capture(
      ["wc", "squash", "--onto", "main", "--base", "@{-1}", "--message-file", messageFile("feat: x\n")],
      [{ match: "git check-ref-format --branch @{-1}", result: { stdout: "feature/x\n" } }],
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("--base '@{-1}' is not a short branch name (git reads it as 'feature/x')");
  });

  it("refuses a --base shaped like an option or a force before any git call at all", async () => {
    const result = await capture(["wc", "squash", "--onto", "main", "--base=--upload-pack=/x", "--message-file", messageFile("feat: x\n")]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/looks like a refspec or a force option/);
    expect(result.seams.calls).toEqual([]);
  });

  it("validates the policy's base name before any other git call", async () => {
    const script = [NAME_OK, CLEAN, MERGE_BASE, ANCESTOR_OK, TWO_COMMITS, NO_UPSTREAM, ...BASE_CLEAR];
    const result = await capture(["wc", "squash", "--onto", "main", "--message-file", messageFile("feat: x\n"), "--dry-run"], script);
    expect(result.code).toBe(0);
    expect(result.seams.calls[0]?.args.join(" ")).toBe("check-ref-format --branch main");
  });
});

// ── nen wc catch-up (zheref/nen#227) ────────────────────────────────────────

/** `--base main` passed git's own validator; every catch-up script starts here. */
const BASE_OK = { match: "git check-ref-format --branch main", result: { code: 0 } };
const FETCH_MAIN = "git fetch --end-of-options origin refs/heads/main:refs/remotes/origin/main";
/** git says neither a rebase nor a merge is in progress. */
const NOTHING_PENDING: readonly ScriptedCall[] = [
  BASE_OK,
  { match: "git rebase --show-current-patch", result: { code: 128, stderr: "fatal: no rebase in progress" } },
  { match: "git rev-parse --git-dir", result: { code: 0, stdout: ".git\n" } },
  { match: "git rev-parse --verify --quiet MERGE_HEAD", result: { code: 1 } },
];
const FETCHED = { match: FETCH_MAIN, result: { code: 0 } };
const UNMERGED = "git -c core.quotePath=false diff --name-only -z --diff-filter=U";
const CHECK = "git -c core.quotePath=false diff --cached --check";
const STAGES = "git ls-files -u -z";
/** `git ls-files -u -z` for `paths`, each with every stage in `stages`. */
const stagesOf = (entries: readonly (readonly [string, readonly number[]])[]): ScriptedCall => ({
  match: STAGES,
  result: { stdout: entries.flatMap(([path, stages]): string[] => stages.map((stage): string => `100644 ${"a".repeat(40)} ${stage}\t${path}\0`)).join("") },
});
const HEAD_BEFORE = { match: "git rev-parse HEAD", result: { stdout: "before00\n" } };
const BEHIND = (n: number): ScriptedCall => ({ match: "git rev-list --count HEAD..origin/main", result: { stdout: `${n}\n` } });
const AHEAD = (n: number): ScriptedCall => ({ match: "git rev-list --count origin/main..HEAD", result: { stdout: `${n}\n` } });
const OWN_COMMITS = { match: "git log origin/main..HEAD --format=%H%x09%s", result: { stdout: "sha2\tsecond\nsha1\tfirst\n" } };

async function captureJson(argv: readonly string[], script: readonly ScriptedCall[]): Promise<{ code: number; doc: Record<string, unknown>; err: string[]; seams: ScriptedSeams }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const seams = new ScriptedSeams(script);
  const code = await runFamily(wcCommand, argv, BANKAI_REPO, true, io, seams);
  return { code, doc: out.length === 0 ? {} : (JSON.parse(out.join("\n")) as Record<string, unknown>), err, seams };
}

const gitCalls = (seams: ScriptedSeams): readonly string[] => seams.calls.map((call): string => [call.command, ...call.args].join(" "));

describe("nen wc catch-up -- rebase or merge onto origin/<base>, never picking a side", () => {
  it("refuses an omitted --repo and --base, and an unknown --strategy, at exit 2", async () => {
    expect((await capture(["wc", "catch-up", "--base", "main"], [], null)).code).toBe(2);
    expect((await capture(["wc", "catch-up"], [])).code).toBe(2);
    const bad = await capture(["wc", "catch-up", "--base", "main", "--strategy", "yolo"], NOTHING_PENDING);
    expect(bad.code).toBe(2);
    expect(bad.err.join("\n")).toMatch(/--strategy 'yolo' is not one of rebase, merge, auto/);
  });

  it("refuses a --base git rejects, or one shaped like an option or a force, before ANY fetch -- under --dry-run too (Feitan S2)", async () => {
    const option = await capture(["wc", "catch-up", "--base=--upload-pack=/x", "--dry-run"], [
      { match: "git check-ref-format --branch --upload-pack=/x", result: { code: 129, stderr: "error: unknown option `upload-pack=/x'" } },
    ]);
    expect(option.code).toBe(2);
    expect(option.err.join("\n")).toMatch(/--base '--upload-pack=\/x' is not a branch name git will accept/);
    expect(gitCalls(option.seams)).toEqual(["git check-ref-format --branch --upload-pack=/x"]);
    const force = await capture(["wc", "catch-up", "--base", "+main"], [
      { match: "git check-ref-format --branch +main", result: { code: 0 } },
    ]);
    expect(force.code).toBe(2);
    expect(force.err.join("\n")).toMatch(/--base '\+main' looks like a refspec or a force option/);
    expect(gitCalls(force.seams)).toEqual(["git check-ref-format --branch +main"]);
  });

  it("refuses a dirty tree at exit 2, before the fetch", async () => {
    const result = await capture(["wc", "catch-up", "--base", "main"], [
      ...NOTHING_PENDING,
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M dirty.ts\n" } },
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/dirty.ts/);
    expect(gitCalls(result.seams)).not.toContain(FETCH_MAIN);
  });

  it("auto picks REBASE when no commit is on the upstream, and runs it", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main"], [
      ...NOTHING_PENDING,
      CLEAN,
      FETCHED,
      { match: "git rev-parse HEAD", result: { stdout: "before00\n" } },
      { match: "git rev-parse HEAD", result: { stdout: "after000\n" } },
      BEHIND(3),
      AHEAD(2),
      OWN_COMMITS,
      { match: "git rev-parse --abbrev-ref @{upstream}", result: { stdout: "origin/work\n" } },
      { match: "git fetch origin work", result: { code: 0 } },
      { match: "git merge-base --is-ancestor sha1 origin/work", result: { code: 1 } },
      { match: "git merge-base --is-ancestor sha2 origin/work", result: { code: 1 } },
      { match: "git rebase origin/main", result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(Object.keys(result.doc)).toEqual(["contract", "base", "strategy", "before", "after", "behindBefore", "aheadBefore", "noOp", "conflicted", "resumed", "aborted", "dryRun"]);
    expect(result.doc).toMatchObject({ contract: "nen.wc.catch-up/v0.1", base: "main", strategy: "rebase", before: "before00", after: "after000", behindBefore: 3, aheadBefore: 2, noOp: false, conflicted: [], resumed: false, aborted: false, dryRun: false });
    expect(gitCalls(result.seams)).toContain("git rebase origin/main");
  });

  it("auto picks MERGE when a commit is already on the upstream", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main"], [
      ...NOTHING_PENDING,
      CLEAN,
      FETCHED,
      HEAD_BEFORE,
      BEHIND(1),
      AHEAD(2),
      OWN_COMMITS,
      { match: "git rev-parse --abbrev-ref @{upstream}", result: { stdout: "origin/work\n" } },
      { match: "git fetch origin work", result: { code: 0 } },
      { match: "git merge-base --is-ancestor sha1 origin/work", result: { code: 0 } },
      { match: "git merge --no-edit origin/main", result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc["strategy"]).toBe("merge");
    expect(gitCalls(result.seams)).toContain("git merge --no-edit origin/main");
    expect(gitCalls(result.seams)).not.toContain("git rebase origin/main");
  });

  it("is a noOp at exit 0 when already up to date, running neither", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main", "--strategy", "rebase"], [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(0), AHEAD(4),
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ noOp: true, after: "before00", strategy: "rebase" });
    expect(gitCalls(result.seams).some((call): boolean => call === "git rebase origin/main" || call.startsWith("git merge "))).toBe(false);
  });

  it("--dry-run prints the line and runs neither", async () => {
    const result = await capture(["wc", "catch-up", "--base", "main", "--strategy", "merge", "--dry-run"], [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(2), AHEAD(1),
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("would run: git merge --no-edit origin/main  (1 ahead, 2 behind)");
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git merge"))).toBe(false);
  });

  it("on a conflict: reports every path with both sides, prints the abort line, leaves the tree, exits 1", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main", "--strategy", "rebase"], [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(2), AHEAD(1),
      { match: "git rebase origin/main", result: { code: 1, stderr: "CONFLICT (content): Merge conflict in a.ts" } },
      { match: UNMERGED, result: { stdout: "a.ts\0b.ts\0" } },
      { match: CHECK, result: { code: 0 } },
      // ON A REBASE stage 2 is origin/main and stage 3 the replayed commit (N1):
      // `ours` is stage 3 here. b.ts has no stage 3 -- this branch deleted it.
      stagesOf([["a.ts", [1, 2, 3]], ["b.ts", [1, 2]]]),
      { match: "git show :2:a.ts", result: { stdout: "base a\n" } },
      { match: "git show :3:a.ts", result: { stdout: "branch a\n" } },
      { match: "git show :2:b.ts", result: { stdout: "base b\n" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.doc["after"]).toBeNull();
    expect(result.doc["conflicted"]).toEqual([
      { path: "a.ts", ours: "branch a\n", theirs: "base a\n" },
      { path: "b.ts", ours: null, theirs: "base b\n" },
    ]);
    expect(gitCalls(result.seams)).not.toContain("git show :3:b.ts");
    expect(gitCalls(result.seams)).not.toContain("git rebase --abort");
    const text = await capture(["wc", "catch-up", "--base", "main", "--strategy", "rebase"], [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(2), AHEAD(1),
      { match: "git rebase origin/main", result: { code: 1 } },
      { match: UNMERGED, result: { stdout: "a.ts\0" } },
      { match: CHECK, result: { code: 0 } },
      stagesOf([["a.ts", [2, 3]]]),
      { match: "git show :2:a.ts", result: { stdout: "base a\n" } },
      { match: "git show :3:a.ts", result: { stdout: "branch a\n" } },
    ]);
    expect(text.code).toBe(1);
    expect(text.out).toContain("to back out: git rebase --abort");
    expect(text.out.join("\n")).toContain("    ours  :\n      branch a\n    theirs:\n      base a");
  });

  it("on a MERGE, ours is stage 2 and theirs stage 3 -- the label follows the strategy, not the stage", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main", "--strategy", "merge"], [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(2), AHEAD(1),
      { match: "git merge --no-edit origin/main", result: { code: 1 } },
      { match: UNMERGED, result: { stdout: "a.ts\0" } },
      { match: CHECK, result: { code: 0 } },
      stagesOf([["a.ts", [1, 2, 3]]]),
      { match: "git show :2:a.ts", result: { stdout: "branch a\n" } },
      { match: "git show :3:a.ts", result: { stdout: "base a\n" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.doc["conflicted"]).toEqual([{ path: "a.ts", ours: "branch a\n", theirs: "base a\n" }]);
  });

  it("reads a non-ASCII path raw, treats a stage that is there but unreadable as an ERROR, and reports a binary side by size (N3, N5)", async () => {
    const path = "docs/ünï.md";
    const result = await captureJson(["wc", "catch-up", "--base", "main", "--strategy", "merge"], [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(2), AHEAD(1),
      { match: "git merge --no-edit origin/main", result: { code: 1 } },
      { match: UNMERGED, result: { stdout: `${path}\0` } },
      { match: CHECK, result: { code: 0 } },
      stagesOf([[path, [2, 3]]]),
      { match: `git show :2:${path}`, result: { stdout: "PNG\0\0\0" } },
      { match: `git cat-file -s :2:${path}`, result: { stdout: "4096\n" } },
      { match: `git show :3:${path}`, result: { stdout: "text\n" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.doc["conflicted"]).toEqual([{ path, ours: "(binary, 4096 bytes)", theirs: "text\n" }]);
    // The stage is listed, the show fails: an error at exit 1, never "deleted".
    const failed = await capture(["wc", "catch-up", "--base", "main", "--strategy", "merge"], [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(2), AHEAD(1),
      { match: "git merge --no-edit origin/main", result: { code: 1 } },
      { match: UNMERGED, result: { stdout: `${path}\0` } },
      { match: CHECK, result: { code: 0 } },
      stagesOf([[path, [2, 3]]]),
      { match: `git show :2:${path}`, result: { code: 128, stderr: "fatal: path 'docs/ünï.md' does not exist in the index" } },
    ]);
    expect(failed.code).toBe(1);
    expect(failed.err.join("\n")).toMatch(/could not read stage 2 of 'docs\/ünï\.md'.*not a deletion/);
    expect(failed.out.join("\n")).not.toContain("deleted on this side");
  });

  it("strips control bytes from the hunks in the text rendering, keeping newlines and tabs; --json keeps the bytes", async () => {
    const ESC = String.fromCharCode(0x1b);
    const script = (): ScriptedCall[] => [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(2), AHEAD(1),
      { match: "git merge --no-edit origin/main", result: { code: 1 } },
      { match: UNMERGED, result: { stdout: "a.ts\0" } },
      { match: CHECK, result: { code: 0 } },
      stagesOf([["a.ts", [2, 3]]]),
      { match: "git show :2:a.ts", result: { stdout: `one${ESC}[2K\n\ttwo\r\n` } },
      { match: "git show :3:a.ts", result: { stdout: "base\n" } },
    ];
    const text = await capture(["wc", "catch-up", "--base", "main", "--strategy", "merge"], script());
    expect(text.out.join("\n")).toContain("    ours  :\n      one[2K\n      \ttwo\n    theirs:");
    expect(text.out.join("\n")).not.toContain(ESC);
    const json = await captureJson(["wc", "catch-up", "--base", "main", "--strategy", "merge"], script());
    expect((json.doc["conflicted"] as { ours: string }[])[0]?.ours).toBe(`one${ESC}[2K\n\ttwo\r\n`);
  });

  it("a failure that leaves no conflict is exit 1 with the git error, not a decided outcome", async () => {
    const result = await capture(["wc", "catch-up", "--base", "main", "--strategy", "merge"], [
      ...NOTHING_PENDING, CLEAN, FETCHED, HEAD_BEFORE, BEHIND(2), AHEAD(1),
      { match: "git merge --no-edit origin/main", result: { code: 128, stderr: "fatal: refusing to merge unrelated histories" } },
      { match: UNMERGED, result: { stdout: "" } },
      { match: CHECK, result: { code: 0 } },
    ]);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/unrelated histories/);
  });

  it("RESUMES an in-progress rebase once the resolutions are staged: rebase --continue under GIT_EDITOR=true, resumed: true", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main"], [
      BASE_OK,
      { match: "git rebase --show-current-patch", result: { code: 0, stdout: "commit abc\n" } },
      { match: "git rev-parse HEAD", result: { stdout: "mid00000\n" } },
      { match: "git rev-parse HEAD", result: { stdout: "after000\n" } },
      BEHIND(0),
      AHEAD(2),
      { match: UNMERGED, result: { stdout: "" } },
      { match: CHECK, result: { code: 0 } },
      { match: "git rebase --continue", result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ strategy: "rebase", before: "mid00000", after: "after000", resumed: true, aborted: false, conflicted: [] });
    const cont = result.seams.calls.find((call): boolean => call.args.join(" ") === "rebase --continue");
    expect(cont?.env).toEqual({ GIT_EDITOR: "true" });
    // Never a fetch, never a status refusal: the tree is dirty by definition mid-resolution.
    expect(gitCalls(result.seams)).not.toContain(FETCH_MAIN);
    expect(gitCalls(result.seams)).not.toContain("git status --porcelain=v1 -uall");
  });

  it("RESUMES an in-progress merge with git commit --no-edit", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main", "--strategy", "merge"], [
      BASE_OK,
      { match: "git rebase --show-current-patch", result: { code: 128, stderr: "fatal: no rebase in progress" } },
      { match: "git rev-parse --git-dir", result: { code: 0, stdout: ".git\n" } },
  { match: "git rev-parse --git-dir", result: { code: 0, stdout: ".git\n" } },
      { match: "git rev-parse --verify --quiet MERGE_HEAD", result: { code: 0, stdout: "abc\n" } },
      { match: "git rev-parse HEAD", result: { stdout: "mid00000\n" } },
      { match: "git rev-parse HEAD", result: { stdout: "after000\n" } },
      BEHIND(1),
      AHEAD(2),
      { match: UNMERGED, result: { stdout: "" } },
      { match: CHECK, result: { code: 0 } },
      { match: "git commit --no-edit", result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ strategy: "merge", resumed: true, after: "after000" });
  });

  it("does NOT continue over unmerged paths or leftover conflict markers: conflicted[] again, exit 1, abort line", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main"], [
      BASE_OK,
      { match: "git rebase --show-current-patch", result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "mid00000\n" } },
      BEHIND(0),
      AHEAD(2),
      { match: UNMERGED, result: { stdout: "" } },
      { match: CHECK, result: { code: 2, stdout: "a.ts:12: leftover conflict marker\na.ts:20: leftover conflict marker\n" } },
      // A staged resolution has no unmerged stages left: neither side is read.
      stagesOf([]),
    ]);
    expect(result.code).toBe(1);
    expect(result.doc).toMatchObject({ resumed: false, after: null });
    expect((result.doc["conflicted"] as { path: string }[]).map((c): string => c.path)).toEqual(["a.ts"]);
    expect(gitCalls(result.seams)).not.toContain("git rebase --continue");
  });

  it("a continued rebase that conflicts on a LATER commit reports that conflict at exit 1", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main"], [
      BASE_OK,
      { match: "git rebase --show-current-patch", result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "mid00000\n" } },
      BEHIND(0),
      AHEAD(2),
      { match: UNMERGED, result: { stdout: "" } },
      { match: UNMERGED, result: { stdout: "c.ts\0" } },
      { match: CHECK, result: { code: 0 } },
      { match: "git rebase --continue", result: { code: 1 } },
      stagesOf([["c.ts", [2, 3]]]),
      { match: "git show :2:c.ts", result: { stdout: "t\n" } },
      { match: "git show :3:c.ts", result: { stdout: "o\n" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.doc["conflicted"]).toEqual([{ path: "c.ts", ours: "o\n", theirs: "t\n" }]);
    expect(result.doc["resumed"]).toBe(false);
  });

  it("refuses a --strategy that disagrees with what is in progress, at exit 2", async () => {
    const result = await capture(["wc", "catch-up", "--base", "main", "--strategy", "merge"], [
      BASE_OK,
      { match: "git rebase --show-current-patch", result: { code: 0 } },
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/a rebase is in progress here and --strategy merge/);
  });

  it("refuses a rebase PAUSED with no current patch, naming --continue and --abort, and never fetches or merges (#307)", async () => {
    const result = await capture(["wc", "catch-up", "--base", "main", "--strategy", "merge"], [
      BASE_OK,
      { match: "git rebase --show-current-patch", result: { code: 1, stderr: "fatal: bad revision 'REBASE_HEAD'" } },
    ]);
    expect(result.code).toBe(2);
    const said = result.err.join("\n");
    expect(said).toMatch(/a rebase is paused here with no current patch/);
    expect(said).toMatch(/git rebase --continue/);
    expect(said).toMatch(/git rebase --abort/);
    expect(gitCalls(result.seams)).not.toContain(FETCH_MAIN);
  });

  it("--abort backs out a PAUSED rebase (#307)", async () => {
    const dry = await capture(["wc", "catch-up", "--base", "main", "--abort", "--dry-run"], [
      BASE_OK,
      { match: "git rebase --show-current-patch", result: { code: 1 } },
      { match: "git rev-parse HEAD", result: { stdout: "mid00000\n" } },
    ]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would run: git rebase --abort");
  });

  it("never runs --abort on a probe killed by a signal, though the runner reports it as code 1 (#307)", async () => {
    const result = await capture(["wc", "catch-up", "--base", "main", "--abort"], [
      BASE_OK,
      { match: "git rebase --show-current-patch", result: { code: 1, signal: "SIGTERM" } },
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not tell whether a rebase is in progress/);
    expect(gitCalls(result.seams)).not.toContain("git rebase --abort");
  });

  it("does not read a 128 as 'no rebase' where git cannot answer at all, so --abort reports no false 'nothing to back out of' (#307)", async () => {
    const result = await capture(["wc", "catch-up", "--base", "main", "--abort"], [
      BASE_OK,
      { match: "git rebase --show-current-patch", result: { code: 128, stderr: "fatal: not a git repository" } },
      { match: "git rev-parse --git-dir", result: { code: 128, stderr: "fatal: not a git repository" } },
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not tell whether a rebase is in progress/);
    expect(result.err.join("\n")).not.toMatch(/nothing to back out of/);
  });

  it("refuses an unanswered rebase probe rather than reading it as nothing in progress (#307)", async () => {
    const result = await capture(["wc", "catch-up", "--base", "main"], [
      BASE_OK,
      { match: "git rebase --show-current-patch", result: { code: 129, stderr: "usage" } },
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not tell whether a rebase is in progress/);
    expect(gitCalls(result.seams)).not.toContain(FETCH_MAIN);
  });

  it("--abort backs out the in-progress operation and reports aborted: true; refused when nothing is in progress", async () => {
    const result = await captureJson(["wc", "catch-up", "--base", "main", "--abort"], [
      BASE_OK,
      { match: "git rebase --show-current-patch", result: { code: 128, stderr: "fatal: no rebase in progress" } },
      { match: "git rev-parse --git-dir", result: { code: 0, stdout: ".git\n" } },
  { match: "git rev-parse --git-dir", result: { code: 0, stdout: ".git\n" } },
      { match: "git rev-parse --verify --quiet MERGE_HEAD", result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "mid00000\n" } },
      { match: "git rev-parse HEAD", result: { stdout: "before00\n" } },
      { match: "git merge --abort", result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ strategy: "merge", aborted: true, resumed: false, after: "before00" });
    const dry = await capture(["wc", "catch-up", "--base", "main", "--abort", "--dry-run"], [
      BASE_OK,
      { match: "git rebase --show-current-patch", result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "mid00000\n" } },
    ]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("would run: git rebase --abort");
    expect(gitCalls(dry.seams)).not.toContain("git rebase --abort");
    const nothing = await capture(["wc", "catch-up", "--base", "main", "--abort"], NOTHING_PENDING);
    expect(nothing.code).toBe(2);
    expect(nothing.err.join("\n")).toMatch(/nothing to back out of/);
  });
});

// ── nen wc publish (zheref/nen#227) ─────────────────────────────────────────

const ON_WORK = { match: "git symbolic-ref --short HEAD", result: { stdout: "feature/work\n" } };
const WORK_OK = { match: "git check-ref-format --branch feature/work", result: { code: 0 } };
const PUSH_WORK = "git push origin -- refs/heads/feature/work:refs/heads/feature/work";
const PUSH_WORK_U = "git push -u origin -- refs/heads/feature/work:refs/heads/feature/work";
const NO_TRACKING = { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { code: 128 } };
const TRACKING = { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { stdout: "origin/feature/work\n" } };
const FETCH_WORK = { match: "git fetch --end-of-options origin refs/heads/feature/work:refs/remotes/origin/feature/work", result: { code: 0 } };
/** `git remote`, which the replace route (--set-upstream over an upstream of another name) reads to find origin -- rule 3 of ./publish.ts's header. */
const REMOTES_O = { match: "git remote", result: { stdout: "origin\n" } };

describe("nen wc publish -- push the current branch to origin, never a force, never the trunk", () => {
  it("pushes with -u on --set-upstream when there is no upstream yet, reporting the nen.wc.publish/v0.1 document", async () => {
    const result = await captureJson(["wc", "publish", "--set-upstream"], [
      ON_WORK, WORK_OK, NO_TRACKING, { match: PUSH_WORK_U, result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(Object.keys(result.doc)).toEqual(["contract", "branch", "remote", "destination", "upstreamBefore", "ahead", "needsForce", "pushed", "dryRun", "retargetedUpstream"]);
    expect(result.doc).toEqual({ contract: "nen.wc.publish/v0.1", branch: "feature/work", remote: "origin", destination: "feature/work", upstreamBefore: null, ahead: null, needsForce: false, pushed: true, dryRun: false, retargetedUpstream: false });
  });

  it("fetches the upstream, checks the fast-forward, counts ahead, and pushes without -u", async () => {
    const result = await captureJson(["wc", "publish"], [
      ON_WORK, WORK_OK, TRACKING, WORK_OK, FETCH_WORK,
      { match: "git merge-base --is-ancestor origin/feature/work HEAD", result: { code: 0 } },
      { match: "git rev-list --count origin/feature/work..HEAD", result: { stdout: "3\n" } },
      { match: PUSH_WORK, result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ destination: "feature/work", upstreamBefore: "origin/feature/work", ahead: 3, needsForce: false, pushed: true });
  });

  it("a local branch tracking a DIFFERENTLY NAMED upstream on a NON-origin remote: bare refuses naming the route, --set-upstream publishes under its own name to origin -- or to --remote -- never to the upstream's branch (zheref/nen#271; Nobunaga F1)", async () => {
    const TRACKING_TOPIC = { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { stdout: "fork/topic\n" } };
    const TOPIC_OK = { match: "git check-ref-format --branch topic", result: { code: 0 } };
    const BOTH = { match: "git remote", result: { stdout: "origin\nfork\n" } };
    const FETCH_TOPIC = { match: "git fetch --end-of-options fork refs/heads/topic:refs/remotes/fork/topic", result: { code: 0 } };
    const AHEAD_OF_TOPIC = { match: "git rev-list --count fork/topic..HEAD", result: { stdout: "2\n" } };
    const pushTo = (remote: string): string => `git push -u ${remote} -- refs/heads/feature/work:refs/heads/feature/work`;
    const probeOn = (remote: string): ScriptedCall => ({ match: `git ls-remote --exit-code ${remote} refs/heads/feature/work`, result: { code: 2 } });

    // Bare: refused before any fetch, naming the route --set-upstream would take -- origin, by rule 3.
    const refused = await capture(["wc", "publish"], [ON_WORK, WORK_OK, TRACKING_TOPIC, TOPIC_OK, BOTH]);
    expect(refused.code).toBe(2);
    expect(refused.out).toEqual([]);
    expect(refused.err.join("\n")).toMatch(/'feature\/work' tracks 'fork\/topic', whose branch 'topic' is not 'feature\/work'/);
    expect(refused.err.join("\n")).toMatch(/Pass --set-upstream to publish 'feature\/work' to 'origin\/feature\/work'/);
    expect(gitCalls(refused.seams).some((call): boolean => call.startsWith("git fetch") || call.startsWith("git push") || call.startsWith("git ls-remote"))).toBe(false);
    // Bare with --remote: the refusal names THAT remote as the route.
    const named = await capture(["wc", "publish", "--remote", "fork"], [ON_WORK, WORK_OK, TRACKING_TOPIC, TOPIC_OK, BOTH]);
    expect(named.code).toBe(2);
    expect(named.err.join("\n")).toMatch(/Pass --set-upstream to publish 'feature\/work' to 'fork\/feature\/work'/);

    // --set-upstream WITHOUT --remote: origin, the fork workflow's own remote -- never the remote the branch was cut from.
    for (const argv of [["wc", "publish", "--set-upstream"], ["wc", "publish", "--set-upstream", "--remote", "origin"]]) {
      const result = await captureJson(argv, [ON_WORK, WORK_OK, TRACKING_TOPIC, TOPIC_OK, BOTH, FETCH_TOPIC, probeOn("origin"), AHEAD_OF_TOPIC, { match: pushTo("origin"), result: { code: 0 } }]);
      expect(result.code, argv.join(" ")).toBe(0);
      expect(result.doc).toMatchObject({ branch: "feature/work", remote: "origin", destination: "feature/work", upstreamBefore: "fork/topic", ahead: 2, pushed: true, retargetedUpstream: true });
      const calls = gitCalls(result.seams);
      expect(calls).toContain(pushTo("origin"));
      expect(calls.some((call): boolean => call.startsWith("git push") && (call.endsWith(":refs/heads/topic") || call.includes(" fork "))), argv.join(" ")).toBe(false);
      // No fast-forward judged against a ref this push does not move.
      expect(calls.some((call): boolean => call.startsWith("git merge-base"))).toBe(false);
    }
    // --set-upstream --remote fork: the named remote, validated and honoured.
    const toFork = await captureJson(["wc", "publish", "--set-upstream", "--remote", "fork"], [ON_WORK, WORK_OK, TRACKING_TOPIC, TOPIC_OK, BOTH, FETCH_TOPIC, probeOn("fork"), AHEAD_OF_TOPIC, { match: pushTo("fork"), result: { code: 0 } }]);
    expect(toFork.code).toBe(0);
    expect(toFork.doc).toMatchObject({ remote: "fork", destination: "feature/work", retargetedUpstream: true });
    // No origin at all: the upstream's own remote is the last resort.
    const noOrigin = await captureJson(["wc", "publish", "--set-upstream"], [ON_WORK, WORK_OK, TRACKING_TOPIC, TOPIC_OK, { match: "git remote", result: { stdout: "fork\n" } }, FETCH_TOPIC, probeOn("fork"), AHEAD_OF_TOPIC, { match: pushTo("fork"), result: { code: 0 } }]);
    expect(noOrigin.code).toBe(0);
    expect(noOrigin.doc).toMatchObject({ remote: "fork", retargetedUpstream: true });
    // A --remote this repository does not have is refused, exactly as on the no-upstream route.
    const unknown = await capture(["wc", "publish", "--set-upstream", "--remote", "nosuch"], [ON_WORK, WORK_OK, TRACKING_TOPIC, TOPIC_OK, BOTH]);
    expect(unknown.code).toBe(2);
    expect(unknown.err.join("\n")).toMatch(/no remote named 'nosuch' \(it has: origin, fork\)/);
    expect(gitCalls(unknown.seams).some((call): boolean => call.startsWith("git fetch") || call.startsWith("git push"))).toBe(false);
  });

  it("--dry-run prints the push line and pushes nothing", async () => {
    const result = await capture(["wc", "publish", "--set-upstream", "--dry-run"], [ON_WORK, WORK_OK, NO_TRACKING]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([`would run: ${PUSH_WORK_U}  (no upstream yet)`]);
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git push"))).toBe(false);
  });

  it("reports needsForce: true at exit 1, pushing nothing, when the local branch is not a fast-forward of its upstream", async () => {
    const result = await captureJson(["wc", "publish"], [
      ON_WORK, WORK_OK, TRACKING, WORK_OK, FETCH_WORK,
      { match: "git merge-base --is-ancestor origin/feature/work HEAD", result: { code: 1 } },
      { match: "git rev-list --count origin/feature/work..HEAD", result: { stdout: "1\n" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.doc).toMatchObject({ needsForce: true, pushed: false });
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git push"))).toBe(false);
  });

  it("refuses at exit 2: a detached HEAD, the trunk (branch.base and main/master), a refspec, a force, an omitted --repo", async () => {
    const detached = await capture(["wc", "publish"], [{ match: "git symbolic-ref --short HEAD", result: { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref" } }]);
    expect(detached.code).toBe(2);
    expect(detached.err.join("\n")).toMatch(/HEAD is detached/);
    for (const trunk of ["main", "master"]) {
      const result = await capture(["wc", "publish"], [{ match: "git symbolic-ref --short HEAD", result: { stdout: `${trunk}\n` } }]);
      expect(result.code, trunk).toBe(2);
      expect(result.err.join("\n")).toMatch(/is the trunk/);
    }
    // A branch git holds under a name that IS a force once it sits in a push
    // argv (Feitan S1): `+main` passes check-ref-format, is the trunk once
    // normalized, and is refused as the trunk -- before any fetch or push.
    const plusMain = await capture(["wc", "publish"], [{ match: "git symbolic-ref --short HEAD", result: { stdout: "+main\n" } }]);
    expect(plusMain.code).toBe(2);
    expect(plusMain.err.join("\n")).toMatch(/'\+main' is the trunk/);
    expect(gitCalls(plusMain.seams).some((call): boolean => call.startsWith("git push") || call.startsWith("git fetch"))).toBe(false);
    // `+feature` is not the trunk, and is refused as a force shape after git accepted the name.
    const plusFeature = await capture(["wc", "publish"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "+feature\n" } },
      { match: "git check-ref-format --branch +feature", result: { code: 0 } },
    ]);
    expect(plusFeature.code).toBe(2);
    expect(plusFeature.err.join("\n")).toMatch(/'\+feature' looks like a refspec or a force option/);
    // A name git itself rejects is refused with git's answer.
    const rejected = await capture(["wc", "publish"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "bad..name\n" } },
      { match: "git check-ref-format --branch bad..name", result: { code: 1, stderr: "fatal: 'bad..name' is not a valid branch name" } },
    ]);
    expect(rejected.code).toBe(2);
    expect(rejected.err.join("\n")).toMatch(/not a branch name git will accept/);
    // An upstream whose branch half is force-shaped is refused before the fetch.
    const badUpstream = await capture(["wc", "publish"], [
      ON_WORK, WORK_OK,
      { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { stdout: "origin/+feature/work\n" } },
      { match: "git check-ref-format --branch +feature/work", result: { code: 0 } },
    ]);
    expect(badUpstream.code).toBe(2);
    expect(badUpstream.err.join("\n")).toMatch(/the upstream's branch '\+feature\/work' looks like a refspec/);
    expect(gitCalls(badUpstream.seams).some((call): boolean => call.startsWith("git fetch"))).toBe(false);
    const refspec = await capture(["wc", "publish", "+feature/work:main"], []);
    expect(refspec.code).toBe(2);
    expect(refspec.err.join("\n")).toMatch(/looks like a refspec or a force option/);
    const colon = await capture(["wc", "publish", "a:b"], []);
    expect(colon.code).toBe(2);
    // --force is not a flag this family declares: the strict parser refuses it by name.
    const force = await capture(["wc", "publish", "--force"], []);
    expect(force.code).toBe(2);
    expect(force.err.join("\n")).toMatch(/unknown option '--force'/);
    expect((await capture(["wc", "publish"], [], null)).code).toBe(2);
  });
});

// ── nen wc publish: the trunk is refused as a DESTINATION (zheref/nen#234) ──

describe("nen wc publish -- a branch tracking the trunk is published under its own name only with --set-upstream, and the trunk is never a destination", () => {
  const TRACKING_MAIN = { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { stdout: "origin/main\n" } };
  const MAIN_OK = { match: "git check-ref-format --branch main", result: { code: 0 } };
  const FETCH_MAIN = { match: "git fetch --end-of-options origin refs/heads/main:refs/remotes/origin/main", result: { code: 0 } };
  const PROBE_OWN = "git ls-remote --exit-code origin refs/heads/feature/work";
  const AHEAD_OF_MAIN = { match: "git rev-list --count origin/main..HEAD", result: { stdout: "8\n" } };

  it("--set-upstream on a branch tracking origin/main pushes refs/heads/<own>:refs/heads/<own> with -u, and reports the retarget", async () => {
    const result = await captureJson(["wc", "publish", "--set-upstream"], [
      ON_WORK, WORK_OK, TRACKING_MAIN, MAIN_OK, REMOTES_O, FETCH_MAIN,
      { match: PROBE_OWN, result: { code: 2 } },
      AHEAD_OF_MAIN,
      { match: PUSH_WORK_U, result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ branch: "feature/work", remote: "origin", destination: "feature/work", upstreamBefore: "origin/main", ahead: 8, needsForce: false, pushed: true, retargetedUpstream: true });
    const calls = gitCalls(result.seams);
    expect(calls).toContain(PUSH_WORK_U);
    // Nothing here names the trunk on the remote side of a refspec, and nothing asked whether main is an ancestor: the trunk is not the ref this push moves.
    expect(calls.some((call): boolean => call.startsWith("git push") && /:refs\/heads\/main$/.test(call))).toBe(false);
    expect(calls.some((call): boolean => call.startsWith("git merge-base"))).toBe(false);
    const text = await capture(["wc", "publish", "--set-upstream"], [
      ON_WORK, WORK_OK, TRACKING_MAIN, MAIN_OK, REMOTES_O, FETCH_MAIN,
      { match: PROBE_OWN, result: { code: 2 } },
      AHEAD_OF_MAIN,
      { match: PUSH_WORK_U, result: { code: 0 } },
    ]);
    expect(text.out).toEqual(["pushed 'feature/work' to origin (upstream set) -- 8 commit(s) ahead of origin/main -- its upstream 'origin/main' named the trunk, so it went to origin under its own name and now tracks origin/feature/work"]);
  });

  it("without --set-upstream a branch tracking the trunk is REFUSED at exit 2 before any fetch, naming both names and the trunk -- no longer pushed with the upstream left behind (zheref/nen#271, superseding #234's bare path)", async () => {
    for (const argv of [["wc", "publish"], ["wc", "publish", "--dry-run"]]) {
      const result = await capture(argv, [ON_WORK, WORK_OK, TRACKING_MAIN, MAIN_OK, REMOTES_O]);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.out).toEqual([]);
      expect(result.err.join("\n")).toMatch(/'feature\/work' tracks 'origin\/main', whose branch 'main' is not 'feature\/work', the trunk \(nen\/workflow.json's branch.base\) -- which is never a destination either/);
      // The trunk drops the "publish that branch instead" alternative: this verb never publishes it.
      expect(result.err.join("\n")).not.toMatch(/really belong on 'main'/);
      expect(result.err.join("\n")).toMatch(/Pass --set-upstream to publish 'feature\/work' to 'origin\/feature\/work' and retrack it there, replacing 'origin\/main' \(add --remote <name> to publish it to another remote\)\. Nothing was fetched or pushed/);
      expect(result.err.join("\n")).toMatch(/Nothing was fetched or pushed/);
      expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git fetch") || call.startsWith("git push") || call.startsWith("git ls-remote"))).toBe(false);
    }
  });

  it("--dry-run --set-upstream predicts the retarget: the push line, and where the upstream would go", async () => {
    const dry = await capture(["wc", "publish", "--set-upstream", "--dry-run"], [
      ON_WORK, WORK_OK, TRACKING_MAIN, MAIN_OK, REMOTES_O, FETCH_MAIN,
      { match: PROBE_OWN, result: { code: 2 } },
      AHEAD_OF_MAIN,
    ]);
    expect(dry.code).toBe(0);
    expect(dry.out).toEqual([`would run: ${PUSH_WORK_U}  (8 ahead of origin/main) -- its upstream 'origin/main' names the trunk, so it would go to origin under its own name and then track origin/feature/work`]);
    expect(gitCalls(dry.seams).some((call): boolean => call.startsWith("git push"))).toBe(false);
    const doc = await captureJson(["wc", "publish", "--set-upstream", "--dry-run"], [
      ON_WORK, WORK_OK, TRACKING_MAIN, MAIN_OK, REMOTES_O, FETCH_MAIN,
      { match: PROBE_OWN, result: { code: 2 } },
      AHEAD_OF_MAIN,
    ]);
    expect(doc.doc).toMatchObject({ destination: "feature/work", upstreamBefore: "origin/main", pushed: false, dryRun: true, retargetedUpstream: true });
  });

  it("the fast-forward is judged against origin/<own> when the remote already has it -- never against the trunk -- and a needsForce retargets nothing", async () => {
    const diverged = await captureJson(["wc", "publish", "--set-upstream"], [
      ON_WORK, WORK_OK, TRACKING_MAIN, MAIN_OK, REMOTES_O, FETCH_MAIN,
      { match: PROBE_OWN, result: { code: 0, stdout: "abc123\trefs/heads/feature/work\n" } },
      FETCH_WORK,
      { match: "git merge-base --is-ancestor origin/feature/work HEAD", result: { code: 1 } },
      AHEAD_OF_MAIN,
    ]);
    expect(diverged.code).toBe(1);
    expect(diverged.doc).toMatchObject({ destination: "feature/work", needsForce: true, pushed: false, retargetedUpstream: false });
    expect(gitCalls(diverged.seams).some((call): boolean => call.startsWith("git push"))).toBe(false);
    const text = await capture(["wc", "publish", "--set-upstream"], [
      ON_WORK, WORK_OK, TRACKING_MAIN, MAIN_OK, REMOTES_O, FETCH_MAIN,
      { match: PROBE_OWN, result: { code: 0, stdout: "abc123\trefs/heads/feature/work\n" } },
      FETCH_WORK,
      { match: "git merge-base --is-ancestor origin/feature/work HEAD", result: { code: 1 } },
      AHEAD_OF_MAIN,
    ]);
    expect(text.out.join("\n")).toMatch(/not a fast-forward of 'origin\/feature\/work', the ref this push updates/);
    expect(text.out.join("\n")).toMatch(/Its upstream still names 'origin\/main': nothing was retracked either/);
    // A probe that failed for any reason but "no such ref" is a git failure, not a green light.
    const broken = await capture(["wc", "publish", "--set-upstream"], [
      ON_WORK, WORK_OK, TRACKING_MAIN, MAIN_OK, REMOTES_O, FETCH_MAIN,
      { match: PROBE_OWN, result: { code: 128, stderr: "fatal: unable to access" } },
    ]);
    expect(broken.code).toBe(1);
    expect(broken.err.join("\n")).toMatch(/could not ask 'origin' whether it has 'refs\/heads\/feature\/work'/);
    expect(gitCalls(broken.seams).some((call): boolean => call.startsWith("git push"))).toBe(false);
  });

  it("the same holds for master as the tracked name", async () => {
    const trunk = "master";
    const tracking = { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { stdout: `origin/${trunk}\n` } };
    const trunkOk = { match: `git check-ref-format --branch ${trunk}`, result: { code: 0 } };
    const bare = await capture(["wc", "publish"], [ON_WORK, WORK_OK, tracking, trunkOk, REMOTES_O]);
    expect(bare.code).toBe(2);
    expect(bare.err.join("\n")).toMatch(/whose branch 'master' is not 'feature\/work', the trunk/);
    const result = await captureJson(["wc", "publish", "--set-upstream"], [
      ON_WORK, WORK_OK, tracking, trunkOk, REMOTES_O,
      { match: `git fetch --end-of-options origin refs/heads/${trunk}:refs/remotes/origin/${trunk}`, result: { code: 0 } },
      { match: PROBE_OWN, result: { code: 2 } },
      { match: `git rev-list --count origin/${trunk}..HEAD`, result: { stdout: "1\n" } },
      { match: PUSH_WORK_U, result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ destination: "feature/work", upstreamBefore: `origin/${trunk}`, retargetedUpstream: true });
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git push") && call.endsWith(`:refs/heads/${trunk}`))).toBe(false);
  });

  it("trackedBranchName: a tracked name that already carries refs/heads/ is stripped once before it reaches a refspec -- and never a leading '+'", () => {
    expect(trackedBranchName("main")).toBe("main");
    expect(trackedBranchName("feature/work")).toBe("feature/work");
    expect(trackedBranchName("refs/heads/main")).toBe("main");
    expect(trackedBranchName("refs/heads/refs/heads/main")).toBe("refs/heads/main");
    expect(trackedBranchName("+main")).toBe("+main");
    expect(trackedBranchName("refs/tags/v1")).toBe("refs/tags/v1");
  });

  it("trunkDestinationRefusal: a defensive belt -- a destination that is the trunk is refused naming it, with no stale claim about the upstream routing the push (Nobunaga F3)", () => {
    expect(trunkDestinationRefusal("feature/work", "feature/work", "main")).toBeNull();
    for (const destination of ["main", "master", "refs/heads/main", "+main", "develop"]) {
      const refusal = trunkDestinationRefusal("feature/work", destination, "develop");
      expect(refusal, destination).toMatch(new RegExp(`the push destination '${destination.replace("+", "\\+")}' for 'feature/work' is the trunk`));
      expect(refusal).toMatch(/Cut a branch for this work\. Nothing was pushed\.$/);
      // The routing this clause used to describe is gone: no upstream is named, and no retrack at a ref that may not exist is recommended.
      expect(refusal).not.toMatch(/tracks|upstream|set-upstream-to/);
    }
    expect(trunkDestinationRefusal("feature/work", "develop", "develop")).toMatch(/\(nen\/workflow.json's branch.base\)/);
    expect(isTrunk("refs/heads/master", "develop")).toBe(true);
    expect(isTrunk("feature/main", "develop")).toBe(false);
  });
});

// ── nen wc publish: an upstream of another name is reported, never followed (zheref/nen#271) ──
//
// The incident's own shape: a stacked effort cut with `shu warmup --from
// <another effort's branch>` tracked that branch, and a publish pushed the
// stacked commit onto it -- and onto the pull request open from it.

describe("nen wc publish -- a stacked branch tracking ANOTHER effort's branch is never pushed onto it (zheref/nen#271)", () => {
  const STACKED = { match: "git symbolic-ref --short HEAD", result: { stdout: "fable/kurapika/bump-and-link-guards\n" } };
  const STACKED_OK = { match: "git check-ref-format --branch fable/kurapika/bump-and-link-guards", result: { code: 0 } };
  const TRACKING_BASE = { match: "git rev-parse --abbrev-ref fable/kurapika/bump-and-link-guards@{upstream}", result: { stdout: "origin/fable/kurapika/ten-installed-surface\n" } };
  const BASE_OK = { match: "git check-ref-format --branch fable/kurapika/ten-installed-surface", result: { code: 0 } };
  const FETCH_BASE = { match: "git fetch --end-of-options origin refs/heads/fable/kurapika/ten-installed-surface:refs/remotes/origin/fable/kurapika/ten-installed-surface", result: { code: 0 } };
  const PROBE_STACKED = "git ls-remote --exit-code origin refs/heads/fable/kurapika/bump-and-link-guards";
  const AHEAD_OF_BASE = { match: "git rev-list --count origin/fable/kurapika/ten-installed-surface..HEAD", result: { stdout: "1\n" } };
  const PUSH_STACKED_U = "git push -u origin -- refs/heads/fable/kurapika/bump-and-link-guards:refs/heads/fable/kurapika/bump-and-link-guards";

  it("a bare publish refuses at exit 2, naming the branch, the upstream and --set-upstream -- before any fetch, in every form", async () => {
    for (const argv of [["wc", "publish"], ["wc", "publish", "--dry-run"], ["wc", "publish", "--remote", "origin"]]) {
      const result = await capture(argv, [STACKED, STACKED_OK, TRACKING_BASE, BASE_OK, REMOTES_O]);
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.out).toEqual([]);
      const said = result.err.join("\n");
      expect(said).toMatch(/'fable\/kurapika\/bump-and-link-guards' tracks 'origin\/fable\/kurapika\/ten-installed-surface', whose branch 'fable\/kurapika\/ten-installed-surface' is not 'fable\/kurapika\/bump-and-link-guards'/);
      expect(said).toMatch(/never follows an upstream onto another one/);
      expect(said).toMatch(/Pass --set-upstream to publish 'fable\/kurapika\/bump-and-link-guards' to 'origin\/fable\/kurapika\/bump-and-link-guards'/);
      expect(said).not.toMatch(/the trunk/);
      expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git fetch") || call.startsWith("git push") || call.startsWith("git ls-remote"))).toBe(false);
    }
  });

  it("--json on the refusal prints no document: stdout stays empty and the reason is on stderr", async () => {
    const result = await captureJson(["wc", "publish"], [STACKED, STACKED_OK, TRACKING_BASE, BASE_OK, REMOTES_O]);
    expect(result.code).toBe(2);
    expect(result.doc).toEqual({});
    expect(result.err.join("\n")).toMatch(/Nothing was fetched or pushed/);
  });

  it("--set-upstream pushes refs/heads/<own>:refs/heads/<own> with -u, never to the base, and reports retargetedUpstream", async () => {
    const script = [
      STACKED, STACKED_OK, TRACKING_BASE, BASE_OK, REMOTES_O, FETCH_BASE,
      { match: PROBE_STACKED, result: { code: 2 } },
      AHEAD_OF_BASE,
      { match: PUSH_STACKED_U, result: { code: 0 } },
    ];
    const result = await captureJson(["wc", "publish", "--set-upstream"], script);
    expect(result.code).toBe(0);
    expect(result.doc).toEqual({
      contract: "nen.wc.publish/v0.1",
      branch: "fable/kurapika/bump-and-link-guards",
      remote: "origin",
      destination: "fable/kurapika/bump-and-link-guards",
      upstreamBefore: "origin/fable/kurapika/ten-installed-surface",
      ahead: 1,
      needsForce: false,
      pushed: true,
      dryRun: false,
      retargetedUpstream: true,
    });
    const calls = gitCalls(result.seams);
    expect(calls).toContain(PUSH_STACKED_U);
    expect(calls.some((call): boolean => call.startsWith("git push") && call.endsWith(":refs/heads/fable/kurapika/ten-installed-surface"))).toBe(false);
    // The base is fetched (ahead is counted against it) but never compared as the ref this push moves.
    expect(calls.some((call): boolean => call.startsWith("git merge-base"))).toBe(false);
    const text = await capture(["wc", "publish", "--set-upstream"], script);
    expect(text.out).toEqual([
      "pushed 'fable/kurapika/bump-and-link-guards' to origin (upstream set) -- 1 commit(s) ahead of origin/fable/kurapika/ten-installed-surface -- its upstream 'origin/fable/kurapika/ten-installed-surface' named another branch, so it went to origin under its own name and now tracks origin/fable/kurapika/bump-and-link-guards",
    ]);
  });

  it("--set-upstream judges the fast-forward against origin/<own> when the remote already has it, and pushes when it is one", async () => {
    const result = await captureJson(["wc", "publish", "--set-upstream"], [
      STACKED, STACKED_OK, TRACKING_BASE, BASE_OK, REMOTES_O, FETCH_BASE,
      { match: PROBE_STACKED, result: { code: 0, stdout: "abc123\trefs/heads/fable/kurapika/bump-and-link-guards\n" } },
      { match: "git fetch --end-of-options origin refs/heads/fable/kurapika/bump-and-link-guards:refs/remotes/origin/fable/kurapika/bump-and-link-guards", result: { code: 0 } },
      { match: "git merge-base --is-ancestor origin/fable/kurapika/bump-and-link-guards HEAD", result: { code: 0 } },
      AHEAD_OF_BASE,
      { match: PUSH_STACKED_U, result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ needsForce: false, pushed: true, retargetedUpstream: true });
    // An own ref that could not be fetched is a git failure at exit 1, never a push.
    const failed = await capture(["wc", "publish", "--set-upstream"], [
      STACKED, STACKED_OK, TRACKING_BASE, BASE_OK, REMOTES_O, FETCH_BASE,
      { match: PROBE_STACKED, result: { code: 0, stdout: "abc123\trefs/heads/fable/kurapika/bump-and-link-guards\n" } },
      { match: "git fetch --end-of-options origin refs/heads/fable/kurapika/bump-and-link-guards:refs/remotes/origin/fable/kurapika/bump-and-link-guards", result: { code: 128, stderr: "fatal: remote hung up" } },
    ]);
    expect(failed.code).toBe(1);
    expect(failed.err.join("\n")).toMatch(/could not fetch 'origin\/fable\/kurapika\/bump-and-link-guards', the ref this push updates/);
    expect(gitCalls(failed.seams).some((call): boolean => call.startsWith("git push"))).toBe(false);
  });

  it("an upstream that names the branch's OWN name on another remote is not a mismatch: no refusal, no retarget", async () => {
    const result = await captureJson(["wc", "publish"], [
      ON_WORK, WORK_OK,
      { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { stdout: "fork/feature/work\n" } },
      WORK_OK,
      { match: "git fetch --end-of-options fork refs/heads/feature/work:refs/remotes/fork/feature/work", result: { code: 0 } },
      { match: "git merge-base --is-ancestor fork/feature/work HEAD", result: { code: 0 } },
      { match: "git rev-list --count fork/feature/work..HEAD", result: { stdout: "1\n" } },
      { match: "git push fork -- refs/heads/feature/work:refs/heads/feature/work", result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ remote: "fork", destination: "feature/work", retargetedUpstream: false });
  });

  it("F2: under --set-upstream an upstream GONE from its remote ('couldn't find remote ref') is ahead: null and said so -- not an exit 1 blocking the one route the refusal names; any other fetch failure is still exit 1 (Nobunaga F2)", async () => {
    const GONE = { match: FETCH_BASE.match, result: { code: 128, stderr: "fatal: couldn't find remote ref refs/heads/fable/kurapika/ten-installed-surface" } };
    const script = [
      STACKED, STACKED_OK, TRACKING_BASE, BASE_OK, REMOTES_O, GONE,
      { match: PROBE_STACKED, result: { code: 2 } },
      { match: PUSH_STACKED_U, result: { code: 0 } },
    ];
    const result = await captureJson(["wc", "publish", "--set-upstream"], script);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ upstreamBefore: "origin/fable/kurapika/ten-installed-surface", ahead: null, needsForce: false, pushed: true, retargetedUpstream: true });
    // Nothing was counted against a ref the remote no longer has.
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git rev-list --count"))).toBe(false);
    const text = await capture(["wc", "publish", "--set-upstream"], script);
    expect(text.out).toEqual([
      "pushed 'fable/kurapika/bump-and-link-guards' to origin (upstream set) -- nothing counted: 'origin/fable/kurapika/ten-installed-surface' is gone from origin -- its upstream 'origin/fable/kurapika/ten-installed-surface' named another branch, so it went to origin under its own name and now tracks origin/fable/kurapika/bump-and-link-guards",
    ]);
    const dry = await capture(["wc", "publish", "--set-upstream", "--dry-run"], script);
    expect(dry.out[0]).toMatch(/\(nothing counted: 'origin\/fable\/kurapika\/ten-installed-surface' is gone from origin\)/);
    // Any OTHER failure of that same fetch is still the exit-1 git failure it is.
    const unreachable = await capture(["wc", "publish", "--set-upstream"], [
      STACKED, STACKED_OK, TRACKING_BASE, BASE_OK, REMOTES_O,
      { match: FETCH_BASE.match, result: { code: 128, stderr: "fatal: unable to access 'https://example.invalid/': Could not resolve host" } },
    ]);
    expect(unreachable.code).toBe(1);
    expect(unreachable.err.join("\n")).toMatch(/could not fetch the upstream 'origin\/fable\/kurapika\/ten-installed-surface'/);
    expect(gitCalls(unreachable.seams).some((call): boolean => call.startsWith("git push"))).toBe(false);
    // And without --set-upstream a gone upstream never reaches the fetch: the mismatch refusal comes first.
    const bare = await capture(["wc", "publish"], [STACKED, STACKED_OK, TRACKING_BASE, BASE_OK, REMOTES_O, GONE]);
    expect(bare.code).toBe(2);
    expect(gitCalls(bare.seams).some((call): boolean => call.startsWith("git fetch"))).toBe(false);
  });

  it("foreignUpstreamRefusal: null when the names agree; otherwise both names, the fix, and the trunk said when it is one", () => {
    expect(foreignUpstreamRefusal("feature/work", "origin/feature/work", "origin", "feature/work", "main")).toBeNull();
    const stacked = foreignUpstreamRefusal("b", "origin/a", "origin", "a", "main");
    expect(stacked).toMatch(/^'b' tracks 'origin\/a', whose branch 'a' is not 'b'\. /);
    expect(stacked).toMatch(/Pass --set-upstream to publish 'b' to 'origin\/b' and retrack it there, replacing 'origin\/a' \(add --remote <name> to publish it to another remote\); if the commits really belong on 'a', check that branch out and publish it instead\. Nothing was fetched or pushed\.$/);
    // The route named is the remote rule 3 resolved, whatever it is.
    expect(foreignUpstreamRefusal("b", "upstream/main", "fork", "main", "main")).toMatch(/Pass --set-upstream to publish 'b' to 'fork\/b'/);
    expect(stacked).not.toMatch(/trunk/);
    expect(foreignUpstreamRefusal("b", "origin/develop", "origin", "develop", "develop")).toMatch(/the trunk \(nen\/workflow.json's branch.base\) -- which is never a destination either/);
    expect(foreignUpstreamRefusal("b", "origin/master", "origin", "master", "develop")).toMatch(/'master' is not 'b', the trunk -- which/);
    expect(foreignUpstreamRefusal("b", "origin/master", "origin", "master", "develop")).toMatch(/replacing 'origin\/master' \(add --remote <name> to publish it to another remote\)\. Nothing was fetched or pushed\.$/);
    // Names compare exactly, as git compares refs: a case difference is another branch.
    expect(foreignUpstreamRefusal("Feature", "origin/feature", "origin", "feature", "main")).not.toBeNull();
  });
});

// ── nen wc publish: the remote is the upstream's (Copilot review on zheref/nen#231) ──

describe("nen wc publish -- the remote pushed to is the one the upstream names", () => {
  const TRACKING_FORK = { match: "git rev-parse --abbrev-ref feature/work@{upstream}", result: { stdout: "fork/feature/work\n" } };
  const FETCH_FORK = "git fetch --end-of-options fork refs/heads/feature/work:refs/remotes/fork/feature/work";
  const PUSH_FORK = "git push fork -- refs/heads/feature/work:refs/heads/feature/work";

  it("a branch tracking fork/<b> is fetched from, compared against, and pushed to fork -- origin is never touched", async () => {
    const result = await captureJson(["wc", "publish"], [
      ON_WORK, WORK_OK, TRACKING_FORK, WORK_OK,
      { match: FETCH_FORK, result: { code: 0 } },
      { match: "git merge-base --is-ancestor fork/feature/work HEAD", result: { code: 0 } },
      { match: "git rev-list --count fork/feature/work..HEAD", result: { stdout: "2\n" } },
      { match: PUSH_FORK, result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ remote: "fork", destination: "feature/work", upstreamBefore: "fork/feature/work", ahead: 2, pushed: true });
    const calls = gitCalls(result.seams);
    expect(calls).toContain(FETCH_FORK);
    expect(calls).toContain(PUSH_FORK);
    expect(calls.filter((call): boolean => call.includes("origin"))).toEqual([]);
  });

  it("needsForce is decided against the upstream's own remote, not origin", async () => {
    const result = await captureJson(["wc", "publish"], [
      ON_WORK, WORK_OK, TRACKING_FORK, WORK_OK,
      { match: FETCH_FORK, result: { code: 0 } },
      { match: "git merge-base --is-ancestor fork/feature/work HEAD", result: { code: 1 } },
      { match: "git rev-list --count fork/feature/work..HEAD", result: { stdout: "1\n" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.doc).toMatchObject({ remote: "fork", needsForce: true, pushed: false });
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git push"))).toBe(false);
  });

  it("--remote names where a branch with NO upstream goes, after 'git remote' confirms it exists", async () => {
    const result = await captureJson(["wc", "publish", "--set-upstream", "--remote", "fork"], [
      ON_WORK, WORK_OK, NO_TRACKING,
      { match: "git remote", result: { stdout: "origin\nfork\n" } },
      { match: "git push -u fork -- refs/heads/feature/work:refs/heads/feature/work", result: { code: 0 } },
    ]);
    expect(result.code).toBe(0);
    expect(result.doc).toMatchObject({ remote: "fork", destination: "feature/work", upstreamBefore: null, pushed: true });

    const unknown = await capture(["wc", "publish", "--remote", "nosuch"], [
      ON_WORK, WORK_OK, NO_TRACKING,
      { match: "git remote", result: { stdout: "origin\n" } },
    ]);
    expect(unknown.code).toBe(2);
    expect(unknown.err.join("\n")).toMatch(/no remote named 'nosuch' \(it has: origin\)/);
    expect(gitCalls(unknown.seams).some((call): boolean => call.startsWith("git push"))).toBe(false);
  });

  it("--remote that contradicts a same-name upstream is refused at exit 2 before any fetch, naming --set-upstream --remote -- never a --set-upstream-to at a ref the remote may not have (Nobunaga F1)", async () => {
    const BOTH = { match: "git remote", result: { stdout: "origin\nfork\n" } };
    const result = await capture(["wc", "publish", "--remote", "origin"], [ON_WORK, WORK_OK, TRACKING_FORK, BOTH]);
    expect(result.code).toBe(2);
    const said = result.err.join("\n");
    expect(said).toMatch(/tracks 'fork\/feature\/work', so without --set-upstream it is pushed to 'fork' -- --remote 'origin' names a different one/);
    expect(said).toMatch(/pass --set-upstream --remote origin to publish it to 'origin\/feature\/work' and track that instead/);
    expect(said).not.toMatch(/set-upstream-to/);
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git fetch"))).toBe(false);
    // ...and the route it names works: --set-upstream --remote origin publishes to origin and retracks there.
    const moved = await captureJson(["wc", "publish", "--set-upstream", "--remote", "origin"], [
      ON_WORK, WORK_OK, TRACKING_FORK, BOTH,
      { match: FETCH_FORK, result: { code: 0 } },
      { match: "git ls-remote --exit-code origin refs/heads/feature/work", result: { code: 2 } },
      { match: "git rev-list --count fork/feature/work..HEAD", result: { stdout: "1\n" } },
      { match: PUSH_WORK_U, result: { code: 0 } },
    ]);
    expect(moved.code).toBe(0);
    expect(moved.doc).toMatchObject({ remote: "origin", destination: "feature/work", upstreamBefore: "fork/feature/work", pushed: true, retargetedUpstream: true });
    // A same-name upstream with --set-upstream and NO --remote keeps its remote: nothing is replaced.
    const kept = await captureJson(["wc", "publish", "--set-upstream"], [
      ON_WORK, WORK_OK, TRACKING_FORK,
      { match: FETCH_FORK, result: { code: 0 } },
      { match: "git merge-base --is-ancestor fork/feature/work HEAD", result: { code: 0 } },
      { match: "git rev-list --count fork/feature/work..HEAD", result: { stdout: "1\n" } },
      { match: "git push -u fork -- refs/heads/feature/work:refs/heads/feature/work", result: { code: 0 } },
    ]);
    expect(kept.code).toBe(0);
    expect(kept.doc).toMatchObject({ remote: "fork", retargetedUpstream: false });
    expect(gitCalls(kept.seams)).not.toContain("git remote");
    // A --remote the repository does not have is refused as that, first.
    const unknown = await capture(["wc", "publish", "--remote", "nosuch"], [ON_WORK, WORK_OK, TRACKING_FORK, BOTH]);
    expect(unknown.code).toBe(2);
    expect(unknown.err.join("\n")).toMatch(/no remote named 'nosuch'/);
    // The same --remote as the upstream's is simply agreed with.
    const agreed = await captureJson(["wc", "publish", "--remote", "origin", "--dry-run"], [
      ON_WORK, WORK_OK, TRACKING, WORK_OK, FETCH_WORK,
      { match: "git merge-base --is-ancestor origin/feature/work HEAD", result: { code: 0 } },
      { match: "git rev-list --count origin/feature/work..HEAD", result: { stdout: "0\n" } },
    ]);
    expect(agreed.code).toBe(0);
    expect(agreed.doc).toMatchObject({ remote: "origin", pushed: false, dryRun: true });
  });

  it("refuses a --remote shaped like an option, a refspec or a path, and --remote on any other wc subcommand", async () => {
    for (const bad of ["--upload-pack=/x", "+fork", "a:b", "fork/x"]) {
      const result = await capture(["wc", "publish", `--remote=${bad}`], [ON_WORK, WORK_OK]);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/is not a remote name this verb will put in a push argv/);
    }
    const elsewhere = await capture(["wc", "catch-up", "--base", "main", "--remote", "fork"], []);
    expect(elsewhere.code).toBe(2);
    expect(elsewhere.err.join("\n")).toMatch(/--remote is not read by 'wc catch-up'; only 'wc publish' takes it/);
  });
});

describe("nen wc publish / catch-up -- a git without --end-of-options is refused, never fetched around", () => {
  const TOO_OLD = { code: 129, stderr: "error: unknown option `end-of-options'\nusage: git fetch [<options>] [<repository> [<refspec>...]]" };
  const VERSION = { match: "git --version", result: { stdout: "git version 2.23.0\n" } };

  it("publish: exit 2 naming the git version and the floor, nothing pushed", async () => {
    const result = await capture(["wc", "publish"], [ON_WORK, WORK_OK, TRACKING, WORK_OK, { match: FETCH_WORK.match, result: TOO_OLD }, VERSION]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/git version 2\.23\.0 rejected '--end-of-options' on fetch .* need git >= 2\.24, and the flag is never dropped/);
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git push") || call.startsWith("git merge-base"))).toBe(false);
  });

  it("catch-up: the same refusal, before any rebase or merge", async () => {
    const result = await capture(["wc", "catch-up", "--base", "main"], [BASE_OK, ...NOTHING_PENDING, CLEAN, { match: FETCH_MAIN, result: TOO_OLD }, VERSION]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/git version 2\.23\.0 rejected '--end-of-options' on fetch/);
    expect(gitCalls(result.seams).some((call): boolean => call.startsWith("git rebase origin/") || call.startsWith("git merge --no-edit"))).toBe(false);
  });

  it("any other fetch failure is still reported as the fetch failure it is, at exit 1", async () => {
    const result = await capture(["wc", "publish"], [ON_WORK, WORK_OK, TRACKING, WORK_OK, { match: FETCH_WORK.match, result: { code: 128, stderr: "fatal: couldn't find remote ref refs/heads/feature/work" } }]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not fetch the upstream 'origin\/feature\/work'.*couldn't find remote ref/);
    expect(gitCalls(result.seams)).not.toContain("git --version");
  });
});

// ── wc worktrees / wc swap: the refusals made before any git call (zheref/nen#241) ──
//
// Every one of these is exit 2 with NO git spawned: the flag grammar is
// settled at the command boundary, so a mistyped swap never parks or clears
// anything. The behaviour against a real repository is
// ./swap.integration.test.ts's.

describe("nen wc swap / worktrees -- CLI refusals", () => {
  const refused = async (argv: readonly string[], pattern: RegExp, repo: string | null = BANKAI_REPO): Promise<void> => {
    const result = await capture(argv, [], repo);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(pattern);
    expect(result.seams.calls).toHaveLength(0);
  };

  it("refuses swap with no target and no mode", async () => {
    await refused(["wc", "swap"], /needs a target/);
  });

  it("refuses two targets", async () => {
    await refused(["wc", "swap", "a", "b"], /one target only/);
  });

  it("refuses --return with --status", async () => {
    await refused(["wc", "swap", "--return", "--status"], /two different questions/);
  });

  it("refuses --take with --return", async () => {
    await refused(["wc", "swap", "--return", "--take"], /--take moves a branch INTO core/);
  });

  it("refuses a target with --return", async () => {
    await refused(["wc", "swap", "feat", "--return"], /--return takes no target/);
  });

  it("refuses --base on swap -- it is worktrees' flag", async () => {
    await refused(["wc", "swap", "feat", "--base", "main"], /--base is not read by 'wc swap'/);
  });

  it("refuses --take / --return / --status on any other subcommand", async () => {
    await refused(["wc", "classify", "--take"], /--take is not read by 'wc classify'/);
    await refused(["wc", "worktrees", "--return"], /--return is not read by 'wc worktrees'/);
  });

  it("refuses a positional on worktrees", async () => {
    await refused(["wc", "worktrees", "extra"], /takes no positional argument/);
  });

  it("refuses an OMITTED --repo on both, naming the flag", async () => {
    await refused(["wc", "swap", "feat"], /--repo <path> is required/, null);
    await refused(["wc", "worktrees"], /--repo <path> is required/, null);
  });
});
