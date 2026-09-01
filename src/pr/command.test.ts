import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { prCommand } from "./command.js";

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
};

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding).
async function capture(argv: readonly string[], repoFlag: string | null): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const code = await runFamily(prCommand, argv, repoFlag, false, io, STUB_SEAMS);
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
