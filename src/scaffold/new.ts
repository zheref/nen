// src/scaffold/new.ts -- `nen scaffold new`, on a FRESH tree.
//
// WHAT IT IS, AND WHAT IT DELIBERATELY IS NOT. It writes the nen-owned slice of
// a new project -- the manifest that identifies the stack, `nen/contract.json`,
// the CI workflow, `.gitignore`, and the commit-msg hook when the caller states
// the trailer convention -- and nothing else. It sits BESIDE a full project
// scaffolder rather than replacing one: a generator that lays out a framework's
// own source tree is that framework's job, and every step of it here would be
// nen deciding a project's shape from a catalogue entry.
//
// EVERY POST-STEP IS PRINTED AND NONE IS RUN. No repository is initialised, no
// dependency is installed, no native project is generated, and no network call
// is made -- including the toolchain check, which `scaffold init` runs and this
// verb only names. Writing into a fresh directory and writing to the host are
// two different consents, and a verb that took the first as the second would be
// the one place in this CLI where a `--dir` typo reaches a package manager.
//
// THE DECLARATION IS `shu detect`'s OWN PROPOSAL, read back off the tree this
// verb just wrote. That is what makes "scaffolded a project" and "declared a
// stack" one fact instead of two that can disagree: the marker file is written,
// `detect` finds it, and the block written to `nen/contract.json` is
// byte-identical to what `nen shu detect --write` would have written standing
// in that directory a second later. ./new.test.ts asserts exactly that.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { CONTRACT_FILE } from "../schema/source.js";
import { detect } from "../shu/detect.js";
import { PROGRAM, VERSION } from "../version.js";
import { renderCommitMsgHook, type HookSpec } from "./hook.js";
import type { ScaffoldWrite } from "./init.js";
import { substitute, templateForStack } from "./templates.js";

/** `nen.scaffold.new/v0.1` -- this verb's own versioned contract string. */
export const SCAFFOLD_NEW_CONTRACT = "nen.scaffold.new/v0.1";

/**
 * The shape a `--name` must have.
 *
 * IT IS SPLICED INTO EVERY TEMPLATE BODY, and two of those bodies are JSON. A
 * name carrying a quote would produce a manifest that no tool can parse and
 * that this verb reported as written; a name carrying a path separator would
 * produce one somewhere else entirely. The same positive allowlist the stack id
 * is held to, for the same reason.
 */
const PROJECT_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export interface ScaffoldNewOptions {
  readonly stack: string;
  readonly name: string;
  /** The directory to create. Must not exist, or must be empty. */
  readonly dir: string;
  /** The trailer convention. Omitted, the hook is a printed post-step. */
  readonly hook?: HookSpec;
  /** Print the tree and write nothing. */
  readonly dryRun?: boolean;
}

export interface ScaffoldNewResult {
  readonly contract: string;
  readonly stack: string;
  readonly name: string;
  readonly dir: string;
  readonly writes: readonly ScaffoldWrite[];
  /** Nothing is ever migrated on a fresh tree; the key is here so both verbs' documents read alike. */
  readonly migrated: readonly never[];
  /** Printed, never run. */
  readonly postSteps: readonly string[];
  readonly notes: readonly string[];
  /** Always null: this verb names the toolchain check and never runs it. */
  readonly tools: null;
  readonly exitCode: number;
}

/**
 * Refuse anything but an empty or absent `--dir`.
 *
 * NO MERGE AND NO `--force`. A directory with something in it is a directory
 * somebody is using, and the failure a merge produces here is a half-scaffolded
 * tree whose declaration describes files that were skipped.
 */
function requireEmptyDir(dir: string): void {
  if (!existsSync(dir)) return;
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    throw new VerbUsageError(
      `--dir '${dir}' could not be read (${(error as NodeJS.ErrnoException).code ?? String(error)}). A fresh tree is written into an empty directory or a new one.`,
    );
  }
  if (entries.length > 0) {
    throw new VerbUsageError(
      `--dir '${dir}' is not empty (${entries.length} ${entries.length === 1 ? "entry" : "entries"}). 'scaffold new' writes a FRESH tree and never merges into one that exists; point it somewhere new, or run '${PROGRAM} scaffold init --repo ${dir}' to add nen's files to what is already there.`,
    );
  }
}

export function scaffoldNew(options: ScaffoldNewOptions): ScaffoldNewResult {
  const dry = options.dryRun === true;
  if (!PROJECT_NAME.test(options.name)) {
    throw new VerbUsageError(
      `--name '${options.name}' is not a project name ([A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]). It is written into this tree's own manifest, and a name that has to be escaped first was never one.`,
    );
  }
  const template = templateForStack(options.stack);
  if (template === null) {
    throw new VerbUsageError(
      `the catalogue proposes no scaffold template for '${options.stack}', so nen has no tree to write. Create the project with its own generator, then run '${PROGRAM} scaffold init --repo <path> --stack ${options.stack}'.`,
    );
  }
  if (template.noFreshTree !== null) {
    throw new VerbUsageError(
      `'scaffold new' has no fresh-tree form for '${options.stack}': ${template.noFreshTree}`,
    );
  }
  requireEmptyDir(options.dir);

  const writes: ScaffoldWrite[] = [];
  const notes: string[] = [];
  const values = { name: options.name, stack: options.stack };

  const put = (relativePath: string, body: string, why: string): void => {
    if (dry) {
      writes.push({ path: relativePath, action: "would-create", why });
      return;
    }
    const path = join(options.dir, ...relativePath.split("/"));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
    writes.push({ path: relativePath, action: "created", why });
  };

  for (const file of template.freshTree) {
    put(
      file.path,
      substitute(file.body, values, `the '${template.template}' template's ${file.path}`),
      `the '${template.template}' template`,
    );
  }
  put(
    template.ci.path,
    substitute(
      template.ci.body,
      { ...values, runner: template.runner, nenRef: `v${VERSION}` },
      `the '${template.template}' CI template`,
    ),
    `the '${template.template}' template's workflow for ${options.stack}`,
  );

  // The hook, ONLY when the caller stated the convention it enforces. Which
  // two trailer keys mark an automated commit, and which environment variable
  // marks the run, are the target system's own vocabulary -- nen ships none,
  // and inventing a pair here would bake one system's convention into every
  // project this verb ever writes.
  const hookPath = ".git/hooks/commit-msg";
  const postSteps: string[] = [`cd ${options.dir} && git init && git add -A && git commit -m "chore: scaffold"`];
  if (options.hook !== undefined) {
    put(hookPath, renderCommitMsgHook(options.hook), "the trailer-enforcing commit-msg hook");
  } else {
    writes.push({
      path: hookPath,
      action: "skipped",
      why: "no trailer convention was stated (--agent-trailer, --run-trailer, --marker-env), and nen ships none. The post-steps name the invocation that installs it.",
    });
  }

  postSteps.push(...template.postSteps);
  if (options.hook === undefined) {
    postSteps.push(
      `${PROGRAM} scaffold init --repo ${options.dir} --stack ${options.stack} --agent-trailer <key> --run-trailer <key> --marker-env <VAR>`,
    );
  }
  postSteps.push(
    `${PROGRAM} shu detect --repo ${options.dir}            # re-propose the rows it withheld, once the manifest answers`,
  );
  postSteps.push(`${PROGRAM} shu tools --repo ${options.dir}            # checks the host; --install acts`);
  postSteps.push(`${PROGRAM} shu build --repo ${options.dir} --dry-run  # confirm the declaration`);

  // The declaration, read back off the tree this verb just wrote. On a dry run
  // there is no tree to read, so the row says what would be written and where
  // it would come from rather than inventing a block from the same catalogue by
  // a second route -- two routes to one document is how the two drift.
  if (dry) {
    writes.push({
      path: CONTRACT_FILE,
      action: "would-create",
      why: `proposed by '${PROGRAM} shu detect' off the marker written above -- the same block '${PROGRAM} shu detect --write' writes, seats and all`,
    });
    notes.push(
      `a dry run writes nothing, so the declaration is described rather than shown: it is exactly what '${PROGRAM} shu detect --repo ${options.dir}' prints once the tree exists.`,
    );
  } else {
    const report = detect(options.dir);
    if (report.proposal === null) {
      writes.push({
        path: CONTRACT_FILE,
        action: "refused",
        why: `the tree was written, but '${PROGRAM} shu detect' found no lane in it -- so there is nothing to declare, and nen will not write a declaration it did not derive from a marker. This is a defect in the '${template.template}' template for '${options.stack}'.`,
      });
    } else {
      const path = join(options.dir, ...CONTRACT_FILE.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify(report.proposal, null, 2)}\n`, "utf8");
      writes.push({
        path: CONTRACT_FILE,
        action: "created",
        why: `proposed by '${PROGRAM} shu detect' off the marker this verb wrote, seats and all`,
      });
      notes.push(...report.notes);
    }
  }

  const refused = writes.some((write): boolean => write.action === "refused");
  return {
    contract: SCAFFOLD_NEW_CONTRACT,
    stack: options.stack,
    name: options.name,
    dir: options.dir,
    writes,
    migrated: [],
    postSteps,
    notes,
    tools: null,
    exitCode: refused ? 1 : 0,
  };
}
