// Read only the generated one-line result. Never open transcripts or execute
// summary text. A missing/unreadable directory cannot prove no registration.
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { plainLine } from "../cli/plain.js";
import { VerbUsageError } from "../cli/command.js";
import { validatePlan, type RunnerPlan } from "./plan.js";

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

export function readSummaryPlan(path: string, platform: NodeJS.Platform): RunnerPlan {
  if (platform === "win32" && !/^[A-Za-z]:[\\/]/.test(path)) throw new VerbUsageError("--plan must be a local drive-qualified path, not UNC or a device path.");
  let fd: number | undefined;
  let raw: unknown;
  try {
    const entry = lstatSync(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024 * 1024) throw new Error("invalid plan file");
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.ino !== entry.ino || stat.dev !== entry.dev || stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs) throw new Error("changed plan");
    const buffer = Buffer.alloc(stat.size);
    if (readSync(fd, buffer, 0, buffer.length, 0) !== stat.size) throw new Error("short plan read");
    const final = fstatSync(fd);
    if (final.size !== stat.size || final.mtimeMs !== stat.mtimeMs) throw new Error("changed plan");
    raw = JSON.parse(buffer.toString("utf8"));
  } catch { throw new VerbUsageError(`--plan '${plainLine(path)}' must be readable JSON in a stable regular file at most 1048576 bytes, not a link.`); }
  finally { if (fd !== undefined) closeSync(fd); }
  return validatePlan(raw, `--plan '${plainLine(path)}'`);
}

export function localSummaryRoot(plan: RunnerPlan): string {
  if (plan.os === "Windows" && !/^[A-Za-z]:[\\/]/.test(plan.projectDir)) {
    throw new VerbUsageError("summary reads require a local drive-letter project directory; UNC and device paths are refused.");
  }
  return plan.os === "Windows" && /^[A-Za-z]:$/.test(plan.root) ? `${plan.root}\\` : plan.root;
}

export function readSummary(plan: RunnerPlan, after: string, platform: NodeJS.Platform, read: (fd: number, buffer: Buffer) => number = (fd, buffer) => readSync(fd, buffer, 0, buffer.length, 0)): SummaryReport {
  const launched = launchTime(after);
  if ((plan.os === "Windows") !== (platform === "win32") || !isAbsolute(plan.projectDir)) {
    throw new VerbUsageError("read the summary on the plan's host with an absolute project directory; Windows and POSIX paths cannot be interchanged.");
  }
  const root = localSummaryRoot(plan);
  const directory = join(plan.projectDir, "_jusshin");
  const empty: SummaryReport = { contract: "nen.runner.summary/v0.1", verdict: "none", after, directory, path: null, writtenAt: null, registered: null, skipped: null, failed: null, reason: null };
  let path: string | null = null;
  let writtenAt: string | null = null;
  try {
    const directories = [root, plan.projectDir, directory].map((path) => {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("summary path components must be regular directories, not links");
      return { path, stat };
    });
    const checkDirectories = (): void => {
      for (const { path, stat } of directories) {
        const now = lstatSync(path);
        if (!now.isDirectory() || now.isSymbolicLink() || now.ino !== stat.ino || now.dev !== stat.dev) throw new Error("summary directory changed; retry");
      }
    };
    const candidates = readdirSync(directory).filter((name) => /^register-[^/\\]+\.summary$/.test(name)).map((name) => {
      const candidate = join(directory, name);
      const stat = lstatSync(candidate);
      // Even an old link is refused: following it could disclose arbitrary data.
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("summary entry must be a regular file, not a link");
      return { path: candidate, stat };
    }).filter(({ stat }) => stat.mtimeMs > launched).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs || a.path.localeCompare(b.path));
    const newest = candidates[0];
    checkDirectories();
    if (newest === undefined) return empty;
    path = newest.path;
    writtenAt = newest.stat.mtime.toISOString();
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let text: string;
    try {
      const current = fstatSync(fd);
      if (!current.isFile() || current.ino !== newest.stat.ino || current.dev !== newest.stat.dev || current.mtimeMs !== newest.stat.mtimeMs || current.size !== newest.stat.size) throw new Error("summary changed while being read; retry the read");
      if (current.size > 256) return { ...empty, verdict: "malformed", path, writtenAt, reason: "summary exceeds 256 bytes; contents withheld" };
      const buffer = Buffer.alloc(257);
      const length = read(fd, buffer);
      if (length !== current.size) throw new Error("short summary read; retry");
      checkDirectories();
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
  if (report.verdict === "none") return [`nothing was registered this run: no summary written after ${report.after} in ${plainLine(report.directory)}`];
  if (report.verdict !== "read") return [`runner summary ${report.verdict}: ${plainLine(report.path ?? report.directory)}: ${report.reason}`];
  return [`${plainLine(report.path ?? "")} (${report.writtenAt}): ${report.registered} registered, ${report.skipped} skipped, ${report.failed} failed`];
}
