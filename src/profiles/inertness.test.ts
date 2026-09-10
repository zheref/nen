// src/profiles/inertness.test.ts -- "the pack is a catalogue", enforced.
//
// THE INVARIANT, STATED ONCE: nothing that spawns a process reads the profiles
// pack. The pack may say what nen was TESTED against; it may never contribute a
// version, a URL or an argument to a command nen runs. The two functions that
// will build commands -- `renderInvocation` over a declaration, and
// `resolveInstall` over a declaration's toolchain entry -- take a declaration
// and nothing else, and neither exists yet, so the part of the invariant that
// CAN be enforced today is enforced here: an IMPORT-GRAPH property, swept out of
// the source in the style of ../taxonomy-purity.test.ts.
//
// WHY A SOURCE SWEEP RATHER THAN A TYPE. A type stops a function SIGNATURE from
// reaching the pack; it does not stop a module that spawns from importing the
// pack and reading a version out of it three lines above the spawn. The sweep
// does, and it fails the build rather than a review.
//
// THIS FILE'S FIRST DRAFT CAUGHT ONE EVASION IN SIX, and the six are in
// `EVASIONS` below, as fixtures, each re-run against the real module graph. It
// scanned line by line with a `from "..."` regex over lines that did not LOOK
// like comments, and compared the result to an allowlist of DIRECT importers.
// Five things walked through it:
//
//   1. A TRANSITIVE PATH. A spawning module that imports an allowlisted
//      importer reaches the pack in two hops and matched no rule that looked at
//      one hop. This is the one that matters most, because the allowlist NAMES
//      three modules and thereby invites exactly this shape.
//   2. A DYNAMIC IMPORT. `await import("../profiles/pack.js")` has no `from`.
//   3. A DIRECT DATA IMPORT. `import doc from "../../profiles/nextjs.json"`
//      never mentions `pack`, and the pack's whole content is those documents.
//   4. A PATH READ. `readFileSync(join(root, "profiles", "nextjs.json"))`
//      imports nothing at all.
//   5. A CONTINUATION LINE. `import\n  * as pack from "../profiles/pack.js";`
//      is valid TypeScript whose second line begins with `*`, which the
//      line-based scanner skipped as a block-comment body.
//
// So the scanner is now a TOKENIZER (comments, strings, template literals and
// regex literals, in one pass), the specifier set covers every static and
// dynamic form, and the rule is a REACHABILITY property over a resolved import
// graph rather than a membership test over one hop. `Bun.Transpiler`'s
// `scanImports` would do the tokenizing for free and is the better tool; it is
// not available here, because vitest runs this suite under node (vitest.config
// .ts), and a guard that only works under one of two runtimes is not a guard.
//
// THE ALLOWLIST SURVIVES, and is still explicit and short on purpose. Adding a
// name to it is the review conversation this file exists to force. But it is no
// longer the load-bearing rule: the reachability sweep below is COMPUTED, and
// stays true when somebody widens the allowlist without thinking about the seam.

import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

// Repo-relative, `/`-separated. The modules under guard: the loader, and the
// documents it is made of -- because importing the seven JSON files directly is
// importing the pack with an extra step.
const PACK = "src/profiles/pack.ts";
const PACK_DATA_DIRECTORY = "profiles";

/**
 * THE OTHER DATA DIRECTORY OUTSIDE `src/`, and it is here for RESOLUTION only.
 *
 * `templates/` is the scaffold template pack -- data, static-imported for the
 * same bundler reason `profiles/` is. It is NOT under guard: it contributes a
 * file body to a file nen writes, never a version, a URL or an argument to a
 * command nen runs, and `src/scaffold/templates.ts` reads both directories
 * side by side. But the graph has to be able to RESOLVE an edge into it, or
 * the "every resolved edge points at a node the graph has" assertion below --
 * the one that stops a broken resolver from passing as an unreachable pack --
 * fails on an edge that is perfectly legitimate. Registering the nodes keeps
 * that assertion about the resolver instead of about this directory.
 */
const DATA_DIRECTORIES: readonly string[] = [PACK_DATA_DIRECTORY, "templates"];

/** Every JSON document under a data directory, `/`-separated and repo-relative. */
function dataNodes(): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), `${name}/`);
      else if (entry.name.endsWith(".json")) found.push(name);
    }
  };
  for (const directory of DATA_DIRECTORIES) walk(directory, `${directory}/`);
  return found;
}

// THE ONLY MODULES THAT MAY IMPORT THE PACK.
//
//   * `src/dev/matrix.ts` -- the generator. It renders a page and spawns
//                            nothing.
//   * `src/shu/detect.ts` -- proposes a DECLARATION a human reads and edits. It
//                            writes a file; it runs no verb.
//   * `src/shu/tools.ts`  -- (not yet written) reports an advisory `packMinimum`
//                            column beside what it probed. The probe argv and
//                            any install argv come from the DECLARATION; the
//                            pack contributes a string to a report and nothing
//                            else. This is the one narrowing of the invariant,
//                            and it is why the rules below are written in terms
//                            of the SEAM rather than in terms of this list.
//   * `src/scaffold/templates.ts`
//                         -- takes THREE strings per stack out of the
//                            catalogue and nothing else: the NAME of the
//                            scaffold template that stack is pointed at
//                            (`scaffoldTemplate`, a filename lookup in a
//                            bundled table), the `hosts` map, which lands
//                            verbatim in a proposed declaration for a human to
//                            read, and the id list a `--stack` is validated
//                            against. None of the three reaches an argv,
//                            because this family builds none: every command in
//                            a generated CI file is `nen shu <verb>`, whose
//                            argv comes from the SCAFFOLDED repository's own
//                            declaration and is resolved by `shu` at run time,
//                            on another machine, from a file this verb did not
//                            write the commands of.
//
//                            `nen scaffold init` DOES end by running `nen shu
//                            tools` in check mode, which spawns probes -- which
//                            is exactly why this module exists apart from
//                            `src/scaffold/init.ts` and `src/scaffold/
//                            command.ts`. The catalogue reader and the module
//                            that can reach a spawn are two files, and the
//                            reachability rule below is what holds them apart
//                            when somebody later merges them for tidiness.
//   * `src/shu/coverage-defaults.ts`
//                         -- the SAME narrowing, for the same kind of column.
//                            `nen shu coverage` parses the report a DECLARATION
//                            names under the verb's `artifacts`; when a lane
//                            names none, this module supplies the sentence the
//                            refusal quotes -- where that stack's tooling
//                            conventionally writes one. That path is PRINTED and
//                            never resolved, opened or spawned: the module that
//                            can spawn (`src/shu/coverage.ts`, through
//                            `src/shu/run.ts`) takes it as a PARAMETER from
//                            `src/shu/command.ts` and formats it with
//                            `src/shu/coverage/advisory.ts`, which reads
//                            nothing. `coverage.ts` therefore reaches no pack
//                            node at all, and the rule below is what says so --
//                            rather than this comment, which is what the same
//                            claim in that file's header was before the seam
//                            side of the rule became transitive. The one module
//                            that reaches both sides is the join, and it is
//                            named in `JOINS` with its own argument.
const ALLOWED_IMPORTERS: readonly string[] = [
  "src/dev/matrix.ts",
  "src/scaffold/templates.ts",
  "src/shu/coverage-defaults.ts",
  "src/shu/detect.ts",
  "src/shu/tools.ts",
];

/**
 * The REPORT parsers: on neither side, by construction.
 *
 * They read a file somebody else's build tool wrote and turn it into numbers.
 * They must not reach the pack (a parser that took a path from the catalogue
 * would be nen opening a file nobody declared) and they must not reach the seam
 * (a parser that could spawn is not a parser). Both directions are one
 * assertion below, over the same resolved graph every other rule here uses.
 *
 * TWO DIRECTORIES, ONE RULE. `nen shu coverage` and `nen shu test-report` are
 * built the same way -- run the lane's declared verb through the executor, then
 * parse what it wrote -- and each keeps its parsing half in a directory of its
 * own. A second verb of that shape must inherit the guarantee rather than a
 * copy of the argument for it.
 */
const REPORT_PARSERS: readonly string[] = ["src/shu/coverage/", "src/shu/test-report/"];

// The module every spawn in this repository goes through, and the node builtins
// it is the only legitimate user of. A module that reaches any of these is a
// module that can run a program.
const SEAM = "src/seam/exec.ts";
const CHILD_PROCESS: readonly string[] = ["child_process", "node:child_process"];

/**
 * A DISPATCH TABLE: reached by the sweep, never traversed through.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A HOLE. `src/cli/registry.ts` imports EVERY
 * family by construction -- that is the entire content of the file, one line per
 * family -- and `src/index.ts` imports the registry and the seam. So without
 * this, the reachability rule below says: index.ts can spawn, index.ts reaches
 * the registry, the registry reaches every family, therefore NO FAMILY MAY EVER
 * READ THE PACK. That is not the invariant anybody meant, and this same file
 * says so three screens up: `ALLOWED_IMPORTERS` names two `src/shu/` modules as
 * legitimate readers, and under the unrefined rule neither could ever exist.
 * A rule whose only satisfying assignment is "nobody, ever" stops being a rule
 * and becomes a thing somebody deletes.
 *
 * WHAT AN EDGE THROUGH THE REGISTRY MEANS is "this program has that family",
 * and nothing else: the registry holds `Command` objects, `src/index.ts` calls
 * `command.run(context)`, and no value crosses from one family to another
 * through either. That is what makes cutting it safe where cutting an ordinary
 * import would not be.
 *
 * IT IS NOT AN EXEMPTION FROM THE RULES, ONLY FROM BEING A PATH. The registry is
 * still swept as an ordinary module: it may not import the pack (the direct-
 * importer rule), and it is still a node every other rule sees. And the modules
 * it dispatches to are each held to the whole set in their own right -- which is
 * why `src/shu/detect.ts` may read the pack (nothing that spawns reaches it, and
 * it imports no seam) while `src/shu/render.ts`, which builds the argv
 * `src/shu/run.ts` spawns, may not.
 *
 * A test below asserts the cut is neither vacuous (the registry really does have
 * many out-edges) nor load-bearing at the cut point (the registry itself reaches
 * no pack node).
 *
 * THE SECOND CUT: `src/cli/command.ts`, THE COMMAND SCAFFOLDING, and it exists
 * because the seam in this program is INJECTED rather than imported. Nothing in
 * `src/shu/` calls `../seam/exec.ts`; every family is handed a
 * `CommandContext`, whose `seams` field it calls -- so the import that marks a
 * module as one that can spawn is `import type { Seams }`, and the module that
 * DEFINES `CommandContext` carries exactly that import. Without this cut, the
 * reachability rule reads: every command module in this CLI reaches the seam
 * through the type of its own argument, therefore no command module may ever
 * read the pack -- which is the same "only satisfying assignment is nobody,
 * ever" the registry cut rejects, and this file's own allowlist again names
 * four modules that could not then exist. An edge to this module means "this
 * is a command", not "this module went and got the seam".
 *
 * IT IS THE NARROWEST CUT THAT SAYS THAT, and the test below pins the premise
 * rather than trusting it: `src/cli/command.ts`'s only reference to the seam
 * must be a TYPE-ONLY import. The day it calls one, the cut stops being true
 * and the assertion fails -- which is the whole difference between a cut and an
 * exemption. Modules that reach the seam any OTHER way -- `src/shu/coverage.ts`
 * through `src/shu/run.ts`, which names `Seams` itself -- are unaffected by it.
 */
const DISPATCH: readonly string[] = ["src/cli/registry.ts", "src/cli/command.ts"];

/** The scaffolding cut, named for the assertion that keeps it honest. */
const SCAFFOLD = "src/cli/command.ts";

// ── the tokenizer ───────────────────────────────────────────────────────────
//
// One pass, four states. It exists because the three things a line-based
// scanner cannot do are exactly the three the evasions used: see a specifier on
// a line that does not begin the statement, ignore a `*` that opens a
// continuation rather than a comment body, and tell a `"` in code from a `"`
// inside a regex literal.
//
// It returns the code with every comment removed and every string literal
// replaced by a SENTINEL -- `\u0000<n>\u0000`, an index into `literals`. That
// makes the rules below regexes over a string in which no `from`, no `import`
// and no `(` can be hiding inside a comment or a quote, and in which a literal
// is one indivisible token however long it is.

const SENTINEL = "\u0000";

// A second, distinct sentinel for a template literal's STATIC text -- the
// parts between a backtick, `${` and `}` -- so `pathCallArguments` below can
// read them without teaching `importSpecifiers` to treat a dynamic template
// as a resolvable specifier. The specifier patterns hardcode `SENTINEL`
// (`\u0000`) and so never match a `TEMPLATE_SENTINEL` (`\u0001`) token,
// however it is placed in `code`.
const TEMPLATE_SENTINEL = "\u0001";

export interface Tokenized {
  /** Comments removed, string literals replaced by sentinels. */
  readonly code: string;
  /** The contents of each string literal, in the order they appeared. */
  readonly literals: readonly string[];
  /**
   * The static text of each template-literal chunk (the segment up to the
   * next `${` or the closing backtick), in the order they appeared. A chunk
   * is not a resolvable specifier -- it may sit beside an interpolation --
   * but its text is still worth reading for a `profiles` path segment, which
   * is what `pathCallArguments` does with it.
   */
  readonly templateLiterals: readonly string[];
}

// A `/` opens a regex literal unless the token before it could END an
// expression -- an identifier, a number, a `)` or a `]`. The exception is a
// KEYWORD, which looks like an identifier and is not one: `return /x/.test(s)`
// is a regex and `count / 2` is division, and only the word tells them apart.
//
// It is a heuristic. What it costs when wrong is one mis-scanned regex; what it
// buys is that `/["']/` -- which this very file contains -- cannot
// desynchronise the string scanner and hide every import below it.
const EXPRESSION_KEYWORDS: readonly string[] = [
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "case",
  "do",
  "else",
  "void",
  "delete",
  "new",
  "yield",
  "await",
];

export function opensRegex(codeSoFar: string): boolean {
  const trimmed = codeSoFar.replace(/\s+$/, "");
  if (trimmed === "") return true;
  const last = trimmed[trimmed.length - 1] ?? "";
  // A sentinel is a string literal, which is an expression like any other.
  if (last === SENTINEL) return false;
  if (!/[A-Za-z0-9_$)\]]/.test(last)) return true;
  const word = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(trimmed)?.[0];
  return word !== undefined && EXPRESSION_KEYWORDS.includes(word);
}

export function tokenize(source: string): Tokenized {
  const literals: string[] = [];
  const templateLiterals: string[] = [];
  let code = "";
  // A stack, so `${...}` inside a template literal is scanned as CODE and a
  // template inside that is scanned as a template again.
  const stack: ("code" | "template")[] = ["code"];
  const braces: number[] = [0];
  // One buffer per template-nesting level, pushed and popped alongside
  // `stack`: the static text collected since the template opened, or since
  // its last `${...}` closed.
  const templateChunks: string[] = [];
  let index = 0;

  const emit = (text: string): void => {
    code += text;
  };

  const readQuoted = (quote: string): void => {
    let content = "";
    index += 1;
    while (index < source.length) {
      const char = source[index] ?? "";
      if (char === "\\") {
        content += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === quote) {
        index += 1;
        break;
      }
      content += char;
      index += 1;
    }
    literals.push(content);
    emit(`${SENTINEL}${literals.length - 1}${SENTINEL}`);
  };

  // Emits the buffer collected for the CURRENT template-nesting level as a
  // TEMPLATE_SENTINEL token, then resets it. Called at every `${` and at the
  // closing backtick, so a multi-hole template (`` `a${x}b${y}c` ``) yields
  // one chunk per gap: "a", "b" and "c".
  const flushTemplateChunk = (): void => {
    const level = templateChunks.length - 1;
    const chunk = templateChunks[level] ?? "";
    templateLiterals.push(chunk);
    emit(`${TEMPLATE_SENTINEL}${templateLiterals.length - 1}${TEMPLATE_SENTINEL}`);
    templateChunks[level] = "";
  };

  while (index < source.length) {
    const mode = stack[stack.length - 1] ?? "code";
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";

    if (mode === "template") {
      const level = templateChunks.length - 1;
      if (char === "\\") {
        // Unescaped, same as `readQuoted`: `\` + the next char contributes
        // that char to the chunk, not the backslash.
        templateChunks[level] = (templateChunks[level] ?? "") + (source[index + 1] ?? "");
        index += 2;
        continue;
      }
      if (char === "$" && next === "{") {
        flushTemplateChunk();
        stack.push("code");
        braces.push(0);
        // A space, so `}${` cannot fuse two identifiers into one token.
        code += " ";
        index += 2;
        continue;
      }
      if (char === "`") {
        flushTemplateChunk();
        templateChunks.pop();
        stack.pop();
        // ` 0 `: a template literal IS an expression, so a `/` after it is
        // division. Emitting nothing here would leave the preceding token
        // showing and could turn `\`x\` / 2` into a regex that ate the rest.
        code += " 0 ";
        index += 1;
        continue;
      }
      if (char === "\n") code += "\n";
      templateChunks[level] = (templateChunks[level] ?? "") + char;
      index += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") code += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      readQuoted(char);
      continue;
    }
    if (char === "`") {
      templateChunks.push("");
      stack.push("template");
      code += " ";
      index += 1;
      continue;
    }
    if (char === "/" && opensRegex(code)) {
      // Skip the regex body, honouring escapes and character classes -- a `/`
      // inside `[...]` does not end it.
      index += 1;
      let inClass = false;
      while (index < source.length) {
        const inner = source[index] ?? "";
        if (inner === "\\") {
          index += 2;
          continue;
        }
        if (inner === "[") inClass = true;
        else if (inner === "]") inClass = false;
        else if (inner === "/" && !inClass) {
          index += 1;
          break;
        } else if (inner === "\n") break;
        index += 1;
      }
      emit(" 0 "); // an expression ended here, so a following `/` is division
      continue;
    }
    if (char === "{") {
      braces[braces.length - 1] = (braces[braces.length - 1] ?? 0) + 1;
    } else if (char === "}") {
      const depth = (braces[braces.length - 1] ?? 0) - 1;
      if (depth < 0 && stack.length > 1) {
        stack.pop();
        braces.pop();
        code += " ";
        index += 1;
        continue;
      }
      braces[braces.length - 1] = depth;
    }
    emit(char);
    index += 1;
  }

  return { code, literals, templateLiterals };
}

// ── specifiers ──────────────────────────────────────────────────────────────

// Every module specifier a source names, in every form TypeScript spells one:
//
//   import x from S     export { a } from S     import(S)
//   import S            export * from S         require(S)
//
// All four patterns run over the TOKENIZED code, so a multi-line statement, a
// `* as` continuation and a specifier inside a comment are all handled by
// construction rather than by a special case. A template-literal specifier
// yields no literal and is therefore not resolvable -- correctly, because it is
// not statically known; the path-read rule below is what covers those.
const SPECIFIER_PATTERNS: readonly RegExp[] = [
  // `from "x"` -- static import and re-export. The lookbehind keeps `x.from` and
  // `{ from: "x" }` out; neither is an import and both occur in real code.
  new RegExp(`(?<![.\\w$])from\\s*${SENTINEL}(\\d+)${SENTINEL}`, "g"),
  // `import "x"` for side effects, and `import("x")` dynamically.
  new RegExp(`(?<![.\\w$])import\\s*\\(?\\s*${SENTINEL}(\\d+)${SENTINEL}`, "g"),
  // `require("x")` -- this repository is ESM, which is exactly why a `require`
  // appearing at all is worth resolving rather than ignoring.
  new RegExp(`(?<![.\\w$])require\\s*\\(\\s*${SENTINEL}(\\d+)${SENTINEL}`, "g"),
];

export function importSpecifiers(source: string): string[] {
  const { code, literals } = tokenize(source);
  const found = new Set<string>();
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const literal = literals[Number(match[1])];
      if (literal !== undefined) found.add(literal);
    }
  }
  return [...found];
}

// The string literals a module hands to a path-building or file-reading call.
//
// SEPARATE FROM THE IMPORT RULES because the fourth evasion imported nothing:
// `readFileSync(join(root, "profiles", "nextjs.json"))` reaches the pack's data
// without an import graph having an edge to follow. Arguments are collected by
// walking the parentheses, so a nested call (`join(dirname(x), "profiles")`)
// contributes its literals too.
//
// EACH NAME IS MATCHED BY ITS CALLEE'S LAST IDENTIFIER SEGMENT, REGARDLESS OF
// NAMESPACE PREFIX: a bare `readFileSync(...)`, a `fs.readFileSync(...)` and an
// aliased `nodeFs.readFileSync(...)` (a `node:fs` default import can be named
// anything) all read the filesystem the same way, and a rule that matched only
// the bare form is a rule an import style walks straight through. `file` is the
// one exception -- alone, it is far too common a method name to sweep
// generically -- so it is matched ONLY as `Bun.file(...)`, the one namespace
// this repository could plausibly write it under.
const PATH_CALLS: readonly string[] = [
  "join",
  "resolve",
  "readFileSync",
  "readFile",
  "readdirSync",
  "existsSync",
  "statSync",
  "lstatSync",
  "openSync",
];

const PATH_CALL_OPENERS: readonly RegExp[] = [
  // The lookbehind excludes only a preceding identifier character (so
  // `xreadFileSync(` is not a match) and, unlike the import-specifier
  // patterns above, explicitly ALLOWS a preceding `.` -- that is exactly what
  // lets `fs.readFileSync(` and `path.join(` through.
  ...PATH_CALLS.map((call): RegExp => new RegExp(`(?<![\\w$])${call}\\s*\\(`, "g")),
  // `import(...)` keeps its original, stricter match: a keyword, not a name
  // that is ever legitimately namespaced.
  /(?<![.\w$])import\s*\(/g,
  // `Bun.file(...)` -- `file` alone is far too generic a method name to sweep.
  /(?<![.\w$])Bun\s*\.\s*file\s*\(/g,
];

export function pathCallArguments(source: string): string[] {
  const { code, literals, templateLiterals } = tokenize(source);
  const found: string[] = [];
  for (const opener of PATH_CALL_OPENERS) {
    for (const match of code.matchAll(opener)) {
      let depth = 1;
      let index = match.index + match[0].length;
      while (index < code.length && depth > 0) {
        const char = code[index];
        if (char === "(") depth += 1;
        else if (char === ")") depth -= 1;
        else if (char === SENTINEL) {
          const end = code.indexOf(SENTINEL, index + 1);
          if (end === -1) break;
          const literal = literals[Number(code.slice(index + 1, end))];
          if (literal !== undefined) found.push(literal);
          index = end;
        } else if (char === TEMPLATE_SENTINEL) {
          const end = code.indexOf(TEMPLATE_SENTINEL, index + 1);
          if (end === -1) break;
          const chunk = templateLiterals[Number(code.slice(index + 1, end))];
          if (chunk !== undefined) found.push(chunk);
          index = end;
        }
        index += 1;
      }
    }
  }
  return found;
}

// ── the module graph ────────────────────────────────────────────────────────

interface Module {
  /** Repo-relative, `/`-separated: `src/profiles/pack.ts`. */
  readonly name: string;
  readonly specifiers: readonly string[];
  readonly pathArguments: readonly string[];
}

function readSource(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function shippedFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "fixtures") continue;
      shippedFiles(path, found);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    // Tests may import anything: a test that could not name the pack could not
    // test it, and a test spawns nothing a user runs.
    if (entry.endsWith(".test.ts")) continue;
    found.push(path);
  }
  return found;
}

function moduleName(file: string): string {
  return relative(ROOT, file).split(sep).join("/");
}

function scan(name: string, source: string): Module {
  return {
    name,
    specifiers: importSpecifiers(source),
    pathArguments: pathCallArguments(source),
  };
}

/**
 * Resolve one specifier to a repo-relative module name, or `null` for a bare
 * one (`node:fs`, `octokit`) which is returned as-is by `resolveSpecifier`.
 *
 * `.js` BECOMES `.ts`, because that is what this repository writes: NodeNext
 * resolution wants the emitted extension and the file on disk is TypeScript. A
 * graph that failed to make that substitution would have no edges at all -- and
 * would pass every rule below, silently, forever. The count assertions in the
 * first test are there for exactly that failure.
 */
export function resolveSpecifier(from: string, specifier: string, known: ReadonlySet<string>): string {
  if (!specifier.startsWith(".")) return specifier;
  const base = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = [
    base.replace(/\.js$/, ".ts").replace(/\.jsx$/, ".tsx").replace(/\.mjs$/, ".mts"),
    base,
    `${base}.ts`,
    `${base}/index.ts`,
  ];
  return candidates.find((candidate): boolean => known.has(candidate)) ?? base;
}

interface Graph {
  readonly modules: readonly Module[];
  /** Resolved edges, module name to module names (bare specifiers included). */
  readonly edges: ReadonlyMap<string, readonly string[]>;
}

function buildGraph(modules: readonly Module[]): Graph {
  // The nodes the graph can resolve TO: every scanned module, plus every JSON
  // document in the pack's own directory -- which is how a direct data import
  // becomes an edge rather than an unresolvable string.
  const known = new Set<string>(modules.map((module): string => module.name));
  for (const node of dataNodes()) known.add(node);
  const edges = new Map<string, readonly string[]>();
  for (const module of modules) {
    edges.set(
      module.name,
      module.specifiers.map((specifier): string =>
        resolveSpecifier(module.name, specifier, known),
      ),
    );
  }
  return { modules, edges };
}

/** Everything reachable from `start` by following imports, `start` included. */
function reachableFrom(graph: Graph, start: string): Set<string> {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) continue;
    // A DISPATCH TABLE IS REACHED, NEVER TRAVERSED. See `DISPATCH` below.
    if (current !== start && DISPATCH.includes(current)) continue;
    for (const next of graph.edges.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** True for a name that IS the pack: the loader, or one of its documents. */
function isPack(name: string): boolean {
  return (
    name === PACK ||
    (name.startsWith(`${PACK_DATA_DIRECTORY}/`) && name.endsWith(".json"))
  );
}

/** True for the seam itself, or for a `child_process` builtin. */
function isSeam(name: string): boolean {
  return name === SEAM || CHILD_PROCESS.includes(name);
}

/**
 * A module that can spawn: it REACHES the seam, at any depth.
 *
 * TRANSITIVE, LIKE THE PACK SIDE ALREADY WAS, and the asymmetry it replaces was
 * a hole rather than a nuance. The pack side asks "can this module GET to the
 * catalogue, through however many hops"; the seam side asked "does this module
 * IMPORT the seam", one edge. So a module one hop from the seam -- `src/shu/
 * coverage.ts` imports `src/shu/run.ts`, which is where every `nen shu` verb's
 * subprocess comes from -- was not "a module that can spawn" as far as this
 * file was concerned, and could import the catalogue with nothing failing. It
 * could, and it did: the header of that file claimed this test would fail the
 * build for it, and this test would not have. Both halves of the rule now mean
 * the same word by "reaches".
 *
 * A CUT POINT IS NOT A SPAWNER IN ITS OWN RIGHT, for the same reason it is not
 * a path THROUGH: `src/cli/registry.ts` holds `Command` objects and runs
 * nothing, and `src/cli/command.ts` declares the type of the argument every
 * command is handed. See `DISPATCH`.
 */
function spawns(graph: Graph, name: string): boolean {
  if (DISPATCH.includes(name)) return false;
  return [...reachableFrom(graph, name)].some(isSeam);
}

/**
 * THE JOINS: the modules that legitimately reach both sides.
 *
 * BOTH ARE A FAMILY'S `command.ts`, AND THAT IS NOT A COINCIDENCE. A value that
 * comes out of a catalogue and lands in a report has to be read somewhere and
 * handed over somewhere, and where a family reads its flags is the one place
 * both halves are already in scope. Anything else that reached both sides would
 * be a module doing two jobs.
 *
 * `src/shu/command.ts` is where the two halves of `nen shu tools` and `nen shu
 * coverage` meet. It imports the catalogue readers (`src/shu/tools.ts`,
 * `src/shu/coverage-defaults.ts`) and it imports the verbs that execute
 * (`src/shu/coverage.ts` -> `src/shu/run.ts`), so under a rule that means
 * REACHES on both sides it is an offender by construction.
 *
 * `src/scaffold/command.ts` is the same shape for `nen scaffold`. It imports
 * the catalogue reader (`src/scaffold/templates.ts` -- `resolveStackId`, and
 * the stack ids its help text lists) and it ends `init` by dispatching into
 * `shuCommand`, the closing `nen shu tools` CHECK, which is where that verb's
 * probes are spawned. It arrived with #131, one release after the seam side of
 * this rule became transitive; it is a name argued onto this list rather than a
 * rule relaxed to fit it.
 *
 * WHAT MAKES THEM SAFE IS NOT THIS LIST, IT IS THE SHAPE, and the shape is
 * asserted rather than described, of every entry:
 *
 *   1. IT SPAWNS NOTHING ITSELF. Neither names a seam or a `child_process`;
 *      the reach is entirely through the verb modules they dispatch to. The
 *      test below asserts that of each name, so a `run(...)` added to either
 *      fails the build even though the name is on this list.
 *   2. WHAT CROSSES NEVER BECOMES AN ARGV. In `shu`, `coverageAdvisories()`
 *      returns paths-as-sentences and `advisoryFor` formats them; the executing
 *      half takes them as a parameter it only ever prints, and there is no
 *      parameter on `runCoverage` through which a catalogue value could become
 *      an argv or a path that is opened -- `src/shu/coverage.ts` reaches
 *      neither the pack nor `src/profiles/`, which the rule above still holds
 *      it to. In `scaffold`, the only argvs this family builds are the two
 *      literals `["shu", "tools"]` and `["shu", "tools", "--install"]`: a
 *      resolved stack id is a filename lookup in the bundled template table and
 *      a `hosts` map written into a proposal for a human to read, and every
 *      command in a generated CI file is `nen shu <verb>`, resolved at run time
 *      on another machine out of the SCAFFOLDED repository's own declaration.
 *   3. IT IS A SHORT, EXACT LIST. The test below pins the CONTENTS rather than
 *      the length: a third join is the review conversation this file exists to
 *      force, not a line to add.
 *
 * IT IS NOT THE `ALLOWED_IMPORTERS` LIST AND MUST NOT BE FOLDED INTO IT. That
 * one answers "who may read the catalogue"; this one answers "who may read it
 * while also being able to reach a subprocess". Two questions, two lists, and
 * the second is deliberately harder to get onto.
 */
const JOINS: readonly string[] = ["src/scaffold/command.ts", "src/shu/command.ts"];

/** Every `<offender> -> ... -> <pack>` path the graph admits, as strings. */
function offences(graph: Graph): string[] {
  const found: string[] = [];
  for (const module of graph.modules) {
    if (JOINS.includes(module.name)) continue;
    if (!spawns(graph, module.name)) continue;
    const reached = [...reachableFrom(graph, module.name)].filter(isPack).sort();
    for (const target of reached) found.push(`${module.name} -> ${target}`);
  }
  return found.sort();
}

/** A module that names a `profiles` path segment in a path-building call. */
function readsPackByPath(module: Module): boolean {
  return module.pathArguments.some((argument): boolean =>
    argument
      .split("/")
      .some((segment): boolean => segment === PACK_DATA_DIRECTORY),
  );
}

const SHIPPED: readonly Module[] = shippedFiles(SRC).map((file): Module =>
  scan(moduleName(file), readSource(file)),
);
const GRAPH = buildGraph(SHIPPED);

// ── the fixtures ────────────────────────────────────────────────────────────
//
// The six modules the review pushed through the first draft of this file. They
// are WRITTEN TO A TEMPORARY DIRECTORY, not to `src/`: a fixture that lives in
// the shipped tree is a violation the sweep would then have to be taught to
// ignore, and an exemption is exactly what these are proving is unnecessary.
// Each is read back from disk by the same reader the real tree uses and spliced
// into the real module graph under a plausible `src/` name, so what is asserted
// is the RULE over the REAL graph plus one offender -- not a toy graph.
//
// All six are valid TypeScript. Five were green against the first draft.

// The two rules an offender can trip, named once so the fixtures below can say
// WHICH one catches each of them rather than only that something did.
const RULE_REACH = "reaches the pack from a module that can spawn";
const RULE_PATH = "names a `profiles` path segment in a path-building call";

interface Evasion {
  readonly what: string;
  readonly name: string;
  /** Which rule catches it now. */
  readonly caught: string;
  /** Whether the first draft of this file caught it. Exactly one did. */
  readonly caughtBefore: boolean;
  readonly source: string;
}

const EVASIONS: readonly Evasion[] = [
  {
    what: "the direct import -- the one the first draft already caught",
    name: "src/run/direct.ts",
    caught: RULE_REACH,
    caughtBefore: true,
    source: [
      'import { loadProfilesPack } from "../profiles/pack.js";',
      'import { run } from "../seam/exec.js";',
      "export async function go(): Promise<void> {",
      "  const pack = loadProfilesPack();",
      '  await run({ exe: "echo", argv: [pack.origin] });',
      "}",
    ].join("\n"),
  },
  {
    what: "a transitive path through an allowlisted importer",
    name: "src/run/transitive.ts",
    caught: RULE_REACH,
    caughtBefore: false,
    source: [
      'import { MATRIX_COMMAND } from "../dev/matrix.js";',
      'import { run } from "../seam/exec.js";',
      "export async function go(): Promise<void> {",
      '  await run({ exe: "echo", argv: [MATRIX_COMMAND] });',
      "}",
    ].join("\n"),
  },
  {
    what: "a dynamic import",
    name: "src/run/dynamic.ts",
    caught: RULE_REACH,
    caughtBefore: false,
    source: [
      'import { run } from "../seam/exec.js";',
      "export async function go(): Promise<void> {",
      '  const pack = await import("../profiles/pack.js");',
      '  await run({ exe: "echo", argv: [pack.PACK_DIRECTORY] });',
      "}",
    ].join("\n"),
  },
  {
    what: "a direct profiles/*.json import",
    name: "src/run/data.ts",
    caught: RULE_REACH,
    caughtBefore: false,
    source: [
      'import document from "../../profiles/nextjs.json";',
      'import { run } from "../seam/exec.js";',
      "export async function go(): Promise<void> {",
      "  await run({ exe: String((document as { id: string }).id), argv: [] });",
      "}",
    ].join("\n"),
  },
  {
    what: "a readFileSync by path",
    name: "src/run/byPath.ts",
    caught: RULE_PATH,
    caughtBefore: false,
    source: [
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import { run } from "../seam/exec.js";',
      "export async function go(root: string): Promise<void> {",
      '  const text = readFileSync(join(root, "profiles", "nextjs.json"), "utf8");',
      '  await run({ exe: "echo", argv: [text] });',
      "}",
    ].join("\n"),
  },
  {
    what: "a `*`-continuation-line import",
    name: "src/run/continuation.ts",
    caught: RULE_REACH,
    caughtBefore: false,
    source: [
      "import",
      '  * as pack from "../profiles/pack.js";',
      'import { run } from "../seam/exec.js";',
      "export async function go(): Promise<void> {",
      '  await run({ exe: "echo", argv: [pack.PACK_DIRECTORY] });',
      "}",
    ].join("\n"),
  },
];

function writeEvasions(): readonly (Evasion & { readonly file: string })[] {
  const dir = mkdtempSync(join(tmpdir(), "nen-inertness-"));
  return EVASIONS.map((evasion) => {
    const file = join(dir, `${evasion.name.split("/").pop() ?? "x"}`);
    writeFileSync(file, `${evasion.source}\n`, "utf8");
    return { ...evasion, file };
  });
}

const WRITTEN = writeEvasions();

/** Which of the rules the real tree is held to catch this offender. */
function caughtBy(module: Module): readonly string[] {
  const graph = buildGraph([...SHIPPED, module]);
  const caught: string[] = [];
  if (offences(graph).some((offence): boolean => offence.startsWith(`${module.name} ->`))) {
    caught.push(RULE_REACH);
  }
  if (readsPackByPath(module)) caught.push(RULE_PATH);
  return caught;
}

/**
 * THE FIRST DRAFT OF THIS FILE, reproduced exactly, so "five of six walked
 * through it" is a fact this suite CHECKS rather than a claim a commit message
 * makes. A regression test for a scanner needs the old scanner in it, or the
 * only evidence that the new one is better is that somebody said so.
 *
 * It is a line sweep: skip anything that looks like a comment line, regex out
 * `from "..."`, and compare the resulting DIRECT importers to the allowlist.
 */
function firstDraftCatches(module: Module, source: string): boolean {
  const specifiers: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const match = /from\s+["']([^"']+)["']/.exec(trimmed);
    if (match?.[1] !== undefined) specifiers.push(match[1]);
  }
  const importsPack = specifiers.some(
    (specifier): boolean =>
      /(^|\/)profiles\/pack\.(js|ts)$/.test(specifier) ||
      (module.name.startsWith("src/profiles/") && /^\.\/pack\.(js|ts)$/.test(specifier)),
  );
  const importsSeam = specifiers.some((specifier): boolean => specifier.endsWith("seam/exec.js"));
  return importsPack && (importsSeam || !ALLOWED_IMPORTERS.includes(module.name));
}

// ── the rules ───────────────────────────────────────────────────────────────

describe("the profiles pack is inert", () => {
  it("sweeps a non-trivial graph, with real edges in it", () => {
    // A sweep that silently matched nothing would pass forever -- and the way
    // this one would fail silently is a resolver that produces no edge any rule
    // can follow, so the edges are counted too, not just the nodes.
    expect(SHIPPED.length).toBeGreaterThan(100);
    expect(SHIPPED.map((module): string => module.name)).toContain(PACK);
    expect(SHIPPED.map((module): string => module.name)).toContain(SEAM);
    const resolved = [...GRAPH.edges.values()]
      .flat()
      .filter((edge): boolean => edge.endsWith(".ts") || edge.endsWith(".json"));
    expect(resolved.length).toBeGreaterThan(100);
    // Every resolved edge points at a node the graph actually has: a typo in
    // the resolver would otherwise show up as an unreachable pack, i.e. a pass.
    const nodes = new Set(SHIPPED.map((module): string => module.name));
    for (const node of dataNodes()) nodes.add(node);
    expect(resolved.filter((edge): boolean => !nodes.has(edge))).toEqual([]);
    // Both data directories really do contribute nodes, or the resolution the
    // line above proves is resolution of nothing.
    expect(dataNodes().filter((node): boolean => node.startsWith("templates/")).length).toBeGreaterThan(0);
    // And at least one module can spawn, or the seam rule is vacuous.
    expect(SHIPPED.filter((module): boolean => spawns(GRAPH, module.name)).length).toBeGreaterThan(
      0,
    );
    expect(new Set(ALLOWED_IMPORTERS).size).toBe(ALLOWED_IMPORTERS.length);
  });

  it("is imported directly only by the modules named here", () => {
    // The loader itself is excluded, and only the loader: `profiles/*.json` are
    // pack nodes -- that is what makes evasion 3 an edge rather than a string --
    // and `pack.ts` importing its own seven documents is the pack, not a
    // reader of it.
    const importers = SHIPPED.filter(
      (module): boolean =>
        !isPack(module.name) && (GRAPH.edges.get(module.name) ?? []).some(isPack),
    ).map((module): string => module.name);
    expect(importers.filter((name): boolean => !ALLOWED_IMPORTERS.includes(name))).toEqual([]);
  });

  it("gives every allowed importer the property the list is granted on: it cannot spawn", () => {
    // THE OTHER HALF OF WHAT BEING ON THAT LIST MEANS, and it is stated here
    // rather than left to `offences` because the two failures read differently.
    // `offences` says "the pack is reachable from a spawner" and prints a path;
    // this says "a module that is allowed to READ the catalogue has acquired a
    // route to a subprocess", which is the sentence a reviewer needs when the
    // edge that did it is one word in an import list somewhere else.
    //
    // THIS IS HOW #132 BROKE IT AND HOW IT WAS FIXED. `src/shu/detect.ts` was
    // moved off `./run.js` by this PR precisely so it would stop reaching the
    // seam -- and then acquired `insideRepo` from that same module, one hop from
    // every `nen shu` subprocess, for a containment answer it discards the
    // message of. It asks `../repo/contain.ts` instead, which is the module that
    // exists to be asked by both families and deliberately throws nothing. The
    // fix was an edge removed, not a name added.
    //
    // A module that needs BOTH belongs in `JOINS`, argued, and never here.
    const spawners = ALLOWED_IMPORTERS.filter((name): boolean => spawns(GRAPH, name));
    expect(spawners).toEqual([]);
    expect(ALLOWED_IMPORTERS.filter((name): boolean => JOINS.includes(name))).toEqual([]);
  });

  it("is reachable from no module that can spawn a process, at any depth", () => {
    // THE RULE THE INVARIANT IS ACTUALLY ABOUT. Not "does a spawning module
    // import the pack" -- "can a spawning module get to it", through however
    // many hops and through an allowlisted importer just the same. It is
    // COMPUTED from the seam, so widening the allowlist does not widen it.
    expect(offences(GRAPH)).toEqual([]);
  });

  it("means REACHES on the seam side too, so one hop from the executor counts", () => {
    // THE ASYMMETRY THIS FILE SHIPPED WITH. `spawns` looked at DIRECT edges
    // while the pack side was already transitive, so `src/shu/coverage.ts` --
    // which imports `src/shu/run.ts`, where every `nen shu` subprocess comes
    // from -- was not a module that can spawn as far as this file was
    // concerned. It is one, and it is now read as one.
    expect(spawns(GRAPH, "src/shu/run.ts")).toBe(true);
    expect(spawns(GRAPH, "src/shu/coverage.ts")).toBe(true);
    // Which is what makes the coverage verb's split load-bearing rather than
    // decorative: the executing half must reach no pack node at all, because
    // there is no list it could be added to.
    expect([...reachableFrom(GRAPH, "src/shu/coverage.ts")].filter(isPack)).toEqual([]);
    expect(JOINS).not.toContain("src/shu/coverage.ts");
  });

  describe("the cuts and the join, each held to what it claims", () => {
    it("cuts only nodes that are real, busy, and pack-free", () => {
      const names = new Set(SHIPPED.map((module): string => module.name));
      for (const cut of DISPATCH) {
        // Real: a cut naming a module that does not exist cuts nothing and
        // hides that it cuts nothing.
        expect(names, cut).toContain(cut);
        // Not vacuous: it really is a hub, or it did not need cutting.
        expect((GRAPH.edges.get(cut) ?? []).length, cut).toBeGreaterThan(2);
        // Not load-bearing at the cut point: what a cut buys is that the sweep
        // does not walk THROUGH it, and it would be an exemption instead if the
        // node itself imported the pack -- so that stays forbidden here, in the
        // one place a reader checking the cut is looking.
        expect((GRAPH.edges.get(cut) ?? []).filter(isPack), cut).toEqual([]);
      }
    });

    it("keeps the scaffolding cut true: its only seam reference is a TYPE", () => {
      // THE PREMISE OF THE SECOND CUT, CHECKED RATHER THAN ASSERTED. The seam
      // in this program is injected -- `CommandContext.seams` -- so the module
      // that declares that type names `../seam/exec.js` while calling nothing
      // in it. That is why an edge to it means "this is a command" rather than
      // "this module went and got the seam". The day it imports a VALUE from
      // the seam, the cut is no longer true and this fails.
      const source = readSource(join(ROOT, ...SCAFFOLD.split("/")));
      const seamLines = source
        .split("\n")
        .filter((line): boolean => line.includes("seam/exec.js") && line.includes("import"));
      expect(seamLines.length).toBe(1);
      expect(seamLines[0]?.trimStart().startsWith("import type ")).toBe(true);
    });

    it("names exactly these two joins, and neither spawns anything itself", () => {
      // THE CONTENTS, NOT THE LENGTH. A list pinned by length is a list a third
      // name joins by deleting one, and the two that are on it are on it for
      // reasons written above rather than for being two.
      expect([...JOINS].sort()).toEqual(["src/scaffold/command.ts", "src/shu/command.ts"]);
      for (const join_ of JOINS) {
        expect(SHIPPED.map((module): string => module.name), join_).toContain(join_);
        // Non-vacuous: without the entry this really would be an offence -- it
        // reaches both sides. A join that had stopped reaching one of them would
        // be a list entry nobody needed and nobody would notice.
        expect(spawns(GRAPH, join_), join_).toBe(true);
        expect([...reachableFrom(GRAPH, join_)].filter(isPack).length, join_).toBeGreaterThan(0);
        // And the property each entry is argued on: it hands values across, it
        // does not run programs. A `run(...)` added here fails HERE, list or no
        // list.
        expect((GRAPH.edges.get(join_) ?? []).filter(isSeam), join_).toEqual([]);
      }
    });
  });

  it("keeps the report parsers off both sides: no pack, no seam, at any depth", () => {
    // A DIRECTORY RULE RATHER THAN A FILE LIST, so a sixth format module joins
    // it by existing. The two halves of `nen shu coverage` meet only in
    // `src/shu/command.ts`, which spawns nothing itself; everything under
    // `src/shu/coverage/` and `src/shu/test-report/` is computation over text
    // and the files a declaration named, and this is what says so about the
    // real graph rather than about the headers.
    const modules = SHIPPED.filter((module): boolean =>
      REPORT_PARSERS.some((directory): boolean => module.name.startsWith(directory)),
    );
    expect(modules.length).toBeGreaterThan(3);
    // BOTH DIRECTORIES ARE ACTUALLY IN THE SWEEP. A prefix that matched nothing
    // -- a directory renamed, a verb moved -- would leave this rule passing
    // over half of what it claims.
    for (const directory of REPORT_PARSERS) {
      expect(
        modules.some((module): boolean => module.name.startsWith(directory)),
        directory,
      ).toBe(true);
    }
    const offending: string[] = [];
    for (const module of modules) {
      for (const reached of reachableFrom(GRAPH, module.name)) {
        if (isPack(reached)) offending.push(`${module.name} -> ${reached} (the pack)`);
        if (reached === SEAM || CHILD_PROCESS.includes(reached)) {
          offending.push(`${module.name} -> ${reached} (the seam)`);
        }
      }
    }
    expect(offending.sort()).toEqual([]);
    // And the advisory half is the mirror image: it reads the pack and can
    // never spawn. (The `offences` rule above would catch it too -- this states
    // it where a reader is looking for it.)
    expect(spawns(GRAPH, "src/shu/coverage-defaults.ts")).toBe(false);
  });

  it("is not read by path from any shipped module", () => {
    // An import graph has no edge for `readFileSync(join(root, "profiles",
    // ...))`, so this rule is stated over the ARGUMENTS instead. The pack's own
    // loader passes a caller-supplied directory and builds its bundled labels
    // from a template, so it names no `profiles` segment in a path call either.
    const offenders = SHIPPED.filter(readsPackByPath).map((module): string => module.name);
    expect(offenders).toEqual([]);
  });

  describe("the widened path-call rule", () => {
    // The rule originally matched only a BARE `readFileSync(` or `join(`, and
    // so missed every namespaced form: `fs.readFileSync(...)`, `path.join(...)`,
    // the same call reached through whatever an aliased `node:fs` default
    // import happens to be named, and the newer Bun file-access name this
    // repository has started to use. It now matches a call by its callee's
    // LAST identifier segment regardless of namespace, and reads every string
    // literal AND every template literal's static text for a `profiles`
    // segment -- each fixture below is one such evasion, caught the same way
    // the shipped-tree sweep above would catch it.
    const READS: readonly { readonly what: string; readonly source: string }[] = [
      {
        what: "a namespaced fs.readFileSync(...) wrapping a bare join(...)",
        source: [
          'import * as fs from "node:fs";',
          'import { join } from "node:path";',
          'fs.readFileSync(join(root, "profiles", "x.json"));',
        ].join("\n"),
      },
      {
        what: "a namespaced path.join(...)",
        source: [
          'import * as path from "node:path";',
          'path.join("profiles", id + ".json");',
        ].join("\n"),
      },
      {
        what: 'a "node:fs" default-import alias calling readFileSync',
        source: [
          'import * as fs from "node:fs";',
          'fs.readFileSync(root + "/profiles/y.json", "utf8");',
        ].join("\n"),
      },
      {
        what: "a template-literal Bun.file(...) read",
        source: "Bun.file(`profiles/${id}.json`);",
      },
    ];

    for (const fixture of READS) {
      it(`catches ${fixture.what}`, () => {
        const module = scan("src/run/widened.ts", fixture.source);
        expect(readsPackByPath(module)).toBe(true);
      });
    }

    it("still passes a `docs` path built the same bare way", () => {
      const module = scan("src/run/docs.ts", 'join(root, "docs");');
      expect(readsPackByPath(module)).toBe(false);
    });
  });

  it("cannot spawn anything itself", () => {
    const edges = GRAPH.edges.get(PACK) ?? [];
    expect(edges.filter((edge): boolean => edge === SEAM)).toEqual([]);
    // `node:child_process` never appears in this repository outside the seam;
    // asserting it here as well means the pack does not become the exception.
    expect(edges.filter((edge): boolean => edge.includes("child_process"))).toEqual([]);
    // And nothing the pack imports can, either.
    expect(
      [...reachableFrom(GRAPH, PACK)].filter((name): boolean => name === SEAM),
    ).toEqual([]);
  });
});

describe("the six evasions the review demonstrated", () => {
  it("writes all six as fixtures outside src/, and reads them back", () => {
    // Outside `src/` on purpose: a fixture in the shipped tree would be a
    // violation the sweep had to be taught to ignore.
    expect(WRITTEN.length).toBe(6);
    for (const evasion of WRITTEN) {
      expect(readSource(evasion.file)).toBe(`${evasion.source}\n`);
      expect(evasion.file.startsWith(SRC)).toBe(false);
    }
  });

  it("reproduces the first draft, and confirms it caught exactly one of the six", () => {
    // The premise of every assertion below. If this ever reports six, the
    // fixtures have stopped being evasions and the suite is proving nothing.
    const before = WRITTEN.filter((evasion): boolean =>
      firstDraftCatches(scan(evasion.name, readSource(evasion.file)), evasion.source),
    ).map((evasion): string => evasion.what);
    expect(before.length).toBe(1);
    expect(WRITTEN.filter((evasion): boolean => evasion.caughtBefore).map((e): string => e.what))
      .toEqual(before);
  });

  for (const evasion of WRITTEN) {
    it(`catches ${evasion.what}`, () => {
      const module = scan(evasion.name, readSource(evasion.file));
      const caught = caughtBy(module);
      expect(caught, `${evasion.name} walked through every rule`).not.toEqual([]);
      // WHICH rule, not just that one fired: a fixture that started tripping a
      // different rule would mean the sweep changed shape without anyone
      // noticing, and the five here trip two rules between them by design.
      expect(caught).toContain(evasion.caught);
      expect(firstDraftCatches(module, evasion.source)).toBe(evasion.caughtBefore);
    });
  }

  it("still passes a module that reaches the pack but cannot spawn", () => {
    // The rules must not be "nothing may mention the pack": `dev/matrix.ts`
    // does, legitimately, and a sweep that refused it would be turned off.
    const renderer = scan(
      "src/dev/other.ts",
      'import { loadProfilesPack } from "../profiles/pack.js";\nexport const x = loadProfilesPack;\n',
    );
    expect(caughtBy(renderer)).toEqual([]);
  });
});

describe("the tokenizer", () => {
  // Every rule above is exactly as trustworthy as this, and the real-tree
  // results are (correctly) EMPTY -- so the scanner's cases are its own, in the
  // style of ../taxonomy-purity.test.ts's `stripComments` suite. Each case here
  // is a way a specifier could have been made invisible.

  it("reads specifiers out of code and not out of prose", () => {
    const source = [
      '// a header that says: import x from "../profiles/pack.js"',
      ' * and a block-comment line quoting from "../seam/exec.js"',
      'import { loadProfilesPack } from "../profiles/pack.js";',
    ].join("\n");
    // The second line is a bare `*` continuation OUTSIDE a comment here, which
    // is why the first draft's line rule was wrong: it is not always a comment.
    expect(importSpecifiers(source)).toContain("../profiles/pack.js");
    expect(importSpecifiers(`/*\n${source}\n*/`)).toEqual([]);
  });

  it("sees a multi-line import and a `*`-continuation line", () => {
    expect(importSpecifiers('import\n  * as p from "./pack.js";')).toEqual(["./pack.js"]);
    expect(
      importSpecifiers('import {\n  a,\n  b,\n}\n  from "./pack.js";'),
    ).toEqual(["./pack.js"]);
  });

  it("sees a dynamic import, a bare import and a re-export", () => {
    expect(importSpecifiers('const p = await import("./pack.js");')).toEqual(["./pack.js"]);
    expect(importSpecifiers('import "./pack.js";')).toEqual(["./pack.js"]);
    expect(importSpecifiers('export * from "./pack.js";')).toEqual(["./pack.js"]);
    expect(importSpecifiers('export { a } from "./pack.js";')).toEqual(["./pack.js"]);
    expect(importSpecifiers('const p = require("./pack.js");')).toEqual(["./pack.js"]);
  });

  it("is not fooled by a regex literal containing a quote", () => {
    // This is the case that would DESYNCHRONISE a naive string scanner and hide
    // every import below it -- and this file's own first draft contained such a
    // regex, so the hazard is not hypothetical.
    const source = [
      'const q = /from\\s+["\']([^"\']+)["\']/;',
      'import { a } from "./pack.js";',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["./pack.js"]);
  });

  it("is not fooled by a template literal, nested or otherwise", () => {
    const source = [
      "const a = `x ${`y ${1} z`} w`;",
      'import { b } from "./pack.js";',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["./pack.js"]);
    // A specifier that IS a template is dynamic and has no static answer.
    expect(importSpecifiers("const p = await import(`./${name}.js`);")).toEqual([]);
  });

  it("does not mistake a property or a key named `from` for an import", () => {
    expect(importSpecifiers('const a = { from: "./pack.js" };')).toEqual([]);
    expect(importSpecifiers('const a = x.from("./pack.js");')).toEqual([]);
  });

  it("collects the string arguments of a path call, through nesting", () => {
    // Once for the inner `join(...)` and once for the outer `readFileSync(...)`,
    // whose argument list contains the nested call's literals too. Duplicates
    // are fine: every rule over this list is a membership test.
    expect(pathCallArguments('readFileSync(join(root, "profiles", "a.json"), "utf8");')).toEqual([
      "profiles",
      "a.json",
      "profiles",
      "a.json",
      "utf8",
    ]);
    expect(pathCallArguments('join(root, "docs")')).toEqual(["docs"]);
    expect(pathCallArguments('// join(root, "profiles")')).toEqual([]);
  });

  it("matches a call by its callee's last segment, whatever the namespace", () => {
    // `fs.readFileSync(` and a bare `readFileSync(` are the same read; only
    // the alias differs, and the alias is whatever an import statement named
    // it. `xreadFileSync(` is NOT a match -- it is a different, longer name
    // that merely ends the same way.
    expect(pathCallArguments('fs.readFileSync("profiles/x.json")')).toEqual(["profiles/x.json"]);
    expect(pathCallArguments('nodeFs.readFileSync("profiles/x.json")')).toEqual([
      "profiles/x.json",
    ]);
    expect(pathCallArguments('xreadFileSync("profiles/x.json")')).toEqual([]);
  });

  it("reads a template literal's static text, split around each hole", () => {
    // `${id}` contributes no literal of its own -- it is not statically
    // known -- but the text on either side of it is read exactly like a
    // quoted string.
    expect(pathCallArguments("join(`profiles/${id}.json`)")).toEqual(["profiles/", ".json"]);
  });

  it("matches `Bun.file(...)` but not a bare, unrelated `file(...)`", () => {
    // `file` alone is far too common a method name to sweep generically, so
    // it is matched only in the one namespace this repository could
    // plausibly write it under.
    expect(pathCallArguments("Bun.file(`profiles/${id}.json`)")).toEqual(["profiles/", ".json"]);
    expect(pathCallArguments('file("profiles/x.json")')).toEqual([]);
    expect(pathCallArguments('config.file("profiles/x.json")')).toEqual([]);
  });
});

describe("the resolver", () => {
  const known = new Set([PACK, SEAM, "profiles/nextjs.json", "src/dev/matrix.ts"]);

  it("maps a `.js` specifier onto the `.ts` file that exists", () => {
    expect(resolveSpecifier("src/dev/matrix.ts", "../profiles/pack.js", known)).toBe(PACK);
    expect(resolveSpecifier("src/dev/matrix.ts", "../profiles/pack.ts", known)).toBe(PACK);
  });

  it("resolves a data import out of src/ entirely", () => {
    expect(resolveSpecifier(PACK, "../../profiles/nextjs.json", known)).toBe(
      "profiles/nextjs.json",
    );
  });

  it("resolves a sibling and an extensionless specifier", () => {
    expect(resolveSpecifier("src/profiles/other.ts", "./pack.js", known)).toBe(PACK);
    expect(resolveSpecifier("src/dev/matrix.ts", "../profiles/pack", known)).toBe(PACK);
  });

  it("leaves a bare specifier alone, so a builtin stays recognisable", () => {
    expect(resolveSpecifier(PACK, "node:fs", known)).toBe("node:fs");
    expect(resolveSpecifier(PACK, "node:child_process", known)).toBe("node:child_process");
  });

  it("does not mistake a module whose name merely ends the same way", () => {
    expect(resolveSpecifier("src/a.ts", "./profiles/unpack.js", known)).not.toBe(PACK);
    expect(isPack("src/profiles/unpack.ts")).toBe(false);
    expect(isPack("src/dev/matrix.ts")).toBe(false);
    expect(isPack(PACK)).toBe(true);
    expect(isPack("profiles/nextjs.json")).toBe(true);
  });
});
