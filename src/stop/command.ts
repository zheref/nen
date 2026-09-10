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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const USAGE = `nen stop [--who <name>] [--gate G1|G1-M|G2|G3|G4|G5] [--notified] [--mark]
         [--repo <path>] [efforts.md | -]
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
  --template          Emit a blank 5-column table to fill in; nothing is
                      waited on, so no signal line is printed.

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
  flags: { values: ["who", "gate"], booleans: ["notified", "template", "mark"] },
  run(context: CommandContext): number {
    const gate = context.args.values["gate"] ?? null;
    if (gate !== null && !(gate in GATE_NAMES)) {
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
    const marker = mark ? writeMarker(context, { who, gate, notified }) : null;
    if (marker !== null) {
      lines.push(`marked: ${marker.path} -- a host hook may ring rungs 2-3 off it.`);
    }

    emit(context.io, context.json, { who, gate, notified, rows, marker }, lines);
    return 0;
  },
};

interface StopMarker {
  /** The absolute path written. */
  readonly path: string;
  readonly contract: string;
  readonly who: string | null;
  readonly gate: string | null;
  readonly notified: boolean;
  /** ISO-8601, from the invocation's own clock seam. */
  readonly at: string;
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
  stop: { who: string | null; gate: string | null; notified: boolean },
): StopMarker {
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const path = join(root, ...MARKER_FILE.split("/"));
  const marker: StopMarker = {
    path,
    contract: STOP_MARK_CONTRACT,
    who: stop.who,
    gate: stop.gate,
    notified: stop.notified,
    at: context.seams.now().toISOString(),
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    // The written document is the marker WITHOUT its own absolute path: a file
    // that names where it is is a file that is wrong the moment a checkout
    // moves, and the hook reading it already knows. It is BUILT here rather
    // than stripped from the marker, so a field added to StopMarker is a
    // decision about this file rather than a leak into it.
    const document = {
      contract: marker.contract,
      who: marker.who,
      gate: marker.gate,
      notified: marker.notified,
      at: marker.at,
    };
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
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
