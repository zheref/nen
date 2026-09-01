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
// THE TABLE IS PADDED MARKDOWN (bankai-core#653), via ../cli/table.ts: the
// terminal degrades to a clean aligned monospace table, a GUI surface that
// renders markdown sees a rich one, and padding is insignificant whitespace to
// a markdown parser either way. No colour, no OSC-8 hyperlink escapes in the
// table -- they would corrupt the markdown a caller pastes elsewhere.

import { readFileSync } from "node:fs";
import {
  emit,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { readTextFile } from "../cli/inputs.js";
import { parsePipeTable, renderPipeTable } from "../cli/table.js";
import { resolveRepoRoot } from "../repo/root.js";
import { normalizeEol } from "../seam/exec.js";

const USAGE = `nen stop [--who <name>] [--gate G1|G1-M|G2|G3|G4|G5] [--notified] [efforts.md | -]
nen stop --template

Render the gate-stop banner and the padded-markdown efforts table. The
embedded python3 this was ported from is removed -- there is only ever this
one renderer.

  --who <name>       Who is asking, stated by the caller. Nen ships no
                      built-in persona name.
  --gate <g>          The human gate being asked for.
  --notified          The caller already fired the push-notification rung.
  efforts.md | -       A markdown pipe table (header + rows); '-' reads stdin.
  --template          Emit a blank 5-column table to fill in; nothing is
                      waited on, so no signal line is printed.

Rungs 2-3 of the escalation ladder (an OS notification, an audible cue) are
NOT fired by this command: D16 restricts nen to shelling out to git and gh
only, and neither is a notification primitive. Wire them through your own
host if you need them; this command renders rung 4 (the banner and table) and
states rung 1's status, which is the caller's to have fired.`;

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
  flags: { values: ["who", "gate"], booleans: ["notified", "template"] },
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
      "rungs 2-3 (OS notification, audible cue): not fired by nen -- D16 permits only git/gh subprocesses.",
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

    emit(context.io, context.json, { who, gate, notified, rows }, lines);
    return 0;
  },
};

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
