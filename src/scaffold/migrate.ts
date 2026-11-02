// src/scaffold/migrate.ts -- `nen scaffold migrate`: write the `nen/` files a
// repository scaffolded before they existed is missing, and nothing else
// (zheref/nen#592).
//
// WHY A VERB OF ITS OWN AND NOT A MODE OF `init`. `init` needs a stack and a
// marker variable before it writes a byte, installs hooks, adds a CI file and
// probes the host -- a lot to ask of a caller whose only problem is that
// `nen schema check` warned about `nen/gates.json`. This verb takes `--repo`
// and nothing else that changes what it writes.
//
// THE THREE PROMISES, each held by ./migrate.test.ts:
//   1. ONLY ABSENCE IS WRITTEN. A path that exists in ANY form -- a file, a
//      directory, a symlink dangling or not, a file this process cannot read --
//      is reported `kept` and never opened, read or compared. The repository's
//      own config is not this verb's to judge; `nen schema check` judges it.
//   2. IDEMPOTENT. A second run finds every seeded file present and writes
//      nothing, so it reports every row `kept` and exits 0.
//   3. READ BACK. A file this verb wrote is loaded through the same loader
//      `schema check` uses before it is reported `created`; a seed that does
//      not load is exit 1 naming the pointer, never a quiet success.
//
// THE WRITE IS AN EXCLUSIVE CREATE (`wx`), so a file that appears between the
// probe and the write -- another process, another session -- fails the create
// rather than being overwritten. And a `nen/` that is a symlink is refused
// before anything is written through it: following it would put a file
// outside the repository under a taxonomy name.

import { lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadColorVocabulary } from "../schema/colors.js";
import { SchemaError } from "../schema/errors.js";
import { loadGateIdentities } from "../schema/gates.js";
import { COLORS_FILE, GATES_FILE, resolveSchemaFile } from "../schema/source.js";
import { PROGRAM } from "../version.js";
import { probePath, SEEDS, shellWord, type Seed } from "./seeds.js";

export const SCAFFOLD_MIGRATE_CONTRACT = "nen.scaffold.migrate/v0.1";

/**
 * What happened to one seeded path.
 *
 * `kept` IS NOT `skipped`: `init`'s `skipped` says "it was already exactly
 * this", a comparison. This verb never compares -- it says only that something
 * is there and was left alone.
 */
export type MigrateAction = "created" | "would-create" | "kept" | "refused";

export interface MigrateRow {
  /** Repo-relative, forward-slashed. */
  readonly file: string;
  readonly action: MigrateAction;
  readonly why: string;
}

export interface ScaffoldMigrateResult {
  readonly contract: typeof SCAFFOLD_MIGRATE_CONTRACT;
  readonly repo: string;
  readonly dryRun: boolean;
  readonly files: readonly MigrateRow[];
  /** 0 when nothing was refused; 1 otherwise. */
  readonly exitCode: 0 | 1;
}

export interface ScaffoldMigrateOptions {
  readonly root: string;
  readonly dryRun: boolean;
  /** A test seam: the seeds to write. Defaults to every seed. */
  readonly seeds?: readonly Seed[];
}

// The loader each seeded file is read back through: `schema check`'s own, so
// "created" means "and `schema check` will read it".
const READ_BACK: Readonly<Record<string, (root: string) => string>> = {
  [COLORS_FILE]: (root): string => `${loadColorVocabulary(root).categories.length} categories`,
  [GATES_FILE]: (root): string => `${loadGateIdentities(root).reviewers.length} reviewer(s)`,
};

function nenDirectoryRefusal(root: string): string | null {
  const dir = join(root, "nen");
  try {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) {
      return "'nen/' is a symlink. nen writes a declaration as a file of this repository, and creating one through a link would put it wherever the link points.";
    }
    if (!stat.isDirectory()) return "'nen' exists and is not a directory.";
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    return `'nen/' could not be inspected (${code ?? String(error)}).`;
  }
}

export function scaffoldMigrate(options: ScaffoldMigrateOptions): ScaffoldMigrateResult {
  const { root, dryRun } = options;
  const seeds = options.seeds ?? SEEDS;
  const files: MigrateRow[] = [];
  const dirRefusal = nenDirectoryRefusal(root);

  for (const seed of seeds) {
    const resolved = resolveSchemaFile(root, seed.file);
    const state = probePath(resolved.path);
    if (state.kind === "present") {
      files.push({ file: seed.file, action: "kept", why: "already there; left untouched and unread" });
      continue;
    }
    // NOT KNOWN IS NOT "ALREADY THERE". An errno other than ENOENT (EACCES on
    // a parent, say) means this process cannot tell; claiming the file exists
    // would be a guess, and writing would be a worse one.
    if (state.kind === "unknown") {
      files.push({ file: seed.file, action: "refused", why: `could not be inspected (${state.code}); nothing was written` });
      continue;
    }
    // A LEGACY COPY IS THE REPOSITORY'S OWN CONFIG, sitting where nen no longer
    // looks. Seeding over its absence would hide it behind defaults it never
    // chose; `init`'s copy step is the migration that keeps it.
    if (resolved.legacy !== null && resolved.legacy.present) {
      files.push({
        file: seed.file,
        action: "refused",
        why: `a legacy '${resolved.legacy.relative}' is there and holds this repository's own config. Run '${PROGRAM} scaffold init --accept-detected' (or copy it) to migrate it; a seed would shadow it.`,
      });
      continue;
    }
    if (dirRefusal !== null) {
      files.push({ file: seed.file, action: "refused", why: dirRefusal });
      continue;
    }
    if (dryRun) {
      files.push({ file: seed.file, action: "would-create", why: `absent; would write ${seed.what}` });
      continue;
    }
    try {
      mkdirSync(dirname(resolved.path), { recursive: true });
      // RE-CHECKED AFTER THE mkdir, RIGHT BEFORE THE WRITE (Feitan F3 on
      // #592). The first check ran before the loop; `mkdirSync` accepts an
      // existing symlink-to-directory and `writeFileSync` follows one, so a
      // `nen/` swapped for a link in between would land the seed wherever it
      // points. This narrows that window to the one syscall pair.
      const lateRefusal = nenDirectoryRefusal(root);
      if (lateRefusal !== null) {
        files.push({ file: seed.file, action: "refused", why: lateRefusal });
        continue;
      }
      writeFileSync(resolved.path, seed.text, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      files.push({
        file: seed.file,
        action: "refused",
        why:
          code === "EEXIST"
            ? "appeared between the check and the write; left untouched"
            : `could not be written (${code ?? String(error)})`,
      });
      continue;
    }
    const readBack = READ_BACK[seed.file];
    try {
      const summary = readBack === undefined ? "written" : readBack(root);
      files.push({ file: seed.file, action: "created", why: `wrote ${seed.what}; read back: ${summary}` });
    } catch (error) {
      // THE FILE IS REMOVED, so the refusal survives a re-run: left in place,
      // a second run would find it present and report `kept`, exit 0. It is
      // this process's own `wx` create, so nothing anyone else wrote goes.
      let removed = "removed again";
      try {
        unlinkSync(resolved.path);
      } catch (unlinkError) {
        removed = `NOT removed (${(unlinkError as NodeJS.ErrnoException).code ?? String(unlinkError)}) -- delete it before re-running`;
      }
      files.push({
        file: seed.file,
        action: "refused",
        why: `written, but does not load, so it was ${removed}: ${error instanceof SchemaError ? error.message : String(error)}`,
      });
    }
  }

  return {
    contract: SCAFFOLD_MIGRATE_CONTRACT,
    repo: root,
    dryRun,
    files,
    exitCode: files.some((row): boolean => row.action === "refused") ? 1 : 0,
  };
}

export function renderMigrate(result: ScaffoldMigrateResult): readonly string[] {
  const lines = result.files.map((row): string => `${row.action}: ${row.file} -- ${row.why}`);
  const written = result.files.filter((row): boolean => row.action === "created").length;
  if (written > 0) {
    lines.push(`next: review the seeded file(s), commit them, then run: ${PROGRAM} schema check --repo ${shellWord(result.repo)}`);
  }
  return lines;
}
