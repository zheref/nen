import { describe, expect, it } from "vitest";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runFamily, type Io } from "../index.js";
import { ALT_REPO, BANKAI_REPO, SHU_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { defaultSeams, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { reviewsArgv, reviewThreadsArgv, viewArgv } from "./fetch.js";
import { botLoginArgv, collaboratorArgv, prAndKnownBotsArgv, requestBotReviewsArgv } from "./bots.js";
import { requestReviewsArgv } from "./reviewers.js";
import { botNodesArgv, commitArgv, gatesAtArgv, requestTimelineArgv } from "./round_ceiling.js";
import { markReadyArgv, readDraftStateArgv } from "./markready.js";
import { PR_FLAGS, PR_SUBCOMMAND_FLAGS, PR_SUBCOMMANDS, PR_TOKEN_ENV_ADVICE_KEYS, gateRefsArgv, THREADS_ACTION_FLAGS, prCommand, prFlagOwners } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";
import { FULL_REACH_ROW, privateListRow, PRIVATE_LIST_PAGE, SCOPES_CALL, UNREADABLE_PRIVATE_LIST, visibilityRow, withPrivateTarget } from "../issue/privacy.testkit.js";

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

/** The `pr` subcommands that run the private-name guard (zheref/nen#363). */
function runsPrivateNameGuard(argv: readonly string[]): boolean {
  if (argv[0] !== "pr") return false;
  if (argv[1] === "edit-body" || argv[1] === "open") return true;
  return argv[1] === "threads" && (argv[2] === "reply" || argv[2] === "settle");
}

/**
 * THE DEFAULT PRIVATE-NAME GUARD ANSWER (zheref/nen#363), for every test that
 * is not about it: ../issue/privacy.testkit.ts's withPrivateTarget, applied to
 * a guarded subcommand's --target. The guard's own describe block passes
 * `"scripted"` and scripts the reads itself.
 */
function withGuardDefault(argv: readonly string[], seams: Seams): Seams {
  const at = argv.indexOf("--target");
  const slug = at >= 0 ? argv[at + 1] : undefined;
  return slug === undefined || !runsPrivateNameGuard(argv) ? seams : withPrivateTarget(seams, slug);
}

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding).
async function capture(
  argv: readonly string[],
  repoFlag: string | null,
  seams: Seams = STUB_SEAMS,
  guard: "private-target" | "scripted" = "private-target",
): Promise<{ code: number; out: string[]; err: string[] }> {
  if (guard === "private-target") seams = withGuardDefault(argv, seams);
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

  it("passes target/pr aliases through the family parser with unchanged JSON shape", async () => {
    const tokenEnv = "NEN_TEST_DEFINITELY_UNSET_TOKEN";
    delete process.env[tokenEnv];
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (line) => void out.push(line), err: (line) => void err.push(line) };
    const code = await run(["--json", "pr", "ready", "--target", "o/r", "--pr", "5", "--reviewers", "alice", "--token-env", tokenEnv, "--repo", SHU_REPO], io);
    expect(code).toBe(1);
    const report = JSON.parse(out.join("\n"));
    expect(report).toMatchObject({ contract: "nen.pr.ready/v0.1", verdict: "unevaluated", meta: { ref: "5", repo: "o/r", pr: 5 } });
    expect(report.remedy).toContain("--token-env");
    expect(report.remedy).toContain("GH_TOKEN");
    expect(err).toEqual([]);
  });

  it("refuses malformed, missing or conflicting alias declarations through the parser", async () => {
    for (const flags of [
      ["--target", "o/r"], ["--pr", "5"], ["--target", "o/r", "--pr"],
      ["--target", "o/r", "--pr", "bad"], ["--target", "bad", "--pr", "5"],
      ["5", "--target", "o/r", "--pr", "6"],
      ["--target", "o/r", "--gh-repo", "o/other", "--pr", "5"],
    ]) {
      const result = await capture(["pr", "ready", ...flags], null, new ScriptedSeams([]));
      expect(result.code, flags.join(" ")).toBe(2);
      expect(result.out).toEqual([]);
    }
    const help = await capture(["pr", "--help"], null);
    expect(help.out.join("\n")).toContain("nen pr ready --target <owner/name> --pr <n>");
    expect(help.out.join("\n")).toContain("Alias for --gh-repo");
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
  //
  // `--repo` names a fixture that ships no nen/gates.json, so `--reviewers` is
  // the identity source as this test intends, rather than whatever gates file
  // the process's own checkout carries -- a fact about that file, not about
  // the --json fold this test proves.
  it("--json is the SAME invocation whether given before or after 'pr' (mutation-proven fold)", async () => {
    const tokenEnv = "NEN_TEST_DEFINITELY_UNSET_TOKEN";
    delete process.env[tokenEnv];
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
    const before = await run(
      ["--json", "pr", "ready", "5", "--gh-repo", "o/r", "--reviewers", "alice", "--token-env", tokenEnv, "--repo", SHU_REPO],
      io,
    );
    const outAfter: string[] = [];
    const errAfter: string[] = [];
    const ioAfter: Io = { out: (l): void => void outAfter.push(l), err: (l): void => void errAfter.push(l) };
    const after = await run(
      ["pr", "ready", "5", "--gh-repo", "o/r", "--reviewers", "alice", "--token-env", tokenEnv, "--json", "--repo", SHU_REPO],
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

  // zheref/nen#239: a shipped file's human output is unchanged; --json gains
  // only the additive 'source' field.
  it("a shipped --requirements-from reports source { kind: shipped, path } in --json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-"));
    writeFileSync(join(dir, "body.md"), "## Summary\nok\n");
    writeFileSync(join(dir, "req.json"), JSON.stringify([{ name: "summary", pattern: "## Summary" }]));
    // A template on disk must NOT be read when a file is given.
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github", "pull_request_template.md"), "## Something else\n");
    const human = await capture(["pr", "body-check", "--body-from", "body.md", "--requirements-from", "req.json"], dir);
    expect(human.code).toBe(0);
    expect(human.out).toEqual(["1/1 requirement(s) satisfied", "ok  summary"]);
    const json = await capture(["pr", "body-check", "--body-from", "body.md", "--requirements-from", "req.json", "--json"], dir);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out.join("\n"))).toEqual({
      results: [{ name: "summary", pattern: "## Summary", satisfied: true }],
      ok: true,
      source: { kind: "shipped", path: "req.json", ref: null, commit: null },
    });
  });

  it("an explicitly EMPTY --requirements-from is still a usage refusal, never a fall-through to derivation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-"));
    writeFileSync(join(dir, "body.md"), "## Summary\n");
    writeFileSync(join(dir, "pull_request_template.md"), "## Summary\n");
    const result = await capture(["pr", "body-check", "--body-from", "body.md", "--requirements-from", ""], dir);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--requirements-from is required/);
  });
});

describe("nen pr body-check -- derived from the pull-request template (zheref/nen#239)", () => {
  function repoWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-"));
    for (const [relative, contents] of Object.entries(files)) {
      mkdirSync(join(dir, relative, ".."), { recursive: true });
      writeFileSync(join(dir, relative), contents);
    }
    return dir;
  }

  it("derives the set from the template's headings and names the source and where it was read", async () => {
    const dir = repoWith({
      ".github/PULL_REQUEST_TEMPLATE.md": "## Summary\n<!-- what -->\n\n## How to verify\n",
      "body.md": "## Summary\nA change.\n",
    });
    const result = await capture(["pr", "body-check", "--body-from", "body.md"], dir);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([
      "1/2 requirement(s) satisfied (DERIVED from the pull-request template '.github/PULL_REQUEST_TEMPLATE.md' in the working tree; no --requirements-from given)",
      "ok  ## Summary",
      "MISSING  ## How to verify",
    ]);
  });

  // N3 + N4, end to end: the untouched template is not a passing body.
  it("an untouched template as the body fails, every heading EMPTY and none MISSING", async () => {
    const template = "## Summary <!-- one line -->\n<!-- what changed -->\n\n## How to verify\n<!-- steps -->\n";
    const dir = repoWith({ ".github/pull_request_template.md": template, "body.md": template });
    const result = await capture(["pr", "body-check", "--body-from", "body.md"], dir);
    expect(result.code).toBe(1);
    expect(result.out.slice(1)).toEqual(["EMPTY  ## Summary", "EMPTY  ## How to verify"]);
    const json = await capture(["pr", "body-check", "--body-from", "body.md", "--json"], dir);
    const report = JSON.parse(json.out.join("\n")) as { results: { status: string; satisfied: boolean }[] };
    expect(report.results.map((entry) => [entry.status, entry.satisfied])).toEqual([
      ["empty", false],
      ["empty", false],
    ]);
  });

  it("--json carries source { kind: derived, path, ref: null } and exits 0 when every heading is filled", async () => {
    const dir = repoWith({
      "docs/pull_request_template.txt": "## Summary\n## Test plan\n",
      "body.md": "## Summary\nx\n## Test plan\ny\n",
    });
    const result = await capture(["pr", "body-check", "--body-from", "body.md", "--json"], dir);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as { ok: boolean; source: unknown; results: unknown[] };
    expect(report.ok).toBe(true);
    expect(report.results).toHaveLength(2);
    expect(report.source).toEqual({ kind: "derived", path: "docs/pull_request_template.txt", ref: null, commit: null });
  });

  it("reads the template under --repo, not the process directory", async () => {
    const dir = repoWith({ "PULL_REQUEST_TEMPLATE/only.md": "## Only\n", "body.md": "## Only\nyes\n" });
    const result = await capture(["pr", "body-check", "--body-from", "body.md"], dir);
    expect(result.code).toBe(0);
    expect(result.out[0]).toMatch(/DERIVED from the pull-request template 'PULL_REQUEST_TEMPLATE\/only\.md' in the working tree/);
  });

  it("no file and no template refuses at exit 2, naming the missing input and the documented bootstrap", async () => {
    const dir = repoWith({ "body.md": "## Summary\n" });
    const result = await capture(["pr", "body-check", "--body-from", "body.md"], dir);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    const err = result.err.join("\n");
    expect(err).toMatch(/no --requirements-from was given and no pull-request template was found/);
    expect(err).toMatch(/docs\/USAGE\.md, "Bootstrapping a body-check requirements file"/);
  });

  it("an ambiguous template refuses at exit 2, listing the candidates", async () => {
    const dir = repoWith({
      ".github/pull_request_template.md": "## A\n",
      "pull_request_template.md": "## B\n",
      "body.md": "## A\n",
    });
    const result = await capture(["pr", "body-check", "--body-from", "body.md"], dir);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    const err = result.err.join("\n");
    expect(err).toMatch(/ambiguous: \.github\/pull_request_template\.md, pull_request_template\.md/);
    expect(err).toMatch(/Bootstrapping a body-check requirements file/);
  });

  it("a template with no headings refuses at exit 2 rather than passing vacuously", async () => {
    const dir = repoWith({ ".github/pull_request_template.md": "Describe the change.\n", "body.md": "anything\n" });
    const result = await capture(["pr", "body-check", "--body-from", "body.md"], dir);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/'\.github\/pull_request_template\.md' in the working tree has no headings/);
  });

  // N5, through the verb: exit 2 naming the file, never exit 1.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable template exits 2 naming the file", async () => {
    const dir = repoWith({ ".github/pull_request_template.md": "## Summary\n", "body.md": "## Summary\nx\n" });
    const template = join(dir, ".github", "pull_request_template.md");
    chmodSync(template, 0o000);
    try {
      const result = await capture(["pr", "body-check", "--body-from", "body.md"], dir);
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/could not read '.*pull_request_template\.md' \(EACCES\)/);
    } finally {
      chmodSync(template, 0o644);
    }
  });

  // N6, through the verb.
  it.skipIf(process.platform === "win32")("a template symlinked outside --repo exits 2 and is never read", async () => {
    const outside = repoWith({ "secret.md": "## Secret\n" });
    const dir = repoWith({ "body.md": "## Secret\nx\n" });
    mkdirSync(join(dir, ".github"));
    symlinkSync(join(outside, "secret.md"), join(dir, ".github", "pull_request_template.md"));
    const result = await capture(["pr", "body-check", "--body-from", "body.md"], dir);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/outside the repository root/);
  });

  // B: repository-controlled text cannot forge or erase a human line.
  it("an ESC sequence in a template heading is stripped from the human lines and kept in --json", async () => {
    const dir = repoWith({ ".github/pull_request_template.md": "## Sum\u001b[2Kmary\n", "body.md": "nothing here\n" });
    const human = await capture(["pr", "body-check", "--body-from", "body.md"], dir);
    expect(human.code).toBe(1);
    expect(human.out).toEqual([
      "0/1 requirement(s) satisfied (DERIVED from the pull-request template '.github/pull_request_template.md' in the working tree; no --requirements-from given)",
      "MISSING  ## Sum[2Kmary",
    ]);
    const json = await capture(["pr", "body-check", "--body-from", "body.md", "--json"], dir);
    const report = JSON.parse(json.out.join("\n")) as { results: { name: string }[] };
    expect(report.results[0]?.name).toBe("## Sum\u001b[2Kmary");
  });

  it("a newline in an alternative template's filename cannot forge a verdict line", async (context) => {
    const dir = repoWith({ "body.md": "## Only\nx\n" });
    const folder = join(dir, ".github", "PULL_REQUEST_TEMPLATE");
    mkdirSync(folder, { recursive: true });
    const evil = "a\nok  forged.md";
    try {
      writeFileSync(join(folder, evil), "## Only\n");
    } catch {
      context.skip();
    }
    const human = await capture(["pr", "body-check", "--body-from", "body.md"], dir);
    expect(human.code).toBe(0);
    expect(human.out).toHaveLength(2);
    for (const line of human.out) expect(line).not.toMatch(/[\u0000-\u001F]/);
    expect(human.out[0]).toContain("'.github/PULL_REQUEST_TEMPLATE/aok  forged.md'");
    const json = await capture(["pr", "body-check", "--body-from", "body.md", "--json"], dir);
    expect((JSON.parse(json.out.join("\n")) as { source: { path: string } }).source.path).toBe(`.github/PULL_REQUEST_TEMPLATE/${evil}`);

    // The refusal that names it goes through the same strip.
    writeFileSync(join(folder, "b.md"), "## Only\n");
    const refused = await capture(["pr", "body-check", "--body-from", "body.md"], dir);
    expect(refused.code).toBe(2);
    for (const line of refused.err) expect(line).not.toMatch(/[\u0000-\u001F]/);
    expect(refused.err.join("\n")).toContain(".github/PULL_REQUEST_TEMPLATE/aok  forged.md, .github/PULL_REQUEST_TEMPLATE/b.md");
  });

  it("--base with --requirements-from is refused -- there is no template to read", async () => {
    const dir = repoWith({ "body.md": "x\n", "req.json": JSON.stringify([{ name: "x", pattern: "x" }]) });
    const result = await capture(["pr", "body-check", "--body-from", "body.md", "--requirements-from", "req.json", "--base", "main"], dir);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--base names the ref the pull-request template is read at/);
  });
});

// N7: --base reads the template from git at a ref, never the working tree.
// REAL git, in a throwaway repository -- no network.
describe("nen pr body-check --base <ref> (zheref/nen#239, against the real git)", () => {
  function git(dir: string, ...args: string[]): string {
    return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined },
    }).trim();
  }

  function repoAtTwoRefs(): string {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-base-"));
    git(dir, "init", "-q", "-b", "trunk");
    mkdirSync(join(dir, ".github"));
    writeFileSync(join(dir, ".github", "pull_request_template.md"), "## Summary\n## How to verify\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
    // The PR's head rewrites its own template: drops the section it skipped.
    writeFileSync(join(dir, ".github", "pull_request_template.md"), "## Summary\n");
    writeFileSync(join(dir, "body.md"), "## Summary\nA change.\n");
    return dir;
  }

  it("reads the template at the ref, not the edited working tree, and names the ref", async () => {
    const dir = repoAtTwoRefs();
    const tree = await capture(["pr", "body-check", "--body-from", "body.md"], dir, defaultSeams());
    expect(tree.code).toBe(0);
    const commit = git(dir, "rev-parse", "trunk");
    const based = await capture(["pr", "body-check", "--body-from", "body.md", "--base", "trunk"], dir, defaultSeams());
    expect(based.code).toBe(1);
    expect(based.out).toEqual([
      `1/2 requirement(s) satisfied (DERIVED from the pull-request template '.github/pull_request_template.md' at trunk (${commit.slice(0, 7)}); no --requirements-from given)`,
      "ok  ## Summary",
      "MISSING  ## How to verify",
    ]);
    const json = await capture(["pr", "body-check", "--body-from", "body.md", "--base", "trunk", "--json"], dir, defaultSeams());
    expect((JSON.parse(json.out.join("\n")) as { source: unknown }).source).toEqual({
      kind: "derived",
      path: ".github/pull_request_template.md",
      ref: "trunk",
      commit,
    });
  });

  it("a template only in the working tree is not found at the ref", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-base-"));
    git(dir, "init", "-q", "-b", "trunk");
    writeFileSync(join(dir, "README.md"), "x\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, "pull_request_template.md"), "## Summary\n");
    writeFileSync(join(dir, "body.md"), "## Summary\nx\n");
    const result = await capture(["pr", "body-check", "--body-from", "body.md", "--base", "trunk"], dir, defaultSeams());
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/no pull-request template was found under '.*' at trunk/);
  });

  // R7: refused by name, never "none found".
  it("a symlinked template at the ref is refused by name, never followed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-base-"));
    git(dir, "init", "-q", "-b", "trunk");
    writeFileSync(join(dir, "real.md"), "## Real\n");
    symlinkSync("real.md", join(dir, "pull_request_template.md"));
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "base");
    writeFileSync(join(dir, "body.md"), "## Real\nx\n");
    const result = await capture(["pr", "body-check", "--body-from", "body.md", "--base", "trunk"], dir, defaultSeams());
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/the pull-request template 'pull_request_template\.md' is a symlink at trunk/);
  });

  // R1: a range is not a ref -- its tip must not be read as the base.
  it("a range given as --base exits 2", async () => {
    // `trunk..feat` names feat's own commit as its tip -- the head's edited
    // template, which a range must never smuggle in as the base.
    const dir = repoAtTwoRefs();
    git(dir, "checkout", "-q", "-b", "feat");
    git(dir, "commit", "-q", "-am", "head drops a section");
    const result = await capture(["pr", "body-check", "--body-from", "body.md", "--base", "trunk..feat"], dir, defaultSeams());
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/--base 'trunk\.\.feat' does not resolve to a single commit/);
  });

  // R2: an inherited GIT_DIR must not redirect the read to another repository.
  it("an inherited GIT_DIR naming another repository is ignored", async () => {
    const dir = repoAtTwoRefs();
    const other = mkdtempSync(join(tmpdir(), "nen-pr-other-"));
    git(other, "init", "-q", "-b", "trunk");
    writeFileSync(join(other, "pull_request_template.md"), "## Summary\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "other");
    const saved = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = join(other, ".git");
    try {
      const result = await capture(["pr", "body-check", "--body-from", "body.md", "--base", "trunk"], dir, defaultSeams());
      // Our base's template has two sections; the other repository's has one
      // that this body fills. Reading the other one would exit 0.
      expect(result.code).toBe(1);
      expect(result.out[0]).toMatch(/'\.github\/pull_request_template\.md' at trunk/);
    } finally {
      if (saved === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved;
    }
  });

  it("an unresolvable ref exits 2", async () => {
    const dir = repoAtTwoRefs();
    const result = await capture(["pr", "body-check", "--body-from", "body.md", "--base", "no-such-ref"], dir, defaultSeams());
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--base 'no-such-ref' does not resolve to a single commit/);
  });

  it("a ref beginning with '-' is refused before git sees it", async () => {
    const dir = repoAtTwoRefs();
    const result = await capture(["pr", "body-check", "--body-from", "body.md", "--base=--output=x"], dir, new ScriptedSeams([]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/A ref beginning with '-' would be read as an option/);
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
    function greenAltApprovedScript(baseSha = "", defaultSha = baseSha): readonly ScriptedCall[] {
      const view = {
        number: 9,
        headRefOid: "abc123",
        baseRefOid: baseSha,
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
        { match: `gh ${gateRefsArgv(TARGET, 9).join(" ")}`, result: { stdout: JSON.stringify({ data: { repository: { pullRequest: { baseRefOid: baseSha, headRefOid: "abc123" }, defaultBranchRef: { target: { oid: defaultSha } } } } }) } },
        ...[...new Set([baseSha, defaultSha])].filter((sha) => sha !== "").map((sha) => ({ match: `gh ${commitArgv(TARGET, sha).join(" ")}`, result: { stdout: "{}" } })),
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
      // Exit 2, as `pr ready` (zheref/nen#310, N2): a refused identity file is
      // a usage error, never a blocker. It was 1 before.
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/no such file/);
      expect(result.err.join("\n")).toMatch(/nen\/gates\.json/);
    });

    it("a gates file carrying a key this build does not read is exit 2, before any gh call (zheref/nen#310)", async () => {
      const checkout = mkdtempSync(join(tmpdir(), "nen-frozen-"));
      const gates = JSON.parse(readFileSync(join(ALT_REPO, "nen", "gates.json"), "utf8")) as Record<string, unknown>;
      gates["round_quorom"] = { any_of: ["itachi"], minimum: 1 };
      const localGates = join(checkout, "gates.json");
      writeFileSync(localGates, JSON.stringify(gates));
      for (const argv of [
        ["pr", "next-blocker", "--target", "o/n", "--pr", "9", "--gates", localGates],
        ["pr", "next-blocker", "--target", "o/n", "--pr", "9", "--gates", localGates, "--json"],
      ]) {
        const result = await capture(argv, checkout, new ScriptedSeams([]));
        expect(result.code).toBe(2);
        expect(result.out).toEqual([]);
        expect(result.err.join("\n")).toContain("carries 'round_quorom', which this build does not read");
      }
      // The same refusal through the checkout's own nen/gates.json (no --gates).
      mkdirSync(join(checkout, "nen"));
      writeFileSync(join(checkout, "nen", "gates.json"), JSON.stringify(gates));
      const own = await capture(["pr", "next-blocker", "--target", "o/n", "--pr", "9"], checkout, new ScriptedSeams([]));
      expect(own.code).toBe(2);
      expect(own.err.join("\n")).toContain("'round_quorom' -> 'round_quorum'?");
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
        const [view, ...rest] = greenAltApprovedScript("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        const viewJson = JSON.parse(String(view?.result.stdout)) as Record<string, unknown>;
        const withRed = {
          ...viewJson,
          baseRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          statusCheckRollup: [
            ...(viewJson["statusCheckRollup"] as unknown[]),
            { __typename: "CheckRun", name: WINDOWS, status: "COMPLETED", conclusion: "FAILURE" },
          ],
        };
        const contents: ScriptedCall =
          atBase === null
            ? { match: "gh api --method GET repos/o/n/contents/nen/gates.json?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", result: { code: 1, stderr: "HTTP 404" } }
            : {
                match: "gh api --method GET repos/o/n/contents/nen/gates.json?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
        "  warning: declared exclusion 'check (Windows*' NOT honoured: the complete declaration is not authorised by the pull request's base (o/n@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:nen/gates.json) and the default-branch tip (o/n@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:nen/gates.json). Both pinned sources must declare the same match, name, reason, ruled and until.",
      );
    });

    it.each(["base-only", "default-only", "shared", "failed-default", "missing-default"])("next-blocker intersects immutable gate refs: %s", async (scenario) => {
      const alt = JSON.parse(readFileSync(join(ALT_REPO, "nen", "gates.json"), "utf8")) as Record<string, unknown>;
      const ruling = { name: "ci / red", reason: "ruled out", ruled: "2020-01-01", until: "2099-12-31" };
      const [view, ...rest] = greenAltApprovedScript("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", scenario === "missing-default" ? "" : "dddddddddddddddddddddddddddddddddddddddd");
      const body = JSON.parse(String(view?.result.stdout)) as Record<string, unknown>;
      const content = (sha: string, entries: readonly unknown[]): ScriptedCall => ({
        match: `gh ${gatesAtArgv(TARGET, sha).join(" ")}`,
        result: { stdout: JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(JSON.stringify({ ...alt, checks: { excluded: entries } })).toString("base64") }) },
      });
      const seams = new ScriptedSeams([
        { match: view?.match ?? "", result: { stdout: JSON.stringify({ ...body, baseRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "ci / red", status: "COMPLETED", conclusion: "FAILURE" }] }) } },
        ...rest,
        content("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", scenario === "default-only" ? [] : [ruling]),
        scenario === "failed-default" ? { match: `gh ${gatesAtArgv(TARGET, "dddddddddddddddddddddddddddddddddddddddd").join(" ")}`, result: { code: 1, stderr: "HTTP 403" } } : content("dddddddddddddddddddddddddddddddddddddddd", scenario === "base-only" ? [] : [ruling]),
      ]);
      const checkout = mkdtempSync(join(tmpdir(), "nen-403-"));
      const result = await capture(["pr", "next-blocker", "--target", "o/n", "--pr", "9", "--gates", join(ALT_REPO, "nen", "gates.json"), "--json"], checkout, seams);
      const parsed = JSON.parse(result.out.join("\n")) as { kind: string; warnings: string[]; declaredExclusionsSource: string };
      expect(parsed.kind).toBe(scenario === "shared" ? "none" : "red-check");
      expect(parsed.declaredExclusionsSource).toContain("o/n@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:nen/gates.json and o/n@");
      if (scenario !== "shared") expect(parsed.warnings.join("\n")).toContain(scenario === "default-only" ? "pull request's base" : "default-branch tip");
      expect(seams.calls.filter((call) => call.args.some((arg) => arg.includes("contents/nen/gates.json?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")))).toHaveLength(1);
    });

    it.each(["base", "head", "missing-head", "unknown-original-base"])("a %s policy-snapshot drift cannot clear the original red check", async (drift) => {
      const first = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const later = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const tip = "dddddddddddddddddddddddddddddddddddddddd";
      const alt = JSON.parse(readFileSync(join(ALT_REPO, "nen", "gates.json"), "utf8")) as Record<string, unknown>;
      const ruling = { name: "ci / red", reason: "ruled out", ruled: "2020-01-01", until: "2099-12-31" };
      const calls = greenAltApprovedScript(first, tip).map((call): ScriptedCall => {
        if (call.match === `gh ${viewArgv(TARGET, 9).join(" ")}`) {
          const view = JSON.parse(String(call.result.stdout)) as Record<string, unknown>;
          return { ...call, result: { stdout: JSON.stringify({ ...view, baseRefOid: drift === "unknown-original-base" ? "older-view" : first,
            statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }, { name: "ci / red", status: "COMPLETED", conclusion: "FAILURE" }] }) } };
        }
        if (call.match === `gh ${gateRefsArgv(TARGET, 9).join(" ")}`) return { ...call, result: { stdout: JSON.stringify({ data: { repository: {
          pullRequest: { baseRefOid: drift === "base" ? later : first, ...(drift === "missing-head" ? {} : { headRefOid: drift === "head" ? "new-head" : "abc123" }) },
          defaultBranchRef: { target: { oid: tip } },
        } } }) } };
        return call;
      });
      const contents = [first, later, tip].map((sha): ScriptedCall => ({ match: `gh ${gatesAtArgv(TARGET, sha).join(" ")}`,
        result: { stdout: JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(JSON.stringify({ ...alt, checks: { excluded: [ruling] } })).toString("base64") }) } }));
      const seams = new ScriptedSeams([...calls, { match: `gh ${commitArgv(TARGET, later).join(" ")}`, result: { stdout: "{}" } }, ...contents]);
      const checkout = mkdtempSync(join(tmpdir(), "nen-403-drift-"));
      const result = await capture(["pr", "next-blocker", "--target", "o/n", "--pr", "9", "--gates", join(ALT_REPO, "nen", "gates.json"), "--json"], checkout, seams);
      const parsed = JSON.parse(result.out.join("\n")) as { kind: string; warnings: string[]; notes: string[] };
      expect(result.code).toBe(1);
      expect(parsed.kind).toBe("red-check");
      expect([...parsed.warnings, ...parsed.notes].join("\n")).toMatch(/snapshot.*(changed|unconfirmed)/);
      expect(seams.calls.some((call) => call.args.some((arg) => arg.includes(`contents/nen/gates.json?ref=${later}`)))).toBe(false);
      expect(seams.calls.some((call) => call.args.some((arg) => arg.includes(`contents/nen/gates.json?ref=${tip}`)))).toBe(false);
    });

    it.each(["base drift", "unreadable refs"])("policy-snapshot %s cannot replace the original base's reviewer identities", async (change) => {
      const first = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const later = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
      const calls = greenAltApprovedScript(first, later).map((call): ScriptedCall => call.match !== `gh ${gateRefsArgv(TARGET, 9).join(" ")}` ? call : {
        ...call, result: change === "unreadable refs" ? { code: 1, stderr: "HTTP 403 while reading policy refs" } : { stdout: JSON.stringify({ data: { repository: { pullRequest: { baseRefOid: later, headRefOid: "abc123" }, defaultBranchRef: { target: { oid: later } } } } }) },
      });
      const contents = [[first, BANKAI_REPO], [later, ALT_REPO]].map(([sha, fixture]): ScriptedCall => ({
        match: `gh ${gatesAtArgv(TARGET, sha ?? "").join(" ")}`,
        result: { stdout: JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(readFileSync(join(fixture ?? "", "nen", "gates.json"), "utf8")).toString("base64") }) },
      }));
      const seams = new ScriptedSeams([...calls, ...contents]);
      const checkout = mkdtempSync(join(tmpdir(), "nen-403-identities-"));
      mkdirSync(join(checkout, "nen"));
      copyFileSync(join(ALT_REPO, "nen", "gates.json"), join(checkout, "nen", "gates.json"));
      const result = await capture(["pr", "next-blocker", "--target", "o/n", "--pr", "9", "--json"], checkout, seams);
      const parsed = JSON.parse(result.out.join("\n")) as { kind: string; identities: { path: string; read: string } };
      expect(result.code).toBe(1);
      expect(parsed.kind).toBe("owed-round");
      expect(parsed.identities).toEqual({ path: `o/n@${first}:nen/gates.json`, read: "base" });
      expect(seams.calls.some((call) => call.args.some((arg) => arg.includes(`contents/nen/gates.json?ref=${later}`)))).toBe(false);
    });

    it.each([
      { code: 1, stderr: "HTTP 403 while reading refs" },
      { stdout: "not JSON" },
      { stdout: JSON.stringify({ errors: [{ message: "not readable" }] }) },
    ])("a failed policy snapshot authorises no exclusion and names its failure", async (answer) => {
      const script = greenAltApprovedScript();
      const calls = script.map((call): ScriptedCall => {
        if (call.match === `gh ${gateRefsArgv(TARGET, 9).join(" ")}`) return { ...call, result: answer };
        if (call.match === `gh ${viewArgv(TARGET, 9).join(" ")}`) {
          const view = JSON.parse(String(call.result.stdout)) as Record<string, unknown>;
          return { ...call, result: { stdout: JSON.stringify({ ...view, statusCheckRollup: [{ name: "ci / red", status: "COMPLETED", conclusion: "FAILURE" }] }) } };
        }
        return call;
      });
      const seams = new ScriptedSeams(calls);
      const result = await capture(["pr", "next-blocker", "--target", "o/n", "--pr", "9", "--gates", join(ALT_REPO, "nen", "gates.json"), "--json"], mkdtempSync(join(tmpdir(), "nen-403-")), seams);
      const parsed = JSON.parse(result.out.join("\n")) as { kind: string; notes: string[] };
      expect(parsed.kind).toBe("red-check");
      expect(parsed.notes.join("\n")).toMatch(/pinned gate.ref/);
      expect(seams.calls.some((call) => call.args.some((arg) => arg.includes("contents/")))).toBe(false);
    });

    it("control characters in labels and declared text are stripped from rendered lines, kept in --json (Copilot on #359)", async () => {
      const EVIL = "check (Windows\u001b[2J\r\nfake: none";
      const altGates = JSON.parse(readFileSync(join(ALT_REPO, "nen", "gates.json"), "utf8")) as Record<string, unknown>;
      const ruling = { name: "check (Windows*", match: "glob", reason: "no\u001b[31m\r\nrunner", ruled: "2020-01-01", until: "2099-12-31" };
      const script = (): ScriptedCall[] => {
        const [view, ...rest] = greenAltApprovedScript("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        const viewJson = JSON.parse(String(view?.result.stdout)) as Record<string, unknown>;
        const withRed = {
          ...viewJson,
          baseRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
            match: "gh api --method GET repos/o/n/contents/nen/gates.json?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
        const [view, ...rest] = greenAltApprovedScript("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        const viewJson = JSON.parse(String(view?.result.stdout)) as Record<string, unknown>;
        const withRed = {
          ...viewJson,
          baseRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          statusCheckRollup: [
            ...(viewJson["statusCheckRollup"] as unknown[]),
            { __typename: "CheckRun", name: WINDOWS, status: "COMPLETED", conclusion: "FAILURE" },
          ],
        };
        return [
          { match: view?.match ?? "", result: { stdout: JSON.stringify(withRed) } },
          ...rest,
          {
            match: "gh api --method GET repos/o/n/contents/nen/gates.json?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
      expect(plain.out.some((line): boolean => /^ {2}warning: declared check exclusions NOT honoured: the pull request's base could not be read \(.*HTTP 403/.test(line))).toBe(true);
      const json = await capture(
        ["pr", "next-blocker", "--target", "o/n", "--pr", "9", "--gates", localGates, "--json"],
        checkout,
        new ScriptedSeams(script()),
      );
      const parsed = JSON.parse(json.out.join("\n")) as { kind: string; warnings: string[]; notes: string[] };
      expect(parsed.kind).toBe("red-check");
      expect(parsed.warnings.join("\n")).toMatch(/NOT honoured: the pull request's base could not be read[\s\S]*HTTP 403/);
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

    // zheref/nen#372: without --gates, the reviewer identities come from the
    // BASE as well -- the checkout's own file, in a worktree the PR's head,
    // cannot name its own reviewers. The same snapshot as above: alt's
    // reviewers approved, bankai's are owed.
    it("without --gates, reads the reviewer identities at the BASE: a head carrying its own reviewer set does not clear its round, and a base with none is refused", async () => {
      const altGates = readFileSync(join(ALT_REPO, "nen", "gates.json"), "utf8");
      const bankaiGates = readFileSync(join(BANKAI_REPO, "nen", "gates.json"), "utf8");
      const checkout = mkdtempSync(join(tmpdir(), "nen-372-"));
      mkdirSync(join(checkout, "nen"));
      writeFileSync(join(checkout, "nen", "gates.json"), altGates);
      const script = (atBase: string | null): ScriptedCall[] => {
        const [view, ...rest] = greenAltApprovedScript("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        const viewJson = JSON.parse(String(view?.result.stdout)) as Record<string, unknown>;
        const contents: ScriptedCall =
          atBase === null
            ? { match: "gh api --method GET repos/o/n/contents/nen/gates.json?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", result: { code: 1, stderr: "HTTP 404" } }
            : {
                match: "gh api --method GET repos/o/n/contents/nen/gates.json?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                result: { stdout: JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(atBase).toString("base64") }) },
              };
        return [{ match: view?.match ?? "", result: { stdout: JSON.stringify({ ...viewJson, baseRefOid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }) } }, ...rest, contents];
      };
      const argv = ["pr", "next-blocker", "--target", "o/n", "--pr", "9"];
      const atBase = await capture(argv, checkout, new ScriptedSeams(script(bankaiGates)));
      expect(atBase.code).toBe(1);
      expect(atBase.out[0]).toBe("#9: owed-round");
      expect(atBase.out.join("\n")).toMatch(/sasuke/);
      expect(atBase.out.join("\n")).not.toMatch(/warning: gate inputs read from the LOCAL/);
      // --json says where the identities came from (Feitan 5).
      const json = await capture([...argv, "--json"], checkout, new ScriptedSeams(script(bankaiGates)));
      const parsed = JSON.parse(json.out.join("\n")) as { kind: string; identities: { path: string; read: string } };
      expect(parsed.kind).toBe("owed-round");
      expect(parsed.identities).toEqual({ path: "o/n@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:nen/gates.json", read: "base" });
      // --gates naming the checkout's OWN file is the head's: read at the base too (Nobunaga 10).
      const own = await capture([...argv, "--gates", "nen/gates.json"], checkout, new ScriptedSeams(script(bankaiGates)));
      expect(own.out[0]).toBe("#9: owed-round");
      expect(own.out.join("\n")).not.toMatch(/warning: gate inputs read from the LOCAL/);
      // The base declaring NONE never applies the checkout's file: a refusal, exit 2 (Feitan 1).
      const absent = await capture(argv, checkout, new ScriptedSeams(script(null)));
      expect(absent.code).toBe(2);
      expect(absent.out).toEqual([]);
      expect(absent.err.join("\n")).toMatch(
        /no gate to apply: the pull request's base \(o\/n@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:nen\/gates\.json\) declares no nen\/gates\.json/,
      );
      // A base file this build refuses: a refusal too, never the checkout's file (Feitan 2).
      const refused = await capture(argv, checkout, new ScriptedSeams(script("{ not json")));
      expect(refused.code).toBe(2);
      expect(refused.err.join("\n")).toMatch(/no gate to apply: this nen cannot read the gate the pull request's base declares/);
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
  const NO_KNOWN_BOTS = { stdout: JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main", target: { oid: "BASE1" } }, pullRequest: { id: "PR_1", baseRefOid: "BASE1", reviewRequests: { nodes: [] }, timelineItems: { nodes: [] } } } } }) };
  const KNOWN_BOT_COPILOT = {
    stdout: JSON.stringify({
      data: {
        repository: {
          defaultBranchRef: { name: "main", target: { oid: "BASE1" } },
          pullRequest: {
            id: "PR_1",
            baseRefOid: "BASE1",
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
  // zheref/nen#240: every bot request first reads round_policy.maxRounds from
  // nen/gates.json at the pull request's base. These cases are about routing,
  // so the base carries no gates file -- no ceiling, the verb's old behaviour.
  // The base and the default branch share BASE1 here, so one commit is read.
  const COMMIT_OK = (sha: string): ScriptedCall => ({
    match: `gh ${commitArgv(KNOWN_BOTS_TARGET, sha).join(" ")}`,
    result: { stdout: JSON.stringify({ sha }) },
  });
  const NO_BASE_GATES: readonly ScriptedCall[] = [
    COMMIT_OK("BASE1"),
    { match: `gh ${gatesAtArgv(KNOWN_BOTS_TARGET, "BASE1").join(" ")}`, result: { code: 1, stderr: "gh: Not Found (HTTP 404)" } },
  ];
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
      ...NO_BASE_GATES,
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
      ...NO_BASE_GATES,
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
      ...NO_BASE_GATES,
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
      ...NO_BASE_GATES,
      { match: `gh ${collaboratorArgv(KNOWN_BOTS_TARGET, "ghost").join(" ")}`, result: COLLABORATOR_NONE },
      { match: `gh ${botLoginArgv("ghost").join(" ")}`, result: { code: 1, stderr: "gh: Not Found (HTTP 404)" } },
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
      ...NO_BASE_GATES,
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
      ...NO_BASE_GATES,
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
      ...NO_BASE_GATES,
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
      ...NO_BASE_GATES,
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
      ...NO_BASE_GATES,
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
      ...NO_BASE_GATES,
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

  // ── the round ceiling, round_policy.maxRounds (zheref/nen#240) ───────────
  //
  // Read from nen/gates.json AT THE BASE (BASE1 here), counted off the
  // timeline's review_requested events for the bot by node id.
  const gatesFile = (sha: string, text: string): ScriptedCall => ({
    match: `gh ${gatesAtArgv(KNOWN_BOTS_TARGET, sha).join(" ")}`,
    result: { stdout: JSON.stringify({ type: "file", encoding: "base64", content: Buffer.from(text).toString("base64") }) },
  });
  const gatesAtBase = (gates: unknown, sha = "BASE1"): readonly ScriptedCall[] => [
    COMMIT_OK(sha),
    gatesFile(sha, JSON.stringify(gates)),
  ];
  // The canonical login of an --add-bots id (N5): one nodes(ids:) read.
  const botNode = (id: string, login: string): ScriptedCall => ({
    match: `gh ${botNodesArgv([id]).join(" ")}`,
    result: { stdout: JSON.stringify({ data: { nodes: [{ __typename: "Bot", id, login }] } }) },
  });
  const CEILING_3 = gatesAtBase({ version: 1, round_policy: { minRounds: 1, maxRounds: 3 } });
  const timelineWith = (requests: number, id = "BOT_1"): ScriptedCall => ({
    match: `gh ${requestTimelineArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`,
    result: {
      stdout: JSON.stringify([
        Array.from({ length: requests }, (): unknown => ({
          event: "review_requested",
          requested_reviewer: { login: "Copilot", node_id: id },
        })),
        // Another bot's request and a team's count toward nobody here.
        [
          { event: "review_requested", requested_reviewer: { login: "other", node_id: "BOT_9" } },
          { event: "review_requested", requested_team: { slug: "acme" } },
        ],
      ]),
    },
  });

  const restCopilot: ScriptedCall = {
    match: `gh ${botLoginArgv("copilot").join(" ")}`,
    result: { stdout: JSON.stringify({ type: "Bot", login: "Copilot", node_id: "BOT_live" }) },
  };

  it.each(["copilot", "copilot-pull-request-reviewer", "copilot-pull-request-reviewer[bot]"])("--add-bots resolves unseen %s before its mutation (#160)", async (login) => {
    const seams = new ScriptedSeams([
      restCopilot,
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      ...NO_BASE_GATES,
      { match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_live"]).join(" ")}`, result: botMutationOk(["copilot-pull-request-reviewer"], ["BOT_live"]) },
    ]);
    const result = await capture(["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", login, "--json"], null, seams);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n")).routing).toEqual([{ name: login, via: "add-bots", route: "bot", id: "BOT_live" }]);
    expect(seams.calls[0]?.args).toEqual(botLoginArgv(login));
  });

  it.each(["copilot", "copilot-pull-request-reviewer", "copilot-pull-request-reviewer[bot]"])("--add-reviewers resolves unseen %s as a Bot (#160)", async (login) => {
    const seams = new ScriptedSeams([
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      { match: `gh ${collaboratorArgv(KNOWN_BOTS_TARGET, login).join(" ")}`, result: COLLABORATOR_NONE },
      restCopilot,
      ...NO_BASE_GATES,
      { match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_live"]).join(" ")}`, result: botMutationOk(["copilot-pull-request-reviewer"], ["BOT_live"]) },
    ]);
    const result = await capture(["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", login, "--json"], null, seams);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n")).routing).toEqual([{ name: login, via: "add-reviewers", route: "bot", id: "BOT_live" }]);
  });

  it.each([
    "U_123", "PR_123", "ANYTHING_not-a-bot", "BOT_", "BOT_bad!", "BOT_a=b", "BOT_a/", "BOT_a b",
    Buffer.from("04:User123").toString("base64"), Buffer.from("03:Bot").toString("base64"),
    Buffer.from("03:Bot1extra").toString("base64"), Buffer.from("03:Bot1\n").toString("base64"),
    Buffer.from("03:Bot1").toString("base64").slice(0, -1), Buffer.from("03:Bot1").toString("base64").replace("MQ==", "MR=="),
  ])("preflights invalid explicit Bot identity %s before any mixed-batch GitHub read", async (id) => {
    for (const dryRun of [false, true]) {
      const seams = new ScriptedSeams([]);
      const result = await capture(["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "sasuke,org/team", "--add-bots", `copilot,${id}`, ...(dryRun ? ["--dry-run"] : []), "--json"], null, seams);
      expect(result.code).toBe(2); expect(result.err.join("\n")).toContain("not a valid Bot node id or bot login");
      expect(seams.calls).toEqual([]); expect(result.out).toEqual([]);
    }
  });

  it.each(["BOT_a-b_C9", Buffer.from("03:Bot1").toString("base64")])("preserves valid explicit Bot identity %s in dry-run routing", async (id) => {
    const seams = new ScriptedSeams([
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      ...NO_BASE_GATES,
    ]);
    const result = await capture(["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", id, "--dry-run", "--json"], null, seams);
    expect(result.code).toBe(0); expect(JSON.parse(result.out.join("\n")).routing).toEqual([{ name: id, via: "add-bots", route: "bot", id }]);
    expect(seams.calls.some((call) => call.args.some((arg) => arg.startsWith("query=mutation")))).toBe(false);
  });

  it.each(["--add-bots", "--add-reviewers"])("refuses malformed REST Bot ids on %s without subsequent reads or mutation", async (flag) => {
    for (const id of ["U_not_a_bot", "BOT_", "not-an-id", Buffer.from("04:User123").toString("base64")]) {
      const seams = new ScriptedSeams([
        ...(flag === "--add-reviewers" ? [{ match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS }] : []),
        { match: `gh ${botLoginArgv("copilot").join(" ")}`, result: { stdout: JSON.stringify({ type: "Bot", login: "Copilot", node_id: id }) } },
      ]);
      const result = await capture(["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", flag, "copilot", "--dry-run", "--json"], null, seams);
      expect(result.code).toBe(1); expect(result.err.join("\n")).toContain("GitHub did not return the requested Bot");
      expect(result.out).toEqual([]); expect(seams.calls).toHaveLength(flag === "--add-reviewers" ? 2 : 1);
    }
  });

  it("deduplicates a bot login and its explicit id into one mutation (#160)", async () => {
    const seams = new ScriptedSeams([
      restCopilot,
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      ...NO_BASE_GATES,
      { match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_live"]).join(" ")}`, result: botMutationOk(["copilot-pull-request-reviewer"], ["BOT_live"]) },
    ]);
    const result = await capture(["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "copilot,BOT_live"], null, seams);
    expect(result.code).toBe(0);
    expect(seams.calls.filter((call) => call.args.some((arg) => arg.startsWith("query=mutation")))).toHaveLength(1);
  });

  it("refuses an unknown --add-bots login before any mutation (#160)", async () => {
    const seams = new ScriptedSeams([{ match: "gh api --method GET users/missing%5Bbot%5D", result: { code: 1, stderr: "HTTP 404" } }]);
    const result = await capture(["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "missing"], null, seams);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("'missing' did not resolve to a Bot login");
  });

  it("previews mixed user, alias and explicit Bot id routes without any mutation (#160)", async () => {
    const seams = new ScriptedSeams([
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      { match: `gh ${collaboratorArgv(KNOWN_BOTS_TARGET, "sasuke").join(" ")}`, result: collaboratorFound("sasuke", "U_1") },
      restCopilot,
      ...CEILING_3,
      timelineWith(1, "BOT_live"),
    ]);
    const result = await capture(["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "sasuke", "--add-bots", "copilot,BOT_live", "--dry-run", "--json"], null, seams);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n"));
    expect(report.dryRun).toBe(true);
    expect(report.message).toContain("copilot -> bot (id BOT_live) [add-bots]");
    expect(report.routing).toEqual([
      { name: "sasuke", via: "add-reviewers", route: "user", id: null },
      { name: "copilot", via: "add-bots", route: "bot", id: "BOT_live" },
      { name: "BOT_live", via: "add-bots", route: "bot", id: "BOT_live" },
    ]);
    expect(report.rounds).toEqual([{ id: "BOT_live", login: "copilot-pull-request-reviewer", requested: 1, next: 2, maxRounds: 3, refused: false }]);
  });

  it.each(["--add-bots", "--add-reviewers"])("keeps canonical-login ceiling fallback when %s receives an alias (#160)", async (flag) => {
    const seams = new ScriptedSeams([
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      restCopilot,
      ...CEILING_3,
      { match: `gh ${requestTimelineArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: { stdout: JSON.stringify([Array.from({ length: 3 }, () => ({ event: "review_requested", requested_reviewer: { type: "Bot", login: "copilot-pull-request-reviewer", node_id: "BOT_old" } }))]) } },
    ]);
    const result = await capture(["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", flag, "copilot", "--json"], null, seams);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.out.join("\n")).rounds[0]).toMatchObject({ requested: 3, next: 4, refused: true });
  });

  it.each([
    { code: 1, stderr: "HTTP 403 forbidden" },
    { stdout: JSON.stringify({ type: "User", login: "Copilot", node_id: "U_1" }) },
  ])("fails bot resolution before requesting an accompanying user %#", async (result) => {
    const seams = new ScriptedSeams([
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      { match: `gh ${collaboratorArgv(KNOWN_BOTS_TARGET, "sasuke").join(" ")}`, result: collaboratorFound("sasuke", "U_1") },
      { match: `gh ${botLoginArgv("copilot").join(" ")}`, result },
    ]);
    const response = await capture(["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "sasuke", "--add-bots", "copilot"], null, seams);
    expect(response.code).toBe(1);
  });

  it("refuses the (M+1)th request for a bot at exit 2, naming the count and the ceiling, and requests nothing", async () => {
    // No mutation is scripted: were it called, the scripted seam would throw.
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: KNOWN_BOT_COPILOT },
      ...CEILING_3,
      timelineWith(3),
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "copilot-pull-request-reviewer"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(2);
    const out = result.out.join("\n");
    expect(out).toContain(
      "refused: copilot-pull-request-reviewer (BOT_1) has been requested 3 times, so this would be request 4 of 3 on zheref/nen#9, past the round_policy.maxRounds ceiling declared in zheref/nen@BASE1:nen/gates.json. Nothing was requested.",
    );
  });

  it("the request inside the ceiling goes through and says which request of M it was", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: KNOWN_BOT_COPILOT },
      ...CEILING_3,
      timelineWith(2),
      { match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_1"]).join(" ")}`, result: botMutationOk(["copilot-pull-request-reviewer"]) },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "copilot-pull-request-reviewer", "--json"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as { ok: boolean; message: string; ceiling: unknown; rounds: unknown };
    expect(report.ok).toBe(true);
    expect(report.message).toContain("copilot-pull-request-reviewer (BOT_1): request 3 of 3");
    expect(report.ceiling).toEqual({ maxRounds: 3, source: "zheref/nen@BASE1:nen/gates.json" });
    expect(report.rounds).toEqual([
      { id: "BOT_1", login: "copilot-pull-request-reviewer", requested: 2, next: 3, maxRounds: 3, refused: false },
    ]);
  });

  it("--dry-run prints 'request N of M' and requests nothing", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      ...CEILING_3,
      botNode("BOT_kgDOCnlnWA", "copilot-pull-request-reviewer"),
      timelineWith(1, "BOT_kgDOCnlnWA"),
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "BOT_kgDOCnlnWA", "--dry-run"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain(
      "  copilot-pull-request-reviewer (BOT_kgDOCnlnWA): request 2 of 3 (round_policy.maxRounds, zheref/nen@BASE1:nen/gates.json)",
    );
  });

  it("--dry-run past the ceiling previews the refusal at exit 2", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      ...CEILING_3,
      botNode("BOT_kgDOCnlnWA", "copilot-pull-request-reviewer"),
      timelineWith(3, "BOT_kgDOCnlnWA"),
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "BOT_kgDOCnlnWA", "--dry-run", "--json"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(2);
    const report = JSON.parse(result.out.join("\n")) as { ok: boolean; dryRun: boolean; message: string };
    expect(report.ok).toBe(false);
    expect(report.dryRun).toBe(true);
    expect(report.message).toMatch(/^refused: copilot-pull-request-reviewer \(BOT_kgDOCnlnWA\) has been requested 3 times/);
  });

  it("refuses the WHOLE call -- the user route too -- when any bot is past the ceiling", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      { match: `gh ${collaboratorArgv(KNOWN_BOTS_TARGET, "sasuke").join(" ")}`, result: collaboratorFound("sasuke", "U_1") },
      ...gatesAtBase({ version: 1, round_policy: { maxRounds: 0 } }),
      botNode("BOT_kgDOCnlnWA", "copilot-pull-request-reviewer"),
      timelineWith(0, "BOT_kgDOCnlnWA"),
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "sasuke", "--add-bots", "BOT_kgDOCnlnWA"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(2);
    expect(result.out.join("\n")).toContain("so this would be request 1 of 0");
  });

  it("a base file stating no maxRounds declares no ceiling: no timeline read, the request goes through", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      ...gatesAtBase({ version: 1, round_policy: { stallMinutes: 30 } }),
      { match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_2"]).join(" ")}`, result: botMutationOk(["some-other-bot"], ["BOT_2"]) },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "BOT_2", "--json"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as { ceiling: unknown; rounds: unknown };
    expect(report.ceiling).toBeNull();
    expect(report.rounds).toEqual([]);
  });

  it("an unreadable timeline under a declared ceiling refuses at exit 1: a ceiling it cannot check is never 'no ceiling'", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      ...CEILING_3,
      botNode("BOT_2", "some-other-bot"),
      { match: `gh ${requestTimelineArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: { code: 1, stderr: "HTTP 502" } },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "BOT_2"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/could not read zheref\/nen#9's timeline: HTTP 502.*Nothing was requested/);
  });

  it("a base file that does not validate refuses at exit 1, naming the pointer -- a misspelt ceiling included", async () => {
    for (const [gates, pattern] of [
      [{ version: 1, round_policy: { maxRound: 3 } }, /'maxRound' -> 'maxRounds'\?/],
      [{ version: 1, round_policy: { maxRounds: -1 } }, /at round_policy\.maxRounds, expected a non-negative integer/],
      [{ version: 1, round_policy: { minRounds: 4, maxRounds: 3 } }, /above round_policy\.maxRounds \(3\)/],
    ] as const) {
      const script: readonly ScriptedCall[] = [
        { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
        ...gatesAtBase(gates),
      ];
      const result = await capture(
        ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "BOT_2"],
        null,
        new ScriptedSeams(script),
      );
      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(pattern);
      expect(result.out.join("\n")).toContain("Nothing was requested");
    }
  });

  it("a base that cannot be read refuses the bot request at exit 1", async () => {
    const noBase = {
      stdout: JSON.stringify({
        data: {
          repository: {
            defaultBranchRef: { name: "main", target: { oid: "MAIN1" } },
            pullRequest: { id: "PR_1", reviewRequests: { nodes: [] }, timelineItems: { nodes: [] } },
          },
        },
      }),
    };
    const script: readonly ScriptedCall[] = [{ match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: noBase }];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "BOT_2"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toContain("GitHub answered no commit to read nen/gates.json at");
  });

  it("a User-only request reads no ceiling at all -- the ceiling caps bot rounds", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      { match: `gh ${collaboratorArgv(KNOWN_BOTS_TARGET, "sasuke").join(" ")}`, result: collaboratorFound("sasuke", "U_1") },
      { match: `gh ${requestReviewsArgv(KNOWN_BOTS_TARGET, 9, ["sasuke"]).join(" ")}`, result: {} },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "sasuke", "--json"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(0);
    expect("ceiling" in (JSON.parse(result.out.join("\n")) as object)).toBe(false);
  });

  // ── round 1 of hanten on #310+#240 ─────────────────────────────────────
  const knownBotsWith = (base: string, main: string): { stdout: string } => ({
    stdout: JSON.stringify({
      data: {
        repository: {
          defaultBranchRef: { name: "main", target: { oid: main } },
          pullRequest: {
            id: "PR_1",
            baseRefOid: base,
            reviewRequests: { nodes: [] },
            timelineItems: { nodes: [{ author: { __typename: "Bot", login: "copilot-pull-request-reviewer", id: "BOT_1" } }] },
          },
        },
      },
    }),
  });
  const copilotRequest = ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-reviewers", "copilot-pull-request-reviewer"];

  it("F1: reads the ceiling at the base AND the default branch, applies the LOWER, and names both", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: knownBotsWith("BASE1", "MAIN1") },
      ...gatesAtBase({ version: 1, round_policy: { maxRounds: 5 } }, "BASE1"),
      ...gatesAtBase({ version: 1, round_policy: { maxRounds: 2 } }, "MAIN1"),
      timelineWith(2),
    ];
    const result = await capture(copilotRequest, null, new ScriptedSeams(script));
    expect(result.code).toBe(2);
    expect(result.out.join("\n")).toContain(
      "so this would be request 3 of 2 on zheref/nen#9, past the round_policy.maxRounds ceiling declared in zheref/nen@BASE1:nen/gates.json (pull request's base: maxRounds 5) and zheref/nen@MAIN1:nen/gates.json (default branch (main): maxRounds 2), the lower applied.",
    );
  });

  it("F1: absent at the base but declared on the default branch is DECLARED", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: knownBotsWith("BASE1", "MAIN1") },
      COMMIT_OK("BASE1"),
      { match: `gh ${gatesAtArgv(KNOWN_BOTS_TARGET, "BASE1").join(" ")}`, result: { code: 1, stderr: "gh: Not Found (HTTP 404)" } },
      ...gatesAtBase({ version: 1, round_policy: { maxRounds: 1 } }, "MAIN1"),
      timelineWith(1),
    ];
    const result = await capture(copilotRequest, null, new ScriptedSeams(script));
    expect(result.code).toBe(2);
    expect(result.out.join("\n")).toContain("(pull request's base: no maxRounds) and zheref/nen@MAIN1:nen/gates.json (default branch (main): maxRounds 1)");
  });

  it("F1: a failed read at EITHER ref refuses at exit 1", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: knownBotsWith("BASE1", "MAIN1") },
      ...gatesAtBase({ version: 1, round_policy: { maxRounds: 5 } }, "BASE1"),
      { match: `gh ${commitArgv(KNOWN_BOTS_TARGET, "MAIN1").join(" ")}`, result: { code: 1, stderr: "HTTP 502" } },
    ];
    const result = await capture(copilotRequest, null, new ScriptedSeams(script));
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toContain("could not read round_policy.maxRounds at the default branch (main) (the commit zheref/nen@MAIN1 could not be read (HTTP 502))");
  });

  it("N2: a repository-level 404 (the commit itself unreadable) is FAILED, never absent", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: KNOWN_BOT_COPILOT },
      { match: `gh ${commitArgv(KNOWN_BOTS_TARGET, "BASE1").join(" ")}`, result: { code: 1, stderr: "gh: Not Found (HTTP 404)" } },
    ];
    const result = await capture(copilotRequest, null, new ScriptedSeams(script));
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toContain("the commit zheref/nen@BASE1 could not be read (gh: Not Found (HTTP 404))");
  });

  it("N2: 'No commit found for the ref' on the file read is FAILED, never absent", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: KNOWN_BOT_COPILOT },
      COMMIT_OK("BASE1"),
      {
        match: `gh ${gatesAtArgv(KNOWN_BOTS_TARGET, "BASE1").join(" ")}`,
        result: { code: 1, stderr: "gh: No commit found for the ref BASE1 (HTTP 404)" },
      },
    ];
    const result = await capture(copilotRequest, null, new ScriptedSeams(script));
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toContain("No commit found for the ref BASE1");
  });

  it("N2: only a FILE-level 404 at a readable commit is absent -- no ceiling, the request goes through", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: KNOWN_BOT_COPILOT },
      ...NO_BASE_GATES,
      { match: `gh ${requestBotReviewsArgv("PR_1", ["BOT_1"]).join(" ")}`, result: botMutationOk(["copilot-pull-request-reviewer"]) },
    ];
    expect((await capture(copilotRequest, null, new ScriptedSeams(script))).code).toBe(0);
  });

  it("F3: a base file repeating a key is refused by pointer at exit 1, never read as the last value", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: KNOWN_BOT_COPILOT },
      COMMIT_OK("BASE1"),
      gatesFile("BASE1", '{"version":1,"round_policy":{"maxRounds":1,"maxRounds":999}}'),
    ];
    const result = await capture(copilotRequest, null, new ScriptedSeams(script));
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toContain("at round_policy, carries the key 'maxRounds' twice");
  });

  it("N5: an --add-bots id is counted under its CANONICAL login too -- a Bot event with another id but that login counts", async () => {
    const timeline: ScriptedCall = {
      match: `gh ${requestTimelineArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`,
      result: {
        stdout: JSON.stringify([
          [
            { event: "review_requested", requested_reviewer: { login: "copilot-pull-request-reviewer", node_id: "BOT_OLD", type: "Bot" } },
            { event: "review_requested", requested_reviewer: { login: "copilot-pull-request-reviewer", node_id: "BOT_kgDOCnlnWA", type: "Bot" } },
            // A User who happens to share the login is never this bot.
            { event: "review_requested", requested_reviewer: { login: "copilot-pull-request-reviewer", node_id: "U_9", type: "User" } },
          ],
        ]),
      },
    };
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      ...gatesAtBase({ version: 1, round_policy: { maxRounds: 2 } }),
      botNode("BOT_kgDOCnlnWA", "copilot-pull-request-reviewer"),
      timeline,
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "BOT_kgDOCnlnWA"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(2);
    expect(result.out.join("\n")).toContain("copilot-pull-request-reviewer (BOT_kgDOCnlnWA) has been requested 2 times");
  });

  it("N5: a Bot-shaped --add-bots id GitHub resolves as a User cannot be counted, so the request is refused at exit 1", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      ...CEILING_3,
      {
        match: `gh ${botNodesArgv(["BOT_2"]).join(" ")}`,
        result: { stdout: JSON.stringify({ data: { nodes: [{ __typename: "User" }] } }) },
      },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "BOT_2"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toContain("BOT_2 does not resolve to a Bot");
  });

  it("R2: an --add-bots id GitHub answers under a different canonical id is refused at exit 1, naming that id", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: NO_KNOWN_BOTS },
      ...CEILING_3,
      {
        match: `gh ${botNodesArgv(["BOT_OLD"]).join(" ")}`,
        result: { stdout: JSON.stringify({ data: { nodes: [{ __typename: "Bot", id: "BOT_kgDOCnlnWA", login: "copilot-pull-request-reviewer" }] } }) },
      },
    ];
    const result = await capture(
      ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "9", "--add-bots", "BOT_OLD"],
      null,
      new ScriptedSeams(script),
    );
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toContain("under the canonical id BOT_kgDOCnlnWA");
    expect(result.out.join("\n")).toContain("Nothing was requested");
  });

  it("N11: a ceiling that could not be checked under --dry-run says dryRun in --json", async () => {
    const script: readonly ScriptedCall[] = [
      { match: `gh ${prAndKnownBotsArgv(KNOWN_BOTS_TARGET, 9).join(" ")}`, result: KNOWN_BOT_COPILOT },
      { match: `gh ${commitArgv(KNOWN_BOTS_TARGET, "BASE1").join(" ")}`, result: { code: 1, stderr: "HTTP 502" } },
    ];
    const result = await capture([...copilotRequest, "--dry-run", "--json"], null, new ScriptedSeams(script));
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out.join("\n")) as { ok: boolean; dryRun?: boolean };
    expect(report.ok).toBe(false);
    expect(report.dryRun).toBe(true);
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
      ...NO_BASE_GATES,
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
      ...NO_BASE_GATES,
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
      ...NO_BASE_GATES,
      { match: `gh ${collaboratorArgv(KNOWN_BOTS_TARGET, "ghost").join(" ")}`, result: COLLABORATOR_NONE },
      { match: `gh ${botLoginArgv("ghost").join(" ")}`, result: { code: 1, stderr: "gh: Not Found (HTTP 404)" } },
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
      new ScriptedSeams([CERTIFY_12, { match: "gh pr edit 12 --repo zheref/nen --body-file -", result: {} }]),
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toBe("replaced zheref/nen#12's body (29 byte(s))");
  });

  it("--json carries the six-field contract plus the guard's privateNameCheck (zheref/nen#363), written: true on a real run", async () => {
    const path = tempFile("body.md", "hello");
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", path, "--json"],
      null,
      new ScriptedSeams([CERTIFY_12, { match: "gh pr edit 12 --repo zheref/nen --body-file -", result: {} }]),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      contract: "nen.pr.edit-body/v0.1",
      target: "zheref/nen",
      number: 12,
      bytes: 5,
      written: true,
      dryRun: false,
      privateNameCheck: { result: "skipped-private-target", targetVisibility: "private", listSize: null, owners: null, hits: [], error: null },
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
      "would run: gh pr edit 12 --repo zheref/nen --body-file -",
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
      "would run: gh pr edit 12 --repo zheref/nen --body-file -",
      "target: zheref/nen",
      "number: 12",
      "bytes: 31",
      "first line: first line",
      "last line: last line",
    ]);
  });

  it("--dry-run --json carries dryRun: true, written: false, the guard's verdict, and no other fields", async () => {
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
      privateNameCheck: { result: "skipped-private-target", targetVisibility: "private", listSize: null, owners: null, hits: [], error: null },
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
      new ScriptedSeams([CERTIFY_12, { match: "gh pr edit 12 --repo zheref/nen --body-file -", result: { code: 1, stderr: "HTTP 500" } }]),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not replace zheref\/nen#12's body/);
  });

  it("refuses --dry-run on any subcommand that does not read it, naming all five that do", async () => {
    const result = await capture(["pr", "ready", "--dry-run"], null, new ScriptedSeams([]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain(
      "--dry-run is only read by 'pr request-reviews', 'pr edit-body', 'pr mark-ready', 'pr threads' and 'pr open'.",
    );
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
    expect(result.err.join("\n")).toContain("--token-env is only read by 'pr ready'; mark-ready runs on whatever credential gh resolves");
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

// zheref/nen#351: every `pr` subcommand refuses, at exit 2 and before any gh
// call, each family flag it does not read -- naming the subcommands that do.
// An empty ScriptedSeams throws on its first call, so `calls.length === 0`
// proves the refusal came first.
describe("the family's one flag guard (zheref/nen#351)", () => {
  const BODY = tempFile("body.md", "## How to verify\n\nRun it.\n");
  const TITLE = tempFile("title.txt", "A title\n");
  const SETTLE = tempFile("settle.json", JSON.stringify([{ thread: "T1", body: "done" }]));
  const REQUIREMENTS = tempFile("requirements.json", JSON.stringify([{ name: "how to verify", pattern: "## How to verify" }]));

  // Each MUTATING subcommand at an invocation that is otherwise complete, so
  // without the guard it would go on to a gh (or git) call.
  const MUTATING: readonly (readonly [string, readonly string[]])[] = [
    ["cascade-main", ["pr", "cascade-main", "--no-push"]],
    ["retarget", ["pr", "retarget", "--target", "zheref/nen", "--pr", "12", "--base", "main"]],
    ["request-reviews", ["pr", "request-reviews", "--target", "zheref/nen", "--pr", "12", "--add-reviewers", "octocat"]],
    ["edit-body", ["pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", BODY]],
    ["mark-ready", ["pr", "mark-ready", "--target", "zheref/nen", "--pr", "12"]],
    ["threads", ["pr", "threads", "reply", "--target", "zheref/nen", "--pr", "12", "--thread", "T1", "--body-file", BODY]],
    ["threads", ["pr", "threads", "resolve", "--target", "zheref/nen", "--pr", "12", "--thread", "T1"]],
    ["threads", ["pr", "threads", "settle", "--target", "zheref/nen", "--pr", "12", "--from", SETTLE]],
    ["open", ["pr", "open", "--target", "zheref/nen", "--base", "main", "--title-file", TITLE, "--body-file", BODY]],
    ["merge", ["pr", "merge", "zheref/example#9", "--release-unit", "--requirements-from", REQUIREMENTS]],
    ["merge", ["pr", "merge", "zheref/example#9", "--delivery", "--requirements-from", REQUIREMENTS]],
  ];

  for (const [subcommand, argv] of MUTATING) {
    const label = argv.slice(1, subcommand === "threads" ? 3 : 2).join(" ");

    it(`refuses --token-env on 'pr ${label}' at exit 2 with zero calls, naming 'pr ready'`, async () => {
      const seams = new ScriptedSeams([]);
      const result = await capture([...argv, "--token-env", "NARROW_TOKEN"], tmpdir(), seams);
      expect(result.code).toBe(2);
      const err = result.err.join("\n");
      expect(err).toContain(`--token-env is not read by 'pr ${label}'.`);
      expect(err).toContain("--token-env is only read by 'pr ready';");
      expect(seams.calls.length).toBe(0);
    });

    it(`refuses --gh-repo on 'pr ${label}' at exit 2 with zero calls, naming 'pr ready'`, async () => {
      const seams = new ScriptedSeams([]);
      const result = await capture([...argv, "--gh-repo", "acme/widgets"], tmpdir(), seams);
      expect(result.code).toBe(2);
      const err = result.err.join("\n");
      expect(err).toContain(`--gh-repo is not read by 'pr ${label}'.`);
      expect(err).toContain("--gh-repo is only read by 'pr ready'");
      expect(seams.calls.length).toBe(0);
    });
  }

  it("says truthfully what credential each subcommand runs on instead", async () => {
    const cases: readonly (readonly [readonly string[], string])[] = [
      [["pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", BODY], "edit-body runs on whatever credential gh resolves (GH_TOKEN/GITHUB_TOKEN if exported, else its stored login), never on the variable --token-env names."],
      [["pr", "merge", "zheref/example#9", "--delivery", "--requirements-from", REQUIREMENTS], "merge judges readiness on GH_TOKEN and merges on whatever credential gh resolves"],
      [["pr", "cascade-main"], "cascade-main fetches and pushes on git's own credential and calls no GitHub API"],
      [["pr", "staleness", "--wakes-from", "w.json", "--last-activity", "2026-01-01T00:00:00Z", "--now", "2026-01-01T00:00:00Z"], "staleness reads local files only and calls no GitHub API"],
    ];
    for (const [argv, advice] of cases) {
      const result = await capture([...argv, "--token-env", "T"], tmpdir(), new ScriptedSeams([]));
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.err.join("\n"), argv.join(" ")).toContain(advice);
    }
  });

  it("points --gh-repo at --target on a subcommand that reads --target", async () => {
    const result = await capture(["pr", "fetch", "--target", "zheref/nen", "--pr", "12", "--gh-repo", "acme/widgets"], null, new ScriptedSeams([]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("--gh-repo is only read by 'pr ready'; 'pr fetch' names its repository with --target <owner/name>.");
  });

  it("names EVERY subcommand that reads a flag, not only 'pr ready'", async () => {
    const mark = ["pr", "mark-ready", "--target", "zheref/nen", "--pr", "12"];
    const cases: readonly (readonly [readonly string[], string])[] = [
      [[...mark, "--reviewers", "a"], "--reviewers is only read by 'pr ready' and 'pr next-blocker'."],
      [[...mark, "--gates", "g.json"], "--gates is only read by 'pr ready' and 'pr next-blocker'."],
      [[...mark, "--base", "main"], "--base is only read by 'pr body-check', 'pr retarget' and 'pr open'."],
      [[...mark, "--body-file", BODY], "--body-file is only read by 'pr edit-body', 'pr threads reply' and 'pr open'."],
      [["pr", "fetch", "--target", "zheref/nen", "--pr", "12", "--from", SETTLE], "--from is only read by 'pr threads settle'."],
      [["pr", "fetch", "--target", "zheref/nen", "--pr", "12", "--require-head", "abcdef1"], "--require-head is only read by 'pr ready', 'pr mark-ready' and 'pr merge --delivery'."],
    ];
    for (const [argv, message] of cases) {
      const result = await capture(argv, null, new ScriptedSeams([]));
      expect(result.code, argv.join(" ")).toBe(2);
      expect(result.err.join("\n"), argv.join(" ")).toContain(message);
    }
  });

  it("names every foreign flag at once, sorted, and never one the subcommand reads", async () => {
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", BODY, "--dry-run", "--token-env", "T", "--gh-repo", "a/b"],
      null,
      new ScriptedSeams([]),
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err.indexOf("--gh-repo is not read")).toBeGreaterThanOrEqual(0);
    expect(err.indexOf("--gh-repo is not read")).toBeLessThan(err.indexOf("--token-env is not read"));
    for (const own of ["--target", "--pr", "--body-file", "--dry-run"]) expect(err).not.toContain(`${own} is not read`);
  });

  // Exhaustive, and derived from the parser's own spec: every family flag a
  // subcommand's row does not declare is refused there, before any call.
  for (const subcommand of PR_SUBCOMMANDS) {
    it(`'pr ${subcommand}' refuses every family flag outside its own row (exit 2, zero calls)`, async () => {
      const row = PR_SUBCOMMAND_FLAGS[subcommand] ?? {};
      const own = new Set([...(row.values ?? []), ...(row.booleans ?? []), ...(row.lists ?? [])]);
      const head = subcommand === "threads" ? ["pr", "threads", "list"] : subcommand === "merge" ? ["pr", "merge", "zheref/example#9"] : ["pr", subcommand];
      const foreign: (readonly string[])[] = [
        ...(PR_FLAGS.values ?? []).filter((flag): boolean => !own.has(flag)).map((flag): readonly string[] => [`--${flag}`, "x"]),
        ...(PR_FLAGS.lists ?? []).filter((flag): boolean => !own.has(flag)).map((flag): readonly string[] => [`--${flag}`, "x"]),
        ...(PR_FLAGS.booleans ?? []).filter((flag): boolean => !own.has(flag)).map((flag): readonly string[] => [`--${flag}`]),
      ];
      expect(foreign.length).toBeGreaterThan(0);
      for (const extra of foreign) {
        const seams = new ScriptedSeams([]);
        const result = await capture([...head, ...extra], tmpdir(), seams);
        const flag = (extra[0] ?? "").slice(2);
        expect(result.code, `${subcommand} ${extra.join(" ")}`).toBe(2);
        const subject = subcommand === "threads" ? "threads list" : subcommand;
        expect(result.err.join("\n"), `${subcommand} ${extra.join(" ")}`).toContain(`--${flag} is not read by 'pr ${subject}'. --${flag} is only read by `);
        expect(seams.calls.length, `${subcommand} ${extra.join(" ")}`).toBe(0);
      }
    });
  }

  // Feitan, SEC-7 (hanten round 1): args.ts hands every token after a bare
  // `--` over as passthrough, which no 'pr' subcommand reads.
  it("refuses tokens after a bare '--' at exit 2 with zero calls, naming the flag but never its value", async () => {
    const seams = new ScriptedSeams([]);
    const result = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", BODY, "--", "--token-env", "SECRET_VAR_NAME", "--gh-repo=acme/widgets"],
      null,
      seams,
    );
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toContain("'pr edit-body' reads nothing after a bare '--'");
    expect(err).toContain("among them --token-env and --gh-repo");
    expect(err).not.toContain("SECRET_VAR_NAME");
    expect(err).not.toContain("acme/widgets");
    expect(seams.calls.length).toBe(0);
  });

  // Nobunaga 4 (hanten round 1): the threads action level names who reads the
  // flag, and reports in the same message as the family level.
  it("names the threads action that reads a flag, and every foreign flag of a threads call at once", async () => {
    const resolve = await capture(["pr", "threads", "resolve", "--target", "zheref/nen", "--pr", "217", "--thread", "T1", "--body-file", BODY], null, new ScriptedSeams([]));
    expect(resolve.code).toBe(2);
    expect(resolve.err.join("\n")).toContain("--body-file is not read by 'pr threads resolve'. --body-file is only read by 'pr edit-body', 'pr threads reply' and 'pr open'.");
    const seams = new ScriptedSeams([]);
    const list = await capture(["pr", "threads", "list", "--target", "zheref/nen", "--pr", "217", "--from", SETTLE, "--token-env", "T", "--thread", "T1"], null, seams);
    expect(list.code).toBe(2);
    const err = list.err.join("\n");
    expect(err).toContain("--from is not read by 'pr threads list'. --from is only read by 'pr threads settle'.");
    expect(err).toContain("--thread is not read by 'pr threads list'. --thread is only read by 'pr threads reply' and 'pr threads resolve'.");
    expect(err).toContain("--token-env is not read by 'pr threads list'. --token-env is only read by 'pr ready';");
    expect(seams.calls.length).toBe(0);
  });

  // Nobunaga 9 (hanten round 1): the form that reads it, not the one that refuses it.
  it("names 'pr merge --delivery' for --require-head", () => {
    expect(prFlagOwners("require-head")).toEqual(["'pr ready'", "'pr mark-ready'", "'pr merge --delivery'"]);
  });

  // Nobunaga 6 (hanten round 1): no default credential claim.
  it("states --token-env advice for every subcommand but ready, and has no default", () => {
    expect([...PR_TOKEN_ENV_ADVICE_KEYS].sort()).toEqual(PR_SUBCOMMANDS.filter((name): boolean => name !== "ready").sort());
  });

  // Nobunaga 5, BC-9 (hanten round 1): the derived tests above take both sides
  // from PR_SUBCOMMAND_FLAGS, so an over-declared row would pass them all and
  // bring back the silent ignore. This literal is the other side. A change to it
  // must be matched by the subcommand's handler actually reading the flag.
  it("declares exactly the flags each handler reads (literal snapshot)", () => {
    expect(PR_SUBCOMMAND_FLAGS).toEqual({
      ready: {
        values: ["target", "pr", "gh-repo", "reviewers", "approvers", "round-policy", "exclude-run", "gates", "token-env", "require-head"],
        booleans: ["explain", "require-base-gates"],
        lists: ["exclude-check", "reviewer-login"],
      },
      staleness: { values: ["wakes-from", "last-activity", "now", "min-verified-wakes", "idle-minutes"], booleans: ["ready"] },
      "body-check": { values: ["body-from", "requirements-from", "base", "max", "prose-budget"], booleans: ["exact"] },
      sections: { values: ["catalogue", "kind", "family", "with", "overrides", "taxonomy", "jobs"] },
      fetch: { values: ["target", "pr"] },
      "next-blocker": { values: ["target", "pr", "reviewers", "gates", "policy"], booleans: ["delivery-pr"] },
      "cascade-main": { values: ["trunk"], booleans: ["no-push"] },
      retarget: { values: ["target", "pr", "base"] },
      "request-reviews": { values: ["target", "pr", "add-reviewers", "add-bots"], booleans: ["dry-run"] },
      "edit-body": { values: ["target", "pr", "body-file", "private-names-ignore-file"], booleans: ["dry-run", "skip-private-name-check", "allow-all-ignored"] },
      "mark-ready": { values: ["target", "pr", "require-head"], booleans: ["dry-run"] },
      threads: { values: ["target", "pr", "thread", "body-file", "from", "private-names-ignore-file"], booleans: ["dry-run", "skip-private-name-check", "allow-all-ignored"] },
      open: { values: ["target", "base", "title-file", "body-file", "head", "assignee", "private-names-ignore-file"], booleans: ["draft", "dry-run", "skip-private-name-check", "allow-all-ignored"] },
      merge: { values: ["requirements-from", "require-head"], booleans: ["release-unit", "delivery", "run"] },
    });
    const threadsRow = PR_SUBCOMMAND_FLAGS["threads"] ?? {};
    const own = new Set([...(threadsRow.values ?? []), ...(threadsRow.booleans ?? [])].filter((flag): boolean => flag !== "target" && flag !== "pr"));
    const actions = new Set(Object.values(THREADS_ACTION_FLAGS).flatMap((row): string[] => [...row.values, ...row.booleans]));
    expect(own).toEqual(actions);
  });

  it("derives the parser spec as the union of the rows, and every flag in it has an owner", () => {
    expect(prCommand.subcommands).toEqual(PR_SUBCOMMANDS);
    expect(prCommand.flags).toBe(PR_FLAGS);
    for (const flag of [...(PR_FLAGS.values ?? []), ...(PR_FLAGS.booleans ?? []), ...(PR_FLAGS.lists ?? [])]) {
      expect(prFlagOwners(flag).length, flag).toBeGreaterThan(0);
    }
    // The spread zheref/nen#351 named is no longer the family's: --token-env
    // and --gh-repo belong to 'pr ready' alone.
    expect(prFlagOwners("token-env")).toEqual(["'pr ready'"]);
    expect(prFlagOwners("gh-repo")).toEqual(["'pr ready'"]);
  });
});

describe("nen pr edit-body -- the private-name guard (zheref/nen#363)", () => {
  const CERTIFY_12: ScriptedCall = { match: "gh api repos/zheref/nen/pulls/12", result: { stdout: JSON.stringify({ number: 12 }) } };
  const LIST = privateListRow(["acme/hidden-thing", "acme/vault"]);
  const WRITE: ScriptedCall = { match: "gh pr edit 12 --repo zheref/nen --body-file -", result: {} };
  const argvFor = (body: string, ...extra: string[]): string[] => [
    "pr", "edit-body", "--target", "zheref/nen", "--pr", "12", "--body-file", tempFile("body.md", body), ...extra,
  ];

  it("a private name on a PUBLIC target refuses with exit 4 after certifying, before any write, and never prints the name", async () => {
    const seams = new ScriptedSeams([CERTIFY_12, visibilityRow("zheref/nen", "public"), FULL_REACH_ROW, LIST]);
    const result = await capture(argvFor("moved out of the vault"), null, seams, "scripted");
    expect(result.code).toBe(4);
    expect(seams.calls.map((call): string => [call.command, ...call.args].join(" "))).toEqual([
      "gh api repos/zheref/nen/pulls/12",
      "gh api repos/zheref/nen",
      SCOPES_CALL,
      PRIVATE_LIST_PAGE,
    ]);
    const all = [...result.out, ...result.err].join("\n");
    expect(all).toContain("nen pr edit-body: body:1: private repository #2");
    expect(all).not.toMatch(/vault/i);
  });

  it("--dry-run refuses the same way, and --json carries the verdict with written: false", async () => {
    const seams = new ScriptedSeams([CERTIFY_12, visibilityRow("zheref/nen", "public"), FULL_REACH_ROW, LIST]);
    const result = await capture(argvFor("the vault", "--dry-run", "--json"), null, seams, "scripted");
    expect(result.code).toBe(4);
    const report = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(report["written"]).toBe(false);
    expect(report["dryRun"]).toBe(true);
    expect((report["privateNameCheck"] as { result: string }).result).toBe("refused");
  });

  it("a PRIVATE target is not checked -- the list is never read, and the body is written from stdin", async () => {
    const seams = new ScriptedSeams([CERTIFY_12, visibilityRow("zheref/nen", "private"), WRITE]);
    const result = await capture(argvFor("the vault\n"), null, seams, "scripted");
    expect(result.code).toBe(0);
    expect(seams.calls.some((call): boolean => call.args.join(" ").startsWith("api user/repos"))).toBe(false);
    expect(seams.calls[seams.calls.length - 1]?.stdin).toBe("the vault\n");
  });

  it("an unreadable private list fails closed (exit 1) and writes nothing", async () => {
    const seams = new ScriptedSeams([CERTIFY_12, visibilityRow("zheref/nen", "public"), FULL_REACH_ROW, UNREADABLE_PRIVATE_LIST]);
    const result = await capture(argvFor("anything"), null, seams, "scripted");
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/nen pr edit-body: private-name check could not run/);
    expect(seams.calls.some((call): boolean => call.args[0] === "pr")).toBe(false);
  });

  it("--skip-private-name-check reads nothing for the guard, writes, and is named", async () => {
    const seams = new ScriptedSeams([CERTIFY_12, WRITE]);
    const result = await capture(argvFor("the vault", "--skip-private-name-check"), null, seams, "scripted");
    expect(result.code).toBe(0);
    expect(result.err.join("\n")).toMatch(/SKIPPED by --skip-private-name-check/);
  });

  it("a missing --private-names-ignore-file is exit 2 before any gh call", async () => {
    const seams = new ScriptedSeams([]);
    const result = await capture(argvFor("x", "--private-names-ignore-file", "/no/such/ignore-file"), null, seams, "scripted");
    expect(result.code).toBe(2);
    expect(seams.calls).toEqual([]);
  });
});


describe("body-check exact and prose flags", () => {
  it("returns line findings, warning counts and retains legacy success", async () => {
    const requirements = tempFile("requirements.json", JSON.stringify([{ name: "summary", pattern: "^## Summary$" }]));
    const body = tempFile("body.md", "## Summary\n" + "word ".repeat(151) + "\n## Extra\n");
    const argv = ["pr", "body-check", "--body-from", body, "--requirements-from", requirements];
    expect((await capture(argv, process.cwd())).code).toBe(0);
    const exact = await capture([...argv, "--exact", "--max", "1", "--prose-budget", "150", "--json"], process.cwd());
    expect(exact.code).toBe(1);
    expect(JSON.parse(exact.out.join("\n"))).toMatchObject({ findings: [{ line: 3, message: expect.stringContaining("undeclared") }], warnings: [{ words: 151 }] });
    const warning = await capture([...argv, "--prose-budget", "150"], process.cwd());
    expect(warning.code).toBe(0); expect(warning.out.join("\n")).toContain("WARN Summary: 151");
    expect((await capture([...argv, "--max", "1"], process.cwd())).code).toBe(2);
    expect((await capture([...argv, "--exact", "--max", "1.5"], process.cwd())).code).toBe(2);
  });
  it("applies exact findings to derived requirements too", async () => {
    const repo = mkdtempSync(join(tmpdir(), "nen-derived-exact-"));
    writeFileSync(join(repo, "pull_request_template.md"), "## Summary\n<!-- Explain -->\n");
    const body = tempFile("body.md", "## Summary\nReal content\n## Extra\nContent\n");
    const result = await capture(["pr", "body-check", "--body-from", body, "--exact", "--json"], repo);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ source: { kind: "derived" }, findings: [{ line: 3 }] });
  });
});
