// Explicit-plan cleanup only. No discovery grants permission to remove a target.
// Dry runs make only reads; no fetch, global prune, reset, force removal or GC.
import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { VerbUsageError, requireRepoFlag, requireValue, type CommandContext } from "../cli/command.js";
import { readTextFile, resolveAgainstRepo } from "../cli/inputs.js";
import { plainLine } from "../cli/plain.js";
import { comparable, samePath } from "../canon/paths.js";
import { assertRepoRoot } from "../repo/root.js";
import { isRecord } from "../schema/errors.js";
import { loadWorkflow } from "../schema/workflow.js";
import { GIT, redactRemoteCredentials, type CommandResult, type Seams } from "../seam/exec.js";
import { isTrunk } from "./publish.js";
import { scrubbedGitEnv } from "./worktree.js";

export const PRUNE_CONTRACT = "nen.wc.prune/v0.1";
export type PruneItem =
  | { readonly kind: "worktree"; readonly path: string; readonly base: string }
  | { readonly kind: "local-branch"; readonly ref: string; readonly base: string }
  | { readonly kind: "remote-branch" | "remote-ref"; readonly remote: string; readonly ref: string; readonly base: string }
  | { readonly kind: "host-link"; readonly path: string };
export interface PruneOutcome {
  readonly item: PruneItem;
  readonly status: "would-remove" | "removed" | "missing" | "refused" | "failed" | "read-link";
  readonly message: string;
  readonly freedBytes: number | null;
  readonly measuredBytes: number | null;
  readonly linkTarget: string | null;
}
export interface PruneReport {
  readonly contract: typeof PRUNE_CONTRACT;
  readonly dryRun: boolean;
  readonly bytesBasis: "logical-file-bytes";
  readonly physicalFreedBytes: null;
  readonly freedBytes: number | null;
  readonly items: readonly PruneOutcome[];
}
class Refused extends Error {}

/** Reject malformed/unknown rows whole, before any operation can remove anything. */
export function parsePrunePlan(value: unknown): readonly PruneItem[] {
  if (!Array.isArray(value)) throw new VerbUsageError("--plan must be a JSON array of explicit cleanup items.");
  return value.map((row: unknown, index): PruneItem => {
    const fail = (): never => { throw new VerbUsageError(`--plan [${index}] has an unknown kind, field, or missing non-empty string. Expected worktree{path,base}, local-branch{ref,base}, remote-branch{remote,ref,base}, remote-ref{remote,ref,base}, or host-link{path}.`); };
    if (!isRecord(row)) return fail();
    const kind = row["kind"];
    const fields = kind === "worktree" ? ["path", "base"] : kind === "host-link" ? ["path"] : (kind === "remote-branch" || kind === "remote-ref") ? ["ref", "base", "remote"] : kind === "local-branch" ? ["ref", "base"] : null;
    if (fields === null || Object.keys(row).some((key) => key !== "kind" && !fields.includes(key)) || fields.some((key) => typeof row[key] !== "string" || row[key] === "" || /[\r\n\0]/.test(row[key]))) return fail();
    return row as unknown as PruneItem;
  });
}

interface Registration { readonly path: string; readonly head: string | null; readonly branch: string | null; readonly locked: boolean; }
function registrations(text: string): Registration[] {
  const rows: Registration[] = [];
  let current: { path: string; head: string | null; branch: string | null; locked: boolean } | null = null;
  for (const token of text.split("\0")) {
    if (token.startsWith("worktree ")) { current = { path: token.slice(9), head: null, branch: null, locked: false }; rows.push(current); }
    else if (current !== null && token.startsWith("HEAD ")) current.head = token.slice(5);
    else if (current !== null && token.startsWith("branch ")) current.branch = token.slice(7);
    else if (current !== null && (token === "locked" || token.startsWith("locked "))) current.locked = true;
  }
  return rows;
}

/** Count logical file/link bytes without following links; this is not disk capacity. */
function fileBytes(path: string): number {
  const stat = lstatSync(path);
  if (stat.isDirectory()) return readdirSync(path).reduce((sum, name) => sum + fileBytes(join(path, name)), 0);
  return stat.size;
}

export function prune(seams: Seams, root: string, plan: readonly PruneItem[], dryRun: boolean, trunk: string): PruneReport {
  const env = scrubbedGitEnv(seams.env);
  const call = (args: readonly string[], cwd: string = root): CommandResult => seams.run(GIT, [...args], { cwd, env });
  const git = (args: readonly string[], cwd: string = root): string => {
    const result = call(args, cwd);
    if (result.spawnFailed || result.code !== 0) throw new Error(`git ${args[0] ?? ""} failed (${result.code}): ${redactRemoteCredentials(result.stderr.trim())}`);
    return result.stdout.trim();
  };
  const fullRef = (ref: string): boolean => ref.startsWith("refs/") && call(["check-ref-format", ref]).code === 0;
  // Refname/namespace validation is whole-plan, and never calls a write command.
  for (const item of plan) {
    if (item.kind === "host-link") continue;
    if (!fullRef(item.base) || (!item.base.startsWith("refs/heads/") && !item.base.startsWith("refs/remotes/"))) throw new VerbUsageError(`invalid base ref '${item.base}': use a full local branch or remote-tracking ref.`);
    if (item.kind === "worktree") continue;
    const prefix = item.kind === "remote-ref" ? "refs/remotes/" : "refs/heads/";
    if (!item.ref.startsWith(prefix) || !fullRef(item.ref)) throw new VerbUsageError(`invalid ${item.kind} ref '${item.ref}': expected ${prefix}<name>.`);
    if ((item.kind === "remote-branch" || item.kind === "remote-ref") && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(item.remote)) throw new VerbUsageError(`invalid configured remote name '${item.remote}'.`);
  }
  // Reject duplicate destructive identities before the first write. Different
  // configured names may still address the same push endpoint and source ref.
  const targets = new Set<string>();
  for (const item of plan) {
    if (item.kind === "host-link") continue;
    let key: string;
    if (item.kind === "worktree") key = JSON.stringify(["worktree", comparable(resolveAgainstRepo(root, item.path), seams.platform)]);
    else if (item.kind === "remote-branch") {
      const result = call(["remote", "get-url", "--push", "--all", item.remote]);
      const urls = result.stdout.trim().split(/\r?\n/);
      // An unreadable/ambiguous endpoint is refused by its per-item guard.
      key = JSON.stringify(["remote", result.code === 0 && !result.spawnFailed && urls.length === 1 && urls[0] !== "" ? urls[0] : item.remote, item.ref]);
    } else key = JSON.stringify(["local-ref", item.ref]);
    if (targets.has(key)) throw new VerbUsageError("--plan contains a duplicate destructive target; list each worktree, local ref or exact remote endpoint/source ref only once.");
    targets.add(key);
  }
  if (!samePath(git(["rev-parse", "--show-toplevel"]), root, seams.platform)) throw new VerbUsageError("--repo must name this checkout's root.");
  const readRegistrations = (): Registration[] => registrations(git(["worktree", "list", "--porcelain", "-z"]));
  const initial = readRegistrations();
  const primary = initial[0]?.path;
  const simulatedRemoved = new Set<string>();
  const simulatedRemoteRemoved = new Set<string>();
  const outcome: PruneOutcome[] = [];
  const refSha = (ref: string): string | null => {
    const symbolic = call(["symbolic-ref", "-q", ref]);
    if (symbolic.code === 0) throw new Refused(`symbolic ref '${ref}' is not a removable branch or immutable base`);
    if (symbolic.code !== 1) throw new Error(`could not determine whether '${ref}' is symbolic: ${symbolic.stderr.trim()}`);
    const exists = call(["show-ref", "--verify", "--quiet", ref]);
    if (!exists.spawnFailed && exists.code === 1) return null;
    if (exists.spawnFailed || exists.code !== 0) throw new Error(`could not check '${ref}': ${exists.stderr.trim()}`);
    const result = call(["show-ref", "--verify", "--hash", ref]);
    if (result.spawnFailed || result.code !== 0) throw new Error(`could not read '${ref}': ${result.stderr.trim()}`);
    const sha = result.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`invalid object id for '${ref}'`);
    return sha;
  };
  const merged = (sha: string, base: string): void => {
    if (plan.some((item) => item.kind !== "worktree" && item.kind !== "host-link" && item.ref === base)) throw new Refused(`base '${base}' is itself listed for removal`);
    const baseSha = refSha(base);
    if (baseSha === null) throw new Refused(`base '${base}' is absent; fetch it explicitly before cleanup`);
    const result = call(["merge-base", "--is-ancestor", sha, baseSha]);
    if (result.code === 1) throw new Refused(`commit ${sha} is not merged into '${base}'; unpublished or unmerged work is retained`);
    if (result.spawnFailed || result.code !== 0) throw new Refused(`cannot prove ${sha} merged into '${base}'; fetch missing objects explicitly before cleanup`);
  };
  const remoteSha = (remote: string, ref: string, destination: string = remote): string | null => {
    if (!git(["remote"]).split(/\r?\n/).includes(remote)) throw new Refused(`'${remote}' is not a configured remote`);
    const text = git(["ls-remote", "--heads", "--", destination, ref]);
    const rows = text === "" ? [] : text.split(/\r?\n/);
    const match = rows.find((row) => row.split(/\s+/)[1] === ref);
    if (match === undefined) { if (rows.length !== 0) throw new Error("remote answered an unexpected ref"); return null; }
    const sha = match.split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("remote answered an invalid object id");
    return sha;
  };
  const remoteUrl = (remote: string, push: boolean): string => {
    if (!git(["remote"]).split(/\r?\n/).includes(remote)) throw new Refused(`'${remote}' is not a configured remote`);
    const urls = git(["remote", "get-url", ...(push ? ["--push"] : []), "--all", remote]).split(/\r?\n/);
    if (urls.length !== 1 || urls[0] === "") throw new Refused(`remote must have exactly one configured ${push ? "push" : "fetch"} URL`);
    return urls[0]!;
  };
  const endpointRef = (url: string, ref: string): string => JSON.stringify([url, ref]);
  const trackingSource = (remote: string, destination: string): string => {
    const result = call(["config", "--get-all", `remote.${remote}.fetch`]);
    if (result.spawnFailed || result.code !== 0 || result.stdout.trim() === "") throw new Refused("remote-ref requires configured fetch refspecs");
    const sources = new Set<string>();
    const excluded: string[] = [];
    const capture = (pattern: string, value: string): string | null => {
      const parts = pattern.split("*");
      if (parts.length > 2 || !fullRef(pattern.replace("*", "wildcard"))) throw new Refused("unsupported fetch refspec pattern");
      if (parts.length === 1) return pattern === value ? "" : null;
      return value.startsWith(parts[0]!) && value.endsWith(parts[1]!) && value.length >= parts[0]!.length + parts[1]!.length ? value.slice(parts[0]!.length, value.length - parts[1]!.length) : null;
    };
    for (const raw of result.stdout.trim().split(/\r?\n/)) {
      if (raw.startsWith("^")) {
        const pattern = raw.slice(1);
        capture(pattern, ""); // validate even when no candidate eventually matches
        excluded.push(pattern);
        continue;
      }
      const spec = raw.startsWith("+") ? raw.slice(1) : raw;
      const parts = spec.split(":");
      if (parts.length !== 2 || (parts[0]!.includes("*") !== parts[1]!.includes("*"))) throw new Refused("unsupported fetch refspec; a source and destination with matching wildcard shape are required");
      capture(parts[0]!, "");
      const middle = capture(parts[1]!, destination);
      if (middle !== null) sources.add(parts[0]!.replace("*", middle));
    }
    if (sources.size !== 1) throw new Refused("tracking ref must reverse to exactly one source through the named remote's fetch refspecs");
    const source = [...sources][0]!;
    if (!source.startsWith("refs/heads/") || !fullRef(source)) throw new Refused("tracking ref source must be one full refs/heads branch");
    if (excluded.some((pattern) => capture(pattern, source) !== null)) throw new Refused("tracking ref source is excluded by a negative fetch refspec");
    if (isTrunk(source.slice("refs/heads/".length), trunk) || source === "refs/heads/HEAD") throw new Refused("tracking ref maps to a protected base branch or HEAD");
    return source;
  };
  for (const item of plan) {
    let measured: number | null = null;
    let writeStarted = false;
    const record = (status: PruneOutcome["status"], message: string, freedBytes: number | null = 0, linkTarget: string | null = null): void => { outcome.push({ item, status, message, freedBytes, measuredBytes: measured, linkTarget }); };
    try {
      if (item.kind === "host-link") {
        const path = resolveAgainstRepo(root, item.path);
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (stat === undefined) record("missing", "host link is absent");
        else if (!stat.isSymbolicLink()) throw new Refused("host-link path is not a symlink; nothing is removed");
        else record("read-link", "host link read only", 0, readlinkSync(path));
        continue;
      }
      if (item.kind === "worktree") {
        const path = resolveAgainstRepo(root, item.path);
        if (samePath(path, root, seams.platform) || (primary !== undefined && samePath(path, primary, seams.platform))) throw new Refused("current or primary worktree is protected");
        const row = readRegistrations().find((entry) => samePath(entry.path, path, seams.platform));
        if (row === undefined) throw new Refused("path is not a registered worktree of this repository");
        if (row.locked) throw new Refused("worktree is locked");
        const stat = lstatSync(path, { throwIfNoEntry: false });
        if (stat === undefined) throw new Refused("registered worktree directory is missing; no global registration prune is permitted");
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Refused("worktree path must be a real directory, not a symlink");
        const canonical = realpathSync.native(path);
        if (git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=matching"], canonical) !== "") throw new Refused("worktree has tracked, untracked or ignored dirt; nothing is discarded");
        if (row.head === null) throw new Refused("worktree has no readable HEAD");
        if (row.branch !== null && isTrunk(row.branch.slice("refs/heads/".length), trunk)) throw new Refused("worktree holds a protected base branch");
        merged(row.head, item.base);
        measured = fileBytes(canonical);
        if (!Number.isSafeInteger(measured)) throw new Refused("worktree byte measurement is not a safe integer");
        if (!dryRun) {
          writeStarted = true;
          git(["worktree", "remove", "--", canonical]);
          if (lstatSync(canonical, { throwIfNoEntry: false }) !== undefined) throw new Error("worktree remove returned success but its directory remains");
        }
        simulatedRemoved.add(row.path);
        record(dryRun ? "would-remove" : "removed", "named clean merged worktree", dryRun ? 0 : measured);
        continue;
      }
      const branch = item.kind === "remote-ref" ? item.ref.split("/").slice(3).join("/") : item.ref.slice("refs/heads/".length);
      if (branch === "" || isTrunk(branch, trunk) || branch === "HEAD" || item.ref === item.base) throw new Refused("protected base branch or HEAD ref");
      let pushUrl: string | undefined;
      if (item.kind === "remote-branch") {
        pushUrl = remoteUrl(item.remote, true);
      }
      let sha: string | null;
      // Observe and lease the actual push destination, which can differ from
      // the fetch URL used by a remote name.
      if (item.kind === "remote-branch") sha = remoteSha(item.remote, item.ref, pushUrl);
      else sha = refSha(item.ref);
      if (sha === null) { record("missing", "named ref is absent"); continue; }
      merged(sha, item.base);
      if (item.kind === "local-branch") {
        const held = readRegistrations().find((row) => row.branch === item.ref && !(dryRun && simulatedRemoved.has(row.path)));
        if (held !== undefined) throw new Refused(`branch is checked out at '${held.path}'`);
        // Keep the non-force merge guard in addition to the explicit plan base.
        // Unlike branch -d, delete exactly the OID whose ancestry was proved.
        const upstream = git(["for-each-ref", "--format=%(refname)%09%(upstream)", item.ref]).split(/\r?\n/).find((row) => row.split("\t")[0] === item.ref)?.split("\t")[1] ?? "";
        const safetySha = upstream === "" ? git(["rev-parse", "--verify", "HEAD^{commit}"]) : refSha(upstream);
        if (safetySha === null) throw new Refused("branch upstream is absent; non-force deletion refused");
        const safety = call(["merge-base", "--is-ancestor", sha, safetySha]);
        if (safety.spawnFailed || safety.code !== 0) throw new Refused("branch is not merged into its readable upstream (or HEAD when no upstream); non-force deletion refused");
        if (!dryRun) {
          if (readRegistrations().some((row) => row.branch === item.ref)) throw new Refused("branch became checked out before deletion");
          writeStarted = true;
          git(["update-ref", "--no-deref", "-d", item.ref, sha]);
        }
      } else if (item.kind === "remote-branch") {
        // A push by configured remote NAME would also delete its unlisted
        // local tracking ref. Use its one configured push URL so that only
        // the explicitly named remote branch is touched.
        if (!dryRun) { writeStarted = true; git(["push", "--no-follow-tags", "--recurse-submodules=no", `--force-with-lease=${item.ref}:${sha}`, "--", pushUrl!, `:${item.ref}`]); }
        simulatedRemoteRemoved.add(endpointRef(pushUrl!, item.ref));
      } else {
        const fetchUrl = remoteUrl(item.remote, false);
        const source = trackingSource(item.remote, item.ref);
        if (remoteSha(item.remote, source, fetchUrl) !== null && !(dryRun && simulatedRemoteRemoved.has(endpointRef(fetchUrl, source)))) throw new Refused("remote branch still exists at the configured fetch URL; tracking ref is not stale");
        if (!dryRun) { writeStarted = true; git(["update-ref", "--no-deref", "-d", item.ref, sha]); }
      }
      record(dryRun ? "would-remove" : "removed", "only the named merged ref; no object GC", 0);
    } catch (error) {
      record(error instanceof Refused ? "refused" : "failed", error instanceof Error ? error.message : String(error), writeStarted ? null : 0);
    }
  }
  return { contract: PRUNE_CONTRACT, dryRun, bytesBasis: "logical-file-bytes", physicalFreedBytes: null, freedBytes: outcome.some((item) => item.freedBytes === null) ? null : outcome.reduce((sum, item) => sum + (item.freedBytes ?? 0), 0), items: outcome };
}

export function runPrune(context: CommandContext): number {
  const root = assertRepoRoot({ repoFlag: requireRepoFlag(context, "It is the repository whose explicitly listed resources may be removed.") });
  if (context.args.positionals.length !== 2) throw new VerbUsageError("wc prune takes no positional arguments; pass --plan <file>.");
  if (context.args.booleans.has("run") && context.args.booleans.has("dry-run")) throw new VerbUsageError("--run and --dry-run conflict.");
  const allowed = new Set(["plan", "repo"]);
  for (const flag of Object.keys(context.args.values)) if (!allowed.has(flag)) throw new VerbUsageError(`--${flag} is not read by wc prune; targets and bases belong in --plan.`);
  for (const flag of Object.keys(context.args.lists)) if ((context.args.lists[flag] ?? []).length > 0) throw new VerbUsageError(`--${flag} is not read by wc prune.`);
  for (const flag of context.args.booleans) if (!["run", "dry-run", "json", "help"].includes(flag)) throw new VerbUsageError(`--${flag} is not read by wc prune.`);
  const path = requireValue(context.args, "plan", "It is the JSON array of explicit cleanup items; relative paths resolve against --repo.");
  let value: unknown;
  try { value = JSON.parse(readTextFile(path, root, "A missing cleanup plan cannot be treated as permission to discover targets.")) as unknown; }
  catch (error) { if (error instanceof VerbUsageError) throw error; throw new VerbUsageError("--plan is not valid JSON."); }
  const plan = parsePrunePlan(value);
  const report = prune(context.seams, root, plan, !context.args.booleans.has("run"), loadWorkflow(root).workflow.branch.base);
  if (context.json) context.io.out(JSON.stringify(report, null, 2));
  else {
    for (const item of report.items) context.io.out(plainLine(`${item.item.kind}: ${item.status} -- ${item.message}${item.linkTarget === null ? "" : ` -> ${item.linkTarget}`}`));
    context.io.out(`freedBytes: ${report.freedBytes ?? "unknown"} (logical file bytes; physical capacity unknown)`);
  }
  return report.items.some((item) => item.status === "failed") ? 1 : report.items.some((item) => item.status === "refused") ? 2 : 0;
}
