// src/loop/command.ts -- `nen loop slots`.

import { readFileSync } from "node:fs";
import { requireSubcommand, requireValue, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { computeSlots, parseEfforts, DEFAULT_CI_CAP, type PlaneReport } from "./slots.js";

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
without re-reading the report.`;

function print(context: CommandContext, report: PlaneReport): void {
  context.io.out(
    `${report.plane}: ${report.occupied}/${report.cap} occupied, ${report.free} free${report.binding ? "  <- BINDING" : ""}`,
  );
  for (const entry of report.holding) context.io.out(`    ${entry.id}: ${entry.why}`);
}

export const loopCommand: Command = {
  name: "loop",
  summary: "Count the CI and local concurrency budgets, separately.",
  usage: USAGE,
  flags: { values: ["efforts", "ci-cap", "local-cap"], booleans: [] },
  run(context: CommandContext): number {
    requireSubcommand("loop", context.args, ["slots"]);
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

    let parsed;
    try {
      parsed = parseEfforts(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
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
