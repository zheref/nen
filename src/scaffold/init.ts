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

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { loadContract } from "../schema/contract.js";
import {
  CONTRACT_FILE,
  LEGACY_MIGRATABLE_FILES,
  inspectShadow,
  resolveSchemaFile,
} from "../schema/source.js";
import { detect, type DetectReport } from "../shu/detect.js";
import { PROGRAM, VERSION } from "../version.js";
import { renderCommitMsgHook, type HookSpec } from "./hook.js";
import { stackHosts, substitute, templateForStack } from "./templates.js";

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
 * FOUR VALUES, AND `skipped` IS NOT A SYNONYM FOR `created`. "It was already
 * exactly this" and "nen wrote it" are different facts about the repository,
 * and an idempotent second run has to be able to say which one it is for every
 * line it prints -- otherwise "idempotent" is a claim rather than an
 * observation.
 */
export type WriteAction = "created" | "skipped" | "would-create" | "refused";

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

/**
 * The ref a generated CI workflow pins nen at.
 *
 * THE REPOSITORY'S OWN ANSWER WINS. A repository that already carries a
 * `dependency` block has decided which nen it runs, and a scaffold that wrote a
 * different ref into its CI would have quietly re-pinned it. Only when there is
 * no such block does the running binary's own version answer, which is the one
 * ref nen can state about itself.
 */
function bootstrapRef(root: string): string {
  try {
    return loadContract(root).dependency?.pinnedRef ?? `v${VERSION}`;
  } catch {
    // An absent or malformed contract is not this step's business to report:
    // the declaration step above has already said what it found.
    return `v${VERSION}`;
  }
}

/** Compare what is on disk with what would be written, byte for byte. */
function existingText(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8").replace(/\r\n/g, "\n") : null;
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
  const report = detect(root);
  const proposed = proposeProject(report, options.stack, accept);
  const stack = proposed.stack;
  notes.push(...proposed.notes);

  // ── 2. directories, the hook and the canon-values template ─────────────────
  //
  // Unchanged from v0.2.0, in the same order, producing the same bytes.
  const createdDirectories: string[] = [];
  for (const dir of options.directories) {
    ensureDir(join(root, dir), createdDirectories, dry);
  }

  const hookPath = join(root, options.hookPath ?? join(".git", "hooks", "commit-msg"));
  ensureDir(dirname(hookPath), createdDirectories, dry);
  const desiredHook = renderCommitMsgHook(options.hook);
  let hookOutcome: HookOutcome;
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
    if (existingHook !== null) {
      // --force: back up what was there before replacing it.
      writeFileSync(`${hookPath}.bak`, existingHook, "utf8");
    }
    writeFileSync(hookPath, desiredHook, "utf8");
    try {
      chmodSync(hookPath, 0o755);
    } catch {
      // Windows filesystems that do not model the POSIX executable bit --
      // git itself only consults it on a POSIX checkout, so a failed chmod
      // here is not a failure of the hook install.
    }
    hookOutcome = "installed";
    record(hookPath, "created", existingHook === null ? "installed" : "--force replaced a different hook");
  }

  let canonValuesWritten: string | null = null;
  if (options.canonValuesPath !== undefined) {
    const path = join(root, options.canonValuesPath);
    ensureDir(dirname(path), createdDirectories, dry);
    if (existsSync(path)) {
      record(path, "skipped", "a canon-values file is already there, and this verb never overwrites one");
    } else if (dry) {
      record(path, "would-create", "nothing is there yet");
    } else {
      writeFileSync(path, renderCanonValuesTemplate(options.scenario), "utf8");
      record(path, "created", "the canon-values template");
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
    if (!resolved.canonical.present) {
      if (dry) {
        migrated.push({
          from: legacy.relative,
          to: resolved.canonical.relative,
          action: "would-create",
          why: "the legacy copy is there, the canonical one is not",
        });
      } else {
        mkdirSync(dirname(resolved.canonical.path), { recursive: true });
        copyFileSync(legacy.path, resolved.canonical.path);
        migrated.push({
          from: legacy.relative,
          to: resolved.canonical.relative,
          action: "created",
          why: "copied; the original is left in place",
        });
      }
      removals.push(legacy.relative);
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
    mkdirSync(dirname(contractResolved.canonical.path), { recursive: true });
    writeFileSync(contractResolved.canonical.path, contractBody, "utf8");
    record(contractResolved.canonical.path, "created", "the project block, written into absence");
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
      { runner: template.runner, nenRef: bootstrapRef(root) },
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
    } else {
      mkdirSync(dirname(ciPath), { recursive: true });
      writeFileSync(ciPath, body, "utf8");
      record(ciPath, "created", `the '${template.template}' template's workflow for ${stack}`);
    }
  }

  // ── 6. .gitignore upkeep ───────────────────────────────────────────────────
  //
  // APPEND ONLY. It never rewrites the file and never reorders it: a
  // `.gitignore` is a file people edit, and a scaffold that normalised one
  // would produce a diff nobody asked for on every run.
  const gitignorePath = join(root, GITIGNORE_FILE);
  const gitignore = existingText(gitignorePath);
  const alreadyIgnored =
    gitignore !== null &&
    gitignore.split("\n").some((line): boolean => line.trim() === GITIGNORE_ENTRY);
  const gitignoreBlock = `# nen writes generated output here; committed configuration lives in nen/.\n${GITIGNORE_ENTRY}\n`;
  if (alreadyIgnored) {
    record(gitignorePath, "skipped", `'${GITIGNORE_ENTRY}' is already ignored`);
  } else if (dry) {
    record(gitignorePath, "would-create", `append '${GITIGNORE_ENTRY}'; nothing else in the file is touched`);
  } else {
    const prefix = gitignore === null || gitignore === "" || gitignore.endsWith("\n") ? "" : "\n";
    writeFileSync(gitignorePath, `${gitignore ?? ""}${prefix}${gitignoreBlock}`, "utf8");
    record(
      gitignorePath,
      "created",
      gitignore === null ? `created, ignoring '${GITIGNORE_ENTRY}'` : `appended '${GITIGNORE_ENTRY}'`,
    );
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
