// src/loop/command.ts -- `nen loop slots` and `nen loop iterate`.
//
// Two verbs about two different budgets, which is why they share a family: how
// many efforts may run AT ONCE (slots), and how many times one of them may act
// BEFORE it comes back to a human (iterate). Both are caps a caller agreed to
// and neither is one nen may widen on its own.

import { copyFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  emit,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { resolveRepoRoot } from "../repo/root.js";
import { resolveAgainstRepo } from "../cli/inputs.js";
import { parseIzanagiInvocation } from "../parse/izanagi.js";
import { computeSlots, parseEfforts, DEFAULT_CI_CAP, type PlaneReport } from "./slots.js";
import { claimIteration, loopIdSegment, parseLedger, type LoopLedger } from "./ledger.js";
import { LOOP_COMMON_DIR, LOOP_LEDGER_DIR, present, resolveLoopHome } from "./home.js";

// Where a loop's ledger lives is ./home.ts's: `<git-common-dir>/nen/loop/`,
// with `<--repo>/.nen/loop/` (`.nen/`, never the committed `nen/`) only outside
// a git repository. Re-exported for the callers that named it here.
export { LOOP_COMMON_DIR, LOOP_LEDGER_DIR };

const USAGE = `nen loop slots -- how many concurrency slots each plane has free.

usage:
  nen loop slots --efforts <path.json> --local-cap <n> [--ci-cap <n>]

The efforts file is a JSON array of
  {"id": "...", "plane": "ci"|"local", "prOpen": bool, "ready": bool, "prompted": bool}

A CI slot frees when the PR OPENS -- something else drives it from there. A
LOCAL slot frees only when the PR is READY and the human has been PROMPTED,
because nothing else is behind a locally-authored PR. The two budgets are
counted separately and never traded against each other.

--local-cap is REQUIRED. It used to default to 7, and that default was removed
(issue #52): a concurrency guard must be chosen, not inherited -- every real
caller's own policy was far stricter, and a forgotten flag silently WIDENED the
guard, the dangerous direction for a safety cap to fail toward.

--ci-cap defaults to ${DEFAULT_CI_CAP}: the ported loop's own CI budget, which every known
caller runs unchanged, so an omission errs tight rather than loose.

Exit 1 when either budget is fully occupied, so a caller can stop starting work
without re-reading the report.

nen loop iterate -- izanagi's cap, enforced ACROSS a loop.

usage:
  nen loop iterate --id <id> --line "<task> until <condition> up to <N>"
                   [--release <why>] [--repo <path>] [--json]

'parse izanagi' refuses an invocation with no 'up to <N>', and then never sees
iteration 2; 'watch until --max-iterations' is a different, optional bound on
izanami's read-only loop. So the count of how many times the MUTATING task had
actually run lived only in the caller's own head (issue #47). This verb is the
backstop: CLAIM each iteration before performing it, and the cap is enforced by
the claim being refused rather than by anyone remembering.

  --id <id>       The caller's own label for this loop. One path segment
                  ([A-Za-z0-9._-], no '..'); anything else is REFUSED rather
                  than sanitised, because two ids mangled to one segment would
                  silently share a cap between two loops.
  --line "<...>"  The invocation, restated on EVERY claim and parsed by the
                  izanagi grammar (so the cap is grammar here too). A claim
                  whose line differs from the running one is refused, naming
                  both: a cap a caller can raise by re-typing the line with a
                  bigger N is not a cap.
  --release <why> End the loop instead of claiming -- the condition became
                  true, or a gate ended it. Releasing twice is not an error;
                  claiming after a release is.

The ledger is '<git-common-dir>/${LOOP_COMMON_DIR}/<id>.json' -- git rev-parse
--git-common-dir of --repo, one home shared by the main checkout and every
linked worktree, so removing an effort worktree never resets a cap. Only when
--repo is not inside a git repository is it '${LOOP_LEDGER_DIR}/<id>.json' under
--repo. Every claim also writes '<id>.opened' beside the ledger; a missing
ledger beside that marker is a LOST ledger, refused, never iteration 1. A
ledger an older build left at '${LOOP_LEDGER_DIR}/<id>.json' under --repo is
moved to the common-dir home once, on the first read, and reported.

Exit 0 on a claim or a release; exit 1 when the cap is REACHED -- an answer,
not a failure: izanagi's cap is grammar rather than a default precisely so that
reaching it is a decision to bring to a human, never a bound to raise and
re-run. Exit 2 for a malformed id, a malformed line, a changed line, a claim
after a release, an unreadable ledger, a lost ledger ('ledger lost'), a ledger
in both homes at once, or a git that cannot name the common directory.`;

function print(context: CommandContext, report: PlaneReport): void {
  context.io.out(
    `${report.plane}: ${report.occupied}/${report.cap} occupied, ${report.free} free${report.binding ? "  <- BINDING" : ""}`,
  );
  for (const entry of report.holding) context.io.out(`    ${entry.id}: ${entry.why}`);
}

export const loopCommand: Command = {
  name: "loop",
  subcommands: ["slots", "iterate"],
  summary: "Count the concurrency budgets, and enforce izanagi's iteration cap.",
  usage: USAGE,
  flags: { values: ["efforts", "ci-cap", "local-cap", "id", "line", "release"], booleans: [] },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("loop", context.args, ["slots", "iterate"]);
    if (subcommand === "iterate") return iterate(context);
    const path = context.args.values["efforts"];
    if (path === undefined) throw new VerbUsageError("--efforts <path.json> is required.");

    // Required, no default (issue #52). The old default of 7 sat more than
    // three times looser than every real caller's own stated policy of 2, so a
    // forgotten flag silently widened a concurrency guard -- the dangerous
    // direction for a safety cap. Refused BEFORE the efforts file is read: a
    // wrong invocation is exit 2 territory, and it should not be masked by
    // whatever the file happens to contain.
    const localCapRaw = requireValue(
      context.args,
      "local-cap",
      "The old default of 7 was removed (issue #52): a concurrency guard must be chosen, not inherited. Pass the local-plane cap your own policy states, e.g. --local-cap 2.",
    );

    const caps = {
      ci: Number(context.args.values["ci-cap"] ?? DEFAULT_CI_CAP),
      local: Number(localCapRaw),
    };
    if (!Number.isInteger(caps.ci) || !Number.isInteger(caps.local)) {
      throw new VerbUsageError("--ci-cap and --local-cap take integers.");
    }

  // RESOLVED OUTSIDE THE TRY (Copilot, PR #197). A malformed `--repo` throws a
  // RepoRootError, which ../index.ts maps to the usage exit 2 it is -- but only
  // if it is allowed to propagate. Inside the read's own catch it became exit 1
  // under a "could not read --efforts" message about a file nobody had a path to
  // yet, which is the wrong code and the wrong sentence at once.
    const root = resolveRepoRoot({ repoFlag: context.repoFlag });
    let parsed;
    try {
      const full = resolveAgainstRepo(root, path);
      parsed = parseEfforts(readFileSync(full, "utf8").replace(/\r\n/g, "\n"));
    } catch (error) {
      context.io.err(`nen: could not read --efforts '${path}': ${String(error)}`);
      return 1;
    }
    if (parsed.errors.length > 0) {
      for (const error of parsed.errors) context.io.err(`nen: ${error}`);
      return 1;
    }
    const report = computeSlots(parsed.efforts, caps);
    if (context.json) {
      context.io.out(JSON.stringify(report, null, 2));
    } else {
      print(context, report.ci);
      print(context, report.local);
      if (report.done.length > 0) context.io.out(`freed: ${report.done.join(", ")}`);
    }
    return report.ci.binding || report.local.binding ? 1 : 0;
  },
};

/**
 * `nen loop iterate` -- claim one iteration against the invocation's own cap.
 *
 * THE READ, THE DECISION AND THE WRITE ARE THREE STEPS, and the decision is the
 * one with no filesystem in it (./ledger.ts's `claimIteration`). That split is
 * what lets the branches that must never be reachable by accident -- raising a
 * cap mid-loop, re-entering a released loop -- be tested as data rather than as
 * a sequence of temp directories.
 */
function iterate(context: CommandContext): number {
  const id = requireValue(
    context.args,
    "id",
    "It is this loop's own label, and the name of the ledger that carries its count between invocations.",
  );
  const segment = loopIdSegment(id);
  if (segment === null) {
    throw new VerbUsageError(
      `--id '${id}' is not usable as a ledger name. It must be 1-100 characters of [A-Za-z0-9._-], start with a letter or digit, and contain no '..'. It is REFUSED rather than sanitised: two ids mangled to one segment would silently share a cap between two loops, which is the failure this verb exists to prevent.`,
    );
  }

  const line = requireValue(
    context.args,
    "line",
    "The invocation is restated on EVERY claim, not just the first, so nen can refuse a claim whose line differs from the running one -- a cap a caller can raise by re-typing it with a bigger N is not a cap.",
  );
  const parsed = parseIzanagiInvocation(line);
  if (!parsed.ok) {
    throw new VerbUsageError(
      `--line is not an izanagi invocation: ${parsed.error.message}${parsed.error.correctedLine === null ? "" : ` Try: '${parsed.error.correctedLine}'`}`,
    );
  }

  const release = context.args.values["release"] ?? null;
  if (release !== null && release.trim() === "") {
    throw new VerbUsageError(
      "--release takes the reason the loop ended -- the condition became true, a gate ended it, the caller abandoned it. An empty reason records that a loop stopped and not why, which is the half a later reader needs.",
    );
  }

  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const home = resolveLoopHome(root, context.seams);
  const path = join(home.dir, `${segment}.json`);
  const marker = join(home.dir, `${segment}.opened`);
  const located = locateLedger(context, home.legacyDir === null ? null : join(home.legacyDir, `${segment}.json`), path, marker, id);
  const existing = located.ledger;
  const migratedFrom = located.migratedFrom;

  const result = claimIteration(existing, {
    id,
    line: line.trim(),
    task: parsed.value.task,
    condition: parsed.value.condition,
    cap: parsed.value.cap,
    now: context.seams.now().toISOString(),
    release: release === null ? null : release.trim(),
  });

  if (!result.ok) {
    if (result.error.kind === "usage") throw new VerbUsageError(result.error.message);
    // THE CAP IS EXIT 1, NOT 2. It is an ANSWER about a loop that ran, not a
    // complaint about how the caller typed it: the invocation was well-formed
    // and nen did exactly what the caller asked, which was to stop here.
    for (const chunk of result.error.message.split("\n")) context.io.err(`nen: ${chunk}`);
    if (context.json) {
      context.io.out(
        JSON.stringify(
          {
            contract: existing?.contract ?? "nen.loop.iterate/v0.1",
            id,
            claimed: false,
            capReached: true,
            cap: existing?.cap ?? parsed.value.cap,
            iterations: existing?.iterations ?? 0,
            released: existing?.released ?? false,
            durable: home.durable,
            migratedFrom,
          },
          null,
          2,
        ),
      );
    }
    return 1;
  }

  // THE MARKER FIRST, THEN THE LEDGER. A marker without a ledger is the
  // lost-ledger refusal, the safe direction; a ledger without a marker would be
  // a loop whose loss later reads as a fresh start.
  writeMarker(marker, result.ledger);
  writeLedger(path, result.ledger);
  const ledger = result.ledger;
  const lines = result.released
    ? [`released ${ledger.id} after ${ledger.iterations}/${ledger.cap} iteration(s): ${ledger.releaseReason ?? ""}`]
    : [
        `iteration ${ledger.iterations}/${ledger.cap} -- ${ledger.task} until ${ledger.condition}`,
        `  ${ledger.cap - ledger.iterations} remaining after this one; ledger ${path}`,
      ];
  emit(
    context.io,
    context.json,
    {
      contract: ledger.contract,
      id: ledger.id,
      claimed: !result.released,
      capReached: false,
      task: ledger.task,
      condition: ledger.condition,
      cap: ledger.cap,
      iterations: ledger.iterations,
      remaining: ledger.cap - ledger.iterations,
      released: ledger.released,
      releaseReason: ledger.releaseReason,
      startedAt: ledger.startedAt,
      lastAt: ledger.lastAt,
      path,
      durable: home.durable,
      marker,
      migratedFrom,
    },
    lines,
  );
  return 0;
}

/**
 * The ledger at `path`, or null when there is none.
 *
 * AN UNREADABLE OR UNRECOGNISED LEDGER IS A REFUSAL, never a fresh start. A
 * loop whose count nen cannot read is a loop with an unknown number of writes
 * behind it, and beginning again from 1 would hand out a whole cap's worth more.
 */
function readLedger(path: string): LoopLedger | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // ONLY "IT IS NOT THERE" MEANS "NO LEDGER" (Copilot, PR #185). A blanket
    // catch read EACCES, EPERM, EISDIR and every transient IO failure as "this
    // loop has not begun", which restarts the count -- handing out a whole
    // fresh cap on exactly the machine that could not read how much of the old
    // one was spent. That is the one direction this verb must never fail in,
    // and it flatly contradicted the paragraph above it.
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw new VerbUsageError(
        `the ledger at ${path} could not be read (${code ?? String(error)}). Refusing rather than treating it as a loop that never began: a fresh start here would hand out a whole cap's worth of iterations on the one machine that cannot tell how much of the old cap was already spent.`,
      );
    }
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new VerbUsageError(
      `the ledger at ${path} is not readable JSON (${error instanceof Error ? error.message : String(error)}). Refusing rather than starting the count again: a loop whose count nen cannot read has an unknown number of writes behind it, and beginning at 1 would hand out a whole cap's worth more. Read it, then delete it if the loop is genuinely finished.`,
    );
  }
  const ledger = parseLedger(value);
  if (ledger === null) {
    throw new VerbUsageError(
      `the file at ${path} is not a '${"nen.loop.iterate/v0.1"}' ledger. Refusing rather than overwriting it: something else owns that path, or it was written by a build with a different ledger shape.`,
    );
  }
  return ledger;
}

interface Located {
  readonly ledger: LoopLedger | null;
  /** The worktree-local path the ledger was moved from on this read, or null. */
  readonly migratedFrom: string | null;
}

/**
 * Find the ledger for one id, applying the migration and the lost-ledger rule.
 *
 * In order: a ledger in BOTH homes is refused (nen never picks which count is
 * true); a ledger only at the old worktree-local path is moved to the durable
 * home once and reported; a ledger at neither, beside an existing `.opened`
 * marker, is LOST and refused; a ledger at neither with no marker is a loop
 * that never began.
 */
function locateLedger(
  context: CommandContext,
  legacyPath: string | null,
  path: string,
  marker: string,
  id: string,
): Located {
  const here = present(path, "ledger");
  const legacy = legacyPath !== null && legacyPath !== path && present(legacyPath, "ledger");
  if (here && legacy) {
    throw new VerbUsageError(
      `loop '${id}' has a ledger in two homes at once:\n  ${path}\n  ${legacyPath}\nRefusing rather than choosing which count is true. Keep the one that carries the loop's real count, delete the other, and claim again.`,
    );
  }
  if (legacy && legacyPath !== null) {
    // Read (and so validate) BEFORE moving: an unrecognised file at the old
    // path is refused where it stands, never carried into the durable home.
    const moved = readLedger(legacyPath);
    if (moved === null) {
      throw new VerbUsageError(`the loop ledger at ${legacyPath} vanished while it was being read for migration. Refusing rather than counting from nothing; claim again.`);
    }
    // The marker goes down WITH the move, not on the next successful claim: a
    // migrated loop already at its cap is refused before any claim writes one,
    // and its later loss must still read as lost rather than as a fresh loop.
    writeMarker(marker, moved);
    moveLedger(legacyPath, path);
    context.io.err(`nen: migrated loop ledger '${id}' from ${legacyPath} to ${path} (the durable git-common-dir home; this happens once).`);
    return { ledger: readLedger(path), migratedFrom: legacyPath };
  }
  if (!here) {
    if (present(marker, "loop marker")) {
      throw new VerbUsageError(
        `ledger lost: loop '${id}' was opened under this repository (${marker}) but its ledger at ${path} is gone. Refusing rather than starting at iteration 1: the iterations it spent are unknown, and a fresh count would hand out a whole cap's worth more. Restore the ledger, or end the loop by hand and begin a new one under its own --id.`,
      );
    }
    return { ledger: null, migratedFrom: null };
  }
  return { ledger: readLedger(path), migratedFrom: null };
}

function moveLedger(from: string, to: string): void {
  try {
    mkdirSync(dirname(to), { recursive: true });
    try {
      renameSync(from, to);
    } catch (error) {
      // A worktree on another filesystem from its git directory cannot rename
      // across; copy then remove, in that order, so a failure leaves a copy.
      if ((error as NodeJS.ErrnoException | null)?.code !== "EXDEV") throw error;
      copyFileSync(from, to);
      unlinkSync(from);
    }
  } catch (error) {
    throw new VerbUsageError(
      `the loop ledger at ${from} could not be moved to its durable home ${to} (${(error as NodeJS.ErrnoException | null)?.code ?? String(error)}). Refusing rather than counting from either copy: check both paths, keep the one with the loop's real count, and claim again.`,
    );
  }
}

function writeMarker(path: string, ledger: LoopLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${ledger.id} opened ${ledger.startedAt}\n`, "utf8");
}

function writeLedger(path: string, ledger: LoopLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}
