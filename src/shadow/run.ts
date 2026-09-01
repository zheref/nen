#!/usr/bin/env bun
// src/shadow/run.ts -- the shadow window: `nen pr ready` beside
// `scripts/pr_ready_gate.sh --verdict`, verdict for verdict, on live pull
// requests (zheref/nen#2, Akatsuki migration P1, §7's P1 evidence bar).
//
//   Shadow window: on live bankai-core PRs, `nen pr ready` must equal
//   `pr_ready_gate.sh --verdict` — every disagreement is a finding before Nen
//   may become an authority.
//
// ── WHY THIS FILE IS NOT A VERB ──────────────────────────────────────────────
//
// It is DEV-ONLY, run directly via `bun src/shadow/run.ts`, and nothing shipped
// imports it -- `bun build --compile ./src/index.ts` never sees this file, so it
// is excluded from the compiled binary by the same mechanism that keeps a test
// file out: nobody reaches it from the entry point. It is not registered in
// ../index.ts's dispatch and takes no `--json` contract of its own; it produces
// one artifact, a markdown report, and its own stdout is a progress log for the
// person running it.
//
// It also does something a shipped verb never does: it shells out to `gh` to
// enumerate pull requests and to `bash` to run bankai-core's own oracle script.
// ../verbs/pr_ready.ts's header is explicit that THAT verb never does either --
// "this verb cannot label, merge, comment, re-request or re-run" -- and this
// file is the reason it does not have to: comparing against the shell is this
// tool's whole job, so it is the one place in this repository allowed to invoke
// the shell it is proving nen agrees with.
//
// ── WHERE THE TARGET LIST LIVES, AND WHY IT IS NOT HERE ─────────────────────
//
// §3: no shipped .ts file may carry the name of a system nen serves --
// src/taxonomy-purity.test.ts sweeps every one of them but `**/*.test.ts` and
// `**/fixtures/**`, and this file is neither. A shadow-window target list is
// exactly a list of such names, so it lives in ./targets.json -- a `.json` file
// the sweep never reads, because only `.ts` files are shipped code -- and this
// file loads it at runtime like every other piece of this repository's
// taxonomy. The identities the oracle judges by follow the same rule: they are
// read from ../schema/fixtures/bankai-repo/schemas/gates.json, "the vocabulary
// of the live system nen serves today" (its own README), rather than
// duplicated into a second copy this file would own and could drift from.
//
// ── THE COMPARISON, AND WHAT COUNTS AS A DISAGREEMENT ────────────────────────
//
// Both sides are asked to decide the SAME pull request under the SAME
// identities and the SAME default policy (bounded, `--reviewers` unpassed on
// both sides so each derives its own default reviewer set from the rollup --
// see ../verbs/pr_ready.ts's header and pr_ready_gate.sh's own `main`). Three
// outcomes are possible on the oracle's side: it prints `ready`, it prints
// `not-ready: <reason>`, or -- under `set -e` on a fetch failure -- it prints
// NO verdict line at all and exits non-zero. Nen has a fourth: `unevaluated`,
// SKILL.md § 4's classification for the exact conditions that make the shell
// print nothing. An oracle silence paired with a nen `unevaluated` is
// AGREEMENT, not a finding -- both sides are saying "no verdict", the only
// difference is that nen's vocabulary has a name for it. Every other pairing
// where the READY-ness disagrees is a finding, full stop, and is reported as
// one rather than judged here: classifying it as a nen defect or a documented
// shell quirk is a reading of the reason strings that belongs in
// docs/evidence/shadow-window-p1.md, written by a person, not inferred by this
// script.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prReady, type PrReadyInput } from "../verbs/pr_ready.js";

interface Targets {
  readonly openPrRepos: readonly string[];
  readonly oracleRepo: string;
  /**
   * Where the oracle's own reviewer identities live, relative to --repo. A
   * PATH SEGMENT, not merely a value: `join()`-ing a literal
   * `"bankai-repo"` here would put the name of a system nen serves into this
   * file's own executable code, which is exactly what ./targets.json exists to
   * keep out of it (see the file header).
   */
  readonly identityFixture: string;
  readonly closedOraclePrs: Readonly<Record<string, readonly number[]>>;
}

interface Candidate {
  readonly repo: string;
  readonly number: number;
  /** Why this PR is in the set, for the report -- "open" or "closed (seeded)". */
  readonly origin: string;
}

interface OracleResult {
  readonly verdictLine: string | null;
  readonly exitCode: number;
  readonly stderr: string;
}

interface NenResult {
  readonly verdict: "ready" | "not-ready" | "unevaluated";
  readonly gateLine: string;
}

interface Row {
  readonly candidate: Candidate;
  readonly oracle: OracleResult;
  readonly nen: NenResult;
  readonly agree: boolean;
}

// ── argv, deliberately small -- this is a dev tool, not a shipped verb ──────

interface Args {
  /**
   * The checkout that carries `scripts/pr_ready_gate.sh` -- the oracle. Named
   * `--oracle-repo` rather than after the specific system that ships it today:
   * §3 keeps a system's name out of this file's own code (see the header), and
   * the flag's JOB -- "where is the oracle script" -- has nothing to do with
   * which repository happens to answer it.
   */
  readonly oracleRepoPath: string;
  readonly repo: string;
  readonly out: string | null;
  readonly limit: number | null;
}

function parseArgs(argv: readonly string[]): Args {
  let oracleRepoPath: string | null = null;
  let repo = process.cwd();
  let out: string | null = null;
  let limit: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--oracle-repo") oracleRepoPath = argv[(index += 1)] ?? null;
    else if (arg === "--repo") repo = argv[(index += 1)] ?? repo;
    else if (arg === "--out") out = argv[(index += 1)] ?? null;
    else if (arg === "--limit") limit = Number.parseInt(argv[(index += 1)] ?? "", 10);
  }
  if (oracleRepoPath === null) {
    // §3's "no root derivation from where a file happens to live on disk",
    // applied to a SIBLING checkout too: this tool never guesses where the
    // oracle's script lives, the same reason ../repo/root.ts never guesses
    // where nen's own target repository is.
    throw new Error(
      "--oracle-repo <path> is required: the oracle is invoked read-only from that checkout's own working copy on main, and this tool derives no such path on its own.",
    );
  }
  return { oracleRepoPath: resolve(oracleRepoPath), repo: resolve(repo), out, limit };
}

// ── the oracle side ──────────────────────────────────────────────────────────

/**
 * `REPO=<owner/repo> scripts/pr_ready_gate.sh --verdict <N>`, run from the
 * oracle checkout's own working copy. READ-ONLY: `--verdict` posts nothing
 * (../verbs/pr_ready.ts's header on the notification-mode arm this flag
 * avoids).
 */
function runOracle(oracleRepoPath: string, repo: string, prNumber: number): OracleResult {
  const result = spawnSync("bash", ["scripts/pr_ready_gate.sh", "--verdict", String(prNumber)], {
    cwd: oracleRepoPath,
    env: { ...process.env, REPO: repo },
    encoding: "utf8",
  });
  const stdout = result.stdout ?? "";
  // `#<N>: <verdict line>` -- main's own printf shape, transcribed at the top
  // of ../gates/ready.ts's header. A run that aborted before printing (a
  // missing REPO, a fetch failure under set -e) leaves stdout empty; that is
  // read as "no verdict", never guessed at.
  const match = /^#\d+:\s*(.+)$/m.exec(stdout);
  return {
    verdictLine: match?.[1]?.trim() ?? null,
    exitCode: result.status ?? 1,
    stderr: result.stderr ?? "",
  };
}

// ── the nen side ─────────────────────────────────────────────────────────────

/**
 * `nen pr ready --gh-repo <repo> <N> --json`, called IN-PROCESS against the
 * exact function ../index.ts's `pr` case dispatches to -- the same code path a
 * compiled binary runs, not a paraphrase of it.
 */
async function runNen(repo: string, prNumber: number, gatesPath: string): Promise<NenResult> {
  const chunks: string[] = [];
  const input: PrReadyInput = {
    positionals: ["pr", "ready", String(prNumber)],
    values: { "gh-repo": repo, gates: gatesPath },
    booleans: new Set(["json"]),
    repoFlag: null,
  };
  await prReady(input, {
    out: (line): void => {
      chunks.push(line);
    },
    err: (): void => {
      // stderr carries the human-readable "could not be evaluated" note on an
      // `unevaluated` verdict, duplicating what --json's own `remedy` field
      // already states. Discarded here; the report reads the JSON.
    },
  });
  const parsed = JSON.parse(chunks.join("\n")) as { verdict: NenResult["verdict"]; gateLine: string };
  return { verdict: parsed.verdict, gateLine: parsed.gateLine };
}

// ── comparison ───────────────────────────────────────────────────────────────

function oracleReady(oracle: OracleResult): boolean | null {
  if (oracle.verdictLine === null) return null; // no verdict printed
  return oracle.verdictLine === "ready";
}

function agrees(oracle: OracleResult, nen: NenResult): boolean {
  const oReady = oracleReady(oracle);
  if (oReady === null) return nen.verdict === "unevaluated"; // both say "no verdict"
  if (nen.verdict === "unevaluated") return false; // oracle decided, nen could not
  return oReady === (nen.verdict === "ready");
}

// ── enumeration ──────────────────────────────────────────────────────────────

/** `gh pr list --repo <repo> --state open --json number`, read-only. */
function listOpenPrs(repo: string): readonly number[] {
  const result = spawnSync("gh", ["pr", "list", "--repo", repo, "--state", "open", "--json", "number", "--limit", "200"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`gh pr list --repo ${repo} failed: ${result.stderr}`);
  }
  const parsed = JSON.parse(result.stdout || "[]") as { number: number }[];
  return parsed.map((entry): number => entry.number);
}

function buildCandidates(targets: Targets, limit: number | null): Candidate[] {
  const candidates: Candidate[] = [];
  for (const repo of targets.openPrRepos) {
    for (const number of listOpenPrs(repo)) {
      candidates.push({ repo, number, origin: "open" });
    }
  }
  for (const [repo, numbers] of Object.entries(targets.closedOraclePrs)) {
    for (const number of numbers) {
      candidates.push({ repo, number, origin: "closed (seeded, issue #2's Scope)" });
    }
  }
  return limit === null ? candidates : candidates.slice(0, limit);
}

// ── reporting ────────────────────────────────────────────────────────────────

function renderReport(rows: readonly Row[]): string {
  const lines: string[] = [];
  lines.push("| Repo | PR | Origin | Oracle | Nen | Agree |");
  lines.push("|---|---|---|---|---|---|");
  for (const row of rows) {
    const oracleCell =
      row.oracle.verdictLine === null
        ? `(no verdict, exit ${row.oracle.exitCode})`
        : row.oracle.verdictLine.length > 80
          ? `${row.oracle.verdictLine.slice(0, 77)}...`
          : row.oracle.verdictLine;
    const nenCell =
      row.nen.gateLine.length > 80 ? `${row.nen.gateLine.slice(0, 77)}...` : row.nen.gateLine;
    lines.push(
      `| ${row.candidate.repo} | #${row.candidate.number} | ${row.candidate.origin} | ${escapeCell(oracleCell)} | ${escapeCell(nenCell)} | ${row.agree ? "yes" : "**NO**"} |`,
    );
  }
  return lines.join("\n");
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // GH_TOKEN is never picked up ambiently by ../github/client.ts's design
  // (tokenFromEnv's own header), but `gh` itself already holds a working
  // credential the moment `gh auth status` is green -- and it is what the
  // oracle side of this comparison authenticates with. Minting nen's copy from
  // it, for THIS process only, is the one ambient read this tool allows itself:
  // asking the operator to paste the same token gh already holds into a second
  // place would be friction with no safety benefit.
  if ((process.env["GH_TOKEN"] ?? "") === "") {
    const minted = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
    if (minted.status === 0 && minted.stdout.trim() !== "") {
      process.env["GH_TOKEN"] = minted.stdout.trim();
    }
  }

  // `args.repo` (default process.cwd(), overridable with --repo) is the base
  // for BOTH files below -- the same "process.cwd() + explicit override" rule
  // ../repo/root.ts states for every other path in this repository, applied
  // here too rather than deriving either path from where this script happens
  // to live on disk.
  const targetsPath = join(args.repo, "src", "shadow", "targets.json");
  const targets = JSON.parse(readFileSync(targetsPath, "utf8")) as Targets;
  const gatesPath = join(args.repo, ...targets.identityFixture.split("/"));

  process.stderr.write(`shadow window: enumerating candidates...\n`);
  const candidates = buildCandidates(targets, args.limit);
  process.stderr.write(`shadow window: ${candidates.length} candidate PR(s).\n`);

  const rows: Row[] = [];
  for (const candidate of candidates) {
    process.stderr.write(`  ${candidate.repo}#${candidate.number} ... `);
    const oracle = runOracle(args.oracleRepoPath, candidate.repo, candidate.number);
    const nen = await runNen(candidate.repo, candidate.number, gatesPath);
    const agree = agrees(oracle, nen);
    rows.push({ candidate, oracle, nen, agree });
    process.stderr.write(`${agree ? "agree" : "DISAGREE"}\n`);
  }

  const report = renderReport(rows);
  process.stdout.write(`${report}\n`);
  if (args.out !== null) {
    writeFileSync(args.out, `${report}\n`, "utf8");
  }

  const disagreements = rows.filter((row): boolean => !row.agree);
  process.stderr.write(
    `\nshadow window: ${rows.length - disagreements.length}/${rows.length} agree, ${disagreements.length} disagreement(s).\n`,
  );
  if (disagreements.length > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  main().catch((error: unknown): void => {
    process.stderr.write(`shadow window: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
