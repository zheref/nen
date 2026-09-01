// src/loop/verb.ts -- `nen loop slots`.

import { readFileSync } from "node:fs";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { computeSlots, parseEfforts, DEFAULT_CAPS, type PlaneReport } from "./slots.js";

const USAGE = `nen loop slots -- how many concurrency slots each plane has free.

usage:
  nen loop slots --efforts <path.json> [--ci-cap <n>] [--local-cap <n>]

The efforts file is a JSON array of
  {"id": "...", "plane": "ci"|"local", "prOpen": bool, "ready": bool, "prompted": bool}

A CI slot frees when the PR OPENS -- something else drives it from there. A
LOCAL slot frees only when the PR is READY and the human has been PROMPTED,
because nothing else is behind a locally-authored PR. The two budgets are
counted separately and never traded against each other.

Exit 1 when either budget is fully occupied, so a caller can stop starting work
without re-reading the report.`;

function print(context: VerbContext, report: PlaneReport): void {
  context.io.out(
    `${report.plane}: ${report.occupied}/${report.cap} occupied, ${report.free} free${report.binding ? "  <- BINDING" : ""}`,
  );
  for (const entry of report.holding) context.io.out(`    ${entry.id}: ${entry.why}`);
}

export const loopVerb: Verb = {
  name: "loop",
  summary: "Count the CI and local concurrency budgets, separately.",
  usage: USAGE,
  flags: { values: ["efforts", "ci-cap", "local-cap"], booleans: [] },
  run(context: VerbContext): number {
    const [subcommand] = context.args;
    if (subcommand !== "slots") {
      return usage(context.io, `unknown 'loop' subcommand '${subcommand ?? "(none)"}'. Try 'loop slots'.`);
    }
    const path = context.values["efforts"];
    if (path === undefined) return usage(context.io, "--efforts <path.json> is required.");

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

    const caps = {
      ci: Number(context.values["ci-cap"] ?? DEFAULT_CAPS.ci),
      local: Number(context.values["local-cap"] ?? DEFAULT_CAPS.local),
    };
    if (!Number.isInteger(caps.ci) || !Number.isInteger(caps.local)) {
      return usage(context.io, "--ci-cap and --local-cap take integers.");
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
