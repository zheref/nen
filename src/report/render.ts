// src/report/render.ts -- `nen report render`: one template, one data document,
// one file written. The filesystem half; ./template.ts is the language.
//
// THE OUT PATH IS CHECKED BEFORE ANYTHING IS READ. A refusal about where a file
// would go must not depend on the template parsing or the data loading first --
// a caller who typed `--out ../../../etc/nen.html` should hear about THAT, not
// about a token on line 40. It is the same containment rule ../shu/run.ts
// applies to a declared path and ../scaffold/init.ts to a flagged one, through
// the module they share (../repo/contain.ts), and it is checked on `--dry-run`
// too: a dry run whose refusals differ from the real run's is a dry run that
// proves nothing.
//
// SYMLINKS ARE RESOLVED, NOT TRUSTED. A lexically contained `Reports/final.html`
// lands outside the repository the moment `Reports/` is a link, and the report
// would still have said `Reports/final.html`. ../repo/contain.ts's
// `realContainment` answers for the path the kernel would actually write to.
//
// THE TEMPLATE IS READ RAW -- NO EOL NORMALIZATION. The output file is the
// template's own bytes with tokens substituted, so a CRLF template writes a CRLF
// report. Normalizing would silently rewrite every line of somebody's file as a
// side effect of filling three tokens in it, which is the same reason
// ../cli/inputs.ts's `readTextFile` grew its `raw` flag for `issue comment
// --body-file`.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { readJsonFile, readTextFile } from "../cli/inputs.js";
import { realContainment } from "../repo/contain.js";
import { parseTemplate, renderTemplate, TemplateError } from "./template.js";

export const RENDER_CONTRACT = "nen.report.render/v0.1";

export interface RenderOptions {
  /** `--template`, exactly as the caller typed it. */
  readonly template: string;
  /** `--data`, exactly as the caller typed it. */
  readonly data: string;
  /** `--out`, exactly as the caller typed it. */
  readonly out: string;
  readonly dryRun: boolean;
  /**
   * Keys merged INTO the data document before the fill -- `--variant`'s
   * `sections`/`sectionList` and `--graph`'s four graph keys (./command.ts
   * resolves both; this module only merges them).
   *
   * MERGED AT THE ROOT AND NEVER DEEP. A deep merge would let an injected key
   * silently rewrite a field of the caller's own document, which is the one
   * thing a verb that "fills a template with YOUR data" must not do; a root
   * key that collides is the caller's to rename, and the collision is visible
   * in `injected` below.
   */
  readonly inject?: Readonly<Record<string, unknown>>;
  /** `--variant`'s name, carried into the report for the record. */
  readonly variant?: string | null;
}

/**
 * KEY ORDER IS THE CONTRACT. The three paths are carried AS THE CALLER TYPED
 * THEM rather than resolved: they are what the caller can act on, and an
 * absolute path in a document that gets pasted into a pull request carries the
 * developer's home directory with it (./data.ts's `repo` field makes the same
 * choice for the same reason).
 */
export interface RenderReport {
  readonly contract: string;
  readonly template: string;
  readonly out: string;
  /** Every token the template names, first-appearance order, de-duplicated. */
  readonly tokens: readonly string[];
  /** False on `--dry-run`, which writes nothing. */
  readonly written: boolean;
  /**
   * `--variant`'s name, or null. KEY ORDER IS THE CONTRACT, so the two fields
   * this release adds sit at the END: a consumer reading the first five keys
   * of a v0.11 document reads the same five here (./render.test.ts pins it).
   */
  readonly variant: string | null;
  /** The root keys `--variant`/`--graph` merged in, sorted. Empty for neither. */
  readonly injected: readonly string[];
}

/**
 * `--out` resolved, or a refusal naming what redirected it.
 *
 * The report a template fills is a file in the repository being reported on --
 * the brief's `Reports/` directory -- and nen writing outside the tree it was
 * pointed at is the one thing this verb must not do, whatever a template says.
 */
export function assertOutPath(repoRoot: string, out: string): string {
  const containment = realContainment(repoRoot, resolveAgainst(repoRoot, out));
  if (!containment.contained) {
    const via =
      containment.link === null
        ? ""
        : ` '${containment.link}' is a symlink to '${containment.target ?? "somewhere else"}', so the write would land at '${containment.real}'.`;
    throw new VerbUsageError(
      `--out '${out}' resolves outside the repository at ${repoRoot}.${via} 'report render' writes the report INTO the repository it is reporting on and nowhere else; point --out at a path under it (the reports directory, typically).`,
    );
  }
  return containment.real;
}

/**
 * `--out` against `--repo`, NORMALIZED.
 *
 * `resolve` rather than a join, and the normalization is the point rather than a
 * tidiness: `realContainment` reports the deepest EXISTING ancestor whose real
 * path differs from its lexical one as the symlink that redirected the write, and
 * an un-normalized `<root>/../escape.html` makes `<root>/..` differ from its own
 * realpath by spelling alone -- so a plain `..` escape was refused with a
 * sentence claiming the parent directory was a symlink, which it is not. The
 * refusal must name what actually redirected the write, or the next one nobody
 * believes.
 *
 * An ABSOLUTE `--out` re-roots safely: `resolve` returns it unchanged, and the
 * containment test then answers for it. Only a `..` escapes.
 */
function resolveAgainst(root: string, value: string): string {
  return resolve(root, value);
}

export interface RenderResult {
  readonly report: RenderReport;
  /** The lines the human rendering prints. */
  readonly lines: readonly string[];
}

/**
 * Fill one template, or refuse.
 *
 * EVERY TemplateError BECOMES A VerbUsageError, so the whole language -- a tag
 * this template does not have, a block left open, a token the data has not got,
 * a value with no text form -- exits 2 and never 1. They are all the same class
 * of problem: the invocation was understood, the inputs disagree, and no retry
 * changes that.
 */
export function renderReport(repoRoot: string, options: RenderOptions): RenderResult {
  const absoluteOut = assertOutPath(repoRoot, options.out);
  const templateText = readTextFile(
    options.template,
    repoRoot,
    "A template with no bytes fills into a report with no content, which is not a report.",
    true,
  );
  const read = readJsonFile<unknown>(
    options.data,
    repoRoot,
    "The data document is what every token in the template is answered from; there is no empty default for it.",
  );
  // THE INJECTION IS APPLIED TO A COPY, never to the file. `report render` has
  // no write path other than `--out` (./data.ts's sibling rule), and a verb
  // that rewrote the document it was handed would make two runs of the same
  // command two different renders.
  // THE DOCUMENT'S OWN `variant` MUST AGREE WITH `--variant`. A data document
  // assembled for the landing report and rendered with `--variant turn-fast`
  // would produce a page that looks right and shows the wrong blocks -- the
  // exact class of silent wrong answer ./template.ts refuses an unknown token
  // over. A document that states NONE is fine: not every caller's assembler
  // writes the key, and an absent field is not a disagreement.
  if (options.variant != null && typeof read === "object" && read !== null && !Array.isArray(read)) {
    const stated = (read as Record<string, unknown>)["variant"];
    // A PRESENT-BUT-NON-STRING `variant` IS A DISAGREEMENT TOO (Copilot, #221).
    // The first cut tested `typeof stated === "string"`, so `{ "variant": 123 }`
    // sailed through the agreement check -- a document that does NOT state the
    // selected variant, read as one that does. `undefined`/`null` still mean
    // "this assembler does not write the key", which is not a disagreement.
    if (stated !== undefined && stated !== null && stated !== options.variant) {
      throw new VerbUsageError(
        typeof stated === "string"
          ? `--variant '${options.variant}' disagrees with --data '${options.data}', which states variant '${stated}'. The data document was assembled for one report and is being rendered as another; nen will not pick, because both readings produce a page that looks finished.`
          : `--data '${options.data}' states a 'variant' that is not a variant name (${Array.isArray(stated) ? `a list of ${stated.length}` : `a ${typeof stated}`}). A document that names its variant must name it as a string, so --variant '${options.variant}' can be checked against it; a value of another type cannot agree or disagree, and silently ignoring it renders the wrong blocks into a page that looks finished.`,
      );
    }
  }
  const injected = Object.keys(options.inject ?? {}).sort();
  const data =
    injected.length === 0
      ? read
      : { ...(typeof read === "object" && read !== null && !Array.isArray(read) ? read : {}), ...options.inject };
  if (injected.length > 0 && (typeof read !== "object" || read === null || Array.isArray(read))) {
    throw new VerbUsageError(
      `--data '${options.data}' is not a JSON object, so there is nothing for --variant/--graph to inject ${injected.join(", ")} into. The data document a template is filled from is an object of tokens; a list or a scalar has no root to merge a key at.`,
    );
  }

  // A DRY RUN RENDERS TOO, AND THROWS AWAY WHAT IT RENDERED. Listing the tokens
  // and stopping would be a preview that proves only that the template parses --
  // the failure a caller actually wants to find before publishing is the one
  // between the template and the DATA ("the document spells it `lastStop`"), and
  // a dry run whose refusals differ from the real run's proves nothing.
  //
  // SO THE TOKEN LIST IS APPENDED TO THE REFUSAL, on the dry-run path only.
  // Without it the advice in ./template.ts's unknown-token message -- run
  // --dry-run to see what this template asks for -- would send the caller to an
  // invocation that answers with the same refusal and no list.
  let filled: string;
  let tokens: readonly string[] = [];
  try {
    const parsed = parseTemplate(templateText);
    tokens = parsed.tokens;
    filled = renderTemplate(parsed, data);
  } catch (error) {
    if (error instanceof TemplateError) {
      const listed =
        options.dryRun && tokens.length > 0
          ? ` This template names ${tokens.length} token(s): ${tokens.join(", ")}.`
          : "";
      throw new VerbUsageError(`${options.template}: ${error.message}${listed}`);
    }
    /* c8 ignore next -- nothing else is thrown from the parse/render pair */
    throw error;
  }

  if (!options.dryRun) {
    mkdirSync(dirname(absoluteOut), { recursive: true });
    writeFileSync(absoluteOut, filled, "utf8");
  }

  const report: RenderReport = {
    contract: RENDER_CONTRACT,
    template: options.template,
    out: options.out,
    tokens,
    written: !options.dryRun,
    variant: options.variant ?? null,
    injected,
  };
  return { report, lines: renderLines(report, options) };
}

function renderLines(report: RenderReport, options: RenderOptions): readonly string[] {
  const lines = [
    `template: ${report.template}`,
    `data: ${options.data}`,
    `out: ${report.out}`,
    ...(report.variant === null ? [] : [`variant: ${report.variant}`]),
    ...(report.injected.length === 0 ? [] : [`injected: ${report.injected.join(", ")}`]),
    `tokens: ${report.tokens.length}`,
    ...report.tokens.map((token): string => `  ${token}`),
  ];
  lines.push(
    report.written
      ? `wrote ${report.out}`
      : `(dry run) nothing written -- the tokens above are every one this template asks for.`,
  );
  return lines;
}
