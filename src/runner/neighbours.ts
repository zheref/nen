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
// existing `actions.runner.*` services, read-only, and reports two things:
// the services that run as the CHOSEN account for a repository whose
// visibility differs from the target's, and -- because following the advice
// moves only the new runners -- the target's OWN existing runners that would
// stay on an account shared that way. The account itself stays a human step:
// nen never creates one and never handles its password.
//
// EVERY SERVICE IS RESOLVED, NONE IS ASSUMED. `actions.runner.<owner>-<repo>.
// <runner>` is ambiguous (`zheref-nen.docs.R1` is zheref/nen.docs; `a-b-c` is
// a/b-c or a-b/c), so no service is taken for the target's by its prefix: each
// is resolved over `gh`, the target owner's split tried first, the first that
// GitHub answers for kept. A name no split resolves (actions/runner shortens a
// long one on Windows) is reported as unresolved, never dropped -- "could not
// tell" must never read as "the same".
//
// ONLY ON THE HOST. A plan is computable on a Mac for a Windows pool
// (./plan.ts); its neighbours are not. Off the host, or on macOS (a LaunchAgent
// has no account to name), the check says it did not run -- never "clear".
//
// A READ THAT FAILS IS A NOTE OR AN UNRESOLVED ROW, NEVER AN EXIT. The plan is
// already written when this runs; what a failed read costs is the warning.

import type { Target } from "../github/target.js";
import { outputLines, type Seams } from "../seam/exec.js";
import type { RunnerOs } from "../schema/workflow.js";
import { asRecord, gh, RunnerFailure } from "./github.js";
import { NETWORK_SERVICE } from "./plan.js";

export const SERVICE_PREFIX = "actions.runner.";
/** The NetworkService SID: the one spelling no Windows display language changes. */
export const NETWORK_SERVICE_SID = "S-1-5-20";

/** One runner service on this host and the account it logs on as. */
export interface HostService {
  readonly name: string;
  readonly account: string;
  /** The account's SID, when the host could translate it (Windows only). */
  readonly sid: string | null;
}

/** A service, and the repository it serves. */
export interface Neighbour {
  readonly service: string;
  /** `owner/name`, or null when no split of the service name resolves on GitHub. */
  readonly repository: string | null;
  /** `public` / `private` / `internal`, or null when unresolved. */
  readonly visibility: string | null;
}

/** The target's own runners that stay on an account shared across visibilities. */
export interface Stranded {
  readonly account: string;
  readonly services: readonly string[];
  /** The other repositories that account serves, with a different or unknown visibility. */
  readonly sharedWith: readonly Neighbour[];
}

export interface NeighbourReport {
  /** `checked`, `off-host` (another OS computed the plan), `no-account` (`ask`, macOS), or `unreadable`. */
  readonly status: "checked" | "off-host" | "no-account" | "unreadable";
  readonly detail: string;
  readonly targetVisibility: string | null;
  /** Services on this host running as the plan's account for a repository of different (or unknown) visibility. */
  readonly mixed: readonly Neighbour[];
  /** The target's own existing runners whose (other) account is shared that way. */
  readonly stranded: readonly Stranded[];
  /** A per-repository account name to create, when `mixed` is non-empty. */
  readonly recommendedAccount: string | null;
}

/** A host read that failed: the check reports `unreadable`. Anything else is a defect and propagates. */
class HostReadError extends Error {}

const HOST_OS: Readonly<Partial<Record<NodeJS.Platform, RunnerOs>>> = { win32: "Windows", linux: "Linux" };

/**
 * Windows PowerShell by its full path when the host names its system root:
 * a bare `powershell` is looked up from the current directory first, and
 * `plan` runs inside a repository checkout.
 */
export function powershellPath(env: Readonly<Record<string, string | undefined>>): string {
  const root = env["SystemRoot"] ?? env["SYSTEMROOT"];
  return root === undefined || root === "" ? "powershell" : `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** The Windows read: every runner service, its logon account, and that account's SID, as JSON. */
export function windowsServicesArgv(): readonly string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Get-CimInstance Win32_Service -Filter \"Name LIKE 'actions.runner.%'\" | Select-Object Name, StartName, @{ n = 'Sid'; e = { try { ([Security.Principal.NTAccount]$_.StartName).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $null } } } | ConvertTo-Json -Compress",
  ];
}

export function linuxUnitsArgv(): readonly string[] {
  return ["list-units", `${SERVICE_PREFIX}*`, "--all", "--no-legend", "--plain", "--no-pager"];
}

export function linuxShowArgv(units: readonly string[]): readonly string[] {
  return ["show", ...units, "-p", "Id", "-p", "User", "--no-pager"];
}

function readWindows(seams: Seams): HostService[] {
  const result = seams.run(powershellPath(seams.env), windowsServicesArgv());
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
  // A row this read cannot vouch for makes the WHOLE read unreadable: dropping
  // it, or reading a missing account as "", could silence the warning.
  return rows.map((entry): HostService => {
    const row = asRecord(entry);
    if (row === null || typeof row["Name"] !== "string" || typeof row["StartName"] !== "string" || row["StartName"] === "") {
      throw new HostReadError(`powershell answered a service row without a name and logon account (${JSON.stringify(entry)})`);
    }
    return { name: row["Name"], account: row["StartName"], sid: typeof row["Sid"] === "string" && row["Sid"] !== "" ? row["Sid"] : null };
  });
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
    if (id !== null) services.push({ name: id.replace(/\.service$/, ""), account: user, sid: null });
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
 * Whether a service logs on as the plan's identity. Windows reports `.\name`,
 * `HOST\name`, or for NetworkService `NT AUTHORITY\NETWORK SERVICE` (the
 * name actions/runner derives from the SID, localized on a non-English host)
 * -- so network-service is matched by SID first, and by its English names
 * with whitespace ignored. Case-blind on Windows; a Linux user exactly.
 */
export function sameAccount(os: RunnerOs, identity: string, service: Pick<HostService, "account" | "sid">, computerName: string | null): boolean {
  if (os === "Linux") return service.account === identity;
  const lower = service.account.toLowerCase().replace(/\s+/g, "");
  if (identity === NETWORK_SERVICE) {
    return service.sid === NETWORK_SERVICE_SID || lower === "ntauthority\\networkservice" || lower === "networkservice";
  }
  const wanted = identity.replace(/^\.\\/, "").toLowerCase();
  const slash = lower.lastIndexOf("\\");
  if (slash === -1) return lower === wanted;
  const domain = lower.slice(0, slash);
  return lower.slice(slash + 1) === wanted && (domain === "." || (computerName !== null && domain === computerName.toLowerCase()));
}

/** A Windows account name in one spelling: case- and space-blind, this host's name as `.`. */
function localSpelling(account: string, computerName: string | null): string {
  const lower = account.toLowerCase().replace(/\s+/g, "");
  const host = computerName === null ? null : `${computerName.toLowerCase()}\\`;
  return host !== null && lower.startsWith(host) ? `.\\${lower.slice(host.length)}` : lower;
}

/** Two services' accounts are one account (Windows: by SID when both have one). */
function sameLogon(os: RunnerOs, a: HostService, b: HostService, computerName: string | null): boolean {
  if (os === "Linux") return a.account === b.account;
  if (a.sid !== null && b.sid !== null) return a.sid === b.sid;
  return localSpelling(a.account, computerName) === localSpelling(b.account, computerName);
}

/** Every `owner/name` a service name `actions.runner.<owner>-<repo>.<runner>` could mean, likeliest first. */
export function candidateRepositories(service: string, target: Target): string[] {
  if (!service.startsWith(SERVICE_PREFIX)) return [];
  const rest = service.slice(SERVICE_PREFIX.length);
  const splits: string[] = [];
  // The runner name is after a dot; a repository name may hold dots too, so
  // every dot is a candidate end -- the LAST first, since a runner name in
  // nen's naming ({machine}-{consumer}R{slot}) carries none.
  for (let dot = rest.lastIndexOf("."); dot > 0; dot = rest.lastIndexOf(".", dot - 1)) {
    const middle = rest.slice(0, dot);
    for (let at = middle.indexOf("-"); at > 0; at = middle.indexOf("-", at + 1)) {
      if (at < middle.length - 1) splits.push(`${middle.slice(0, at)}/${middle.slice(at + 1)}`);
    }
  }
  // The target's own owner first: a host's services are mostly one owner's.
  const ownerFirst = `${target.owner.toLowerCase()}/`;
  const unique = [...new Set(splits)];
  return [...unique.filter((slug): boolean => slug.toLowerCase().startsWith(ownerFirst)), ...unique.filter((slug): boolean => !slug.toLowerCase().startsWith(ownerFirst))];
}

export function repoArgv(slug: string): readonly string[] {
  return ["api", "--method", "GET", `repos/${slug}`];
}

type Resolved = { readonly slug: string; readonly visibility: string };

/** A repository's canonical slug and visibility, or null when GitHub does not answer for it. */
function lookup(seams: Seams, slug: string, cache: Map<string, Resolved | null>): Resolved | null {
  const key = slug.toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? null;
  let found: Resolved | null = null;
  try {
    const result = gh(seams, repoArgv(slug));
    if (result.code === 0) {
      const answer = asRecord(JSON.parse(result.stdout));
      const visibility = answer?.["visibility"] ?? (answer?.["private"] === true ? "private" : answer?.["private"] === false ? "public" : null);
      const name = answer?.["full_name"];
      if (typeof visibility === "string") found = { slug: typeof name === "string" ? name : slug, visibility };
    }
  } catch (error) {
    // gh that will not start, or an answer that is not JSON: unresolved, never an exit.
    if (!(error instanceof RunnerFailure) && !(error instanceof SyntaxError)) throw error;
    found = null;
  }
  cache.set(key, found);
  return found;
}

/**
 * A per-repository account name, folded to what the OS accepts (Windows 20
 * characters, Linux 32): `runner-<repo>`, else `runner-<owner>-<repo>`, else
 * either with `-2`, `-3`, ... -- the first that no service on this host
 * serving ANOTHER repository already logs on as (`taken`, bare lower-case
 * names). A name shared across owners or shortened into a collision is exactly
 * the shared account this recommendation exists to avoid.
 */
export function recommendAccount(os: RunnerOs, target: Target, taken: ReadonlySet<string> = new Set()): string {
  const limit = os === "Windows" ? 20 : 32;
  const fold = (text: string): string => text.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const fit = (base: string, suffix = ""): string => `${base.slice(0, limit - suffix.length).replace(/-$/, "")}${suffix}`;
  const bases = [fold(`runner-${target.repo}`), fold(`runner-${target.owner}-${target.repo}`)];
  for (const base of bases) if (!taken.has(fit(base))) return fit(base);
  for (let n = 2; ; n += 1) {
    const candidate = fit(bases[0] as string, `-${n}`);
    if (!taken.has(candidate)) return candidate;
  }
}

/** The bare account name a service logs on as (`.\x`, `HOST\x` and `x` are all `x`). */
function bareAccount(account: string): string {
  const lower = account.toLowerCase();
  return lower.slice(lower.lastIndexOf("\\") + 1);
}

/** Whether a neighbour's visibility is not provably the target's. */
function differs(neighbour: Neighbour, own: Resolved | null): boolean {
  return neighbour.visibility === null || own === null || neighbour.visibility !== own.visibility;
}

export function checkNeighbours(seams: Seams, target: Target, os: RunnerOs, identity: string): NeighbourReport {
  const none = { targetVisibility: null, mixed: [], stranded: [], recommendedAccount: null };
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
  if (services.length === 0) return { status: "checked", detail: "no runner service on this host", ...none };

  const computerName = seams.env["COMPUTERNAME"] ?? null;
  const cache = new Map<string, Resolved | null>();
  const own = lookup(seams, target.slug, cache);
  const isTarget = (neighbour: Neighbour): boolean => neighbour.repository !== null && neighbour.repository.toLowerCase() === target.slug.toLowerCase();
  const resolved = services.map((service): { service: HostService; neighbour: Neighbour } => {
    let found: Resolved | null = null;
    for (const candidate of candidateRepositories(service.name, target)) {
      found = lookup(seams, candidate, cache);
      if (found !== null) break;
    }
    return { service, neighbour: { service: service.name, repository: found?.slug ?? null, visibility: found?.visibility ?? null } };
  });

  const mixed = resolved
    .filter(({ service, neighbour }): boolean => sameAccount(os, identity, service, computerName) && !isTarget(neighbour) && differs(neighbour, own))
    .map(({ neighbour }): Neighbour => neighbour);

  // The target's own runners on an account OTHER than the planned one: a new
  // account moves only the new runners, so these stay where they are.
  const groups: { readonly logon: HostService; readonly services: string[] }[] = [];
  for (const { service, neighbour } of resolved) {
    if (!isTarget(neighbour) || sameAccount(os, identity, service, computerName)) continue;
    const group = groups.find((entry): boolean => sameLogon(os, entry.logon, service, computerName));
    if (group === undefined) groups.push({ logon: service, services: [service.name] });
    else group.services.push(service.name);
  }
  const stranded = groups
    .map((group): Stranded => ({
      account: group.logon.account,
      services: group.services,
      sharedWith: resolved
        .filter((row): boolean => sameLogon(os, row.service, group.logon, computerName) && !isTarget(row.neighbour) && differs(row.neighbour, own))
        .map((row): Neighbour => row.neighbour),
    }))
    .filter((entry): boolean => entry.sharedWith.length > 0);

  return {
    status: "checked",
    detail: `${services.length} runner service(s) on this host read`,
    targetVisibility: own?.visibility ?? null,
    mixed,
    stranded,
    recommendedAccount:
      mixed.length === 0
        ? null
        : recommendAccount(os, target, new Set(resolved.filter((row): boolean => !isTarget(row.neighbour)).map((row): string => bareAccount(row.service.account)))),
  };
}

/** The lines `runner plan` prints on stderr. Empty when there is nothing to say. */
export function renderNeighbours(report: NeighbourReport, target: Target, identity: string): string[] {
  if (report.status === "no-account") return [];
  if (report.status !== "checked") {
    return [`note: the shared-account check did not run (${report.detail}). Run 'nen runner plan' on the runner host to have it read.`];
  }
  const describe = (neighbour: Neighbour): string => `${neighbour.service} -- ${neighbour.repository ?? "(repository unresolved)"}, ${neighbour.visibility ?? "visibility unknown"}`;
  const lines: string[] = [];
  if (report.mixed.length > 0) {
    lines.push(
      `warning: ${identity} already runs ${report.mixed.length} runner service(s) on this host for repositories whose visibility differs from ${target.slug}'s (${report.targetVisibility ?? "unknown"}) or cannot be told -- one account is one trust domain, so either repository's jobs can rewrite the other's runners (#330):`,
      ...report.mixed.map((neighbour): string => `  ${describe(neighbour)}`),
      `recommended: a local account for ${target.slug} alone, e.g. --service-account ${report.recommendedAccount ?? "runner-<repo>"} (create it yourself first; nen never creates an account or handles its password).`,
    );
  }
  for (const entry of report.stranded) {
    lines.push(
      `warning: ${target.slug}'s existing runner service(s) ${entry.services.join(", ")} log on as ${entry.account}, which also serves repositories whose visibility differs or cannot be told; a new account moves only the runners this plan adds -- these keep ${entry.account} until they are removed and registered again under the new account (#330):`,
      ...entry.sharedWith.map((neighbour): string => `  ${describe(neighbour)}`),
    );
  }
  return lines;
}
