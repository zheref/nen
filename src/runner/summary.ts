// Read only the generated one-line result. Never open transcripts or execute
// summary text. A missing/unreadable directory cannot prove no registration.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import type { RunnerPlan } from "./plan.js";

export interface SummaryReport {
  readonly contract: "nen.runner.summary/v0.1";
  readonly verdict: "read" | "none" | "unreadable" | "malformed";
  readonly after: string;
  readonly directory: string;
  readonly path: string | null;
  readonly writtenAt: string | null;
  readonly registered: number | null;
  readonly skipped: number | null;
  readonly failed: number | null;
  readonly reason: string | null;
}

export function launchTime(value: string): number {
  const time = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(time) || new Date(time).toISOString() !== value.replace(/(?<=:\d{2})Z$/, ".000Z")) {
    throw new VerbUsageError("--after must be a valid UTC ISO launch time (YYYY-MM-DDTHH:mm:ss[.sss]Z).");
  }
  return time;
}

export function readSummary(plan: RunnerPlan, after: string, platform: NodeJS.Platform): SummaryReport {
  const launched = launchTime(after);
  if ((plan.os === "Windows") !== (platform === "win32") || !isAbsolute(plan.projectDir)) {
    throw new VerbUsageError("read the summary on the plan's host with an absolute project directory; Windows and POSIX paths cannot be interchanged.");
  }
  const directory = join(plan.projectDir, "_jusshin");
  const empty: SummaryReport = { contract: "nen.runner.summary/v0.1", verdict: "none", after, directory, path: null, writtenAt: null, registered: null, skipped: null, failed: null, reason: null };
  let path: string | null = null;
  let writtenAt: string | null = null;
  try {
    const dirStat = lstatSync(directory);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error("summary directory must be a regular directory, not a link");
    const candidates = readdirSync(directory).filter((name) => /^register-[^/\\]+\.summary$/.test(name)).map((name) => {
      const candidate = join(directory, name);
      const stat = lstatSync(candidate);
      // Even an old link is refused: following it could disclose arbitrary data.
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("summary entry must be a regular file, not a link");
      return { path: candidate, stat };
    }).filter(({ stat }) => stat.mtimeMs > launched).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.path.localeCompare(b.path));
    const newest = candidates[0];
    if (newest === undefined) return empty;
    path = newest.path;
    writtenAt = newest.stat.mtime.toISOString();
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let text: string;
    try {
      const current = fstatSync(fd);
      if (!current.isFile() || current.ino !== newest.stat.ino || current.dev !== newest.stat.dev || current.mtimeMs !== newest.stat.mtimeMs || current.size !== newest.stat.size) throw new Error("summary changed while being read; retry the read");
      const buffer = Buffer.alloc(257);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      text = length > 256 ? "" : buffer.subarray(0, length).toString("utf8");
      const final = fstatSync(fd);
      if (final.mtimeMs !== current.mtimeMs || final.size !== current.size) throw new Error("summary changed while being read; retry the read");
    } finally { closeSync(fd); }
    const match = /^\uFEFF?jusshin: (\d+) registered, (\d+) skipped, (\d+) failed(?:\r?\n)?$/.exec(text);
    const counts = match?.slice(1).map(Number);
    if (counts === undefined || !counts.every(Number.isSafeInteger)) return { ...empty, verdict: "malformed", path, writtenAt, reason: "summary must contain exactly one generated count line (at most 256 bytes); contents withheld" };
    return { ...empty, verdict: "read", path, writtenAt, registered: counts[0]!, skipped: counts[1]!, failed: counts[2]! };
  } catch {
    return { ...empty, verdict: "unreadable", path, writtenAt, reason: "could not read the summary directory or a stable regular summary file; check existence, access and links, then retry" };
  }
}

export function renderSummary(report: SummaryReport): string[] {
  if (report.verdict === "none") return [`nothing was registered this run: no summary written after ${report.after} in ${report.directory}`];
  if (report.verdict !== "read") return [`runner summary ${report.verdict}: ${report.path ?? report.directory}: ${report.reason}`];
  return [`${report.path} (${report.writtenAt}): ${report.registered} registered, ${report.skipped} skipped, ${report.failed} failed`];
}
