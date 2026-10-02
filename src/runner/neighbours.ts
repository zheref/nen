// src/runner/neighbours.ts -- who else on THIS host runs as the account a plan
// names (#330).
//
// ONE ACCOUNT IS ONE TRUST DOMAIN. Every runner service that logs on as the
// same account can write every other one's binaries and `_work` (on Windows,
// `config.cmd` grants the account's `GITHUB_ActionsRunner_*` group full control
// of each `Runner<N>`). A host that runs a PUBLIC repository's jobs and a
// PRIVATE repository's under one account lets the public one's CI -- one
// compromised dependency -- persist into jobs that hold the private one's
// token. Feitan found exactly that on the maintainer's host (SEC-16).
//
// WARN AND RECOMMEND, NEVER REFUSE (the maintainer's ruling on #330). `runner
// plan` still accepts any local account; this module only reads the host's
// existing `actions.runner.*` services, read-only, and reports the ones that
// run as the chosen account for a repository whose visibility differs from
// the target's. The account itself stays a human step: nen never creates one
// and never handles its password.
//
// ONLY ON THE HOST. A plan is computable on a Mac for a Windows pool
// (./plan.ts); its neighbours are not. Off the host, or on macOS (a LaunchAgent
// has no account to name), the check says it did not run -- never "clear".
//
// A READ THAT FAILS IS A NOTE, NEVER AN EXIT. The plan is still right without
// it; what the maintainer loses is the warning, and the note says so.

import type { Target } from "../github/target.js";
import { outputLines, type Seams } from "../seam/exec.js";
import type { RunnerOs } from "../schema/workflow.js";
import { asRecord, gh } from "./github.js";
import { NETWORK_SERVICE } from "./plan.js";

export const SERVICE_PREFIX = "actions.runner.";

/** One runner service on this host and the account it logs on as. */
export interface HostService {
  readonly name: string;
  readonly account: string;
}

/** A service that shares the plan's account, and the repository it serves. */
export interface Neighbour {
  readonly service: string;
  /** `owner/name`, or null when no split of the service name resolves on GitHub. */
  readonly repository: string | null;
  /** `public` / `private` / `internal`, or null when unresolved. */
  readonly visibility: string | null;
}

export interface NeighbourReport {
  /** `checked`, `off-host` (another OS computed the plan), `no-account` (`ask`, macOS), or `unreadable`. */
  readonly status: "checked" | "off-host" | "no-account" | "unreadable";
  readonly detail: string;
  readonly targetVisibility: string | null;
  /** Services on this host running as the plan's account for a repository of different (or unknown) visibility. */
  readonly mixed: readonly Neighbour[];
  /** A per-repository account name to create, when `mixed` is non-empty. */
  readonly recommendedAccount: string | null;
}

/** A host read that failed: the check reports `unreadable`. Anything else is a defect and propagates. */
class HostReadError extends Error {}

const HOST_OS:Readonly<Partial<Record<NodeJS.Platform, RunnerOs>>> = { win32: "Windows", linux: "Linux" };

/** The Windows read: every runner service and its logon account, as JSON. */
export function windowsServicesArgv(): readonly string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Service -Filter \"Name LIKE 'actions.runner.%'\" | Select-Object Name, StartName | ConvertTo-Json -Compress",
  ];
}

export function linuxUnitsArgv(): readonly string[] {
  return ["list-units", `${SERVICE_PREFIX}*`, "--all", "--no-legend", "--plain", "--no-pager"];
}

export function linuxShowArgv(units: readonly string[]): readonly string[] {
  return ["show", ...units, "-p", "Id", "-p", "User", "--no-pager"];
}

function readWindows(seams: Seams): HostService[] {
  const result = seams.run("powershell", windowsServicesArgv());
  if (result.spawnFailed || result.code !== 0) throw new HostReadError(`powershell could not list services (${outputLines(result.stderr).join(" ") || `exit ${result.code}`})`);
  const text = result.stdout.trim();
  if (text === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HostReadError("powershell answered something that is not JSON");
  }
  // ConvertTo-Json writes one object, not a list, for a single service.
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => row !== null && typeof row["Name"] === "string")
    .map((row): HostService => ({ name: row["Name"] as string, account: typeof row["StartName"] === "string" ? row["StartName"] : "" }));
}

function readLinux(seams: Seams): HostService[] {
  const listed = seams.run("systemctl", linuxUnitsArgv());
  if (listed.spawnFailed || listed.code !== 0) throw new HostReadError(`systemctl could not list units (${outputLines(listed.stderr).join(" ") || `exit ${listed.code}`})`);
  const units = outputLines(listed.stdout)
    .map((line): string => line.trim().split(/\s+/)[0] ?? "")
    .filter((unit): boolean => unit.startsWith(SERVICE_PREFIX));
  if (units.length === 0) return [];
  const shown = seams.run("systemctl", linuxShowArgv(units));
  if (shown.spawnFailed || shown.code !== 0) throw new HostReadError(`systemctl could not show units (${outputLines(shown.stderr).join(" ") || `exit ${shown.code}`})`);
  const services: HostService[] = [];
  let id: string | null = null;
  let user = "";
  const flush = (): void => {
    if (id !== null) services.push({ name: id.replace(/\.service$/, ""), account: user });
    id = null;
    user = "";
  };
  for (const line of shown.stdout.replace(/\r\n/g, "\n").split("\n")) {
    if (line.trim() === "") flush();
    else if (line.startsWith("Id=")) id = line.slice(3);
    else if (line.startsWith("User=")) user = line.slice(5);
  }
  flush();
  return services;
}

/**
 * Whether a service's logon account is the plan's identity. Windows reports
 * `.\name`, `HOST\name` or `NT AUTHORITY\NetworkService`; the plan stores
 * `.\name` or `network-service`. Linux compares the bare user. Case-blind on
 * Windows, as its account names are.
 */
export function sameAccount(os: RunnerOs, identity: string, account: string, computerName: string | null): boolean {
  if (os === "Linux") return account === identity;
  const lower = account.toLowerCase();
  if (identity === NETWORK_SERVICE) return lower === "nt authority\\networkservice" || lower === "networkservice";
  const wanted = identity.replace(/^\.\\/, "").toLowerCase();
  const slash = lower.lastIndexOf("\\");
  if (slash === -1) return lower === wanted;
  const domain = lower.slice(0, slash);
  const user = lower.slice(slash + 1);
  return user === wanted && (domain === "." || (computerName !== null && domain === computerName.toLowerCase()));
}

/** Every `owner/name` a service name `actions.runner.<owner>-<repo>.<runner>` could mean, likeliest first. */
export function candidateRepositories(service: string, target: Target): string[] {
  if (!service.startsWith(SERVICE_PREFIX)) return [];
  const rest = service.slice(SERVICE_PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) return [];
  const middle = rest.slice(0, dot);
  const splits: string[] = [];
  for (let at = middle.indexOf("-"); at > 0; at = middle.indexOf("-", at + 1)) {
    if (at < middle.length - 1) splits.push(`${middle.slice(0, at)}/${middle.slice(at + 1)}`);
  }
  // The target's own owner first: a host's services are mostly one owner's.
  const ownerFirst = `${target.owner.toLowerCase()}/`;
  return [...splits.filter((slug): boolean => slug.toLowerCase().startsWith(ownerFirst)), ...splits.filter((slug): boolean => !slug.toLowerCase().startsWith(ownerFirst))];
}

export function repoArgv(slug: string): readonly string[] {
  return ["api", "--method", "GET", `repos/${slug}`];
}

/** A repository's canonical slug and visibility, or null when GitHub does not answer for it. */
function lookup(seams: Seams, slug: string, cache: Map<string, { slug: string; visibility: string } | null>): { slug: string; visibility: string } | null {
  const key = slug.toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? null;
  let found: { slug: string; visibility: string } | null = null;
  const result = gh(seams, repoArgv(slug));
  if (result.code === 0) {
    try {
      const answer = asRecord(JSON.parse(result.stdout));
      const visibility = answer?.["visibility"] ?? (answer?.["private"] === true ? "private" : answer?.["private"] === false ? "public" : null);
      const name = answer?.["full_name"];
      if (typeof visibility === "string") found = { slug: typeof name === "string" ? name : slug, visibility };
    } catch {
      found = null;
    }
  }
  cache.set(key, found);
  return found;
}

/** A per-repository account name: `runner-<repo>`, folded to what the OS accepts. */
export function recommendAccount(os: RunnerOs, target: Target): string {
  const base = `runner-${target.repo.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`.replace(/-+/g, "-").replace(/-$/, "");
  return base.slice(0, os === "Windows" ? 20 : 32).replace(/-$/, "");
}

export function checkNeighbours(seams: Seams, target: Target, os: RunnerOs, identity: string): NeighbourReport {
  const none = { targetVisibility: null, mixed: [], recommendedAccount: null };
  if (os === "macOS" || identity === "ask" || identity === "invoking-user") {
    return { status: "no-account", detail: os === "macOS" ? "a macOS runner is a LaunchAgent of the installing user; there is no service account to compare" : "no --service-account was named", ...none };
  }
  if (HOST_OS[seams.platform] !== os) {
    return { status: "off-host", detail: `this plan was computed on ${seams.platform}, not on the ${os} host, so the host's existing runner services were not read`, ...none };
  }
  let services: HostService[];
  try {
    services = os === "Windows" ? readWindows(seams) : readLinux(seams);
  } catch (error) {
    if (!(error instanceof HostReadError)) throw error;
    return { status: "unreadable", detail: error.message, ...none };
  }
  const computerName = seams.env["COMPUTERNAME"] ?? null;
  const ownPrefix = `${SERVICE_PREFIX}${target.owner}-${target.repo}.`.toLowerCase();
  const shared = services.filter(
    (service): boolean => !service.name.toLowerCase().startsWith(ownPrefix) && sameAccount(os, identity, service.account, computerName),
  );
  if (shared.length === 0) return { status: "checked", detail: `no other repository's runner service on this host runs as ${identity}`, ...none };

  const cache = new Map<string, { slug: string; visibility: string } | null>();
  const own = lookup(seams, target.slug, cache);
  const mixed: Neighbour[] = [];
  for (const service of shared) {
    let resolved: { slug: string; visibility: string } | null = null;
    for (const candidate of candidateRepositories(service.name, target)) {
      resolved = lookup(seams, candidate, cache);
      if (resolved !== null) break;
    }
    if (resolved !== null && resolved.slug.toLowerCase() === target.slug.toLowerCase()) continue;
    // Unknown on either side is reported: "could not tell" must never read as "the same".
    if (resolved === null || own === null || resolved.visibility !== own.visibility) {
      mixed.push({ service: service.name, repository: resolved?.slug ?? null, visibility: resolved?.visibility ?? null });
    }
  }
  return {
    status: "checked",
    detail: `${shared.length} other runner service(s) on this host run as ${identity}`,
    targetVisibility: own?.visibility ?? null,
    mixed,
    recommendedAccount: mixed.length === 0 ? null : recommendAccount(os, target),
  };
}

/** The lines `runner plan` prints on stderr. Empty when there is nothing to say. */
export function renderNeighbours(report: NeighbourReport, target: Target, identity: string): string[] {
  if (report.status === "checked" && report.mixed.length === 0) return [];
  if (report.status === "no-account") return [];
  if (report.status !== "checked") {
    return [`note: the shared-account check did not run (${report.detail}). Run 'nen runner plan' on the runner host to have it read.`];
  }
  return [
    `warning: ${identity} already runs ${report.mixed.length} runner service(s) on this host for a repository whose visibility differs from ${target.slug}'s (${report.targetVisibility ?? "unknown"}) -- one account is one trust domain, so either repository's jobs can rewrite the other's runners (#330):`,
    ...report.mixed.map((neighbour): string => `  ${neighbour.service} -- ${neighbour.repository ?? "(repository unresolved)"}, ${neighbour.visibility ?? "visibility unknown"}`),
    `recommended: a local account for ${target.slug} alone, e.g. --service-account ${report.recommendedAccount ?? "runner-<repo>"} (create it yourself first; nen never creates an account or handles its password).`,
  ];
}
