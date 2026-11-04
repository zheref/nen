// src/scaffold/seeds.ts -- the bytes `nen scaffold migrate` writes into an
// ABSENT `nen/colors.yml` or `nen/gates.json` (zheref/nen#592).
//
// A SEED IS NOT A FALLBACK. ../schema/source.ts refuses to read a taxonomy file
// the target does not carry, because a binary that guessed the names would
// report a taxonomy the repository does not have. That rule is about READING,
// and it stands: nothing here is consulted when a file is missing. These are
// the bytes a caller ASKED nen to write once, into absence, after which the
// file is the repository's own and the seed is never looked at again -- the
// same footing as `scaffold init`'s canon-values template.
//
// THE BYTES ARE DATA, in ../../templates/seeds.json, for ../taxonomy-purity.test.ts's
// rule: a reviewer's name, a colour and a glyph may live in shipped data and
// never in shipped code. This module only renders them, and it is imported as
// JSON so the bundler carries the file into the binary.
//
// EACH SEED WIDENS NOTHING, so a repository that commits one unread has asked
// for no less than it had:
//   * colors.yml declares NO category. An absent file and an empty vocabulary
//     answer every colour verb the same way (a refusal naming the category),
//     and neither invents a status or a severity the repository never chose.
//   * gates.json FAILS CLOSED: the reviewer every GitHub repository can
//     request owes a round at head on every pull request -- it is not
//     `bounded_policy_exempt`, which would excuse it whenever no request is
//     pending and let a pull request nobody reviewed read ready (Feitan F1 on
//     #592) -- and no approval or quorum stands in for it. With no gates file
//     at the base the readiness verbs refuse; with this one they wait for a
//     review. Its delivery carve-out matches no author: its pattern
//     carries spaces, which no GitHub login can, so the carve-out the loader
//     requires to exist reaches no pull request until the repository names its
//     own. (`^$` would read as "nobody" and mean "everybody": the loader
//     refuses a pattern that matches the empty string, because every pattern
//     is applied unanchored.)
//
// BOTH ARE READ BACK THROUGH THEIR OWN LOADERS by ./migrate.ts after the write,
// and ./migrate.test.ts parses each one too, so a seed this build would refuse
// cannot ship.

import { lstatSync } from "node:fs";
import seedPack from "../../templates/seeds.json";
import { shellSingleQuote } from "../shu/render.js";
import { PROGRAM } from "../version.js";

/** One file `scaffold migrate` can create, and the bytes it creates it with. */
export interface Seed {
  readonly file: string;
  readonly text: string;
  readonly what: string;
}

interface SeedEntry {
  readonly file: string;
  readonly what: string;
  readonly lines?: readonly string[];
  readonly document?: unknown;
}

function render(entry: SeedEntry): Seed {
  const text =
    entry.lines !== undefined
      ? `${entry.lines.join("\n")}\n`
      : `${JSON.stringify(entry.document, null, 2)}\n`;
  return { file: entry.file, text, what: entry.what };
}

/**
 * Every file `scaffold migrate` seeds, in the order `schema check` reports them.
 *
 * `nen/labels.json` AND `nen/repos.json` ARE NOT HERE, deliberately: a label
 * set and a registry are names only the repository can choose, and no seed
 * of either would widen nothing.
 */
export const SEEDS: readonly Seed[] = (seedPack.seeds as readonly SeedEntry[]).map(render);

/** Whether `file` is one `scaffold migrate` can create. */
export function isSeeded(file: string): boolean {
  return SEEDS.some((seed): boolean => seed.file === file);
}

/**
 * The command `nen schema check` names on the row of a seeded file that is
 * absent (zheref/nen#592 AC-1), ready to paste: the root is quoted only when
 * a shell would read it as more than one word.
 */
export function migrateCommand(root: string): string {
  return `${PROGRAM} scaffold migrate --repo ${shellWord(root)}`;
}

/**
 * What is at a seeded path, by `lstat` -- never `stat`, so a dangling symlink
 * is `present` (something is there, and `migrate` will not write through it)
 * rather than absent. Only a clean ENOENT/ENOTDIR is `absent`; any other
 * errno is `unknown`, carried so neither `migrate` nor `schema check` claims
 * to know what is there.
 */
export type PathState = { readonly kind: "absent" } | { readonly kind: "present" } | { readonly kind: "unknown"; readonly code: string };

export function probePath(path: string): PathState {
  try {
    lstatSync(path);
    return { kind: "present" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "unknown", code };
  }
}

/** A root, quoted only when a shell would read it as more than one word. */
export function shellWord(text: string): string {
  return /^[A-Za-z0-9_./:@+,-]+$/.test(text) ? text : shellSingleQuote(text);
}
