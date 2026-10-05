import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runFamily, type Io } from "../index.js";
import { ALT_REPO, BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { reviewsArgv, reviewThreadsArgv, viewArgv } from "./fetch.js";
import { collaboratorArgv, prAndKnownBotsArgv, requestBotReviewsArgv } from "./bots.js";
import { requestReviewsArgv } from "./reviewers.js";
import { markReadyArgv, readDraftStateArgv } from "./markready.js";
import { prCommand } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";

/** A throwaway file, for edit-body's --body-file. */
function tempFile(name: string, contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "nen-pr-")), name);
  writeFileSync(path, contents, "utf8");
  return path;
}

// NEVER `defaultSeams()` HERE (review finding) -- see board/command.test.ts's
// own note on the same fix. A `run` that throws converts a future regression
// (this verb growing a real `gh` call) into an immediate red test instead of
// a silent live subprocess call.
const STUB_SEAMS: Seams = {
  run: (): never => {
    throw new Error("must not be called");
  },
  now: (): Date => new Date("2026-01-01T00:00:00Z"),
  env: {},
  probePort: noPortProbe,
  runInteractive: (): never => {
    throw new Error("this verb has no interactive form");
  },
  runStreamed: (): never => {
    throw new Error("this verb has no watched form");
  },
  platform: "linux",
};

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding).
async function capture(
  argv: readonly string[],
  repoFlag: string | null,
  seams: Seams = STUB_SEAMS,
): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const code = await runFamily(prCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

// THE REGISTRY WIRING FOR "ready", not prReady()'s own logic -- every branch
// of prReady() itself (ref/identity resolution, the unevaluated/not-ready/ready
// tri-state, the frozen --json contract) is covered exhaustively in
// ../verbs/pr_ready.test.ts, unchanged by this merge. What matters HERE is
// that the "pr" family -- which used to be a hard-coded case in ../index.ts,
// separate from this registry entry -- now reaches prReady() through the SAME
// findCommand -> mergeFlags -> family.run path every other family uses, with
// no second "pr" entry point left standing.
describe("nen pr ready (registry wiring onto ../verbs/pr_ready.ts)", () => {
  it("is a known subcommand of the 'pr' family, alongside staleness and body-check", async () => {
    const result = await capture(["pr", "frobnicate"], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown 'pr' subcommand 'frobnicate'/);
    expect(result.err.join("\n")).toMatch(/ready/);
    expect(result.err.join("\n")).toMatch(/staleness/);
    expect(result.err.join("\n")).toMatch(/body-check/);
  });

  it("a missing <ref> is a usage error (exit 2) reached WITHOUT any network call -- STUB_SEAMS never fires", async () => {
    const result = await capture(["pr", "ready"], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/'pr ready' requires a pull-request reference/);
  });

  it("'nen pr --help' documents all three subcommands", async () => {
    const result = await capture(["pr", "--help"], null);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/nen pr ready <ref>/);
    expect(result.out.join("\n")).toMatch(/nen pr staleness/);
    expect(result.out.join("\n")).toMatch(/nen pr body-check/);
  });

  // zheref/nen#26(a): the help never mentioned the no-# shorthand at all --
  // the only place it surfaced was the refusal thrown at an unparseable ref.
  it("'nen pr --help' documents the no-# shorthand and its longest-trailing-digits rule", async () => {
    const result = await capture(["pr", "--help"], null);
    expect(result.code).toBe(0);
    const help = result.out.join("\n");
    expect(help).toMatch(/The '#' may be\s+omitted/);
    expect(help).toMatch(/LONGEST trailing digit run/);
    // The precedence rule for digit-ending codes rides along: the '#'-present
    // form is named as the unambiguous spelling.
    expect(help).toMatch(/<CODE>#<N> is the unambiguous form/);
  });

  // MUTATION-PROVEN CASE for ./command.ts's `ready()` fold of `context.json`
  // into the boolean set handed to prReady(): a `--json` typed BEFORE the
  // family name never reaches `context.args.booleans` (it is stage-one's
  // `head.booleans`, merged into `context.json` by ../index.ts's `runFamily`,
  // never copied back into `context.args.booleans`). Reverting the `if
  // (context.json) booleans.add("json")` line in ./command.ts turns this red:
  // the "before" invocation would fall back to the human line while "after"
  // still emits JSON, and the two outputs below would stop matching.
  //
  // Reaches ONLY the token-check no-network path (an unset env var refuses
  // before ../verbs/pr_ready.ts ever calls fetchPrState) -- see the house rule
  // against live GitHub reads from tests. `--gh-repo`/`--reviewers` resolve
  // the ref and identities from flags alone, with no repository schema read.
  it("--json is the SAME invocation whether given before or after 'pr' (mutation-proven fold)", async () => {
    const tokenEnv = "NEN_TEST_DEFINITELY_UNSET_TOKEN";
    delete process.env[tokenEnv];
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
    const before = await run(
      ["--json", "pr", "ready", "5", "--gh-repo", "o/r", "--reviewers", "alice", "--token-env", tokenEnv],
      io,
    );
    const outAfter: string[] = [];
    const errAfter: string[] = [];
    const ioAfter: Io = { out: (l): void => void outAfter.push(l), err: (l): void => void errAfter.push(l) };
    const after = await run(
      ["pr", "ready", "5", "--gh-repo", "o/r", "--reviewers", "alice", "--token-env", tokenEnv, "--json"],
      ioAfter,
    );
    expect(before).toBe(1); // unevaluated
    expect(after).toBe(1);
    const beforeParsed: unknown = JSON.parse(out.join("\n"));
    const afterParsed: unknown = JSON.parse(outAfter.join("\n"));
    expect(beforeParsed).toMatchObject({ verdict: "unevaluated" });
    expect(afterParsed).toMatchObject({ verdict: "unevaluated" });
    // `--json` also SUPPRESSES the human stderr note (../verbs/pr_ready.ts's
    // own `emit`): if the "before" ordering had fallen back to the human
    // branch (the bug this test guards against), stderr would carry "could
    // NOT be evaluated" where the "after" ordering has none -- so asserting
    // both are EMPTY is itself part of proving the two orderings agree.
    expect(err).toEqual([]);
    expect(errAfter).toEqual([]);
  });
});

describe("nen pr staleness", () => {
  it("reports stale from a wakes file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-"));
    const wakes = join(dir, "wakes.json");
    writeFileSync(wakes, JSON.stringify([{ at: "a", noCommit: true }, { at: "b", noCommit: true }]));
    const result = await capture(
      ["pr", "staleness", "--wakes-from", wakes, "--last-activity", "2026-01-01T00:00:00Z", "--now", "2026-01-01T01:00:00Z"],
      dir,
    );
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("stale");
  });

  it("refuses a wakes file whose noCommit is a truthy non-boolean (review finding)", async () => {
    // The string "false" is truthy in JavaScript -- a hand-assembled or
    // mis-serialized wakes file must never count it toward the threshold
    // that authorizes the one merge a non-human actor may make.
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-"));
    const wakes = join(dir, "wakes.json");
    writeFileSync(wakes, JSON.stringify([{ at: "a", noCommit: "false" }, { at: "b", noCommit: "no" }]));
    const result = await capture(
      ["pr", "staleness", "--wakes-from", wakes, "--last-activity", "2026-01-01T00:00:00Z", "--now", "2026-01-01T05:00:00Z", "--ready"],
      dir,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/noCommit.*boolean/);
  });

  it("refuses an unparseable --now or --last-activity as a usage error, not a silent NaN (review finding)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-"));
    const wakes = join(dir, "wakes.json");
    writeFileSync(wakes, JSON.stringify([{ at: "a", noCommit: true }, { at: "b", noCommit: true }]));
    const result = await capture(
      ["pr", "staleness", "--wakes-from", wakes, "--last-activity", "yesterday", "--now", "now", "--ready", "--json"],
      dir,
    );
    // NOT exit 0 with `"idleMinutes": null` -- a machine consumer must never
    // be handed a null it cannot distinguish from a genuinely computed value.
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--last-activity 'yesterday' is not a parseable ISO-8601 instant/);
  });
});

describe("nen pr body-check", () => {
  it("exits 1 when a requirement is missing, listing every requirement", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-"));
    const body = join(dir, "body.md");
    const requirements = join(dir, "req.json");
    writeFileSync(body, "## Summary\nok\n");
    writeFileSync(requirements, JSON.stringify([{ name: "summary", pattern: "## Summary" }, { name: "test-plan", pattern: "## Test plan" }]));
    const result = await capture(["pr", "body-check", "--body-from", body, "--requirements-from", requirements], dir);
    expect(result.code).toBe(1);
    expect(result.out).toEqual(["1/2 requirement(s) satisfied", "ok  summary", "MISSING  test-plan"]);
  });

  it("refuses an empty requirements file rather than reporting a vacuous pass (review finding)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-"));
    const body = join(dir, "body.md");
    const requirements = join(dir, "req.json");
    writeFileSync(body, "anything at all\n");
    writeFileSync(requirements, "[]");
    const result = await capture(["pr", "body-check", "--body-from", body, "--requirements-from", requirements], dir);
    // NOT exit 0 with no output -- `nen pr body-check ... && gh pr merge`
    // must never get a green light from an empty requirements file.
    expect(result.code).not.toBe(0);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/empty/);
  });
});

// --- verbs/4-remainders: fetch, next-blocker, cascade-main, retarget,
// request-reviews, merged into this same "pr" family alongside main's
// ready/staleness/body-check (zheref/nen#3, zheref/nen#4). ---

describe("nen pr fetch/next-blocker/cascade-main/retarget/request-reviews -- CLI wiring", () => {
  // zheref/nen#93: EXIT 2, not 1. Four families each kept a private
  // `requireTarget` that threw a plain Error, so sixteen verbs answered a
  // forgotten flag with "the thing you asked for did not work" instead of "you
  // typed it wrong" -- and a retry wrapper honouring that distinction retries a
  // 1 forever. One shared `requireTargetFlag` now answers for all of them, the
  // way every OTHER required flag in these same families already did.
  it("requires --target, as a USAGE error", async () => {
    const result = await capture(["pr", "fetch", "--pr", "1"], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--target owner\/name is required/);
    // The sentence worth saying, kept: which of the two flags this is.
    expect(result.err.join("\n")).toMatch(/--repo names a checkout on disk/);
  });

  it("requires a valid --pr", async () => {
    const result = await capture(["pr", "fetch", "--target", "o/n"], null);
    expect(result.code).toBe(2);
  });

  // Review finding #7: --reviewers "" (an unset shell variable passed
  // through) must be refused, not silently read as "no reviewers owed".
  it("next-blocker refuses an explicitly-empty --reviewers rather than treating it as an override", async () => {
    // No seams calls are scripted -- the guard must fire before any fetch is
    // attempted (an unscripted call would throw first otherwise).
    const result = await capture(
      ["pr", "next-blocker", "--target", "o/n", "--pr", "1", "--reviewers", ""],
      null,
      new ScriptedSeams([]),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/named no reviewers/);
  });

  it("next-blocker refuses a --reviewers of only commas/whitespace the same way", async () => {
    const result = await capture(
      ["pr", "next-blocker", "--target", "o/n", "--pr", "1", "--reviewers", " , "],
      null,
      new ScriptedSeams([]),
    );
    expect(result.code).toBe(2);
  });

  // zheref/nen#28: next-blocker's and cascade-main's usage lines list --repo
  // unbracketed, so omitting it is refused by name at exit 2 -- never silently
  // resolved to whatever repository the process is standing in. No seams calls
  // are scripted: the refusal must fire before any fetch or git call.
  it("next-blocker refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(
      ["pr", "next-blocker", "--target", "o/n", "--pr", "1"],
      null,
      new ScriptedSeams([]),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("cascade-main refuses an OMITTED --repo the same way -- it MUTATES what it is pointed at", async () => {
    const result = await capture(["pr", "cascade-main"], null, new ScriptedSeams([]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  // Review finding (PR #141, Copilot): --no-push sits in this family's SHARED
  // boolean flag set (there is no per-subcommand table here yet), so without
  // this guard it parsed cleanly and was silently ignored on every other `pr`
  // subcommand -- misleading a caller who carried it over from a
  // `cascade-main` invocation. Fires before dispatch, so no other flag this
  // subcommand needs has to be supplied for the test to isolate this refusal.
  it("refuses --no-push on any subcommand other than cascade-main", async () => {
    const result = await capture(["pr", "ready", "--no-push"], null, new ScriptedSeams([]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--no-push is only read by 'pr cascade-main'/);
  });

  it("retarget requires --base", async () => {
    const result = await capture(["pr", "retarget", "--target", "o/n", "--pr", "1"], null, new ScriptedSeams([]));
    expect(result.code).toBe(2);
  });

  it("retarget exits 0 on success and calls gh with the right argv", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh pr edit 12 --repo zheref/nen --base release/1.0`, result: {} },
    ];
    const result = await capture(
      ["pr", "retarget", "--target", "zheref/nen", "--pr", "12", "--base", "release/1.0"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/now targets/);
  });

  it("cascade-main resolves the repo root and reports a conflict as exit 1", async () => {
    const script: readonly ScriptedCall[] = [
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: { code: 1, stderr: "CONFLICT" } },
      { match: "git diff --name-only --diff-filter=U", result: {} },
    ];
    const result = await capture(["pr", "cascade-main"], BANKAI_REPO, new ScriptedSeams(script));
    expect(result.code).toBe(1);
  });

  it("cascade-main --no-push merges cleanly, never calls push, and says so in the log and --json", async () => {
    const script: readonly ScriptedCall[] = [
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: {} },
    ];
    const result = await capture(["pr", "cascade-main", "--no-push"], BANKAI_REPO, new ScriptedSeams(script));
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/not pushed \(--no-push\)/);

    const jsonResult = await capture(
      ["pr", "cascade-main", "--no-push", "--json"],
      BANKAI_REPO,
      new ScriptedSeams(script),
    );
    expect(jsonResult.code).toBe(0);
    const parsed = JSON.parse(jsonResult.out.join("\n"));
    expect(parsed).toMatchObject({ noPush: true, pushed: false, conflicted: false, conflicts: [] });
  });

  it("cascade-main --json without --no-push carries noPush: false and conflicts: []", async () => {
    const script: readonly ScriptedCall[] = [
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: {} },
      { match: "git push", result: {} },
    ];
    const result = await capture(["pr", "cascade-main", "--json"], BANKAI_REPO, new ScriptedSeams(script));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n"));
    expect(parsed).toMatchObject({ noPush: false, pushed: true, conflicts: [] });
  });

  it("cascade-main lists conflicts[] as text (path, kind, both sides' commits) and in --json", async () => {
    const script: readonly ScriptedCall[] = [
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: { code: 1, stderr: "CONFLICT" } },
      { match: "git diff --name-only --diff-filter=U", result: { stdout: "src/a.ts\n" } },
      { match: "git ls-files -u", result: { stdout: "100644 aaa 2\tsrc/a.ts\n100644 bbb 3\tsrc/a.ts\n" } },
      { match: "git merge-base HEAD origin/main", result: { stdout: "base123\n" } },
      { match: "git log --format=%H base123..HEAD -- src/a.ts", result: { stdout: "ours1\n" } },
      { match: "git log --format=%H base123..origin/main -- src/a.ts", result: { stdout: "theirs1\n" } },
    ];
    const textResult = await capture(["pr", "cascade-main"], BANKAI_REPO, new ScriptedSeams(script));
    expect(textResult.code).toBe(1);
    const text = textResult.out.join("\n");
    expect(text).toMatch(/src\/a\.ts\s+\(add-add\)/);
    expect(text).toMatch(/ours:\s+ours1/);
    expect(text).toMatch(/theirs:\s+theirs1/);

    const jsonResult = await capture(["pr", "cascade-main", "--json"], BANKAI_REPO, new ScriptedSeams(script));
    expect(jsonResult.code).toBe(1);
    const parsed = JSON.parse(jsonResult.out.join("\n"));
    expect(parsed.conflicts).toEqual([{ path: "src/a.ts", kind: "add-add", ours: ["ours1"], theirs: ["theirs1"] }]);
  });

  // Review finding (PR #141, Copilot): the text placeholder for an empty
  // ours[]/theirs[] used to read "(no commits since the merge base)" even
  // when the merge base itself could not be resolved -- claiming a specific
  // reason (a resolved, genuinely empty range) that may not be the true one.
  // Both scenarios below must render the SAME neutral text, which names no
  // reason at all.
  it("cascade-main's text placeholder for an empty commit list never claims a specific reason", async () => {
    const resolvedButEmpty: readonly ScriptedCall[] = [
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: { code: 1, stderr: "CONFLICT" } },
      { match: "git diff --name-only --diff-filter=U", result: { stdout: "a.ts\n" } },
      { match: "git ls-files -u", result: { stdout: "100644 aaa 2\ta.ts\n100644 bbb 3\ta.ts\n" } },
      { match: "git merge-base HEAD origin/main", result: { stdout: "base123\n" } },
      { match: "git log --format=%H base123..HEAD -- a.ts", result: {} },
      { match: "git log --format=%H base123..origin/main -- a.ts", result: {} },
    ];
    const resolvedResult = await capture(["pr", "cascade-main"], BANKAI_REPO, new ScriptedSeams(resolvedButEmpty));
    const resolvedText = resolvedResult.out.join("\n");
    expect(resolvedText).toMatch(/ours:\s+\(no commits found\)/);
    expect(resolvedText).toMatch(/theirs:\s+\(no commits found\)/);
    expect(resolvedText).not.toMatch(/merge base/);

    const unresolvedBase: readonly ScriptedCall[] = [
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: { code: 1, stderr: "CONFLICT" } },
      { match: "git diff --name-only --diff-filter=U", result: { stdout: "a.ts\n" } },
      { match: "git ls-files -u", result: { stdout: "100644 aaa 2\ta.ts\n100644 bbb 3\ta.ts\n" } },
      { match: "git merge-base HEAD origin/main", result: { code: 1, stderr: "fatal: no merge base" } },
    ];
    const unresolvedResult = await capture(["pr", "cascade-main"], BANKAI_REPO, new ScriptedSeams(unresolvedBase));
    const unresolvedText = unresolvedResult.out.join("\n");
    expect(unresolvedText).toMatch(/ours:\s+\(no commits found\)/);
    expect(unresolvedText).toMatch(/theirs:\s+\(no commits found\)/);
  });

  // zheref/nen#20: `--gates` PARSED cleanly on next-blocker (the name sits in
  // this family's declared value flags via the PR_READY_FLAGS spread, for
  // `ready`'s sake) but ./command.ts's blocker() never read it -- silently
  // accepted, zero effect, and the verb still demanded --repo's own
  // nen/gates.json. The three tests below pin both halves of the fix and
  // the direction that matters: the flag does not merely silence the missing-
  // file refusal, it is the file whose identities DECIDE.
  describe("next-blocker --gates (zheref/nen#20)", () => {
    const TARGET: Target = { owner: "o", repo: "n", slug: "o/n" };

    // One green-check, approvals-at-head, no-thread snapshot for PR o/n#9 --
    // the same three-call script shape ../pr/fetch.test.ts drives
    // fetchPullRequest with. The approvals are ALT_REPO's reviewers (itachi,
    // kisame), so the verdict flips with the taxonomy: alt gates read "none",
    // bankai gates read "owed-round" for their own sasuke/tenma -- which is
    // the proof the --gates file, not some other source, decided.
    function greenAltApprovedScript(): readonly ScriptedCall[] {
      const view = {
        number: 9,
        headRefOid: "abc123",
        baseRefName: "main",
        headRefName: "feature/x",
        author: { login: "alice" },
        labels: [],
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        isDraft: false,
        body: "## How to verify\n\nrun it",
        url: "https://x/9",
        title: "a PR",
        state: "OPEN",
        statusCheckRollup: [
          { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
        ],
        reviewRequests: [],
      };
      const reviews = [
        { user: { login: "itachi" }, state: "APPROVED", commit_id: "abc123", submitted_at: "2026-01-01T00:00:00Z" },
        { user: { login: "kisame" }, state: "APPROVED", commit_id: "abc123", submitted_at: "2026-01-01T00:00:00Z" },
      ];
      const threads = {
        data: {
          repository: {
            pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
          },
        },
      };
      return [
        { match: `gh ${viewArgv(TARGET, 9).join(" ")}`, result: { stdout: JSON.stringify(view) } },
        { match: `gh ${reviewsArgv(TARGET, 9).join(" ")}`, result: { stdout: JSON.stringify(reviews) } },
        { match: `gh ${reviewThreadsArgv(TARGET, 9).join(" ")}`, result: { stdout: JSON.stringify(threads) } },
      ];
    }

    it("without --gates, a checkout shipping no nen/gates.json is still refused before any gh call", async () => {
      const checkout = mkdtempSync(join(tmpdir(), "nen-frozen-"));
      // No seams calls are scripted: the refusal must land before the fetch,
      // so an unscripted call would throw first and fail this loudly.
      const result = await capture(
        ["pr", "next-blocker", "--target", "o/n", "--pr", "9"],
        checkout,
        new ScriptedSeams([]),
      );
      expect(result.code).toBe(1);
      expect(result.err.join("\n")).toMatch(/no such file/);
      expect(result.err.join("\n")).toMatch(/nen\/gates\.json/);
    });

    it("--gates redirects the taxonomy read: the alternate file's identities clear a PR the checkout alone could not even evaluate", async () => {
      const checkout = mkdtempSync(join(tmpdir(), "nen-frozen-"));
      const result = await capture(
        [
          "pr", "next-blocker", "--target", "o/n", "--pr", "9",
          "--gates", join(ALT_REPO, "nen", "gates.json"),
        ],
        checkout,
        new ScriptedSeams(greenAltApprovedScript()),
      );
      expect(result.err).toEqual([]);
      expect(result.code).toBe(0);
      expect(result.out[0]).toBe("#9: none");
    });

    // zheref/nen#249 (Nobunaga N4): next-blocker applies the same declared
    // exclusions pr ready does, read from nen/gates.json AT THE BASE commit,
    // never from the local (head) file.
    it("applies checks.excluded read at the pull request's BASE, and only there", async () => {
      const WINDOWS = 'check (Windows, ["self-hosted","Windows","X64"])';
      const altGates = JSON.parse(readFileSync(join(ALT_REPO, "nen", "gates.json"), "utf8")) as Record<string, unknown>;
      const ruling = { name: "check (Windows*", match: "glob", reason: "no runner", ruled: "2020-01-01", until: { condition: "a runner exists" } };
      const script = (atBase: Record<string, unknown> | null): ScriptedCall[] => {
        const [view, ...rest] = greenAltApprovedScript();
        const viewJson = JSON.parse(String(view?.result.stdout)) as Record<string, unknown>;
        const withRed = {
          ...viewJson,
          baseRefOid: "base123",
          statusCheckRollup: [
            ...(viewJson["statusCheckRollup"] as unknown[]),
            { __typename: "CheckRun", name: WINDOWS, status: "COMPLETED", conclusion: "FAILURE" },
          ],
        };
        const contents: ScriptedCall =
          atBase === null
            ? { match: "gh api repos/o/n/contents/nen/gates.json?ref=base123", result: { code: 1, stderr: "HTTP 404" } }
            : {
                match: "gh api repos/o/n/contents/nen/gates.json?ref=base123",
                result: { stdout: JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(JSON.stringify(atBase)).toString("base64") }) },
              };
        return [{ match: view?.match ?? "", result: { stdout: JSON.stringify(withRed) } }, ...rest, contents];
      };
      const checkout = mkdtempSync(join(tmpdir(), "nen-frozen-"));
      const honoured = await capture(
        ["pr", "next-blocker", "--target", "o/n", "--pr", "9", "--gates", join(ALT_REPO, "nen", "gates.json")],
        checkout,
        new ScriptedSeams(script({ ...altGates, checks: { excluded: [ruling] } })),
      );
      expect(honoured.out[0]).toBe("#9: none");
      // Never silent (hanten round 2, N1): the notice and the condition
      // warning print under the result line.
      expect(honoured.out).toContain(`  excluded by declaration: ${WINDOWS} — no runner (ruled 2020-01-01, until a runner exists)`);
      expect(honoured.out.some((line): boolean => /^ {2}warning: declared exclusion 'check \(Windows\*' .* CONDITION nen cannot evaluate/.test(line))).toBe(true);
      // The LOCAL file declaring it is not enough: the base has none.
      const localOnly = mkdtempSync(join(tmpdir(), "nen-249-local-"));
      const localGates = join(localOnly, "gates.json");
      writeFileSync(localGates, JSON.stringify({ ...altGates, checks: { excluded: [ruling] } }));
      const refused = await capture(
        ["pr", "next-blocker", "--target", "o/n", "--pr", "9", "--gates", localGates],
        checkout,
        new ScriptedSeams(script(null)),
      );
      expect(refused.out[0]).toBe("#9: red-check");
      expect(refused.out.join("\n")).toContain(WINDOWS);
      expect(refused.out).toContain(
        "  warning: declared exclusion 'check (Windows*' is in the local nen/gates.json but not at the pull request's base (o/n@base123:nen/gates.json) — NOT honoured until it is merged there.",
      );
    });

    it("control characters in labels and declared text are stripped from rendered lines, kept in --json (Copilot on #359)", async () => {
      const EVIL = "check (Windows\u001b[2J\r\nfake: none";
      const altGates = JSON.parse(readFileSync(join(ALT_REPO, "nen", "gates.json"), "utf8")) as Record<string, unknown>;
      const ruling = { name: "check (Windows*", match: "glob", reason: "no\u001b[31m\r\nrunner", ruled: "2020-01-01", until: "2099-12-31" };
      const script = (): ScriptedCall[] => {
        const [view, ...rest] = greenAltApprovedScript();
        const viewJson = JSON.parse(String(view?.result.stdout)) as Record<string, unknown>;
        const withRed = {
          ...viewJson,
          baseRefOid: "base123",
          statusCheckRollup: [
            ...(viewJson["statusCheckRollup"] as unknown[]),
            { __typename: "CheckRun", name: EVIL, status: "COMPLETED", conclusion: "FAILURE" },
          ],
        };
        const content = Buffer.from(JSON.stringify({ ...altGates, checks: { excluded: [ruling] } })).toString("base64");
        return [
          { match: view?.match ?? "", result: { stdout: JSON.stringify(withRed) } },
          ...rest,
          {
            match: "gh api repos/o/n/contents/nen/gates.json?ref=base123",
            result: { stdout: JSON.stringify({ type: "file", encoding: "base64", content }) },
          },
        ];
      };
      const checkout = mkdtempSync(join(tmpdir(), "nen-frozen-"));
      const gatesFlag = ["--gates", join(ALT_REPO, "nen", "gates.json")];
      const plain = await capture(["pr", "next-blocker", "--target", "o/n", "--pr", "9", ...gatesFlag], checkout, new ScriptedSeams(script()));
      expect(plain.out[0]).toBe("#9: none");
      expect(plain.out).toContain("  excluded by declaration: check (Windows[2Jfake: none — no[31mrunner (ruled 2020-01-01, until 2099-12-31)");
      for (const line of plain.out) expect(line).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/);
      const json = await capture(
        ["pr", "next-blocker", "--target", "o/n", "--pr", "9", ...gatesFlag, "--json"],
        checkout,
        new ScriptedSeams(script()),
      );
      const parsed = JSON.parse(json.out.join("\n")) as { warnings: string[] };
      expect(parsed.warnings).toContain(`excluded by declaration: ${EVIL} — ${ruling.reason} (ruled 2020-01-01, until 2099-12-31)`);
    });

    it("a base read refused with 403 applies nothing and WARNS -- in the plain output and in --json's warnings", async () => {
      const WINDOWS = 'check (Windows, ["self-hosted","Windows","X64"])';
      const altGates = JSON.parse(readFileSync(join(ALT_REPO, "nen", "gates.json"), "utf8")) as Record<string, unknown>;
      const ruling = { name: "check (Windows*", match: "glob", reason: "no runner", ruled: "2020-01-01", until: "2099-12-31" };
      const dir = mkdtempSync(join(tmpdir(), "nen-249-local-"));
      const localGates = join(dir, "gates.json");
      writeFileSync(localGates, JSON.stringify({ ...altGates, checks: { excluded: [ruling] } }));
      const script = (): ScriptedCall[] => {
        const [view, ...rest] = greenAltApprovedScript();
        const viewJson = JSON.parse(String(view?.result.stdout)) as Record<string, unknown>;
        const withRed = {
          ...viewJson,
          baseRefOid: "base123",
          statusCheckRollup: [
            ...(viewJson["statusCheckRollup"] as unknown[]),
            { __typename: "CheckRun", name: WINDOWS, status: "COMPLETED", conclusion: "FAILURE" },
          ],
        };
        return [
          { match: view?.match ?? "", result: { stdout: JSON.stringify(withRed) } },
          ...rest,
          {
            match: "gh api repos/o/n/contents/nen/gates.json?ref=base123",
            result: { code: 1, stderr: "gh: Resource not accessible by integration (HTTP 403)" },
          },
        ];
      };
      const checkout = mkdtempSync(join(tmpdir(), "nen-frozen-"));
      const plain = await capture(
        ["pr", "next-blocker", "--target", "o/n", "--pr", "9", "--gates", localGates],
        checkout,
        new ScriptedSeams(script()),
      );
      expect(plain.out[0]).toBe("#9: red-check");
      expect(plain.out.some((line): boolean => /^ {2}warning: declared check exclusions NOT honoured: the base could not be read \(.*HTTP 403/.test(line))).toBe(true);
      const json = await capture(
        ["pr", "next-blocker", "--target", "o/n", "--pr", "9", "--gates", localGates, "--json"],
        checkout,
        new ScriptedSeams(script()),
      );
      const parsed = JSON.parse(json.out.join("\n")) as { kind: string; warnings: string[]; notes: string[] };
      expect(parsed.kind).toBe("red-check");
      expect(parsed.warnings.join("\n")).toMatch(/NOT honoured: the base could not be read[\s\S]*HTTP 403/);
      expect(parsed.notes).toEqual([]);
    });

    it("the --gates file's OWN reviewer set decides -- the SAME snapshot reads owed-round under the other taxonomy", async () => {
      const checkout = mkdtempSync(join(tmpdir(), "nen-frozen-"));
      const result = await capture(
        [
          "pr", "next-blocker", "--target", "o/n", "--pr", "9",
          "--gates", join(BANKAI_REPO, "nen", "gates.json"),
        ],
        checkout,
        new ScriptedSeams(greenAltApprovedScript()),
      );
      expect(result.code).toBe(1);
      expect(result.out[0]).toBe("#9: owed-round");
      // itachi/kisame's approvals mean nothing to bankai's identities: their
      // own sasuke is still owed a round, which is only reachable if the
      // gates FILE was what parameterised the verdict.
      expect(result.out.join("\n")).toMatch(/sasuke/);
    });

    // zheref/nen#8 item 4, on THIS verb: next-blocker shares `ready`'s
    // resolveIdentities rather than re-spelling it, so the relative-path rule
    // is one rule for both -- and this case proves it is, rather than asserting
    // it. The process stands in a directory that HAS a nen/gates.json while
    // --repo points somewhere else that also has one; only one of the two
    // answers is right, and the two taxonomies give different verdicts on the
    // identical snapshot.
    it("a RELATIVE --gates resolves against --repo, not the cwd -- the same rule 'ready' applies", async () => {
      const previous = process.cwd();
      try {
        process.chdir(BANKAI_REPO);
        const result = await capture(
          [
            "pr", "next-blocker", "--target", "o/n", "--pr", "9",
            "--gates", join("nen", "gates.json"),
          ],
          ALT_REPO,
          new ScriptedSeams(greenAltApprovedScript()),
        );
        // ALT_REPO's itachi/kisame approved at head, so under ALT's identities
        // nothing blocks. Under the cwd's identities it would read owed-round
        // for sasuke -- which is exactly what this used to return.
        expect(result.err).toEqual([]);
        expect(result.code).toBe(0);
        expect(result.out[0]).toBe("#9: none");
      } finally {
        process.chdir(previous);
      }
    });

    it("a --gates that resolves to nothing is refused by name, before any gh call", async () => {
      const result = await capture(
        [
          "pr", "next-blocker", "--target", "o/n", "--pr", "9",
          "--gates", join("nen", "nowhere.json"),
        ],
        ALT_REPO,
        // Nothing scripted: the refusal must land before the fetch.
        new ScriptedSeams([]),
      );
      const text = result.err.join("\n");
      expect(text).toMatch(/no such file/);
      expect(text).toContain(ALT_REPO);
      expect(text).not.toMatch(/ENOENT/);
    });

    it("'nen pr --help' documents --gates on next-blocker", async () => {
      const result = await capture(["pr", "--help"], null);
      expect(result.code).toBe(0);
      const help = result.out.join("\n");
      expect(help).toMatch(/nen pr next-blocker .*\[--gates <path>\]/);
      // The flag is documented in next-blocker's OWN section, not merely
      // present somewhere in the page (ready's section already had it).
      // Both delimiters are ASSERTED before slicing (review finding): a
      // missing/renamed header would make indexOf return -1, and slice(-1)
      // silently reshapes the range instead of failing -- a start of -1
      // means "from the last char" (empty section, confusing failure) and
      // an end of -1 means "to the end of the page", which would let a
      // --gates line in ANY later section satisfy an assertion that is
      // supposed to be scoped to next-blocker alone.
      const sectionStart = help.indexOf("next-blocker:");
      const sectionEnd = help.indexOf("cascade-main:");
      expect(sectionStart).toBeGreaterThanOrEqual(0);
      expect(sectionEnd).toBeGreaterThan(sectionStart);
      const section = help.slice(sectionStart, sectionEnd);
      expect(section).toMatch(/--gates <path>/);
    });
  });

  // zheref/nen#160: a Bot reviewer (Copilot's own `copilot-pull-request-reviewer`
  // login) cannot travel `requestReviewsByLogin` (what `gh pr edit
  // --add-reviewer` uses), so every `--add-reviewers` login is now resolved
  // FIRST -- against this pull request's own known bots, then against
  // --target's collaborators -- before either route is called.
  const KNOWN_BOTS_TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };
  const NO_KNOWN_BOTS = { stdout: JSON.stringify({ data: { repository: { pullRequest: { id: "PR_1", reviewRequests: { nodes: [] }, timelineItems: { nodes: [] } } } } }) };
  const KNOWN_BOT_COPILOT = {
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            id: "PR_1",
            reviewRequests: { nodes: [] },
            timelineItems: { nodes: [{ author: { __typename: "Bot", login: "copilot-pull-request-reviewer", id: "BOT_1" } }] },
          },
        },
      },
    }),
  };
  const collaboratorFound = (login: string, id: string): Partial<{ stdout: string }> => ({
    stdout: JSON.stringify({ data: { repository: { collaborators: { nodes: [{ login, id }] } } } }),
  });
  const COLLABORATOR_NONE = { stdout: JSON.stringify({ data: { repository: { collaborators: { nodes: [] } } } }) };
  // `ids` defaults to BOT_1, BOT_2, ... by position. Since zheref/nen#277 the
  // ids MATTER -- a requested id the response does not carry is reported as
  // not recorded -- so a test whose request is not BOT_1-first states them.
  const botMutationOk = (logins: readonly string[], ids?: readonly string[]): Partial<{ stdout: string }> => ({
    stdout: JSON.stringify({
      data: {
        requestReviews: {
          pullRequest: {
            reviewRequests: {
              nodes: logins.map((login, index): unknown => ({
                requestedReviewer: { __typename: "Bot", login, id: ids?.[index] ?? `BOT_${index + 1}` },
              })),
            },
          },
        },
      },
    }),
  });

  it("resolves a login this pull request already knows as a bot and routes it through the requestReviews mutation's botIds, never gh pr edit --add-reviewer", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: KNOWN_BOT_COPILOT },
      {
        match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_1"]).join(" ")}`,
        result: botMutationOk(["copilot-pull-request-reviewer"]),
      },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "copilot-pull-request-reviewer"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/copilot-pull-request-reviewer/);
  });

  it("resolves a login as a collaborator and requests it through gh pr edit --add-reviewer, unchanged from before", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      { match: `gh ${collaboratorArgv(KNOWN_BOTS_TARGET, "sasuke").join(" ")}`, result: collaboratorFound("sasuke", "U_1") },
      { match: `gh ${requestReviewsArgv(KNOWN_BOTS_TARGET, 9, ["sasuke"]).join(" ")}`, result: {} },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "sasuke"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/requested sasuke/);
  });

  // Regression flagged post-#174: that PR started resolving EVERY
  // --add-reviewers login as a Bot-or-collaborator, uniformly -- which also
  // caught a TEAM SLUG ('org/team'), refusing it at exit 2 even though
  // 'gh pr edit --add-reviewer' has always accepted one, unresolved, through
  // the exact same requestReviewsByLogin mutation a User login travels. A
  // '/' is the one syntactic tell GitHub itself uses for a team slug, so an
  // entry containing one now routes straight to the user/team path -- no
  // known-bots read, no collaborator lookup -- exactly as it did before #174.
  it("routes a team slug (org/team) straight to gh pr edit --add-reviewer, with no bot-or-collaborator lookup at all", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${requestReviewsArgv(KNOWN_BOTS_TARGET, 9, ["acme/reviewers"]).join(" ")}`, result: {} },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "acme/reviewers"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/requested acme\/reviewers/);
  });

  it("--dry-run reports a team slug as 'team' and makes no GitHub call to resolve it", async () => {
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "acme/reviewers", "--dry-run"],
      null,
      STUB_SEAMS,
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/acme\/reviewers -> team \[add-reviewers\]/);
  });

  it("a mixed list routes each entry to its own lane -- team straight through, a known bot to the mutation, a collaborator to gh pr edit", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: KNOWN_BOT_COPILOT },
      { match: `gh ${collaboratorArgv(KNOWN_BOTS_TARGET, "sasuke").join(" ")}`, result: collaboratorFound("sasuke", "U_1") },
    ];
    const result = await capture(
      [
        "pr",
        "request-reviews",
        "--target",
        "zheref/nen",
        "--pr",
        "9",
        "--add-reviewers",
        "acme/reviewers,copilot-pull-request-reviewer,sasuke",
        "--dry-run",
      ],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(0);
    const out = result.out.join("\n");
    expect(out).toMatch(/acme\/reviewers -> team \[add-reviewers\]/);
    expect(out).toMatch(/copilot-pull-request-reviewer -> bot \(id BOT_1\) \[add-reviewers\]/);
    expect(out).toMatch(/sasuke -> user \[add-reviewers\]/);
  });

  it("a bare unknown login still refuses (exit 2) even alongside a team slug that routes cleanly", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      { match: `gh ${collaboratorArgv(KNOWN_BOTS_TARGET, "ghost").join(" ")}`, result: COLLABORATOR_NONE },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "acme/reviewers,ghost"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/'ghost'/);
    expect(result.err.join("\n")).not.toMatch(/acme\/reviewers/);
    expect(result.err.join("\n")).toMatch(/--add-bots/);
  });

  it("--add-bots routes a node id straight to botIds, with no --add-reviewers resolution at all", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      { match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_2"]).join(" ")}`, result: botMutationOk(["some-other-bot"], ["BOT_2"]) },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "BOT_2"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/some-other-bot/);
  });

  // zheref/nen#277: the call zheref/hatsu#123, #128 and #130 made on
  // 2026-09-29 -- accepted, answered, and recording nothing. It used to exit 0
  // with "(none reported back)" while no review was ever coming.
  const BOT_MUTATION_RECORDS_NOTHING = {
    stdout: JSON.stringify({ data: { requestReviews: { pullRequest: { reviewRequests: { nodes: [] } } } } }),
  };

  it("exits 9 naming the bot when GitHub accepts an --add-bots request but records no pending review for it (zheref/nen#277)", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      { match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_kgDOCnlnWA"]).join(" ")}`, result: BOT_MUTATION_RECORDS_NOTHING },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "BOT_kgDOCnlnWA"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(9);
    const out = result.out.join("\n");
    expect(out).toMatch(/did not record it for BOT_kgDOCnlnWA/);
    expect(out).not.toMatch(/none reported back/);
  });

  it("--json carries the same fact: ok false, unrecordedBots naming the bot, under exit 9", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      { match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_kgDOCnlnWA"]).join(" ")}`, result: BOT_MUTATION_RECORDS_NOTHING },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "BOT_kgDOCnlnWA", "--json"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(9);
    const report = JSON.parse(result.out.join("\n")) as { ok: boolean; unrecordedBots: unknown; message: string; routing: unknown };
    expect(report.ok).toBe(false);
    expect(report.unrecordedBots).toEqual([{ id: "BOT_kgDOCnlnWA", login: null }]);
    expect(report.message).toMatch(/did not record it for BOT_kgDOCnlnWA/);
    expect(report.routing).toEqual([{ name: "BOT_kgDOCnlnWA", via: "add-bots", route: "bot", id: "BOT_kgDOCnlnWA" }]);
  });

  it("names an unrecorded bot by the login it was requested under, when it came in through --add-reviewers", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: KNOWN_BOT_COPILOT },
      { match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_1"]).join(" ")}`, result: BOT_MUTATION_RECORDS_NOTHING },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "copilot-pull-request-reviewer", "--json"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(9);
    const report = JSON.parse(result.out.join("\n")) as { unrecordedBots: unknown };
    expect(report.unrecordedBots).toEqual([{ id: "BOT_1", login: "copilot-pull-request-reviewer" }]);
  });

  it("a route whose gh call FAILED outranks an unrecorded bot: exit 1, and --json still names the bot", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      { match: `gh ${collaboratorArgv(KNOWN_BOTS_TARGET, "sasuke").join(" ")}`, result: collaboratorFound("sasuke", "U_1") },
      { match: `gh ${requestReviewsArgv(KNOWN_BOTS_TARGET, 9, ["sasuke"]).join(" ")}`, result: { code: 1, stderr: "could not add reviewer" } },
      { match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_kgDOCnlnWA"]).join(" ")}`, result: BOT_MUTATION_RECORDS_NOTHING },
    ];
    const result = await capture(
      [
        "pr",
        "request-reviews",
        "--target",
        "zheref/nen",
        "--pr",
        "9",
        "--add-reviewers",
        "sasuke",
        "--add-bots",
        "BOT_kgDOCnlnWA",
        "--json",
      ],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out.join("\n")) as { ok: boolean; unrecordedBots: unknown };
    expect(report.ok).toBe(false);
    expect(report.unrecordedBots).toEqual([{ id: "BOT_kgDOCnlnWA", login: null }]);
  });

  it("a recorded request exits 0 and --json carries an EMPTY unrecordedBots, never an absent key", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      { match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_2"]).join(" ")}`, result: botMutationOk(["some-other-bot"], ["BOT_2"]) },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "BOT_2", "--json"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as { ok: boolean; unrecordedBots: unknown };
    expect(report.ok).toBe(true);
    expect(report.unrecordedBots).toEqual([]);
  });

  it("--help documents exit 9 and the unrecordedBots field under request-reviews", async () => {
    const result = await capture(["pr", "--help"], null);
    const help = result.out.join("\n");
    const start = help.indexOf("request-reviews:");
    const end = help.indexOf("edit-body:");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const section = help.slice(start, end);
    expect(section).toMatch(/\b9 every\s+call was ACCEPTED/);
    expect(section).toMatch(/unrecordedBots/);
  });

  it("folds an --add-bots id resolved from --add-reviewers AND an explicit --add-bots id into ONE mutation call", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: KNOWN_BOT_COPILOT },
      {
        match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_1", "BOT_2"]).join(" ")}`,
        result: botMutationOk(["copilot-pull-request-reviewer", "some-other-bot"]),
      },
    ];
    const result = await capture(
      [
        "pr",
        "request-reviews",
        "--target",
        "zheref/nen",
        "--pr",
        "9",
        "--add-reviewers",
        "copilot-pull-request-reviewer",
        "--add-bots",
        "BOT_2",
      ],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(0);
  });

  it("--dry-run resolves (still reads GitHub) but requests nothing, and prints which route each name went to", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: KNOWN_BOT_COPILOT },
      { match: `gh ${collaboratorArgv(KNOWN_BOTS_TARGET, "sasuke").join(" ")}`, result: collaboratorFound("sasuke", "U_1") },
    ];
    const result = await capture(
      [
        "pr",
        "request-reviews",
        "--target",
        "zheref/nen",
        "--pr",
        "9",
        "--add-reviewers",
        "copilot-pull-request-reviewer,sasuke",
        "--dry-run",
      ],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(0);
    const out = result.out.join("\n");
    expect(out).toMatch(/copilot-pull-request-reviewer -> bot \(id BOT_1\) \[add-reviewers\]/);
    expect(out).toMatch(/sasuke -> user \[add-reviewers\]/);
  });

  it("refuses (exit 2) a login that resolves to neither a known bot nor a collaborator, naming it and pointing at --add-bots", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      { match: `gh ${collaboratorArgv(KNOWN_BOTS_TARGET, "ghost").join(" ")}`, result: COLLABORATOR_NONE },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "ghost"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/'ghost'/);
    expect(result.err.join("\n")).toMatch(/--add-bots/);
  });

  // zheref/nen#95, generalized: the empty-input refusal now names BOTH flags
  // this verb reads, and needs no network call to answer -- STUB_SEAMS never
  // fires.
  it("the no-reviewers refusal names --add-reviewers AND --add-bots, not the sibling verbs' --reviewers", async () => {
    const result = await capture(["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9"], null);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/--add-reviewers/);
    expect(result.out.join("\n")).toMatch(/--add-bots/);
    expect(result.out.join("\n")).not.toMatch(/--reviewers takes/);
  });
});

describe("nen pr edit-body -- replaces a pull request's body outright, byte for byte", () => {
  const CERTIFY_12: ScriptedCall = {
    match: "gh api repos/zheref/nen/pulls/12",
    result: { stdout: JSON.stringify({ number: 12 }) },
  };

  it("certifies the number first, then writes through the Runner seam", async () => {
    const path = tempFile("body.md", "## plan\n\nreplaced wholesale.\n");
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", path],
      null,
      new ScriptedSeams([CERTIFY_12, { match: `gh pr edit 12 --repo zheref/nen --body-file ${path}`, result: {} }]),
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toBe("replaced zheref/nen#12's body (29 byte(s))");
  });

  it("--json carries the frozen six-field contract, written: true on a real run", async () => {
    const path = tempFile("body.md", "hello");
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", path, "--json"],
      null,
      new ScriptedSeams([CERTIFY_12, { match: `gh pr edit 12 --repo zheref/nen --body-file ${path}`, result: {} }]),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      contract: "nen.pr.edit-body/v0.1",
      target: "zheref/nen",
      number: 12,
      bytes: 5,
      written: true,
      dryRun: false,
    });
  });

  // --dry-run still reads GitHub to certify the number -- this verb is not
  // network-free -- but runs no write.
  it("--dry-run certifies (still reads GitHub), then prints target/number/bytes/first-last line and writes nothing", async () => {
    const path = tempFile("body.md", "first line\nmiddle\nlast line\n");
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", path, "--dry-run"],
      null,
      new ScriptedSeams([CERTIFY_12]),
    );
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      `would run: gh pr edit 12 --repo zheref/nen --body-file ${path}`,
      "target: zheref/nen",
      "number: 12",
      "bytes: 28",
      "first line: first line",
      "last line: last line",
    ]);
  });

  // Copilot review (PR #151): splitting the preview on a bare "\n" left a
  // CRLF file's displayed last line carrying a trailing "\r" -- a caller
  // reading `last line: last line\r` could not tell whether that was really
  // in the file. `bytes` still counts every raw byte the CRLF file holds
  // (31, not 28): this fix touches only what the preview SPLITS ON, never
  // the bytes `--body-file` reads or reports.
  it("--dry-run's first/last line preview strips a CRLF cleanly, with no trailing \\r", async () => {
    const path = tempFile("crlf.md", "first line\r\nmiddle\r\nlast line\r\n");
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", path, "--dry-run"],
      null,
      new ScriptedSeams([CERTIFY_12]),
    );
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      `would run: gh pr edit 12 --repo zheref/nen --body-file ${path}`,
      "target: zheref/nen",
      "number: 12",
      "bytes: 31",
      "first line: first line",
      "last line: last line",
    ]);
  });

  it("--dry-run --json carries dryRun: true, written: false, and no other fields", async () => {
    const path = tempFile("body.md", "hi");
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", path, "--dry-run", "--json"],
      null,
      new ScriptedSeams([CERTIFY_12]),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      contract: "nen.pr.edit-body/v0.1",
      target: "zheref/nen",
      number: 12,
      bytes: 2,
      written: false,
      dryRun: true,
    });
  });

  // UNLIKE 'issue comment', a number that does not read as a pull request is
  // refused before any write -- and the wording never claims it IS an issue,
  // only that it is not a pull request (see ./editbody.ts's header).
  it("refuses (exit 2) a number that does not read as a pull request, before any write", async () => {
    const path = tempFile("body.md", "hi");
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "17", "--body-file", path],
      null,
      new ScriptedSeams([{ match: "gh api repos/zheref/nen/pulls/17", result: { code: 1, stderr: "HTTP 404: Not Found" } }]),
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/#17 does not read as a pull request/);
    expect(err).toMatch(/nen issue edit-body/);
    expect(err).not.toMatch(/#17 names an issue/);
  });

  it("--dry-run also refuses a non-pull-request number -- the dry run never lies about what a real run would do", async () => {
    const path = tempFile("body.md", "hi");
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "17", "--body-file", path, "--dry-run"],
      null,
      new ScriptedSeams([{ match: "gh api repos/zheref/nen/pulls/17", result: { code: 1, stderr: "HTTP 404: Not Found" } }]),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/#17 does not read as a pull request/);
  });

  it("requires --pr", async () => {
    const path = tempFile("body.md", "hi");
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--body-file", path],
      null,
      new ScriptedSeams([]),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--pr <n>/);
  });

  it.each(["1e3", "0x0c", "12.0", " 12", "+12", "0"])(
    "refuses (exit 2) --pr '%s' rather than letting a loose read retarget the write",
    async (raw) => {
      const path = tempFile("body.md", "hi");
      const result = await capture(
        ["pr", "edit-body", "--target", "zheref/nen", "--pr", raw, "--body-file", path],
        null,
        new ScriptedSeams([]),
      );
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/--pr <n>: a positive whole number of at most 9 digits, digits only/);
    },
  );

  it("requires --body-file", async () => {
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "12"],
      null,
      new ScriptedSeams([]),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--body-file <path>/);
  });

  it("refuses (exit 2) an empty --body-file", async () => {
    const path = tempFile("body.md", "\n   \n");
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", path],
      null,
      new ScriptedSeams([]),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is empty/);
  });

  it("refuses (exit 2) a --body-file that does not exist", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "nen-pr-")), "nope.md");
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", missing],
      null,
      new ScriptedSeams([]),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not read/);
  });

  it("propagates a gh write failure as its own error (exit 1), after certification succeeded", async () => {
    const path = tempFile("body.md", "hi");
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", path],
      null,
      new ScriptedSeams([CERTIFY_12, { match: `gh pr edit 12 --repo zheref/nen --body-file ${path}`, result: { code: 1, stderr: "HTTP 500" } }]),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not replace zheref\/nen#12's body/);
  });

  it("refuses --dry-run on any subcommand other than edit-body", async () => {
    const result = await capture(["pr", "ready", "--dry-run"], null, new ScriptedSeams([]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--dry-run is only read by 'pr edit-body'/);
  });

  it("refuses --body-file on any subcommand other than edit-body", async () => {
    const path = tempFile("body.md", "hi");
    const result = await capture(
      ["pr", "ready", "--body-file", path],
      null,
      new ScriptedSeams([]),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--body-file is only read by 'pr edit-body'/);
  });

  it("'nen pr --help' documents edit-body, its --body-file-only shape and the non-pull-request refusal", async () => {
    const result = await capture(["pr", "--help"], null);
    expect(result.code).toBe(0);
    const out = result.out.join("\n");
    expect(out).toMatch(/nen pr edit-body --target <owner\/name> --pr <n> --body-file <path> \[--dry-run\]/);
    expect(out).toMatch(/does not read as a pull request/);
  });
});

describe("nen pr merge -- the bounded merge, CLI wiring", () => {
  function unitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-merge-"));
    mkdirSync(join(dir, "nen"), { recursive: true });
    copyFileSync(join(BANKAI_REPO, "nen", "gates.json"), join(dir, "nen", "gates.json"));
    return dir;
  }

  const REQUIREMENTS_FILE = tempFile("requirements.json", JSON.stringify([{ name: "how to verify", pattern: "## How to verify" }]));

  it("only merges a release unit -- refused (exit 2) without --release-unit", async () => {
    const result = await capture(["pr", "merge", "zheref/example#9", "--requirements-from", REQUIREMENTS_FILE], unitRepo());
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/nen pr merge only merges a release unit/);
  });

  it("requires a pull-request reference, and the refusal names all three forms", async () => {
    const result = await capture(["pr", "merge", "--release-unit", "--requirements-from", REQUIREMENTS_FILE], unitRepo());
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/'pr merge <CODE>#<n> --release-unit \.\.\.'/);
  });

  // zheref/nen#269, at the CLI: a <CODE>#<n> is read as a product code and
  // resolved through --repo's registry -- never refused as "not an owner/name
  // slug" -- and one --repo's registry does not list is a usage error (exit 2)
  // reached before any tool runs.
  it("reads <CODE>#<n> as a product code: an unknown one is exit 2 naming the known codes, not an owner/name refusal", async () => {
    const root = unitRepo();
    writeFileSync(join(root, "nen", "repos.json"), JSON.stringify({ consumers: [{ repo: "zheref/example", consumes: [], code: "EX" }] }));
    const result = await capture(
      ["pr", "merge", "ZZ#9", "--release-unit", "--requirements-from", REQUIREMENTS_FILE],
      root,
      new ScriptedSeams([]),
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/'ZZ' is not a product code/);
    expect(err).toMatch(/Known codes: EX/);
    expect(err).not.toMatch(/owner\/name repository slug/);
  });

  it("refuses (exit 2) a <CODE>#<n> that resolves to a repository other than --repo's origin", async () => {
    const root = unitRepo();
    writeFileSync(
      join(root, "nen", "repos.json"),
      JSON.stringify({ consumers: [{ repo: "zheref/example", consumes: [], code: "EX" }, { repo: "zheref/other", consumes: [], code: "OT" }] }),
    );
    const result = await capture(
      ["pr", "merge", "OT#9", "--release-unit", "--requirements-from", REQUIREMENTS_FILE, "--run"],
      root,
      new ScriptedSeams([{ match: "git remote get-url origin", result: { code: 0, stdout: "https://github.com/zheref/example.git\n" } }]),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/nen pr merge never merges a repository --repo does not name/);
  });

  it("'nen pr --help' states the CODE#n form on merge's usage line and the deliberate '#'-required narrowing", async () => {
    const result = await capture(["pr", "--help"], null);
    const help = result.out.join("\n");
    expect(help).toMatch(/nen pr merge <n\|owner\/name#n\|CODE#n> --release-unit/);
    const start = help.indexOf("\nmerge:");
    expect(start).toBeGreaterThanOrEqual(0);
    const section = help.slice(start);
    expect(section).toMatch(/SAME lookup\s+'pr ready <CODE>#<N>' uses/);
    expect(section).toMatch(/NARROWER\s+THAN 'pr ready', DELIBERATELY: the '#' is\s+required/);
  });

  it("requires --requirements-from", async () => {
    const result = await capture(["pr", "merge", "zheref/example#9", "--release-unit"], unitRepo());
    expect(result.code).toBe(2);
  });

  it("--release-unit is refused on every other subcommand", async () => {
    const result = await capture(["pr", "staleness", "--release-unit", "--wakes-from", "x", "--last-activity", "2025-01-01T00:00:00Z", "--now", "2025-01-01T00:00:00Z"], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--release-unit is only read by 'pr merge'/);
  });

  // zheref/nen#286, narrowed by the maintainer's ruling of 2026-10-03.
  it("--release-unit and --delivery are mutually exclusive (exit 2)", async () => {
    const result = await capture(["pr", "merge", "zheref/example#9", "--release-unit", "--delivery", "--requirements-from", REQUIREMENTS_FILE], unitRepo());
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--release-unit and --delivery are mutually exclusive/);
  });

  it("names both forms when neither is given", async () => {
    const result = await capture(["pr", "merge", "zheref/example#9"], unitRepo());
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/a run's own delivery pull request into a non-main base \(--delivery\)/);
  });

  it("--delivery's missing-ref refusal names the --delivery forms", async () => {
    const result = await capture(["pr", "merge", "--delivery"], unitRepo());
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/'pr merge <CODE>#<n> --delivery \.\.\.'/);
  });

  /** The reads a --delivery run makes before it refuses a PR into the default branch. */
  function trunkRefusalSeams(): ScriptedSeams {
    const workflow = JSON.stringify({ content: Buffer.from(JSON.stringify({ branch: { base: "main" } })).toString("base64"), encoding: "base64" });
    const baseOid = "ba5e".repeat(10);
    return new ScriptedSeams([
      { match: "git remote get-url origin", result: { code: 0, stdout: "https://github.com/zheref/example.git\n" } },
      {
        match: "gh pr view 9 --repo zheref/example --json headRefOid,baseRefOid,baseRefName,headRefName,body,isCrossRepository,author,state",
        result: {
          code: 0,
          stdout: JSON.stringify({ headRefOid: "cafebabe", baseRefOid: baseOid, baseRefName: "main", headRefName: "opus/kurapika/x", body: "", isCrossRepository: false, author: { login: "someone" }, state: "OPEN" }),
        },
      },
      { match: "gh repo view zheref/example --json defaultBranchRef", result: { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }) } },
      { match: `gh api repos/zheref/example/contents/nen/workflow.json?ref=${baseOid}`, result: { code: 0, stdout: workflow } },
      { match: "gh api repos/zheref/example/contents/nen/workflow.json?ref=main", result: { code: 0, stdout: workflow } },
      { match: "gh api repos/zheref/example/branches/main", result: { code: 0, stdout: JSON.stringify({ protected: true }) } },
      { match: "gh api repos/zheref/example/rules/branches/main", result: { code: 0, stdout: "[]" } },
    ]);
  }

  it("--delivery refuses a pull request into the default branch at exit 2 -- refused by ruling, on stdout, not a usage error", async () => {
    const result = await capture(["pr", "merge", "zheref/example#9", "--delivery", "--requirements-from", REQUIREMENTS_FILE, "--run"], unitRepo(), trunkRefusalSeams());
    expect(result.code).toBe(2);
    expect(result.err).toEqual([]);
    const out = result.out.join("\n");
    expect(out).toMatch(/^base: 'main' is the repository's default branch/m);
    expect(out).toMatch(/nen pr merge: refused by ruling -- not merged \(exit 2\)\. Per the maintainer's merge-authority ruling of 2026-09-30/);
  });

  it("--delivery --json emits its contract on a refusal too, baseOk false (N6)", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runFamily(
      prCommand,
      ["pr", "merge", "zheref/example#9", "--delivery", "--requirements-from", REQUIREMENTS_FILE],
      unitRepo(),
      true,
      { out: (line): void => void out.push(line), err: (line): void => void err.push(line) },
      trunkRefusalSeams(),
    );
    expect(code).toBe(2);
    const doc = JSON.parse(out.join("\n")) as { contract: string; refused: boolean; baseOk: boolean; ok: boolean; mergeArgv: unknown; base: string };
    expect(doc.contract).toBe("nen.pr.merge-delivery/v0.1");
    expect(doc.refused).toBe(true);
    expect(doc.baseOk).toBe(false);
    expect(doc.ok).toBe(false);
    expect(doc.mergeArgv).toBeNull();
    expect(doc.base).toBe("main");
  });

  // Round 2, N7: other subcommands' flags parse on 'merge' (one family table)
  // and are refused, not ignored -- on either form, before any gh call.
  for (const [form, extra] of [
    ["--delivery", ["--base", "main"]],
    ["--delivery", ["--target", "zheref/example"]],
    ["--release-unit", ["--base", "main"]],
    ["--release-unit", ["--target", "zheref/example"]],
  ] as const) {
    it(`${extra[0]} is refused on 'pr merge ${form}' (exit 2, zero gh calls)`, async () => {
      const result = await capture(["pr", "merge", "zheref/example#9", form, "--requirements-from", REQUIREMENTS_FILE, ...extra], unitRepo(), new ScriptedSeams([]));
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(new RegExp(`${extra[0]} is not read by 'pr merge'`));
    });
  }

  it("--delivery requires --requirements-from (AC1, N5)", async () => {
    const result = await capture(["pr", "merge", "zheref/example#9", "--delivery"], unitRepo(), new ScriptedSeams([]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/requirements-from/);
  });

  // N11: 'pr ready''s own flags are refused on merge, before any gh call --
  // an empty ScriptedSeams throws on the first call, so exit 2 proves zero.
  for (const extra of [
    ["--exclude-check", "ci / lint"],
    ["--gates", "g.json"],
    ["--reviewers", "a"],
    ["--approvers", "a"],
    ["--round-policy", "strict"],
    ["--token-env", "TOKEN"],
    ["--exclude-run", "1"],
    ["--gh-repo", "zheref/example"],
    ["--explain"],
  ]) {
    it(`${extra[0]} is refused on 'pr merge' (exit 2, zero gh calls)`, async () => {
      const result = await capture(["pr", "merge", "zheref/example#9", "--delivery", "--requirements-from", REQUIREMENTS_FILE, ...extra], unitRepo(), new ScriptedSeams([]));
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(new RegExp(`${extra[0]} is only read by 'pr ready'`));
    });
  }

  it("--require-head is refused with --release-unit", async () => {
    const result = await capture(["pr", "merge", "zheref/example#9", "--release-unit", "--require-head", "cafebabe", "--requirements-from", REQUIREMENTS_FILE], unitRepo());
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--require-head is read by 'pr merge --delivery'/);
  });

  it("--delivery is refused on every other subcommand", async () => {
    const result = await capture(["pr", "staleness", "--delivery", "--wakes-from", "x", "--last-activity", "2025-01-01T00:00:00Z", "--now", "2025-01-01T00:00:00Z"], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--delivery is only read by 'pr merge'/);
  });

  it("'nen pr --help' carries the --delivery usage line and its section", async () => {
    const help = (await capture(["pr", "--help"], null)).out.join("\n");
    expect(help).toMatch(/nen pr merge <n\|owner\/name#n\|CODE#n> --delivery --requirements-from <path> --repo <path> \[--require-head <sha>\]/);
    expect(help).toMatch(/7 MERGED WITHOUT AUTHORITY/);
    expect(help).toMatch(/merge --delivery \(zheref\/nen#286\):/);
    expect(help).toMatch(/nen\.pr\.merge-delivery\/v0\.1/);
  });

  it("--run is refused on every other subcommand", async () => {
    const result = await capture(["pr", "staleness", "--run", "--wakes-from", "x", "--last-activity", "2025-01-01T00:00:00Z", "--now", "2025-01-01T00:00:00Z"], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--run is only read by 'pr merge'/);
  });

  // pr_ready's own transport (../verbs/pr_ready.ts's `deps.openSource`) is
  // stubbed exhaustively, for a fully-passing chain, in ../pr/mergeunit.test.ts
  // -- this CLI-level test proves only the ADAPTER: the positional ref, the
  // --release-unit/--requirements-from/--repo wiring, and that a real
  // invocation reaches the composition rather than refusing at the parser.
  // 'pr ready' has no seam here at all (../verbs/pr_ready.ts reads its token
  // from `process.env` directly, unlike every seam-driven verb in this
  // family), so the deterministic way to reach it without a live network call
  // is the same one ../verbs/pr_ready.test.ts's own CLI test uses: an
  // explicitly unset token-env variable is not a flag this subcommand takes,
  // so GH_TOKEN itself is cleared for the duration of this one test.
  it("reaches the composition (no parser refusal) and reports 'pr ready' as unevaluated with no usable token", async () => {
    const root = unitRepo();
    const priorToken = process.env["GH_TOKEN"];
    delete process.env["GH_TOKEN"];
    try {
      const script: readonly ScriptedCall[] = [
        { match: "git remote get-url origin", result: { code: 0, stdout: "https://github.com/zheref/example.git\n" } },
        {
          match: "gh pr view 9 --repo zheref/example --json headRefOid,baseRefOid,body,isCrossRepository,author,state",
          result: {
            code: 0,
            stdout: JSON.stringify({
              headRefOid: "cafebabe",
              baseRefOid: "deadbeef",
              body: "## Summary\ndone\n\n## How to verify\nrun\n",
              isCrossRepository: false,
              author: { login: "someone" },
              state: "OPEN",
            }),
          },
        },
        {
          match: "gh api --paginate --slurp repos/zheref/example/pulls/9/files",
          result: { code: 0, stdout: JSON.stringify([{ filename: "src/unit/a.ts" }]) },
        },
        {
          match: "gh api repos/zheref/example/pulls/9",
          result: { code: 0, stdout: JSON.stringify({ changed_files: 1 }) },
        },
        {
          match: "gh api repos/zheref/example/contents/nen/workflow.json?ref=deadbeef",
          result: {
            code: 0,
            stdout: JSON.stringify({
              content: Buffer.from(JSON.stringify({ release: { unitPaths: ["src/unit/**"] } })).toString("base64"),
              encoding: "base64",
            }),
          },
        },
        {
          match: "gh api repos/zheref/example/git/trees/cafebabe?recursive=1",
          result: { code: 0, stdout: JSON.stringify({ tree: [{ path: "src/unit/a.ts", mode: "100644" }] }) },
        },
        {
          match: "gh api repos/zheref/example/git/trees/deadbeef?recursive=1",
          result: { code: 0, stdout: JSON.stringify({ tree: [{ path: "src/unit/a.ts", mode: "100644" }] }) },
        },
        { match: "gh api user --jq .login", result: { code: 0, stdout: "someone\n" } },
      ];
      const result = await capture(
        ["pr", "merge", "zheref/example#9", "--release-unit", "--requirements-from", REQUIREMENTS_FILE],
        root,
        new ScriptedSeams(script),
      );
      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(/pr ready: unevaluated: no usable token/);
      // The two gates that DID pass are printed too -- "every gate evaluated,
      // every verdict line quoted verbatim" holds even when the overall merge
      // does not.
      expect(result.out.join("\n")).toMatch(/pr body-check: 1\/1 requirement/);
      expect(result.out.join("\n")).toMatch(/every changed path is inside the release unit/);
    } finally {
      if (priorToken === undefined) delete process.env["GH_TOKEN"];
      else process.env["GH_TOKEN"] = priorToken;
    }
  });

  describe("validates the requirements file's shape before ever calling gh (item 4)", () => {
    it("refuses (exit 2) an empty requirements array, with no gh call made", async () => {
      const emptyFile = tempFile("empty-requirements.json", JSON.stringify([]));
      const seams = new ScriptedSeams([]);
      const result = await capture(
        ["pr", "merge", "zheref/example#9", "--release-unit", "--requirements-from", emptyFile],
        unitRepo(),
        seams,
      );
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/requirement list is empty/);
      expect(seams.calls.length).toBe(0);
    });

    it("refuses (exit 2) a requirement with an unparseable regex, with no gh call made", async () => {
      const badFile = tempFile("bad-requirements.json", JSON.stringify([{ name: "broken", pattern: "(" }]));
      const seams = new ScriptedSeams([]);
      const result = await capture(
        ["pr", "merge", "zheref/example#9", "--release-unit", "--requirements-from", badFile],
        unitRepo(),
        seams,
      );
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/unparseable pattern/);
      expect(seams.calls.length).toBe(0);
    });
  });
});

// ── mark-ready (zheref/nen#345): the registry wiring and the exit codes ─────
// ./markready.test.ts covers every branch of the logic; this drives the REAL
// runFamily so flag parsing, usage refusals and the status-to-exit mapping are
// proven end to end, still with no network.
describe("nen pr mark-ready (registry wiring onto ./markready.ts)", () => {
  const MR_TARGET: Target = { owner: "acme", repo: "widgets", slug: "acme/widgets" };
  const MR_HEAD = "0123456789abcdef0123456789abcdef01234567";
  const MR_NODE = "PR_kwSYNTHETIC";
  const readKey = `gh ${readDraftStateArgv(MR_TARGET, 42).join(" ")}`;
  const writeKey = `gh ${markReadyArgv(MR_NODE).join(" ")}`;
  const readCall = (overrides: Record<string, unknown> = {}): ScriptedCall => ({
    match: readKey,
    result: {
      code: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              id: MR_NODE,
              number: 42,
              state: "OPEN",
              isDraft: true,
              headRefOid: MR_HEAD,
              url: "https://github.com/acme/widgets/pull/42",
              ...overrides,
            },
          },
        },
      }),
    },
  });
  const writeOk: ScriptedCall = {
    match: writeKey,
    result: { code: 0, stdout: JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { id: MR_NODE, isDraft: false } } } }) },
  };
  const base = ["pr", "mark-ready", "--target", "acme/widgets", "--pr", "42"];

  it("is listed in the family's usage, distinct from the read-only 'ready' verdict", async () => {
    const result = await capture(["pr", "--help"], null);
    const text = [...result.out, ...result.err].join("\n");
    expect(text).toContain("nen pr mark-ready --target <owner/name> --pr <n>");
    expect(text).toMatch(/NOT 'pr ready'/);
  });

  it("refuses a missing or malformed --target at exit 2, before any call", async () => {
    expect((await capture(["pr", "mark-ready", "--pr", "42"], null)).code).toBe(2);
    expect((await capture(["pr", "mark-ready", "--target", "not-a-slug", "--pr", "42"], null)).code).toBe(2);
  });

  it("refuses a coerced or missing --pr at exit 2, before any call", async () => {
    expect((await capture(["pr", "mark-ready", "--target", "acme/widgets", "--pr", "1e3"], null)).code).toBe(2);
    expect((await capture(["pr", "mark-ready", "--target", "acme/widgets"], null)).code).toBe(2);
  });

  it("refuses a malformed --require-head at exit 2, before any call", async () => {
    const result = await capture([...base, "--require-head", "xyz"], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/7 to 40 hex digits/);
  });

  it("--dry-run --json prints the contract document, sends nothing, exits 0", async () => {
    const seams = new ScriptedSeams([readCall()]);
    const result = await capture([...base, "--dry-run", "--json"], null, seams);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["contract"]).toBe("nen.pr.mark-ready/v0.1");
    expect(doc["status"]).toBe("dry-run");
    expect(doc["sent"]).toBe(false);
    expect(seams.calls.length).toBe(1);
  });

  it("--dry-run prints the exact mutation it would send", async () => {
    const result = await capture([...base, "--dry-run"], null, new ScriptedSeams([readCall()]));
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/would run: gh api --method POST graphql/);
    expect(result.out.join("\n")).toContain("markPullRequestReadyForReview");
  });

  it("transitions and exits 0 only on a not-draft read back", async () => {
    const seams = new ScriptedSeams([readCall(), writeOk, readCall({ isDraft: false })]);
    const result = await capture([...base, "--require-head", MR_HEAD.slice(0, 7)], null, seams);
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("marked-ready");
    expect(seams.calls.length).toBe(3);
  });

  it("exits 0 already-ready with nothing sent", async () => {
    const seams = new ScriptedSeams([readCall({ isDraft: false })]);
    const result = await capture(base, null, seams);
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("already-ready");
    expect(seams.calls.length).toBe(1);
  });

  it("exits 8 on a head mismatch and 3 on a merged pull request", async () => {
    expect((await capture([...base, "--require-head", "fedcba9"], null, new ScriptedSeams([readCall()]))).code).toBe(8);
    expect((await capture(base, null, new ScriptedSeams([readCall({ state: "MERGED" })]))).code).toBe(3);
  });

  it("exits 1 on a refused mutation and on a still-draft read back", async () => {
    const refused = new ScriptedSeams([readCall(), { match: writeKey, result: { code: 1, stderr: "GraphQL: Resource not accessible by integration" } }]);
    expect((await capture(base, null, refused)).code).toBe(1);
    expect((await capture(base, null, new ScriptedSeams([readCall(), writeOk, readCall()]))).code).toBe(1);
  });

  it("exits 2 on a number that is not a pull request", async () => {
    const seams = new ScriptedSeams([
      { match: readKey, result: { code: 1, stderr: "GraphQL: Could not resolve to a PullRequest with the number of 42." } },
    ]);
    expect((await capture(base, null, seams)).code).toBe(2);
  });

  it("refuses --token-env at exit 2 with zero gh calls, naming gh's own credential", async () => {
    const seams = new ScriptedSeams([]);
    const result = await capture([...base, "--token-env", "MY_TOKEN"], null, seams);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("--token-env is only read by 'pr ready'; mark-ready runs on gh's own credential");
    expect(seams.calls.length).toBe(0);
  });

  it.each([
    [["--gh-repo", "acme/widgets"], /--gh-repo is only read by 'pr ready'/],
    [["--reviewers", "a"], /--reviewers is only read by 'pr ready'/],
    [["--gates", "g.json"], /--gates is only read by 'pr ready'/],
    [["--exclude-check", "ci"], /--exclude-check is only read by 'pr ready'/],
    [["--explain"], /--explain is only read by 'pr ready'/],
    [["--base", "main"], /--base is not read by 'pr mark-ready'/],
    [["--add-reviewers", "a"], /--add-reviewers is not read by 'pr mark-ready'/],
    [["--policy", "strict"], /--policy is not read by 'pr mark-ready'/],
    [["--delivery-pr"], /--delivery-pr is not read by 'pr mark-ready'/],
  ])("refuses a flag it does not read (%j) at exit 2 with zero gh calls", async (extra, message) => {
    const seams = new ScriptedSeams([]);
    const result = await capture([...base, ...extra], null, seams);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(message);
    expect(seams.calls.length).toBe(0);
  });

  it("still accepts every flag it reads, together", async () => {
    const seams = new ScriptedSeams([readCall()]);
    const result = await capture([...base, "--require-head", MR_HEAD, "--dry-run", "--json"], null, seams);
    expect(result.code).toBe(0);
  });

  it("exits 8 marked-ready-head-moved when the pinned head moved by the read back", async () => {
    const other = "fedcba9876543210fedcba9876543210fedcba98";
    const seams = new ScriptedSeams([readCall(), writeOk, readCall({ isDraft: false, headRefOid: other })]);
    const result = await capture([...base, "--require-head", MR_HEAD], null, seams);
    expect(result.code).toBe(8);
    expect(result.out[0]).toBe("marked-ready-head-moved");
  });

  it("strips control characters from GitHub-controlled strings in the human rendering, never in --json", async () => {
    const hostile = "https://github.com/acme/widgets/pull/42\u001b[2J\r";
    const human = await capture(base, null, new ScriptedSeams([readCall({ isDraft: false, url: hostile })]));
    for (const line of human.out) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(human.out.join("\n")).toContain("https://github.com/acme/widgets/pull/42[2J");
    const json = await capture([...base, "--json"], null, new ScriptedSeams([readCall({ isDraft: false, url: hostile })]));
    expect((JSON.parse(json.out.join("\n")) as { url: string }).url).toBe(hostile);
  });

  // Copilot, PR #355: a THROWN error is printed by runFamily directly, never
  // through the command's plainLine rendering, so gh's and GitHub's words must
  // be filtered where they enter the message. Every path that carries foreign
  // text is driven end to end here with an ESC sequence in it.
  describe("hostile gh/GitHub text never reaches the terminal raw", () => {
    const ESC = "\u001b]0;pwned\u0007\u001b[2J";
    const noControls = (result: { out: string[]; err: string[] }): void => {
      const lines = [...result.out, ...result.err];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain("\u001b");
        expect(line).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
      }
    };

    it("first read fails (exit 1, thrown error): stderr is filtered, its words kept", async () => {
      const seams = new ScriptedSeams([{ match: readKey, result: { code: 1, stderr: `HTTP 502 ${ESC} Bad Gateway` } }]);
      const result = await capture(base, null, seams);
      expect(result.code).toBe(1);
      noControls(result);
      expect(result.err.join("\n")).toMatch(/502/);
    });

    it("first read cannot spawn gh (exit 1): the raw spawn stderr is filtered too", async () => {
      const seams = new ScriptedSeams([{ match: readKey, result: { code: -1, stderr: `spawn gh ENOENT ${ESC}`, spawnFailed: true } }]);
      const result = await capture(base, null, seams);
      expect(result.code).toBe(1);
      noControls(result);
      expect(result.err.join("\n")).toMatch(/ENOENT/);
    });

    it("not a pull request (exit 2, usage error): GitHub's words are filtered", async () => {
      const seams = new ScriptedSeams([
        { match: readKey, result: { code: 1, stderr: `GraphQL: Could not resolve to a PullRequest ${ESC} with the number of 42.` } },
      ]);
      const result = await capture(base, null, seams);
      expect(result.code).toBe(2);
      noControls(result);
    });

    it("a 200 carrying errors on the read (exit 1): the errors' messages are filtered", async () => {
      const seams = new ScriptedSeams([
        { match: readKey, result: { code: 0, stdout: JSON.stringify({ data: null, errors: [{ message: `rate limited ${ESC}` }] }) } },
      ]);
      const result = await capture(base, null, seams);
      expect(result.code).toBe(1);
      noControls(result);
    });

    it("an uncertain mutation and a failing read back (exit 1, report): both gh texts are filtered, in --json too", async () => {
      const script: ScriptedCall[] = [
        readCall(),
        { match: writeKey, result: { code: 1, stderr: `connection reset ${ESC}` } },
        { match: readKey, result: { code: 1, stderr: `HTTP 500 ${ESC}` } },
      ];
      const human = await capture(base, null, new ScriptedSeams(script));
      expect(human.code).toBe(1);
      expect(human.out[0]).toBe("unconfirmed");
      noControls(human);
      const json = await capture([...base, "--json"], null, new ScriptedSeams(script));
      expect((JSON.parse(json.out.join("\n")) as { message: string }).message).not.toContain("\u001b");
    });
  });

  it("is the only new reader of --dry-run: 'pr retarget --dry-run' is still refused", async () => {
    const result = await capture(["pr", "retarget", "--target", "acme/widgets", "--pr", "1", "--base", "main", "--dry-run"], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/'pr mark-ready'/);
  });
});
