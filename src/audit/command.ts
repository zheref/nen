// src/audit/command.ts -- `nen audit deps`: a repository's dependency pins,
// read from its lockfile and queried against the advisory service the
// declaring contract names (zheref/nen#508).
//
// WHY A VERB. The dependency audit had no owner: the Node half was an interim
// Hatsu script carrying its own hostile-input defences, and the Swift half was
// a procedure in a contract file's `$comment`, executed by hand. Deterministic
// jobs belong to nen, and a caller must never improvise one -- so the parsers,
// the OSV client and the exit-code contract live here, and the policy (where
// to send the query, which ecosystem, which severities count) stays the
// caller's, in the row `--contract` and `--row` name (./row.ts).
//
// FOUR EXITS, AND THEY NEVER BLUR (AC-8; ./verdict.ts):
//   0  resolved (no --query); or queried, with nothing at or above the floor
//      and nothing unqueried
//   1  --query: a finding at or above the floor, an UNRATED id, or any
//      unqueried entry -- evidence, never clean
//   2  wiring: the invocation, the contract, or nen itself; stderr only
//   3  NOT SCANNED: the tree or the service could not be read, named on one
//      closing `not scanned:` line
// A failure nen did not anticipate is a 2, never a 1: runFamily would map an
// unexpected throw to 1, and 1 here means "findings". So every throw that is
// not a verdict is caught below and re-raised as a usage-class stop.
//
// IT EXECUTES NOTHING AND READS NO ENVIRONMENT (AC-3). No package manager, no
// program the tree supplies, no `process.env`; ./command.test.ts sweeps this
// directory's source for the spellings that would do either.

import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";
import {
  emit,
  requireRepoFlag,
  requireSubcommand,
  requireValue,
  refuseExtraPositionals,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { resolveNode } from "./lockfiles.js";
import { queryOsv, type Fetch, type Finding } from "./osv.js";
import { loadRow, type AuditRow } from "./row.js";
import { resolveSwift } from "./swift.js";
import { NotScanned, notScanned, Wiring, type Evidence, type Pin, type Resolution } from "./verdict.js";

export const AUDIT_DEPS_CONTRACT = "nen.audit.deps/v0.1";
export const EXIT_FINDINGS = 1;
export const EXIT_WIRING = 2;
export const EXIT_NOT_SCANNED = 3;

const SUBCOMMANDS = ["deps"] as const;

const USAGE = `nen audit deps --repo <path> --contract <file> --row <name> [--stack <id>] [--query] [--json]

Read the directory at --repo's dependency pins from its lockfile -- never by
running its package manager -- and, with --query, ask the OSV querybatch
endpoint the declaring contract names about every one of them.

  --repo <path>      The directory to audit: a lane's cwd, or the checkout
                     root. Required. Its lockfile and package.json are read
                     there, directly, and a symbolic link is never followed.
  --contract <file>  The DECLARING CONTRACT: an ABSOLUTE path to a JSON file
                     with a 'dependencyAudit' object, rows keyed by name.
                     A relative path is refused:
                     the destination must never come from the audited tree.
  --row <name>       The row of 'dependencyAudit' to apply. Its 'ecosystem'
                     selects the reader: 'npm' reads pnpm-lock.yaml (5, 6, 9),
                     yarn.lock (berry, classic) or package-lock.json /
                     npm-shrinkwrap.json (1, 2, 3) through the row's
                     'managers'; 'SwiftURL' reads Package.resolved (1, 2, 3) at
                     the root or inside an .xcodeproj / .xcworkspace bundle.
                     Any other ecosystem is exit 2.
  --stack <id>       The lane's stack. A stack the row's 'stacks' does not
                     list is NOT SCANNED (exit 3), named.
  --query            Query OSV. Without it the verb resolves and stops.

Row keys read (unknown keys are exit 2): endpoint, vulnEndpoint (https, or
http on loopback only; vulnEndpoint's path must end in '/'), ecosystem, severityLevels, severityFloor (drawn from
the levels), timeoutSeconds, stacks; npm rows also registryHosts, managers
({lockfiles, format, lockfileMarkers}), unsupportedLockfiles, auditConfigKeys.
Bounds, defaulted when absent: maxResponseBytes 33554432, maxEntries 500000,
maxDepth 1000, maxLockfileBytes 268435456. Prose keys run, runSemantics,
resolution, failure and '$' keys are accepted and not read.

An entry from git, file:, a tarball off registryHosts, or a Swift pin on a
branch or revision is UNQUERIED, and unqueried is never clean. A severity
missing or outside severityLevels is UNRATED and counts as a finding.

Human lines: 'resolved:' first, then 'audit-config:' (evidence, never
honoured), 'local:', 'unqueried:', and with --query 'finding:' /
'below-floor:' per id and one closing 'audit:' line; or a closing
'not scanned: <reason>'. --json prints one document, top-level keys
contract (${AUDIT_DEPS_CONTRACT}), verdict, exit, row, ecosystem, stack,
queried, manager, files, source, packages, pins, local, unqueried, evidence,
findings, findingCount and notScanned.

Exit codes:
  0  resolved (no --query); or queried, nothing at or above the floor and
     nothing unqueried
  1  --query: a finding at or above the floor, an UNRATED id, or any
     unqueried entry -- evidence, never clean
  2  wiring: an argument, the contract, or an internal error; stderr only
  3  not scanned: the tree or OSV could not be read, with the reason

A pnpm entry is local or unqueried only by its own resolution map's keys; a
registry entry's resolved/tarball URL must name the pair the entry claims, or
the entry is unqueried. A redirect is not scanned, never followed.

It never executes the repository's package manager or any program the tree
supplies, and reads no environment variable of its own. Certificates are
always verified; the runtime's fetch honours the host's HTTPS_PROXY /
HTTP_PROXY / NO_PROXY and NODE_EXTRA_CA_CERTS, the host's network
configuration and the only environment that reaches the query.`;

export interface AuditReport {
  readonly contract: typeof AUDIT_DEPS_CONTRACT;
  readonly verdict: "resolved" | "clean" | "findings" | "not-scanned";
  readonly exit: number;
  readonly row: string;
  readonly ecosystem: string;
  readonly stack: string | null;
  readonly queried: boolean;
  readonly manager: string | null;
  readonly files: readonly string[];
  readonly source: string | null;
  readonly packages: number;
  readonly pins: readonly Pin[];
  readonly local: number;
  readonly unqueried: number;
  readonly evidence: readonly Evidence[];
  readonly findings: ReadonlyArray<{ readonly id: string; readonly severity: string; readonly atFloor: boolean; readonly pins: readonly string[] }>;
  readonly findingCount: number;
  readonly notScanned: string | null;
}

const q = (value: string): string => JSON.stringify(value);
const spec = (pin: Pin): string => `${pin.name}@${pin.version}`;

function resolutionLines(row: AuditRow, tree: Resolution): string[] {
  const files = tree.files.join(", ");
  const lines = [`resolved: osv ${row.ecosystem} for ${tree.manager} (${tree.source}, ${files}, ${String(tree.pins.length)} packages)`];
  for (const hit of tree.evidence) {
    if (hit.kind === "other-lockfile") lines.push(`audit-config: ${q(hit.file)} "other-lockfile" -- not audited; evidence for review`);
    else if (hit.kind === "key") lines.push(`audit-config: ${q(hit.file)} ${q(hit.key)} -- not honoured; evidence for review`);
    else lines.push(`audit-config: ${q(hit.file)} ${q(hit.key)}`);
  }
  if (tree.local > 0) lines.push(`local: ${String(tree.local)} ${files} entries are workspace, link or directory packages, not queried`);
  if (tree.unqueried > 0) {
    const what = row.reader === "lockfile"
      ? "come from git, file: or a host off registryHosts"
      : "are pinned to a branch or revision, a registry identity, or a non-git location";
    lines.push(`unqueried: ${String(tree.unqueried)} ${files} entries ${what} -- never clean`);
  }
  return lines;
}

function findingLines(findings: readonly Finding[]): string[] {
  return findings.map((finding: Finding): string =>
    `${finding.atFloor ? "finding" : "below-floor"}: ${finding.id} ${finding.severity} ${finding.pins.map((pin: Pin): string => q(spec(pin))).join(" ")}`);
}

interface Invocation {
  readonly dir: string;
  readonly contract: string;
  readonly rowName: string;
  readonly stack: string | null;
  readonly query: boolean;
}

function readInvocation(context: CommandContext): Invocation {
  requireSubcommand("audit", context.args, SUBCOMMANDS);
  refuseExtraPositionals(context.args, 2);
  const repo = requireRepoFlag(context, "It names the directory whose lockfile is audited.");
  const contract = requireValue(context.args, "contract", "It names the declaring contract the destination comes from.");
  if (!isAbsolute(contract)) {
    throw new VerbUsageError("--contract must be an absolute path; a relative one would be resolved somewhere a caller did not choose, and the destination must never come from the audited tree.");
  }
  const rowName = requireValue(context.args, "row", "It names the dependencyAudit row to apply (e.g. node, swift).");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(rowName)) throw new VerbUsageError("--row takes a row name ([A-Za-z0-9._-]).");
  const stackFlag = context.args.values["stack"];
  if (stackFlag !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(stackFlag)) throw new VerbUsageError("--stack takes a stack id ([a-z0-9._-]).");
  const dir = resolve(repo);
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new VerbUsageError(`--repo ${dir} is not a directory.`);
  return { dir, contract, rowName, stack: stackFlag ?? null, query: context.args.booleans.has("query") };
}

/**
 * The audit itself, with the advisory service's `fetch` as a parameter. The
 * command passes the runtime's; a test passes a stand-in.
 */
export async function runAudit(context: CommandContext, fetcher: Fetch): Promise<number> {
  const call = readInvocation(context);
  let row: AuditRow;
  try {
    row = loadRow(call.contract, call.rowName);
  } catch (error) {
    if (error instanceof Wiring) throw new VerbUsageError(error.message);
    throw error;
  }
  const lines: string[] = [];
  let tree: Resolution | null = null;
  let findings: Finding[] = [];
  let reason: string | null = null;
  try {
    if (call.stack !== null && !row.stacks.includes(call.stack)) notScanned(`stack ${q(call.stack)} is not on dependencyAudit.${row.name}.stacks`);
    tree = row.reader === "lockfile" ? resolveNode(call.dir, row) : resolveSwift(call.dir, row);
    lines.push(...resolutionLines(row, tree));
    if (call.query) {
      findings = await queryOsv(row, tree.pins, fetcher);
      lines.push(...findingLines(findings));
    }
  } catch (error) {
    if (!(error instanceof NotScanned)) throw error;
    reason = error.message;
    lines.push(`not scanned: ${reason}`);
  }
  const atFloor = findings.filter((finding: Finding): boolean => finding.atFloor).length;
  let exit: number;
  let verdict: AuditReport["verdict"];
  if (reason !== null) {
    exit = EXIT_NOT_SCANNED;
    verdict = "not-scanned";
  } else if (!call.query) {
    exit = 0;
    verdict = "resolved";
  } else {
    const unqueried = tree?.unqueried ?? 0;
    const packages = tree?.pins.length ?? 0;
    lines.push(`audit: ${String(atFloor)} finding(s) at or above ${row.severityFloor.join("/")} or unrated, ${String(unqueried)} unqueried, across ${String(packages)} packages`);
    exit = atFloor > 0 || unqueried > 0 ? EXIT_FINDINGS : 0;
    verdict = exit === 0 ? "clean" : "findings";
  }
  const report: AuditReport = {
    contract: AUDIT_DEPS_CONTRACT,
    verdict,
    exit,
    row: row.name,
    ecosystem: row.ecosystem,
    stack: call.stack,
    queried: call.query && reason === null,
    manager: tree?.manager ?? null,
    files: tree?.files ?? [],
    source: tree?.source ?? null,
    packages: tree?.pins.length ?? 0,
    pins: tree?.pins ?? [],
    local: tree?.local ?? 0,
    unqueried: tree?.unqueried ?? 0,
    evidence: tree?.evidence ?? [],
    findings: findings.map((finding: Finding): AuditReport["findings"][number] => ({
      id: finding.id,
      severity: finding.severity,
      atFloor: finding.atFloor,
      pins: finding.pins.map(spec),
    })),
    findingCount: atFloor,
    notScanned: reason,
  };
  emit(context.io, context.json, report, lines.map((line: string): string => plainLine(line)));
  return exit;
}

export const auditCommand: Command = {
  name: "audit",
  summary: "Dependency pins read from the lockfile and queried against the contract's OSV endpoint.",
  usage: USAGE,
  flags: { values: ["contract", "row", "stack"], booleans: ["query"] },
  subcommands: SUBCOMMANDS,
  exits: [
    { verb: "audit deps", code: EXIT_WIRING, meaning: "its own meaning of 2, beside usage: wiring -- an unreadable or invalid contract or row, an ecosystem with no reader, or an internal error; never a verdict about the tree" },
    { verb: "audit deps", code: EXIT_NOT_SCANNED, meaning: "not scanned: the lockfile or the advisory service could not be read (a symlink, a truncated or unrecognised lockfile, a bound exceeded, a malformed, failing, oversized or timed-out OSV answer); never clean" },
  ],
  async run(context: CommandContext): Promise<number> {
    try {
      return await runAudit(context, (input: URL, init: RequestInit): Promise<Response> => fetch(input, init));
    } catch (error) {
      if (error instanceof VerbUsageError) throw error;
      // Not a verdict and not anticipated: a wiring stop (2), never runFamily's 1, which here would read as "findings".
      throw new VerbUsageError(`internal error (${(error as Error | undefined)?.name ?? "unknown"}); a wiring stop, never a verdict`);
    }
  },
};
