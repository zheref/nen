// Read the archive's declared identity as data; never cut a tag or resolve a SHA.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, resolve, sep, win32 } from "node:path";
import { plainLine } from "../cli/plain.js";
import { requireRepoFlag, VerbUsageError, type CommandContext } from "../cli/command.js";
import { assertRepoRoot } from "../repo/root.js";
import { isRecord } from "../schema/errors.js";

export interface Announcement {
  readonly contract: "nen.tag.announce/v0.1";
  readonly status: "announced" | "undeclared" | "invalid";
  readonly identity: string | null;
  readonly archiveSha: string | null;
  readonly nameFrom: string | null;
  readonly error: string | null;
  readonly exitCode: 0 | 1 | 3;
}

/** Bounded, nonblocking descriptor read with no symlink components. */
function readRegular(root: string, relative: string, limit: number, twoLines: boolean): string {
  if (relative === "" || isAbsolute(relative) || win32.isAbsolute(relative) || win32.parse(relative).root !== "" || /[\0\r\n]/.test(relative) || relative.split(/[\\/]/).includes("..")) throw new Error("nameFrom must be a nonempty repo-relative path without '..' segments");
  const path = resolve(root, relative);
  const parts = path.slice(root.length + (root.endsWith(sep) ? 0 : 1)).split(sep);
  const inspect = (): Stats => {
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error(`input '${relative}' has a symlink component`);
      if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`input '${relative}' has a non-directory parent`);
      if (index === parts.length - 1) {
        if (!stat.isFile()) throw new Error(`input '${relative}' is not a regular file`);
        return stat;
      }
    }
    throw new Error(`input '${relative}' is not a regular file`);
  };
  const before = inspect();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`input '${relative}' changed before it was opened`);
    const chunks: Buffer[] = [];
    let length = 0; let newlines = 0;
    while (length <= limit) {
      const chunk = Buffer.alloc(Math.min(4096, limit + 1 - length));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      let used = count;
      for (let index = 0; index < count; index++) {
        if (chunk[index] === 10) newlines++;
        if (twoLines && newlines >= 2) { used = index + 1; break; }
      }
      chunks.push(chunk.subarray(0, used)); length += used;
      if (length > limit) throw new Error(`input '${relative}' exceeds the ${limit}-byte read limit`);
      if (twoLines && newlines >= 2) break;
    }
    const after = fstatSync(fd); const named = inspect();
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || named.dev !== opened.dev || named.ino !== opened.ino) throw new Error(`input '${relative}' changed during the read`);
    return Buffer.concat(chunks).toString("utf8");
  } finally { closeSync(fd); }
}

export function announceTag(root: string): Announcement {
  let nameFrom: string | null = null;
  const result = (status: Announcement["status"], exitCode: Announcement["exitCode"], identity: string | null = null, archiveSha: string | null = null, error: string | null = null): Announcement => ({ contract: "nen.tag.announce/v0.1", status, identity, archiveSha, nameFrom, error, exitCode });
  try {
    const canonical = realpathSync.native(root);
    const workflow: unknown = JSON.parse(readRegular(canonical, "nen/workflow.json", 1024 * 1024, false));
    if (!isRecord(workflow)) throw new Error("nen/workflow.json must contain an object");
    const tags = workflow["tags"];
    if (tags === undefined || tags === null) return result("undeclared", 3);
    if (!isRecord(tags)) throw new Error("tags must be an object");
    const identity = tags["identity"];
    if (identity === undefined || identity === null) return result("undeclared", 3);
    if (!isRecord(identity)) throw new Error("tags.identity must be an object");
    const path = identity["nameFrom"];
    if (typeof path !== "string" || path === "") throw new Error("tags.identity.nameFrom must be a nonempty string");
    nameFrom = path;
    const text = readRegular(canonical, path, 64 * 1024, true);
    const lines = text.split("\n");
    if (text.endsWith("\n")) lines.pop(); // a trailing terminator is not another line
    if (lines.length < 2) throw new Error("tags.identity.nameFrom must contain at least two lines");
    return result("announced", 0, lines[0]!.replaceAll("\r", ""), lines[1]!.replaceAll("\r", ""));
  } catch (error) { return result("invalid", 1, null, null, error instanceof Error ? error.message : String(error)); }
}

export function runAnnounce(context: CommandContext): number {
  if (context.args.positionals.length !== 2 || context.args.passthrough.length > 0) throw new VerbUsageError("tag announce takes no positional arguments");
  for (const flag of Object.keys(context.args.values)) if (flag !== "repo") throw new VerbUsageError(`--${flag} is not read by tag announce`);
  for (const flag of context.args.booleans) if (!["json", "help"].includes(flag)) throw new VerbUsageError(`--${flag} is not read by tag announce`);
  const root = assertRepoRoot({ repoFlag: requireRepoFlag(context, "It contains the archive's tag identity declaration.") });
  const report = announceTag(root);
  if (context.json) context.io.out(JSON.stringify(report, null, 2));
  else if (report.status === "announced") { context.io.out(report.identity!); context.io.out(report.archiveSha!); }
  else if (report.status === "undeclared") context.io.out("no tag declared");
  if (report.error !== null) context.io.err(plainLine(`tag declaration error: ${report.error}`));
  return report.exitCode;
}
