// src/scaffold/init.ts -- `nen scaffold init`, on an EXISTING repository.
//
// WHAT THIS VERB WAS, AND WHAT IT IS NOW. Through v0.2.0 it did three
// scenario-agnostic things -- a directory skeleton, the trailer-enforcing
// commit-msg hook (./hook.ts, new here and never ported from anywhere), and a
// canon-values template. All three are unchanged, byte for byte, and
// ./init.test.ts still pins them. What is added is the stack-aware layer the
// repository needed a second verb for otherwise: the declaration, the legacy
// taxonomy migration, the CI workflow, `.gitignore` upkeep, and a closing
// toolchain CHECK that installs nothing.
//
// IT NEVER GUESSES A STACK. `--stack <id>` states one; `--accept-detected`
// accepts the proposal `nen shu detect` prints, seats and all. With neither,
// this verb refuses at exit 2 naming both flags -- an inferred stack written
// into a declaration is an inference that every later verb then treats as a
// decision.
//
// EVERY WRITE IS ONE OF FOUR OUTCOMES -- `created`, `skipped`, `would-create`,
// `refused` -- and the report carries every one of them with the reason. A step
// that quietly did nothing is the failure mode a scaffold has: the caller reads
// "done", and finds out three verbs later that the file they were promised is
// not there.
//
// IT SPAWNS NOTHING ITSELF. The closing toolchain check is a function the
// caller passes in (./command.ts builds it out of `nen shu tools`), so this
// module imports no seam and `--dry-run` cannot spawn even by accident: a dry
// run never calls it.

import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { containedPath, realContainment } from "../repo/contain.js";
import { loadContract } from "../schema/contract.js";
import {
  CONTRACT_FILE,
  LEGACY_MIGRATABLE_FILES,
  inspectShadow,
  resolveSchemaFile,
} from "../schema/source.js";
import { detect, type DetectReport } from "../shu/detect.js";
import { PROGRAM, VERSION } from "../version.js";
import { renderCommitMsgHook, writeHookFile, type HookSpec } from "./hook.js";
import {
  NEN_REF,
  compareNenRefs,
  minimumNenRef,
  stackHosts,
  substitute,
  templateForStack,
} from "./templates.js";

/** `nen.scaffold.init/v0.1` -- this verb's own versioned contract string. */
export const SCAFFOLD_INIT_CONTRACT = "nen.scaffold.init/v0.1";

/** The workflow directory a CI template's path is rooted at. Data names the file. */
export const GITIGNORE_FILE = ".gitignore";

/** The one line `.gitignore` upkeep appends, and the comment above it. */
export const GITIGNORE_ENTRY = ".nen/";

/**
 * The taxonomy files the `schemas/` -> `nen/` migration covers.
 *
 * IT IS THE LOADER'S OWN LIST, not a copy of it. A hand-written four-entry list
 * here would be a second place the migration set is written down, and the two
 * would come apart in exactly one direction: a file the loader still falls back
 * for, that the scaffold silently stops copying.
 */
export const MIGRATED_FILES: readonly string[] = LEGACY_MIGRATABLE_FILES;

/**
 * What happened to one path.
 *
 * `skipped` IS NOT A SYNONYM FOR `created`. "It was already exactly this" and
 * "nen wrote it" are different facts about the repository, and an idempotent
 * second run has to be able to say which one it is for every line it prints --
 * otherwise "idempotent" is a claim rather than an observation.
 *
 * AND `appended` IS NOT A SYNONYM FOR EITHER. Exactly one step of this verb adds
 * to a file somebody else owns rather than writing one of nen's own
 * (`.gitignore`), and reporting that as `created` about a file that was already
 * there -- with the caller's own thirty lines still in it -- is the one line in
 * the report that would need a second look to be believed. The dry form says
 * `would-append` for the same reason: a preview that says `would-create` about
 * an existing file invites exactly the wrong question.
 */
export type WriteAction =
  | "created"
  | "appended"
  | "skipped"
  | "would-create"
  | "would-append"
  | "refused";

export interface ScaffoldWrite {
  /** Repo-relative, forward-slashed -- the spelling every message prints. */
  readonly path: string;
  readonly action: WriteAction;
  /** Why this outcome, in one sentence. Never empty. */
  readonly why: string;
}

export interface ScaffoldMigration {
  /** The legacy path, repo-relative. */
  readonly from: string;
  /** The canonical path, repo-relative. */
  readonly to: string;
  readonly action: WriteAction;
  readonly why: string;
}

/**
 * What a closing toolchain check reported, or the reason it could not run.
 *
 * THERE IS NO "the command to run" FIELD, deliberately. `shu tools` renders its
 * own advice -- the `--install --dry-run` line and the `--install` line, in that
 * order -- and those lines arrive here in `lines`. A second field carrying a
 * second spelling of the same command is a second thing to keep in step with
 * that verb, and the two would come apart the first time its advice changed.
 */
export interface ToolsOutcome {
  /** The `nen.shu.tools/v0.1` document, or null when the check did not run. */
  readonly report: unknown;
  /** The rendered table, plus that verb's own advice when it did not pass. */
  readonly lines: readonly string[];
}

/**
 * The closing check, injected.
 *
 * IT IS A PARAMETER AND NOT AN IMPORT, so that this module imports no seam and
 * a `--dry-run` cannot spawn a probe by any path at all -- there is nothing
 * here to spawn WITH. ./command.ts supplies the real one out of
 * `nen shu tools`, reusing that verb's own report assembly rather than growing
 * a second opinion about the same host.
 */
export type ToolsChecker = (install: boolean) => ToolsOutcome;

export interface ScaffoldInitOptions {
  readonly root: string;
  /** The host `nen shu detect`'s `{gw}` resolution answers for. */
  readonly platform: NodeJS.Platform;
  /** Repo-relative directories to create, e.g. ["src", "tests", "docs"]. */
  readonly directories: readonly string[];
  readonly hook: HookSpec;
  /** Repo-relative path for the git hook. Default '.git/hooks/commit-msg'. */
  readonly hookPath?: string;
  /**
   * When a DIFFERENT hook already lives at the hook path, overwrite it
   * anyway -- backing up the previous content to '<path>.bak' first. Without
   * it, a differing existing hook is refused rather than silently replaced.
   */
  readonly force?: boolean;
  /** Repo-relative path for the canon-values template. Omit to skip it. */
  readonly canonValuesPath?: string;
  readonly scenario?: string;
  /** The stack this repository builds, stated. Never inferred. */
  readonly stack?: string;
  /** Accept `nen shu detect`'s proposal exactly as `detect --write` writes it. */
  readonly acceptDetected?: boolean;
  /** The nen release the generated workflow pins. Omitted, nen chooses one. */
  readonly nenRef?: string;
  /** Print every write and perform none. Spawns nothing, not even a probe. */
  readonly dryRun?: boolean;
  /** Run the closing check as `--install` rather than as a check. */
  readonly installTools?: boolean;
  /** The closing toolchain check. Omitted, the report says it did not run. */
  readonly tools?: ToolsChecker;
}

export type HookOutcome = "installed" | "unchanged" | "refused" | "would-install";

export interface ScaffoldInitResult {
  readonly contract: string;
  readonly createdDirectories: readonly string[];
  readonly hookWritten: string;
  /**
   * "installed": no hook existed, or --force replaced a differing one.
   * "unchanged": a hook already existed with the SAME generated content.
   * "refused": a DIFFERENT hook already existed and --force was not given --
   * see hookError.
   * "would-install": a dry run, which wrote nothing.
   */
  readonly hookOutcome: HookOutcome;
  readonly hookError: string | null;
  readonly canonValuesWritten: string | null;
  /** The lane set this run declared, or null when nothing was written. */
  readonly stack: string | null;
  readonly writes: readonly ScaffoldWrite[];
  readonly migrated: readonly ScaffoldMigration[];
  /** Lines worth printing that are not a write: detect's notes, the `git rm`. */
  readonly notes: readonly string[];
  readonly tools: ToolsOutcome | null;
  readonly exitCode: number;
}

function ensureDir(path: string, created: string[], dry: boolean): void {
  if (existsSync(path)) return;
  if (!dry) mkdirSync(path, { recursive: true });
  created.push(path);
}

/** Repo-relative and forward-slashed, the one spelling a report prints. */
function repoRelative(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === "" ? "." : rel.split(sep).join("/");
}

export function renderCanonValuesTemplate(scenario: string | undefined): string {
  const lines = [
    "# Generated by 'nen scaffold init'. Bind every {{TOKEN}} 'nen canon mirror generate'",
    "# needs for this repo's rule set. See handbooks/stacks/<scenario>/rules/placeholders.md",
    "# in the canon source for the token registry.",
  ];
  if (scenario !== undefined) lines.push(`scenario: ${scenario}`);
  lines.push("values:");
  lines.push("  # TOKEN_NAME: literal value");
  return `${lines.join("\n")}\n`;
}

/**
 * The `project` block this run would write, and the notes that go with it.
 *
 * BOTH ROUTES GO THROUGH `detect`, and that is the point rather than an
 * implementation detail: `--accept-detected` takes its proposal whole, and
 * `--stack <id>` takes the same proposal NARROWED to that stack's lanes. A
 * `--stack` for a stack no marker answered still gets a lane -- at the
 * repository root, with an EMPTY verb map -- because the caller stated the
 * stack and nen may not contradict them; what nen will not do is fill that
 * lane's rows with commands it never cross-checked against this tree.
 *
 * AN AMBIGUOUS TREE IS NOT AN ERROR. More than one lane means `defaultLane` is
 * null and `--lane` becomes required, and a withheld row means a seat a
 * maintainer answers. Both are written exactly as `detect --write` writes them,
 * with detect's own notes printed: refusing here would leave the repository
 * with no declaration at all, which is strictly worse than one that says out
 * loud which questions are still open.
 */
function proposeProject(
  report: DetectReport,
  stack: string | undefined,
  acceptDetected: boolean,
): { document: Record<string, unknown>; stack: string | null; notes: readonly string[] } {
  if (acceptDetected) {
    if (report.proposal === null) {
      throw new VerbUsageError(
        `--accept-detected has nothing to accept: no lane was detected under ${report.repo}. Nen proposes a lane only from a marker it can see, so state the stack with --stack <id> instead.`,
      );
    }
    const stacks = [...new Set(report.lanes.map((lane): string => lane.stack))].sort();
    return {
      document: report.proposal,
      stack: stacks.length === 1 ? (stacks[0] ?? null) : null,
      notes: report.notes,
    };
  }
  const named = stack as string;
  const lanes = report.lanes.filter((lane): boolean => lane.stack === named);
  const notes = [...report.notes];
  if (lanes.length === 0) {
    notes.push(
      `no marker for '${named}' was found under ${report.repo}, and --stack said so anyway. One lane is declared at the repository root with an EMPTY verb map: nen writes a command row only for a verb it cross-checked against this tree, so every row here is yours to write. '${PROGRAM} shu detect --repo ${report.repo}' prints what the markers do say.`,
    );
    return {
      document: {
        $schema: "nen.contract/v0.1",
        project: {
          lanes: { [named]: { stack: named, cwd: "." } },
          defaultLane: named,
          verbs: { [named]: {} },
          hosts: stackHosts(named),
        },
      },
      stack: named,
      notes,
    };
  }
  if (lanes.length !== report.lanes.length) {
    notes.push(
      `--stack ${named} narrowed the proposal to ${lanes.length} of ${report.lanes.length} detected lanes; the others are not written. Re-run with --accept-detected to take every lane the markers answered.`,
    );
  }
  return {
    document: {
      $schema: "nen.contract/v0.1",
      project: {
        lanes: Object.fromEntries(
          lanes.map((lane): [string, unknown] => [lane.lane, { stack: lane.stack, cwd: lane.cwd }]),
        ),
        defaultLane: lanes.length === 1 ? (lanes[0]?.lane ?? null) : null,
        verbs: Object.fromEntries(lanes.map((lane): [string, unknown] => [lane.lane, lane.verbs])),
        hosts: stackHosts(named),
      },
    },
    stack: named,
    notes,
  };
}

/** What a repository's own `dependency` block pins nen at, or null. */
function declaredRef(root: string): string | null {
  try {
    return loadContract(root).dependency?.pinnedRef ?? null;
  } catch {
    // An absent or malformed contract is not this step's business to report:
    // the declaration step above has already said what it found.
    return null;
  }
}

/** The ref a generated workflow will pin nen at, and what to say about it. */
export interface BootstrapRef {
  readonly ref: string;
  /** Lines to print, empty when the ref is this build's own version. */
  readonly notes: readonly string[];
}

/**
 * The ref a generated CI workflow pins nen at.
 *
 * THREE ANSWERS, IN THIS ORDER, AND THE MINIMUM IS A FLOOR UNDER ALL OF THEM.
 *
 *   1. `--nen-ref vX.Y.Z` -- the caller states it. Validated by shape, and
 *      refused BY NAME below the minimum: a caller who pins a release that
 *      cannot run the workflow has made a typo, not a decision.
 *   2. The repository's own `dependency.pinnedRef`. A repository that carries
 *      one has decided which nen it runs, and a scaffold that wrote a different
 *      ref into its CI would have quietly re-pinned it.
 *   3. This build's own `v${VERSION}` -- the one ref nen can state about itself.
 *
 * AND THEN THE GREATER OF THAT AND `templates/index.json`'s `minimumNenRef`,
 * which is the whole point. `src/version.ts` says which nen WROTE the workflow;
 * the minimum says which nen can RUN it. Between a version bump and the release
 * that publishes it those are different numbers -- v0.3.0 shipped `nen shu`
 * after this build's own version had already moved past the last published
 * release, and writing that ref instead of the floor produced a workflow that
 * was red on the first push of every repository this verb ever scaffolded --
 * the bootstrap refusing at exit 6 before a single verb ran, because the tag
 * exists and no release does.
 *
 * NEN CANNOT CHECK OFFLINE THAT THE REF IT WRITES HAS A RELEASE, and says so
 * rather than implying it did: whenever the written ref is not this build's own
 * version, the notes name it, quote the exit-6 behaviour, and send the caller to
 * the releases page.
 */
export function bootstrapRef(root: string, override: string | undefined): BootstrapRef {
  const minimum = minimumNenRef();
  const own = `v${VERSION}`;
  if (override !== undefined) {
    if (!NEN_REF.test(override)) {
      throw new VerbUsageError(
        `--nen-ref '${override}' is not a release tag (vX.Y.Z). It is written into the generated workflow as the ref the bootstrap fetches, and a value that is not a tag fetches nothing.`,
      );
    }
    if (compareNenRefs(override, minimum.ref) < 0) {
      throw new VerbUsageError(
        `--nen-ref '${override}' is older than ${minimum.ref}, which is the oldest release the generated workflow can run: ${minimum.why} Pass ${minimum.ref} or newer, or write the workflow yourself.`,
      );
    }
    return { ref: override, notes: override === own ? [] : [offlineNote(override, minimum.ref)] };
  }
  const declared = declaredRef(root);
  const chosen = declared ?? own;
  const ref = compareNenRefs(chosen, minimum.ref) < 0 ? minimum.ref : chosen;
  const notes: string[] = [];
  if (declared !== null && ref !== declared) {
    notes.push(
      `this repository's nen/contract.json pins nen at ${declared}, which is older than ${minimum.ref}: ${minimum.why} The workflow is pinned at ${minimum.ref} instead -- re-pin the declaration, or pass --nen-ref to state a ref yourself.`,
    );
  }
  if (ref !== own) notes.push(offlineNote(ref, minimum.ref));
  return { ref, notes };
}

function offlineNote(ref: string, minimum: string): string {
  return `the generated workflow pins nen at ${ref}, not at this binary's own v${VERSION}${ref === minimum ? ` (${minimum} is the oldest release that carries the verbs the workflow runs)` : ""}. nen cannot verify offline that a release exists for ${ref}: a tag is not a release, and until one is published 'bash nen-bootstrap.sh --ref ${ref}' refuses at exit 6 -- the tag exists but no release does, so there is no SHA256SUMS to verify a binary against. Check https://github.com/zheref/nen/releases before the first CI run.`;
}

/** Compare what is on disk with what would be written, byte for byte. */
function existingText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
}

/** The raw bytes on disk, unnormalised. Null when nothing is there. */
function rawText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/**
 * A path a FLAG stated, resolved against the repository and refused if it left.
 *
 * `--hook-path ../outside/evil-hook` used to write an EXECUTABLE outside
 * `--repo` and report success. The rule is ../repo/contain.ts's, shared with
 * `nen shu` -- which asks the same question of a path a declaration states --
 * and the refusal is exit 2 because it is decided before the first write, like
 * every other usage refusal this verb makes.
 */
function containFlag(root: string, value: string, flag: string): string {
  const absolute = containedPath(root, value);
  if (absolute === null) {
    throw new VerbUsageError(
      `${flag} '${value}' resolves to '${resolve(root, value)}', which is outside the repository at ${root}. Every path this verb writes is relative to the repository root, and nen will not write outside the tree --repo pointed it at.`,
    );
  }
  return absolute;
}

/**
 * The same question, asked of the path the KERNEL would write to.
 *
 * A LEXICAL CHECK IS NOT ENOUGH FOR A DIRECTORY NEN CREATES ITSELF. `nen/` and
 * `.github/workflows/` are two directories this verb makes when they are
 * absent; when one is a SYMLINK the write lands wherever it points, and the
 * report still says `nen/contract.json`. Only these two writes are held to it:
 * `.git/` is legitimately a symlink or a gitdir file in a worktree, and a check
 * here would refuse a repository that is merely laid out that way.
 *
 * Returns the refusal sentence, or null when the write may proceed.
 */
function symlinkEscape(root: string, absolute: string, printed: string): string | null {
  const check = realContainment(root, absolute);
  if (check.contained) return null;
  return `'${printed}' would be written to '${check.real}', outside the repository at ${root}: '${check.link ?? absolute}' is a symlink pointing at '${check.target ?? check.real}'. nen writes what its report says it writes, so this write is refused rather than followed -- remove the link, or point --repo at the tree you meant.`;
}

/** The errno a failed filesystem call carried, for a `refused` row. */
function errnoOf(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.message : String(error);
}

export function scaffoldInit(options: ScaffoldInitOptions): ScaffoldInitResult {
  const { root } = options;
  const dry = options.dryRun === true;
  const writes: ScaffoldWrite[] = [];
  const migrated: ScaffoldMigration[] = [];
  const notes: string[] = [];
  const record = (path: string, action: WriteAction, why: string): void => {
    writes.push({ path: repoRelative(root, path), action, why });
  };

  /**
   * One step, whose FILESYSTEM failure is a `refused` row rather than a crash.
   *
   * WHY THE REPORT SURVIVES AN EACCES. Without this, an unwritable `.gitignore`
   * (or a full disk, or a read-only checkout, or a directory sitting where a
   * file goes) threw out of the middle of the run: exit 1, EMPTY stdout under
   * `--json`, and four files already on disk that the caller was never told
   * about. A scaffold's whole contract is that every path it touched is in the
   * report with an outcome beside it, and "it crashed" is the one outcome that
   * cannot be. So the errno becomes a row, the run continues, and the exit code
   * is 1 because a write was refused -- which is exactly what happened.
   *
   * A `VerbUsageError` STILL PROPAGATES. An unsubstituted template token is not
   * a filesystem failure; it is the caller's invocation being wrong, it is exit
   * 2, and swallowing it here would turn a usage error into a mystery row.
   */
  const step = (path: string, run: () => void): void => {
    try {
      run();
    } catch (error) {
      if (error instanceof VerbUsageError) throw error;
      record(
        path,
        "refused",
        `the filesystem refused this write (${errnoOf(error)}). Every step before it stands and is reported above; fix the path or the permission and re-run -- this verb is idempotent, so a second run does only what is left.`,
      );
    }
  };

  // ── 1. the stack, resolved BEFORE the first write ──────────────────────────
  //
  // A refusal here must leave the repository exactly as it was, so it happens
  // before the directory step rather than after it.
  const stackNamed = options.stack !== undefined;
  const accept = options.acceptDetected === true;
  if (stackNamed && accept) {
    throw new VerbUsageError(
      "--stack and --accept-detected say the same thing two ways and can disagree. Pass one: --stack <id> states the stack, --accept-detected takes the proposal 'nen shu detect' prints.",
    );
  }
  if (!stackNamed && !accept) {
    throw new VerbUsageError(
      `scaffold init needs a stack, and nen never guesses one: pass --stack <id> to state it, or --accept-detected to write exactly the proposal '${PROGRAM} shu detect --repo ${root}' prints (seats, notes and all).`,
    );
  }
  // Both flag-stated paths are CONTAINED HERE, before the first write, so a
  // refusal leaves the repository exactly as it was -- and so that `--hook-path`
  // and `--canon-values-path` are answered at exit 2 like every other usage
  // refusal rather than half-way through a report.
  const hookRelative = options.hookPath ?? join(".git", "hooks", "commit-msg");
  const hookPath = containFlag(root, hookRelative, "--hook-path");
  const canonValuesPath =
    options.canonValuesPath === undefined
      ? null
      : containFlag(root, options.canonValuesPath, "--canon-values-path");
  // The workflow's ref is decided here for the same reason: a `--nen-ref` that
  // is not a tag, or is older than the workflow can run, is a usage refusal.
  const bootstrap = bootstrapRef(root, options.nenRef);

  const report = detect(root, options.platform);
  const proposed = proposeProject(report, options.stack, accept);
  const stack = proposed.stack;
  notes.push(...proposed.notes);

  // ── 2. directories, the hook and the canon-values template ─────────────────
  //
  // Unchanged from v0.2.0, in the same order, producing the same bytes.
  const createdDirectories: string[] = [];
  for (const dir of options.directories) {
    step(join(root, dir), (): void => {
      ensureDir(join(root, dir), createdDirectories, dry);
    });
  }

  step(dirname(hookPath), (): void => {
    ensureDir(dirname(hookPath), createdDirectories, dry);
  });
  const desiredHook = renderCommitMsgHook(options.hook);
  // "refused" until a branch below says otherwise: a step whose write the
  // filesystem rejected has not installed a hook, and the summary line must not
  // claim it did.
  let hookOutcome: HookOutcome = "refused";
  let hookError: string | null = null;
  const existingHook = existingText(hookPath);
  if (existingHook !== null && existingHook === desiredHook) {
    // Same content already installed -- nothing to do, and nothing to back up.
    hookOutcome = "unchanged";
    record(hookPath, "skipped", "the same generated hook is already installed");
  } else if (existingHook !== null && options.force !== true) {
    // A DIFFERENT hook already lives here. Writing over it unconditionally
    // would destroy whatever the project already had installed -- with no
    // guard, no backup and no record -- for a script that has no way to know
    // whether that hook was load-bearing. Refuse; --force is the explicit
    // override, and even then a backup is written first (below).
    hookOutcome = "refused";
    hookError = `a different commit-msg hook already exists at '${hookPath}' -- refusing to overwrite it. Pass --force to replace it (the existing hook is backed up to '${hookPath}.bak' first).`;
    record(hookPath, "refused", hookError);
  } else if (dry) {
    hookOutcome = "would-install";
    record(
      hookPath,
      "would-create",
      existingHook === null
        ? "no hook is installed there"
        : "--force would replace a different hook, backing it up to <path>.bak first",
    );
  } else {
    step(hookPath, (): void => {
      if (existingHook !== null) {
        // --force: back up what was there before replacing it, RAW. A backup
        // that normalised the line endings of the file it is preserving would
        // be a backup the caller cannot restore byte for byte.
        writeFileSync(`${hookPath}.bak`, rawText(hookPath) ?? existingHook, "utf8");
      }
      // ONE HOOK WRITER for both verbs (./hook.ts), and the mode is the reason:
      // `git` silently skips a `commit-msg` hook that is not executable.
      writeHookFile(hookPath, desiredHook);
      hookOutcome = "installed";
      record(hookPath, "created", existingHook === null ? "installed" : "--force replaced a different hook");
    });
    if (hookOutcome === "refused") {
      hookError = `the commit-msg hook at '${hookPath}' could not be written -- see the refused row above.`;
    }
  }

  let canonValuesWritten: string | null = null;
  if (canonValuesPath !== null) {
    const path = canonValuesPath;
    step(dirname(path), (): void => {
      ensureDir(dirname(path), createdDirectories, dry);
    });
    if (existsSync(path)) {
      record(path, "skipped", "a canon-values file is already there, and this verb never overwrites one");
    } else if (dry) {
      record(path, "would-create", "nothing is there yet");
    } else {
      step(path, (): void => {
        writeFileSync(path, renderCanonValuesTemplate(options.scenario), "utf8");
        record(path, "created", "the canon-values template");
      });
    }
    canonValuesWritten = path;
  }

  // ── 3. migrate schemas/ -> nen/, BY COPY ───────────────────────────────────
  //
  // Never a move and never a delete. A delete is not recoverable if some tool
  // in the caller's estate still reads the old path, and this verb's hook rule
  // already established refuse-and-report over destroy. The `nen/` copy wins
  // immediately because the loader prefers it, so the caller gets the new
  // behaviour before they get round to the removal -- and `nen schema check`
  // reports the leftover as shadowed until they do.
  const removals: string[] = [];
  for (const file of MIGRATED_FILES) {
    const resolved = resolveSchemaFile(root, file);
    const legacy = resolved.legacy;
    if (legacy === null || !legacy.present) continue;
    // A SYMLINKED LEGACY SOURCE IS NOT A LEGACY TAXONOMY FILE. `copyFileSync`
    // follows the link and copies whatever it points at INTO the repository
    // under a taxonomy file's name, and the printed next step then tells the
    // caller to `git add` it: `schemas/labels.json -> ../../outside/secret.json`
    // is a file this verb would have committed on their behalf. `lstat`, not
    // `stat`, is the whole check.
    const link = ((): string | null => {
      try {
        return lstatSync(legacy.path).isSymbolicLink() ? legacy.path : null;
      } catch {
        return null;
      }
    })();
    if (link !== null) {
      migrated.push({
        from: legacy.relative,
        to: resolved.canonical.relative,
        action: "refused",
        why: `'${legacy.relative}' is a SYMLINK, not a taxonomy file. nen copies bytes it can see into '${resolved.canonical.relative}' and prints the 'git add' that commits them, and following a link would commit whatever it points at under a name that says otherwise. Copy the file yourself if that is what you meant.`,
      });
      continue;
    }
    if (!resolved.canonical.present) {
      if (dry) {
        migrated.push({
          from: legacy.relative,
          to: resolved.canonical.relative,
          action: "would-create",
          why: "the legacy copy is there, the canonical one is not",
        });
        removals.push(legacy.relative);
        continue;
      }
      let copied = false;
      step(resolved.canonical.path, (): void => {
        mkdirSync(dirname(resolved.canonical.path), { recursive: true });
        copyFileSync(legacy.path, resolved.canonical.path);
        migrated.push({
          from: legacy.relative,
          to: resolved.canonical.relative,
          action: "created",
          why: "copied; the original is left in place",
        });
        copied = true;
      });
      // The removal line is printed only for a copy that HAPPENED. Telling a
      // caller to `git rm` a legacy file whose copy the filesystem refused is
      // telling them to delete the only copy there is.
      if (copied) removals.push(legacy.relative);
      continue;
    }
    const shadow = inspectShadow(resolved);
    if (shadow.state === "identical") {
      migrated.push({
        from: legacy.relative,
        to: resolved.canonical.relative,
        action: "skipped",
        why: "both copies are already byte-identical, so the migration is done and only the removal is left",
      });
      removals.push(legacy.relative);
      continue;
    }
    migrated.push({
      from: legacy.relative,
      to: resolved.canonical.relative,
      action: "refused",
      why:
        shadow.state === "different"
          ? `'${legacy.relative}' and '${resolved.canonical.relative}' are both there and their bytes DIFFER. Two disagreeing taxonomies is not a merge nen can make, and there is deliberately no --force: diff them, keep one, delete the other.`
          : `'${legacy.relative}' and '${resolved.canonical.relative}' are both there and could not be compared (${shadow.errno ?? "unknown"}). nen will not copy over a file it could not read.`,
    });
  }
  if (removals.length > 0) {
    notes.push(`next: git rm ${removals.join(" ")} && git add nen/`);
  }

  // ── 4. nen/contract.json, INTO ABSENCE ONLY ────────────────────────────────
  //
  // The same rule `shu detect --write` applies, and for the same reason: a file
  // that is there was written by a human who decided something, and merging two
  // decisions is a human's job with a diff in front of them. The block is
  // printed either way, so a refusal still hands the caller what to paste.
  const contractResolved = resolveSchemaFile(root, CONTRACT_FILE);
  const contractBody = `${JSON.stringify(proposed.document, null, 2)}\n`;
  const existingContract = existingText(contractResolved.canonical.path);
  if (existingContract === contractBody) {
    // THE ONE PLACE THIS VERB IS MORE PERMISSIVE THAN `shu detect --write`,
    // and it is idempotence rather than a loosening. `detect --write` refuses
    // on PRESENCE, full stop, because it is a one-shot proposal verb. `scaffold
    // init` promises that a second run changes nothing and says so per item --
    // so a file whose bytes are already exactly what this run would write is
    // `skipped`, exactly as the commit-msg hook is. Any other content is still
    // refused: that file is a decision somebody made, and merging two decisions
    // is a human's job with a diff in front of them.
    record(contractResolved.canonical.path, "skipped", "the same declaration is already there");
  } else if (contractResolved.canonical.present) {
    record(
      contractResolved.canonical.path,
      "refused",
      `${contractResolved.canonical.relative} already exists with different content, and this verb never overwrites a declaration -- a declaration is a decision. The block to merge is printed above; there is deliberately no --force.`,
    );
    notes.push(contractBody.trimEnd());
  } else if (dry) {
    record(contractResolved.canonical.path, "would-create", "no declaration is there yet");
    notes.push(contractBody.trimEnd());
  } else {
    // THE ONE PLACE A LEXICAL CHECK IS NOT ENOUGH: this write CREATES `nen/`
    // when it is absent, and a symlinked `nen/` sends it out of the tree while
    // the report still says `nen/contract.json`.
    const escape = symlinkEscape(
      root,
      contractResolved.canonical.path,
      contractResolved.canonical.relative,
    );
    if (escape !== null) {
      record(contractResolved.canonical.path, "refused", escape);
    } else {
      step(contractResolved.canonical.path, (): void => {
        mkdirSync(dirname(contractResolved.canonical.path), { recursive: true });
        writeFileSync(contractResolved.canonical.path, contractBody, "utf8");
        record(contractResolved.canonical.path, "created", "the project block, written into absence");
      });
    }
  }

  // ── 5. the stack's CI workflow ─────────────────────────────────────────────
  const template = stack === null ? null : templateForStack(stack);
  if (stack === null) {
    notes.push(
      "no single stack: this proposal declares lanes for more than one, so no CI workflow is added. Re-run per stack with --stack <id> if you want one.",
    );
  } else if (template === null) {
    notes.push(
      `no CI workflow: the catalogue proposes no template for '${stack}', so nen has none to add. Write the workflow yourself; every step in it is 'nen shu <verb> --repo .'.`,
    );
  } else {
    const ciPath = join(root, ...template.ci.path.split("/"));
    const body = substitute(
      template.ci.body,
      { runner: template.runner, nenRef: bootstrap.ref },
      `the '${template.template}' CI template`,
    );
    const existing = existingText(ciPath);
    if (existing === body) {
      record(ciPath, "skipped", "the same workflow is already there");
    } else if (existing !== null) {
      record(
        ciPath,
        "refused",
        `a DIFFERENT file already exists at '${template.ci.path}' -- refusing to overwrite it, the same rule the commit-msg hook follows. Diff it against the template and keep the one you mean.`,
      );
    } else if (dry) {
      record(ciPath, "would-create", `the '${template.template}' template's workflow for ${stack}`);
      notes.push(...bootstrap.notes);
    } else {
      // `.github/workflows/` is the second directory this verb creates, and is
      // held to the same real-path rule as `nen/` for the same reason.
      const escape = symlinkEscape(root, ciPath, template.ci.path);
      if (escape !== null) {
        record(ciPath, "refused", escape);
      } else {
        step(ciPath, (): void => {
          mkdirSync(dirname(ciPath), { recursive: true });
          writeFileSync(ciPath, body, "utf8");
          record(ciPath, "created", `the '${template.template}' template's workflow for ${stack}`);
          notes.push(...bootstrap.notes);
        });
      }
    }
  }

  // ── 6. .gitignore upkeep ───────────────────────────────────────────────────
  //
  // APPEND ONLY. It never rewrites the file and never reorders it: a
  // `.gitignore` is a file people edit, and a scaffold that normalised one
  // would produce a diff nobody asked for on every run.
  const gitignorePath = join(root, GITIGNORE_FILE);
  // THE RAW BYTES ARE WHAT GETS WRITTEN BACK, and only a NORMALISED copy is
  // scanned. Reading through existingText() and writing the result back
  // rewrote a CRLF `.gitignore` wholesale -- every line of it, in a diff nobody
  // asked for -- under a comment promising the file is never rewritten. The
  // appended line matches the file's own ending for the same reason: a lone LF
  // in a CRLF file is a line some Windows tools do not see at all.
  // A read that FAILS is not an absence: `.gitignore` being a directory, or
  // unreadable, must become a `refused` row rather than "there was nothing
  // there, so create one" -- which is how a crash used to escape this step.
  let gitignore: string | null = null;
  let unreadable: unknown = null;
  try {
    gitignore = rawText(gitignorePath);
  } catch (error) {
    unreadable = error;
  }
  const alreadyIgnored =
    gitignore !== null &&
    gitignore.replace(/\r\n/g, "\n").split("\n").some((line): boolean => line.trim() === GITIGNORE_ENTRY);
  const eol = gitignore !== null && gitignore.includes("\r\n") ? "\r\n" : "\n";
  const gitignoreBlock = [
    "# nen writes generated output here; committed configuration lives in nen/.",
    GITIGNORE_ENTRY,
    "",
  ].join(eol);
  if (unreadable !== null) {
    record(
      gitignorePath,
      "refused",
      `'${GITIGNORE_FILE}' could not be read (${errnoOf(unreadable)}), so nen cannot tell whether '${GITIGNORE_ENTRY}' is already there -- and it will not append to a file it could not read. Every step before this one stands and is reported above.`,
    );
  } else if (alreadyIgnored) {
    record(gitignorePath, "skipped", `'${GITIGNORE_ENTRY}' is already ignored`);
  } else if (dry) {
    record(
      gitignorePath,
      gitignore === null ? "would-create" : "would-append",
      gitignore === null
        ? `create it, ignoring '${GITIGNORE_ENTRY}'`
        : `append '${GITIGNORE_ENTRY}'; nothing else in the file is touched`,
    );
  } else {
    const prefix = gitignore === null || gitignore === "" || /\r?\n$/.test(gitignore) ? "" : eol;
    step(gitignorePath, (): void => {
      writeFileSync(gitignorePath, `${gitignore ?? ""}${prefix}${gitignoreBlock}`, "utf8");
      record(
        gitignorePath,
        gitignore === null ? "created" : "appended",
        gitignore === null ? `created, ignoring '${GITIGNORE_ENTRY}'` : `appended '${GITIGNORE_ENTRY}'`,
      );
    });
  }

  // ── 7. the closing toolchain check ─────────────────────────────────────────
  //
  // LAST, AND IT INSTALLS NOTHING. Scaffolding succeeded; whether this host can
  // build the thing is a separate question with its own verb and its own exit
  // code. A `scaffold init` that failed because an IDE is absent would be
  // permanently red on every machine that is not already set up, CI runners
  // that legitimately never build this stack included.
  //
  // A DRY RUN DOES NOT CALL IT AT ALL. That is what makes `--dry-run` the form
  // ../parse/izanami.ts can certify read-only: not "it spawns something
  // harmless", but "there is no call".
  let tools: ToolsOutcome | null = null;
  if (dry) {
    notes.push(
      `would check: '${PROGRAM} shu tools --repo ${root}' runs last and installs nothing. A dry run spawns nothing at all, probes included, so no host was looked at.`,
    );
  } else if (options.tools !== undefined) {
    tools = options.tools(options.installTools === true);
  }

  const refused =
    writes.some((write): boolean => write.action === "refused") ||
    migrated.some((entry): boolean => entry.action === "refused");

  return {
    contract: SCAFFOLD_INIT_CONTRACT,
    createdDirectories,
    hookWritten: hookPath,
    hookOutcome,
    hookError,
    canonValuesWritten,
    stack,
    writes,
    migrated,
    notes,
    tools,
    exitCode: refused ? 1 : 0,
  };
}
