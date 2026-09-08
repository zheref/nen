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
import { dirname, isAbsolute, join } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { looksLikeOwnerSlug } from "../repo/root.js";
import { CONTRACT_FILE } from "../schema/source.js";
import { detect } from "../shu/detect.js";
import { PROGRAM } from "../version.js";
import { renderCommitMsgHook, writeHookFile, type HookSpec } from "./hook.js";
import { bootstrapRef, type ScaffoldWrite, type WriteAction } from "./init.js";
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
  /** The host `nen shu detect`'s `{gw}` resolution answers for. */
  readonly platform: NodeJS.Platform;
  /** The trailer convention. Omitted, the hook is a printed post-step. */
  readonly hook?: HookSpec;
  /** The nen release the generated workflow pins. Omitted, nen chooses one. */
  readonly nenRef?: string;
  /** Print the tree and write nothing. */
  readonly dryRun?: boolean;
}

/**
 * `--dir`, in the spelling every printed post-step can actually be pasted with.
 *
 * SEVEN OF THIS VERB'S EIGHT POST-STEPS PASS `--dir`'s VALUE TO `--repo`, and
 * `--repo` refuses an `owner/name`-shaped value by design (../repo/root.ts):
 * `--dir parity/nextjs` produced five post-steps that refuse at exit 2 when
 * pasted. Two rules, and they are the CLI's existing ones rather than new ones:
 *
 *   * A one-slash relative value reads as a slug and is refused HERE, at exit 2,
 *     with the same way out `--repo` offers -- spell it `./parity/nextjs` if a
 *     path is what was meant. Guessing would make `--dir` the one flag in this
 *     CLI that resolves the ambiguity silently.
 *   * Every other relative value is `./`-prefixed for the post-steps, so
 *     `a/b/c` prints as `./a/b/c` and is a path to every verb that reads it.
 *
 * An absolute value is already unambiguous and is returned unchanged.
 */
export function postStepDir(dir: string): string {
  if (looksLikeOwnerSlug(dir)) {
    throw new VerbUsageError(
      `--dir '${dir}' reads as an owner/name slug, and this verb writes to a filesystem PATH. Every post-step it prints passes this value to --repo, which refuses a slug by name -- so spell it './${dir}' if that is the directory you meant.`,
    );
  }
  if (isAbsolute(dir) || dir.startsWith("./") || dir.startsWith("../")) return dir;
  if (dir.startsWith(".\\") || dir.startsWith("..\\")) return dir;
  return `./${dir}`;
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
  // The `--dir` spelling every post-step below is printed with -- and the one
  // this verb reports. Refused before the first write when it is ambiguous.
  const dir = postStepDir(options.dir);
  // The ref the workflow pins, decided before any write: a `--nen-ref` that is
  // not a tag, or is older than the workflow can run, is a usage refusal. A
  // fresh tree has no declaration to read a pin out of yet, so the answer is
  // the greater of this build's version and the template pack's minimum.
  const bootstrap = bootstrapRef(dir, options.nenRef);
  requireEmptyDir(dir);

  const writes: ScaffoldWrite[] = [];
  const notes: string[] = [];
  const values = { name: options.name, stack: options.stack };

  /**
   * One file of the tree.
   *
   * A FILESYSTEM FAILURE IS A `refused` ROW, not a crash: the same rule
   * `scaffold init` follows, and for the same reason -- a run that already
   * wrote three files and then threw left the caller with a tree and no report
   * of it.
   */
  const put = (relativePath: string, body: string, why: string, write: (path: string) => void): void => {
    if (dry) {
      writes.push({ path: relativePath, action: "would-create", why });
      return;
    }
    const path = join(dir, ...relativePath.split("/"));
    let action: WriteAction = "created";
    let reason = why;
    try {
      mkdirSync(dirname(path), { recursive: true });
      write(path);
    } catch (error) {
      action = "refused";
      const code = (error as NodeJS.ErrnoException).code;
      reason = `the filesystem refused this write (${typeof code === "string" ? code : String(error)}). Every file written before it is reported above; this tree is incomplete.`;
    }
    writes.push({ path: relativePath, action, why: reason });
  };

  const putText = (relativePath: string, body: string, why: string): void => {
    put(relativePath, body, why, (path): void => {
      writeFileSync(path, body, "utf8");
    });
  };

  for (const file of template.freshTree) {
    putText(
      file.path,
      substitute(file.body, values, `the '${template.template}' template's ${file.path}`),
      `the '${template.template}' template`,
    );
  }
  putText(
    template.ci.path,
    substitute(
      template.ci.body,
      { ...values, runner: template.runner, nenRef: bootstrap.ref },
      `the '${template.template}' CI template`,
    ),
    `the '${template.template}' template's workflow for ${options.stack}`,
  );
  notes.push(...bootstrap.notes);

  // The hook, ONLY when the caller stated the convention it enforces. Which
  // two trailer keys mark an automated commit, and which environment variable
  // marks the run, are the target system's own vocabulary -- nen ships none,
  // and inventing a pair here would bake one system's convention into every
  // project this verb ever writes.
  const hookPath = ".git/hooks/commit-msg";
  const postSteps: string[] = [`cd ${dir} && git init && git add -A && git commit -m "chore: scaffold"`];
  if (options.hook !== undefined) {
    const body = renderCommitMsgHook(options.hook);
    // THROUGH ./hook.ts's WRITER, exactly as `scaffold init` does. A hook
    // written 0644 is one `git` skips in silence on every commit, and this verb
    // shipped one for as long as it had a writer of its own.
    put(hookPath, body, "the trailer-enforcing commit-msg hook", (path): void => {
      writeHookFile(path, body);
    });
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
      `${PROGRAM} scaffold init --repo ${dir} --stack ${options.stack} --agent-trailer <key> --run-trailer <key> --marker-env <VAR>`,
    );
  }
  postSteps.push(
    `${PROGRAM} shu detect --repo ${dir}            # re-propose the rows it withheld, once the manifest answers`,
  );
  postSteps.push(`${PROGRAM} shu tools --repo ${dir}            # checks the host; --install acts`);
  postSteps.push(`${PROGRAM} shu build --repo ${dir} --dry-run  # confirm the declaration`);

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
      `a dry run writes nothing, so the declaration is described rather than shown: it is exactly what '${PROGRAM} shu detect --repo ${dir}' prints once the tree exists.`,
    );
  } else {
    const report = detect(dir, options.platform);
    if (report.proposal === null) {
      writes.push({
        path: CONTRACT_FILE,
        action: "refused",
        why: `the tree was written, but '${PROGRAM} shu detect' found no lane in it -- so there is nothing to declare, and nen will not write a declaration it did not derive from a marker. This is a defect in the '${template.template}' template for '${options.stack}'.`,
      });
    } else {
      const body = `${JSON.stringify(report.proposal, null, 2)}\n`;
      putText(
        CONTRACT_FILE,
        body,
        `proposed by '${PROGRAM} shu detect' off the marker this verb wrote, seats and all`,
      );
      notes.push(...report.notes);
    }
  }

  const refused = writes.some((write): boolean => write.action === "refused");
  return {
    contract: SCAFFOLD_NEW_CONTRACT,
    stack: options.stack,
    name: options.name,
    dir,
    writes,
    migrated: [],
    postSteps,
    notes,
    tools: null,
    exitCode: refused ? 1 : 0,
  };
}
