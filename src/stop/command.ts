// src/stop/command.ts -- `nen stop`: the gate-stop ceremony.
//
// PORTED FROM bankai-core's `scripts/gate_stop.sh` + `scripts/ichigo_prompt.sh`
// (bankai-core#598/#653), with the embedded python3 REMOVED as the issue asks
// -- this port has no interpreter fallback ladder to build, because there is
// only ever the one TypeScript renderer.
//
// TWO DELIBERATE DEVIATIONS FROM THE SOURCE, both forced by this repository's
// own §3 rule ("no hard-coded persona ... in shipped src/") rather than chosen
// for convenience:
//
//   1. NO PERSONA NAME IS BUILT IN. The source's banner names its own agent
//      persona in a literal string; src/taxonomy-purity.test.ts forbids that
//      exact literal (and five others) from appearing in shipped code. So the
//      caption is generic ("YOUR INPUT IS NEEDED") and `--who <name>` lets a
//      caller state the persona if their own workflow wants one named -- never
//      defaulted to one this binary would be shipping.
//   2. NO ASCII PORTRAIT. The source draws a shared pixel-art sprite
//      (`scripts/ichigo_pix.txt`) that is itself a specific persona's likeness
//      and has no schema equivalent to read it from. Dropping it is a real
//      fidelity gap, disclosed rather than silently improved: the escalation
//      ladder's rungs 2-4 (OS notification, audible cue, drawn banner) are
//      this command's job in the source, and only rung 4's TEXT survives here.
//
// RUNGS 2-3 (OS NOTIFICATION, AUDIBLE CUE) ARE NOT IMPLEMENTED, for a third
// reason that is not a persona rule: D16 restricts this binary to spawning
// `git` and `gh`, nothing else (../seam/exec.ts). A cross-platform "play a
// sound" / "raise a toast" primitive needs a third tool on PATH this binary
// is not permitted to shell out to. `nen stop` therefore renders rungs 1
// (stated, not fired -- that is the caller's, exactly as the source says) and
// 4 (the banner + table) and says plainly that 2-3 are the caller's to wire
// through their own host, rather than silently pretending to have rung them.
//
// ...AND `--mark` IS HOW THE HOST RINGS THEM WITHOUT NEN GROWING A NOTIFIER.
// The two rungs need a tool nen may not spawn; what they do NOT need is for
// nen to spawn it. `--mark` writes `.nen/last-stop.json` -- the marker's own
// contract string, who, which gate, whether rung 1 was already fired, and the
// instant -- and a hook on the caller's own
// host reads that file and rings whatever its platform has. The split is the
// same one this file already draws about rung 1: nen states the fact, the host
// acts on it. Nothing here plays a sound, raises a toast, or learns the name of
// a program that could; the marker is a FACT ABOUT THIS STOP, and a host that
// never reads it is a host where `--mark` costs one small file.
//
// THE MARKER GOES UNDER `.nen/`, WHICH IS GENERATED OUTPUT BY CONSTRUCTION
// (../schema/source.ts's one-character rule): committed configuration is
// `nen/`, so a `git add nen/` after a stop can never stage this file. The
// directory is created when it is absent, because a marker nobody can write is
// a rung nobody can ring.
//
// THE TABLE IS PADDED MARKDOWN (bankai-core#653), via ../cli/table.ts: the
// terminal degrades to a clean aligned monospace table, a GUI surface that
// renders markdown sees a rich one, and padding is insignificant whitespace to
// a markdown parser either way. No colour, no OSC-8 hyperlink escapes in the
// table -- they would corrupt the markdown a caller pastes elsewhere.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  emit,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { readTextFile } from "../cli/inputs.js";
import { parsePipeTable, renderPipeTable } from "../cli/table.js";
import { assertRepoRoot, resolveRepoRoot } from "../repo/root.js";
import { normalizeEol } from "../seam/exec.js";

/**
 * Where `--mark` writes, repo-relative and forward-slashed.
 *
 * `.nen/`, NOT `nen/`, and the one-character difference is ../schema/source.ts's
 * rule rather than a preference: `nen/` is committed configuration and `.nen/`
 * is generated output, so a `git add nen/` after a stop cannot stage this file.
 */
export const MARKER_FILE = ".nen/last-stop.json";

/** `nen.stop.mark/v0.1` -- the marker's own versioned contract string. */
export const STOP_MARK_CONTRACT = "nen.stop.mark/v0.1";
/**
 * `nen.stop.mark/v0.2` -- written INSTEAD of v0.1 whenever the stop carries
 * any of the new fields (zheref/nen#216): a title, a body, a report link, the
 * lettered options, a proposed process issue. A stop that carries none keeps
 * writing v0.1, so a hook reading the old shape sees nothing change until its
 * caller starts saying more.
 */
export const STOP_MARK_CONTRACT_V2 = "nen.stop.mark/v0.2";

const USAGE = `nen stop [--who <name>] [--gate G1|G1-M|G2|G3|G4|G5] [--notified] [--mark]
         [--title <line>] [--body <text>] [--report-url <url>]
         [--options <file.json>] [--propose-issue <file.json>]
         [--repo <path>] [efforts.md | -]
nen stop clear [--repo <path>]
nen stop show  [--repo <path>] [--json]
nen stop --template

Render the gate-stop banner and the padded-markdown efforts table. The
embedded python3 this was ported from is removed -- there is only ever this
one renderer.

  --who <name>       Who is asking, stated by the caller. Nen ships no
                      built-in persona name.
  --gate <g>          The human gate being asked for.
  --notified          The caller already fired the push-notification rung.
  --mark              Also write '${MARKER_FILE}' under --repo:
                      { contract, who, gate, notified, at }, where 'contract'
                      is '${STOP_MARK_CONTRACT}' -- the marker's own versioned
                      shape, so a hook can tell a future change from a
                      compatible one. The ONLY form of this verb that writes.
  efforts.md | -       A markdown pipe table (header + rows); '-' reads stdin.
  --title <line>      One line naming the stop, carried into the marker for a
                      host notification to show.
  --body <text>       The ask, in one or two sentences; carried the same way.
  --report-url <url>  Where the report for this stop was published. It is
                      LINKED with the banner and the marker; it is never one
                      of the options -- a report is read, not decided.
  --options <file>    A JSON array of the decisions this stop asks for:
                      [{ key, label, command, consequence?, recommended? }].
                      Rendered as lettered lines with a star on the
                      recommended one; at least ONE must be recommended, every
                      'command' must be non-empty (an option nothing executes
                      is a suggestion), and a label that reads 'open/read the
                      report' is refused. Fewer than three is accepted and
                      said aloud -- the caller's canon may want three.
  --propose-issue <f> A JSON object { title, body, labels? } drafting the
                      process issue this stop suggests filing, carried in the
                      marker under 'proposedIssue' and written beside it at
                      '.nen/proposed/<at>.json' for a later harvest.
  --template          Emit a blank 5-column table to fill in; nothing is
                      waited on, so no signal line is printed.

show:
  Read '${MARKER_FILE}' back and VALIDATE it: a v0.1 marker must carry exactly
  its five keys with the right types, a v0.2 marker the same plus title, body,
  reportUrl, options[] (each executable, one starred, none naming the report)
  and proposedIssue. Exit 0 and print it; exit 1 naming the first defect; a
  missing marker is exit 0 with 'no marker'. This is the validator a hook or a
  report can rely on: nothing else reads the marker back.

clear:
  Remove '${MARKER_FILE}' when it exists. A surface with no Stop hook consumes
  the marker itself once the bell has rung; this is that consumption as a verb.

Rungs 2-3 of the escalation ladder (an OS notification, an audible cue) are
NOT fired by this command: nen only ever shells out to git and gh, and
neither is a notification primitive. Wire them through your own
host if you need them; this command renders rung 4 (the banner and table) and
states rung 1's status, which is the caller's to have fired.

--mark is how a host wires those two rungs without nen learning a notifier: it
records this stop as a fact -- the contract string, who asked, which gate,
whether rung 1 was already fired, and the instant -- and a Stop hook on your
own machine reads '${MARKER_FILE}' and rings whatever that platform has. Nen
still fires nothing. The file lives under the dot-prefixed, gitignored '.nen/'
(generated output), never under the committed 'nen/'; the directory is created
if it is absent, and an existing marker is replaced, because the latest stop is
the one a hook should ring for.`;

const GATE_NAMES: Readonly<Record<string, string>> = {
  G1: "epic approval",
  "G1-M": "release into build",
  G2: "merge",
  G3: "release go/no-go",
  G4: "policy/spec change",
  G5: "decision / human-only action",
};

const TEMPLATE_TABLE = [
  ["Effort", "Open issues & PRs", "Status (gate)", "Thought flow", "Session / lane"],
  ["<title>", "<link>", "<status (gate)>", "<one line>", "<session>"],
];

export const stopCommand: Command = {
  name: "stop",
  summary: "Render the gate-stop banner and efforts table.",
  usage: USAGE,
  // NO "--from" HERE (review finding): it was declared with no reader --
  // `efforts.md | -` is read off the POSITIONAL, so `nen stop --from
  // efforts.md` parsed cleanly, silently rendered the banner with no table,
  // and exited 0. "--from" is also a highly plausible typo given
  // --files-from/--body-from/--rows-from/--board-from/--wakes-from/
  // --live-chores-from are this branch's convention everywhere else -- so a
  // dropped, undeclared flag becomes ../cli/args.ts's own strictness: a hard
  // usage error naming it, rather than a silently accepted no-op.
  // NO `subcommands` DECLARATION HERE, deliberately: this family's primary
  // grammar takes a POSITIONAL file (`nen stop efforts.md`), so a declared
  // subcommand list would make `nen stop efforts.md --help` refuse the file
  // as an unknown subcommand (review finding on zheref/nen#216). `clear` and
  // `show` are recognised in run() instead.
  flags: {
    values: ["who", "gate", "title", "body", "report-url", "options", "propose-issue"],
    booleans: ["notified", "template", "mark"],
  },
  run(context: CommandContext): number {
    if (context.args.positionals[1] === "clear") return clearMarker(context);
    if (context.args.positionals[1] === "show") return showMarker(context);
    const gate = context.args.values["gate"] ?? null;
    if (gate !== null && !Object.hasOwn(GATE_NAMES, gate)) {
      throw new VerbUsageError(
        `--gate must be one of ${Object.keys(GATE_NAMES).join(", ")}, got '${gate}'.`,
      );
    }
    const who = context.args.values["who"] ?? null;
    const notified = context.args.booleans.has("notified");
    const template = context.args.booleans.has("template");
    const mark = context.args.booleans.has("mark");
    // `--template` EMITS A BLANK TABLE AND WAITS ON NOTHING, so there is no
    // stop for a marker to be about: writing one would leave a hook ringing for
    // an event that never happened, and the next real stop's marker would be
    // the SECOND file a host saw. Refused by name rather than ignored -- a flag
    // this verb accepted and silently dropped is a rung the caller believes is
    // armed (../scaffold/command.ts states the same rule for its own pair).
    if (mark && template) {
      throw new VerbUsageError(
        "--mark and --template contradict each other: --template prints a blank table and waits on nothing, so there is no stop to record. Drop one.",
      );
    }

    const lines: string[] = [];

    if (template) {
      lines.push(...renderPipeTable(TEMPLATE_TABLE));
      emit(context.io, context.json, { template: true, rows: TEMPLATE_TABLE }, lines);
      return 0;
    }

    lines.push("=== YOUR INPUT IS NEEDED " + "=".repeat(30));
    if (who !== null) lines.push(`who: ${who}`);
    if (gate !== null) lines.push(`gate: ${gate} -- ${GATE_NAMES[gate]}`);
    lines.push(
      notified
        ? "rung 1 (push notification): reported sent by the caller."
        : "rung 1 (push notification): NOT fired -- the caller's to have sent, before this renders.",
    );
    lines.push(
      "rungs 2-3 (OS notification, audible cue): not fired by nen -- only git/gh subprocesses are ever shelled out to.",
    );
    lines.push("see the table below. No banner above => nothing needs you right now.");

    const title = context.args.values["title"] ?? null;
    const body = context.args.values["body"] ?? null;
    const reportUrl = context.args.values["report-url"] ?? null;
    if (title !== null) lines.push(`title: ${title}`);
    if (body !== null) lines.push(`ask: ${body}`);
    if (reportUrl !== null) lines.push(`report: ${reportUrl}`);

    const cwdForFiles = resolveRepoRoot({ repoFlag: context.repoFlag });
    const optionsFile = context.args.values["options"] ?? null;
    const options = optionsFile === null ? null : readOptions(optionsFile, cwdForFiles);
    if (options !== null) {
      lines.push("");
      lines.push("options -- pick one (the star is the recommendation):");
      for (const option of options) {
        lines.push(`  ${option.recommended ? "⭐ " : "   "}${option.key} -- ${option.label}`);
        lines.push(`       ${option.command}${option.consequence === null ? "" : `  · ${option.consequence}`}`);
      }
      if (options.length < 3) {
        lines.push(`  (${options.length} option${options.length === 1 ? "" : "s"} -- fewer than the three a stop usually offers)`);
      }
    }
    const issueFile = context.args.values["propose-issue"] ?? null;
    const proposedIssue = issueFile === null ? null : readProposedIssue(issueFile, cwdForFiles);
    if (proposedIssue !== null) {
      lines.push("");
      lines.push(`proposed process issue: ${proposedIssue.title}`);
    }

    const src = context.args.positionals[1];
    let rows: string[][] = [];
    if (src !== undefined) {
      const cwd = resolveRepoRoot({ repoFlag: context.repoFlag });
      const text = src === "-" ? readStdin() : readTextFile(src, cwd);
      rows = parsePipeTable(text);
      if (rows.length > 0) {
        lines.push("");
        lines.push(...renderPipeTable(rows));
      }
    }

    // THE MARKER IS WRITTEN LAST, AFTER EVERY REFUSAL THIS VERB CAN MAKE. An
    // unreadable efforts file is a stop that did not render, and a hook ringing
    // for a banner nobody saw is worse than one that never rang.
    const marker = mark
      ? writeMarker(context, { who, gate, notified, title, body, reportUrl, options, proposedIssue })
      : null;
    if (marker !== null) {
      lines.push(`marked: ${marker.path} (${marker.contract}) -- a host hook may ring rungs 2-3 off it.`);
      if (marker.proposedPath !== null) lines.push(`proposed issue written: ${marker.proposedPath}`);
    }

    emit(context.io, context.json, { who, gate, notified, title, body, reportUrl, options, proposedIssue, rows, marker }, lines);
    return 0;
  },
};

export interface StopOption {
  readonly key: string;
  readonly label: string;
  readonly command: string;
  readonly consequence: string | null;
  readonly recommended: boolean;
}

export interface ProposedIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

interface StopMarker {
  /** The absolute path written. */
  readonly path: string;
  readonly contract: string;
  readonly who: string | null;
  readonly gate: string | null;
  readonly notified: boolean;
  /** ISO-8601, from the invocation's own clock seam. */
  readonly at: string;
  readonly title: string | null;
  readonly body: string | null;
  readonly reportUrl: string | null;
  readonly options: readonly StopOption[] | null;
  readonly proposedIssue: ProposedIssue | null;
  /** Where the proposed issue was written beside the marker, or null. */
  readonly proposedPath: string | null;
}

const REPORT_AS_OPTION = /\b(open|read|view|see)\b.*\breport\b/i;

/** The options file: a JSON array, every entry executable, one star. */
export function parseOptions(document: unknown, display: string): StopOption[] {
  if (!Array.isArray(document) || document.length === 0) {
    throw new VerbUsageError(`--options ${display}: expected a non-empty JSON array of { key, label, command, consequence?, recommended? }.`);
  }
  const options = document.map((raw, index): StopOption => {
    const at = `--options ${display}[${index}]`;
    if (typeof raw !== "object" || raw === null) throw new VerbUsageError(`${at}: not an object.`);
    const entry = raw as Record<string, unknown>;
    const key = entry["key"];
    const label = entry["label"];
    const command = entry["command"];
    if (typeof key !== "string" || key.trim() === "") throw new VerbUsageError(`${at}.key: a non-empty string is required.`);
    if (typeof label !== "string" || label.trim() === "") throw new VerbUsageError(`${at}.label: a non-empty string is required.`);
    if (typeof command !== "string" || command.trim() === "") {
      throw new VerbUsageError(`${at}.command: a non-empty command line is required. An option nothing executes is a suggestion, not an option.`);
    }
    if (REPORT_AS_OPTION.test(label)) {
      throw new VerbUsageError(`${at}.label reads '${label}'. The report is linked with every stop (--report-url) and is never one of the decisions; drop this option.`);
    }
    const consequence = entry["consequence"];
    if (consequence !== undefined && consequence !== null && typeof consequence !== "string") throw new VerbUsageError(`${at}.consequence: a string when present.`);
    const recommended = entry["recommended"];
    if (recommended !== undefined && typeof recommended !== "boolean") throw new VerbUsageError(`${at}.recommended: a boolean when present.`);
    return { key, label, command, consequence: (consequence as string | undefined) ?? null, recommended: recommended === true };
  });
  const starred = options.filter((option): boolean => option.recommended).length;
  if (starred !== 1) {
    throw new VerbUsageError(`--options ${display}: exactly one option must be 'recommended' (found ${starred}). A stop with no star, or two, has not made a recommendation.`);
  }
  const keys = new Set(options.map((option): string => option.key));
  if (keys.size !== options.length) throw new VerbUsageError(`--options ${display}: option keys must be distinct.`);
  return options;
}

const OPTIONS_WHY = "A stop with no options renders no decisions; the file named here IS the ask, so an unreadable one is refused rather than rendered as a stop with nothing to pick.";
const ISSUE_WHY = "A proposed issue with no draft is not a proposal; the file named here IS the draft, so an unreadable one is refused.";

function readOptions(file: string, cwd: string): StopOption[] {
  const text = readTextFile(file, cwd, OPTIONS_WHY);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new VerbUsageError(`--options ${file}: not JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  return parseOptions(parsed, file);
}

export function parseProposedIssue(document: unknown, display: string): ProposedIssue {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new VerbUsageError(`--propose-issue ${display}: expected a JSON object { title, body, labels? }.`);
  }
  const entry = document as Record<string, unknown>;
  const title = entry["title"];
  const body = entry["body"];
  if (typeof title !== "string" || title.trim() === "") throw new VerbUsageError(`--propose-issue ${display}.title: a non-empty string is required.`);
  if (typeof body !== "string" || body.trim() === "") throw new VerbUsageError(`--propose-issue ${display}.body: a non-empty string is required -- a draft with no body is not a draft.`);
  const labels = entry["labels"] ?? [];
  if (!Array.isArray(labels) || labels.some((label): boolean => typeof label !== "string")) {
    throw new VerbUsageError(`--propose-issue ${display}.labels: an array of strings when present.`);
  }
  return { title, body, labels: labels as string[] };
}

function readProposedIssue(file: string, cwd: string): ProposedIssue {
  const text = readTextFile(file, cwd, ISSUE_WHY);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new VerbUsageError(`--propose-issue ${file}: not JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  return parseProposedIssue(parsed, file);
}

/**
 * The marker read back and validated -- v0.1 or v0.2 -- or a one-line reason
 * it is not a marker. Exported for the report assembler and for tests.
 */
export function parseMarker(document: unknown): { ok: true; marker: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return { ok: false, reason: "not a JSON object" };
  const m = document as Record<string, unknown>;
  const contract = m["contract"];
  if (contract !== STOP_MARK_CONTRACT && contract !== STOP_MARK_CONTRACT_V2) {
    return { ok: false, reason: `contract is ${JSON.stringify(contract)}; expected '${STOP_MARK_CONTRACT}' or '${STOP_MARK_CONTRACT_V2}'` };
  }
  const str = (key: string): string | null => {
    const v = m[key];
    if (v !== null && typeof v !== "string") throw new Error(`${key} must be a string or null`);
    return (v as string | null | undefined) ?? null;
  };
  try {
    str("who");
    const gate = str("gate");
    if (gate !== null && !Object.hasOwn(GATE_NAMES, gate)) throw new Error(`gate '${gate}' is not one of ${Object.keys(GATE_NAMES).join(", ")}`);
    if (typeof m["notified"] !== "boolean") throw new Error("notified must be a boolean");
    const at = str("at");
    if (at === null || Number.isNaN(Date.parse(at))) throw new Error("at must be an ISO-8601 instant");
    if (contract === STOP_MARK_CONTRACT_V2) {
      str("title");
      str("body");
      str("reportUrl");
      if (m["options"] !== null && m["options"] !== undefined) parseOptions(m["options"], "marker");
      if (m["proposedIssue"] !== null && m["proposedIssue"] !== undefined) parseProposedIssue(m["proposedIssue"], "marker");
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, marker: m };
}

/** `nen stop show` -- the marker, validated. */
function showMarker(context: CommandContext): number {
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const path = join(root, ...MARKER_FILE.split("/"));
  if (!existsSync(path)) {
    emit(context.io, context.json, { present: false, path }, [`no marker at ${path}.`]);
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    context.io.err(`nen stop: ${path} is not JSON (${error instanceof Error ? error.message : String(error)}).`);
    return 1;
  }
  const verdict = parseMarker(parsed);
  if (!verdict.ok) {
    context.io.err(`nen stop: ${path} is not a valid marker: ${verdict.reason}.`);
    return 1;
  }
  const m = verdict.marker;
  const lines = [
    `marker: ${path} (${String(m["contract"])})`,
    `  who: ${String(m["who"] ?? "-")} · gate: ${String(m["gate"] ?? "-")} · notified: ${String(m["notified"])} · at: ${String(m["at"])}`,
  ];
  if (typeof m["title"] === "string") lines.push(`  title: ${m["title"]}`);
  if (typeof m["reportUrl"] === "string") lines.push(`  report: ${m["reportUrl"]}`);
  if (Array.isArray(m["options"])) lines.push(`  options: ${m["options"].length}`);
  emit(context.io, context.json, { present: true, path, marker: m }, lines);
  return 0;
}

/** `nen stop clear` -- consume the marker, on a surface with no hook to do it. */
function clearMarker(context: CommandContext): number {
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const path = join(root, ...MARKER_FILE.split("/"));
  if (!existsSync(path)) {
    emit(context.io, context.json, { cleared: false, path }, [`no marker at ${path} -- nothing to clear.`]);
    return 0;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    throw new StopMarkError(`clear could not remove '${path}' (${(error as NodeJS.ErrnoException).code ?? String(error)}).`);
  }
  emit(context.io, context.json, { cleared: true, path }, [`cleared ${path}.`]);
  return 0;
}

/**
 * Record this stop as a fact a host hook can read.
 *
 * THE INSTANT COMES FROM THE SEAM (`../seam/exec.ts`'s `now`), not from
 * `new Date()`. Every verb in this CLI that reasons about time reads it once
 * from there, which is what makes a marker's freshness window -- the thing a
 * host hook checks before ringing -- provable in a test rather than a race.
 *
 * A FAILED WRITE IS A REFUSAL, NOT A SILENT MISS. A caller who typed `--mark`
 * asked for a rung to be armed; "the banner rendered and the marker did not"
 * is exactly the state where somebody waits for a bell that will never ring, so
 * it exits 1 with the errno rather than 0 with a shrug.
 */
function writeMarker(
  context: CommandContext,
  stop: {
    who: string | null;
    gate: string | null;
    notified: boolean;
    title: string | null;
    body: string | null;
    reportUrl: string | null;
    options: readonly StopOption[] | null;
    proposedIssue: ProposedIssue | null;
  },
): StopMarker {
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const path = join(root, ...MARKER_FILE.split("/"));
  const at = context.seams.now().toISOString();
  const rich =
    stop.title !== null || stop.body !== null || stop.reportUrl !== null || stop.options !== null || stop.proposedIssue !== null;
  const proposedPath = stop.proposedIssue === null ? null : join(root, ".nen", "proposed", `${at.replace(/[:.]/g, "-")}.json`);
  const marker: StopMarker = {
    path,
    contract: rich ? STOP_MARK_CONTRACT_V2 : STOP_MARK_CONTRACT,
    who: stop.who,
    gate: stop.gate,
    notified: stop.notified,
    at,
    title: stop.title,
    body: stop.body,
    reportUrl: stop.reportUrl,
    options: stop.options,
    proposedIssue: stop.proposedIssue,
    proposedPath,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    // The written document is the marker WITHOUT its own absolute path: a file
    // that names where it is is a file that is wrong the moment a checkout
    // moves, and the hook reading it already knows. It is BUILT here rather
    // than stripped from the marker, so a field added to StopMarker is a
    // decision about this file rather than a leak into it. THE v0.1 SHAPE IS
    // WRITTEN BYTE-COMPATIBLY when nothing new was said (zheref/nen#216).
    const document = rich
      ? {
          contract: marker.contract,
          who: marker.who,
          gate: marker.gate,
          notified: marker.notified,
          at: marker.at,
          title: marker.title,
          body: marker.body,
          reportUrl: marker.reportUrl,
          options: marker.options,
          proposedIssue: marker.proposedIssue,
        }
      : {
          contract: marker.contract,
          who: marker.who,
          gate: marker.gate,
          notified: marker.notified,
          at: marker.at,
        };
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    if (proposedPath !== null && stop.proposedIssue !== null) {
      mkdirSync(dirname(proposedPath), { recursive: true });
      writeFileSync(
        proposedPath,
        `${JSON.stringify({ contract: "nen.stop.proposed-issue/v0.1", at, gate: stop.gate, who: stop.who, ...stop.proposedIssue }, null, 2)}\n`,
        "utf8",
      );
    }
  } catch (error) {
    throw new StopMarkError(
      `--mark could not write '${path}' (${(error as NodeJS.ErrnoException).code ?? String(error)}). The banner above rendered; the marker did not, so no host hook will ring for this stop.`,
    );
  }
  return marker;
}

/**
 * A marker that could not be written. NOT a `VerbUsageError`: nothing the
 * caller typed produced it, so exit 1 ("the thing you asked for did not work")
 * rather than 2 -- ../index.ts's own distinction.
 */
export class StopMarkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StopMarkError";
  }
}

// '-' reads stdin, EOL-normalized like every other repo-file read (see
// ../cli/inputs.ts's header on why CRLF is normalized at every read site). Not
// routed through readTextFile itself: '-' there would mean "a file literally
// named -", and stdin is a different input.
function readStdin(): string {
  try {
    return normalizeEol(readFileSync(0, "utf8"));
  } catch (error) {
    throw new VerbUsageError(
      `could not read stdin (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}
