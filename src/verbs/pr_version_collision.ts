// src/verbs/pr_version_collision.ts -- `nen pr version-collision <ref>`: the
// narrow, trusted-CI read of ONE pull request's live plugin-version collision
// (zheref/nen#663).
//
// THE SAME EVALUATOR AS `nen pr ready`. This verb owns no decision: it reads
// the pull request's snapshot, the default-branch tip's `nen/gates.json` (the
// one copy that decides; the base's and the checkout's only warn when they
// differ) and hands both to ../pr/version_collision.ts's `readVersionCollision`
// -- the function `nen pr ready` folds into its CON-32(a) row. A trusted CI
// job that runs this verb and a readiness read of the same pull request at the
// same moment therefore cannot disagree (the issue's SC-1).
//
// READ-ONLY. It reads GitHub on the token `--token-env` names (default
// GH_TOKEN) and nothing else: no label, no comment, no status. It never runs
// pull request content -- a manifest is text, read through a JSON pointer.
//
// EXIT CODES. 0 clear or not-applicable; 1 collision or unknown (a non-zero
// exit never means "cleared"); 2 usage; 8 `--require-head` did not match
// GitHub's head -- `pr ready`'s code for the same fact.

import { assertRepoRoot } from "../repo/root.js";
import { plainLine } from "../cli/plain.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { GATES_FILE, resolveSchemaFile } from "../schema/source.js";
import { PROGRAM, VERSION } from "../version.js";
import type { PullRequestSnapshot } from "../github/graphql.js";
import {
  collectPolicyCopies,
  readLocalGatesCopy,
  readVersionCollision,
  renderVersionCollisionDetail,
  resolveCollisionPolicy,
  VERSION_COLLISION_LIMITS,
  type GatesCopyRead,
  type VersionCollisionEntry,
  type VersionCollisionLimits,
  type VersionCollisionResult,
} from "../pr/version_collision.js";
import {
  defaultDeps,
  DEFAULT_TOKEN_ENV,
  EXIT_HEAD_MISMATCH,
  HEAD_MISMATCH_CONTRACT,
  readBaseGates,
  readyInvocation,
  resolveRef,
  SHA_PREFIX,
  type HeadMismatchReport,
  type Io,
  type PrReadyDeps,
  type PrReadyInput,
  type ResolvedRef,
} from "./pr_ready.js";

/** The frozen machine contract. Adding a field is compatible; removing or renaming one bumps it. */
export const VERSION_COLLISION_CONTRACT = "nen.pr.version-collision/v0.1";

/** The flags this verb reads, beside `--target`/`--pr` and the global `--json`. */
export const PR_VERSION_COLLISION_FLAGS = {
  values: ["gh-repo", "token-env", "require-head"],
  booleans: ["explain"],
} as const;

/** `nen.pr.version-collision/v0.1`: the evaluator's result, addressed and attributed. */
export interface VersionCollisionReport extends VersionCollisionResult {
  readonly contract: typeof VERSION_COLLISION_CONTRACT;
  readonly ref: string;
  readonly repo: string;
  readonly pr: number;
  readonly evaluatedAt: string;
  readonly generator: { readonly program: string; readonly version: string; readonly executable: string };
}

/** What one invocation decided, before anything is printed (exported for the parity tests). */
export type VersionCollisionRead =
  | { readonly kind: "usage"; readonly message: string }
  | { readonly kind: "head-mismatch"; readonly report: HeadMismatchReport }
  | { readonly kind: "result"; readonly report: VersionCollisionReport };

export async function prVersionCollision(
  input: PrReadyInput,
  io: Io,
  deps: PrReadyDeps = defaultDeps,
  limits: VersionCollisionLimits = VERSION_COLLISION_LIMITS,
): Promise<number> {
  const read = await readVersionCollisionVerb(input, deps, limits);
  const json = input.booleans.has("json");
  switch (read.kind) {
    case "usage":
      io.err(`${PROGRAM}: ${read.message}`);
      return 2;
    case "head-mismatch":
      if (json) io.out(JSON.stringify(read.report, null, 2));
      else {
        io.out(plainLine(`${read.report.repo}#${read.report.pr}: head-mismatch: required ${read.report.requiredHead}, GitHub's head is ${read.report.githubHead ?? "(unread)"}`));
        io.err(plainLine(`${PROGRAM}: ${read.report.message}`));
      }
      return EXIT_HEAD_MISMATCH;
    case "result":
      return emit(io, json, input.booleans.has("explain"), read.report);
  }
}

export async function readVersionCollisionVerb(
  input: PrReadyInput,
  deps: PrReadyDeps = defaultDeps,
  limits: VersionCollisionLimits = VERSION_COLLISION_LIMITS,
): Promise<VersionCollisionRead> {
  let ref: ResolvedRef;
  try {
    const invocation = readyInvocation(input, "version-collision");
    ref = resolveRef(invocation.typedRef, invocation.input.values["gh-repo"], () =>
      loadRepoRegistry(assertRepoRoot({ repoFlag: input.repoFlag })),
    );
  } catch (error) {
    return { kind: "usage", message: error instanceof Error ? error.message : String(error) };
  }
  const requiredHead = input.values["require-head"];
  if (requiredHead !== undefined && !SHA_PREFIX.test(requiredHead)) {
    return { kind: "usage", message: `--require-head takes a commit SHA of 7 to 40 hex digits (got '${requiredHead}').` };
  }
  const report = (result: VersionCollisionResult): VersionCollisionRead => ({
    kind: "result",
    report: {
      contract: VERSION_COLLISION_CONTRACT,
      ...result,
      ref: ref.typed,
      repo: `${ref.owner}/${ref.repo}`,
      pr: ref.number,
      evaluatedAt: deps.now(),
      generator: { program: PROGRAM, version: VERSION, executable: deps.executable() },
    },
  });

  const opened = deps.openSource(input.values["token-env"] ?? DEFAULT_TOKEN_ENV);
  if (!opened.ok) return report(unreadResult(`a usable token (${opened.message})`));
  const source = opened.source;
  let snapshot: PullRequestSnapshot;
  try {
    snapshot = await source.pullRequestSnapshot(ref, ref.number);
  } catch (error) {
    return report(unreadResult(`the pull request (${error instanceof Error ? error.message : String(error)})`));
  }
  const node = snapshot.pullRequest;
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  if (node === undefined) return report(unreadResult("the pull request (GitHub answered no pull request node)"));
  const headSha = text(node.headRefOid);
  if (requiredHead !== undefined && (headSha === "" || !headSha.toLowerCase().startsWith(requiredHead.toLowerCase()))) {
    return {
      kind: "head-mismatch",
      report: {
        contract: HEAD_MISMATCH_CONTRACT,
        status: "head-mismatch",
        ref: ref.typed,
        repo: `${ref.owner}/${ref.repo}`,
        pr: ref.number,
        requiredHead,
        githubHead: headSha === "" ? null : headSha,
        message:
          `--require-head ${requiredHead} does not match GitHub's head for ${ref.owner}/${ref.repo}#${ref.number}, ` +
          `which is ${headSha === "" ? "(unread)" : headSha}. No collision was decided: the question was about a commit ` +
          "GitHub does not hold as this pull request's head.",
        evaluatedAt: deps.now(),
        generator: { program: PROGRAM, version: VERSION, executable: deps.executable() },
      },
    };
  }

  // THE POLICY: the default-branch tip's file, by the route `pr ready` uses.
  const defaultSha = text(snapshot.defaultBranchOid);
  const baseSha = text(node.baseRefOid);
  const atDefault = await readBaseGates(source, ref, defaultSha, "default-branch tip");
  const copies = collectPolicyCopies(atDefault, baseSha === defaultSha ? undefined : await readBaseGates(source, ref, baseSha), localCopy(input.repoFlag));
  const outcome = await readVersionCollision(
    source,
    ref,
    { number: ref.number, headSha, baseRef: text(node.baseRefName), defaultBranch: text(snapshot.defaultBranch) },
    resolveCollisionPolicy({ where: atDefault.where, read: atDefault.read }, copies),
    limits,
  );
  return report(outcome.result);
}

/** The checkout's own `nen/gates.json`, as a diagnostic copy; `null` when there is none. */
function localCopy(repoFlag: string | null): GatesCopyRead | null {
  let root: string;
  try {
    root = assertRepoRoot({ repoFlag });
  } catch {
    return null;
  }
  const file = resolveSchemaFile(root, GATES_FILE).canonical;
  return file.present ? readLocalGatesCopy(`the checkout's ${file.path}`, file.path) : null;
}

/** An unknown before any evidence was read: one missing piece, nothing else known. */
function unreadResult(missing: string): VersionCollisionResult {
  return {
    status: "unknown",
    line: `unknown: ${missing} could not be read`,
    judgedHead: null,
    base: { ref: "", sha: null },
    default: { ref: "", sha: null },
    policySource: null,
    policy: null,
    proposedVersion: null,
    collisions: [],
    missing: [`${missing} could not be read`],
    inventory: { pages: 0, inspected: 0, reads: 0, budget: VERSION_COLLISION_LIMITS.budget },
    warnings: [],
    notes: [],
  };
}

/** One `--explain` line per collision, by kind -- each names its version, branch and commit. */
export function explainCollision(entry: VersionCollisionEntry, proposed: string | null): string {
  switch (entry.kind) {
    case "base":
      return `collision (base): ${entry.version} is already at the tip of '${entry.baseRef ?? "?"}' (${entry.head ?? "?"})`;
    case "unbumped":
      return `collision (unbumped): the head keeps its merge base's ${proposed ?? "?"}, and '${entry.baseRef ?? "?"}' moved on to ${entry.version} at ${entry.head ?? "?"} -- merged, it would ship under ${entry.version}`;
    case "peer":
      return `collision (peer): ${entry.version} is also proposed by #${entry.pr ?? "?"} (head ${entry.head ?? "?"}, base '${entry.baseRef ?? "?"}'${entry.draft === true ? ", draft" : ""})`;
  }
}

function emit(io: Io, json: boolean, explain: boolean, report: VersionCollisionReport): number {
  if (json) {
    io.out(JSON.stringify(report, null, 2));
  } else {
    // Every string below may carry text this verb did not write (a branch
    // name, a file path): plain at the human seam, as `pr ready` is.
    io.out(plainLine(`${report.repo}#${report.pr}: version collision ${report.line}`));
    io.out(
      plainLine(
        report.judgedHead === null
          ? "  judged head: (unread)"
          : `  judged head: ${report.judgedHead} (GitHub's head for this pull request when it was read)`,
      ),
    );
    if (explain) {
      for (const line of renderVersionCollisionDetail(report)) io.out(plainLine(`  ${line}`));
      for (const entry of report.collisions) io.out(plainLine(`  ${explainCollision(entry, report.proposedVersion)}`));
      for (const missing of report.missing) io.out(plainLine(`  missing: ${missing}`));
      for (const note of report.notes) io.out(plainLine(`  note: ${note}`));
    }
    for (const warning of report.warnings) io.out(plainLine(`  warning: ${warning}`));
  }
  return report.status === "clear" || report.status === "not-applicable" ? 0 : 1;
}
