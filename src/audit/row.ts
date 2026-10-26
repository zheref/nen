// src/audit/row.ts -- the DECLARING CONTRACT of `nen audit deps`: one row of a
// caller-named JSON file's `dependencyAudit` object, read and refused strictly
// (zheref/nen#508).
//
// WHERE THE DESTINATION COMES FROM (AC-4). Every value that decides where a
// query is sent, what ecosystem it names, and which severities count is read
// from this row, and the row is read from the file `--contract` names -- an
// ABSOLUTE path the caller chose, never a path resolved inside the audited
// tree. The tree under review can carry an `.npmrc`, a `.yarnrc.yml` or a
// `pnpm-workspace.yaml` naming any registry it likes; none of them is a source
// of a destination here (./lockfiles.ts prints their redirect keys as evidence
// and honours none).
//
// THE SHAPE IS THE ONE HATSU ALREADY DECLARES. `contracts/scans.json` ->
// `dependencyAudit.node` (hatsu.scans/v0.2) is the row the interim resolver
// `scripts/dependency_audit_resolve.mts` read, key for key; this port reads the
// same keys with the same refusals, so a caller retires the script by changing
// its `run` line and nothing else in the row. The ROW'S `ecosystem` SELECTS
// THE READER: `npm` reads a Node lockfile through the row's `managers`;
// `SwiftURL` reads SwiftPM's `Package.resolved` (./swift.ts). Any other
// ecosystem has no reader and is a wiring stop -- "other ecosystems" is out of
// this verb's scope (#508's scope boundaries), and a row that named one must
// not read as an audit that ran.
//
// REFUSED, NOT DEFAULTED, where a default would decide something. The
// endpoints, the ecosystem, the severity vocabulary and floor, the timeout and
// (for npm) the registry hosts have NO default: each is a policy value, and
// "the severity floor's value stays the declaring contract's" (#508 scope).
// Only the four resource bounds default, to the interim resolver's documented
// values plus one this port adds (`maxLockfileBytes`, AC-5's size bound).
// Unknown keys are refused, so a misspelt bound is never silently ignored.

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Wiring } from "./verdict.js";

export type Format = "pnpm-lock" | "yarn-lock" | "npm-lock";

export interface Manager {
  readonly lockfiles: readonly string[];
  readonly format: Format;
  readonly markers?: { readonly berry: RegExp; readonly classic: RegExp };
}

interface CommonRow {
  readonly name: string;
  readonly stacks: readonly string[];
  readonly endpoint: URL;
  readonly vulnEndpoint: URL;
  readonly ecosystem: string;
  readonly severityLevels: readonly string[];
  readonly severityFloor: readonly string[];
  readonly timeoutSeconds: number;
  readonly maxResponseBytes: number;
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly maxLockfileBytes: number;
}

/** A Node row: `ecosystem: "npm"`, read from a lockfile through `managers`. */
export interface NodeRow extends CommonRow {
  readonly reader: "lockfile";
  readonly registryHosts: readonly string[];
  readonly managers: Readonly<Record<string, Manager>>;
  readonly unsupportedLockfiles: Readonly<Record<string, string>>;
  readonly auditConfigKeys: Readonly<Record<string, readonly string[]>>;
}

/** A Swift row: `ecosystem: "SwiftURL"`, read from SwiftPM's Package.resolved. */
export interface SwiftRow extends CommonRow {
  readonly reader: "swift-resolved";
}

export type AuditRow = NodeRow | SwiftRow;

/** The ecosystems this verb has a reader for, and the reader each selects. */
export const READERS: Readonly<Record<string, AuditRow["reader"]>> = { npm: "lockfile", SwiftURL: "swift-resolved" };

/** Prose keys a row may carry for its human readers; read by nobody here. */
const PROSE_KEYS = ["run", "runSemantics", "resolution", "failure"];
const COMMON_KEYS = ["stacks", "endpoint", "vulnEndpoint", "ecosystem", "severityLevels", "severityFloor", "timeoutSeconds",
  "maxResponseBytes", "maxEntries", "maxDepth", "maxLockfileBytes", ...PROSE_KEYS];
const NODE_KEYS = new Set([...COMMON_KEYS, "registryHosts", "managers", "unsupportedLockfiles", "auditConfigKeys"]);
const SWIFT_KEYS = new Set(COMMON_KEYS);
const MANAGER_KEYS = new Set(["lockfiles", "format", "lockfileMarkers"]);

/** The documented defaults of the four resource bounds. */
export const DEFAULT_BOUNDS = {
  maxResponseBytes: 33_554_432,
  maxEntries: 500_000,
  maxDepth: 1000,
  maxLockfileBytes: 268_435_456,
} as const;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length > 0 && value.every((entry: unknown): boolean => typeof entry === "string" && entry !== "");
/** Own keys that are data: a `$`-prefixed key is metadata, everywhere nen reads JSON. */
const own = (value: Record<string, unknown>): Array<[string, unknown]> =>
  Object.entries(value).filter(([key]): boolean => !key.startsWith("$"));

/** A file directly in the audited directory: no separator, never `.` or `..`. */
const bareName = (file: string): boolean => /^[A-Za-z0-9._-]+$/.test(file) && file !== "." && file !== "..";

function wiring(message: string): never {
  throw new Wiring(message);
}

function endpointUrl(where: string, value: unknown): URL {
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    wiring(`${where} is not a URL`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    wiring(`${where} must be https (http only on loopback, for a fixture)`);
  }
  if (url.username !== "" || url.password !== "") wiring(`${where} must carry no credentials`);
  return url;
}

/**
 * The vuln endpoint is a BASE an advisory id is appended to, so its path must
 * end in `/` (N1, AC-4): `new URL("GHSA-x", "https://api.osv.dev/v1/vulns")`
 * is `https://api.osv.dev/v1/GHSA-x` -- a path the contract never named. The
 * slash is required rather than added, so the URL queried is the one written.
 */
function vulnBase(where: string, value: unknown): URL {
  const url = endpointUrl(where, value);
  if (!url.pathname.endsWith("/")) wiring(`${where} must end in '/': an advisory id is appended to it`);
  if (url.search !== "" || url.hash !== "") wiring(`${where} must carry no query or fragment: an advisory id is appended to its path`);
  return url;
}

function bound(row: Record<string, unknown>, where: string, key: keyof typeof DEFAULT_BOUNDS): number {
  if (!(key in row)) return DEFAULT_BOUNDS[key];
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < 1) wiring(`${where}.${key} must be an integer >= 1`);
  return value as number;
}

function compile(source: unknown, where: string): RegExp {
  if (typeof source !== "string" || source === "") wiring(`${where} must be a non-empty regular expression string`);
  try {
    return new RegExp(source, "m");
  } catch {
    wiring(`${where} is not a valid regular expression`);
  }
}

function managersOf(where: string, value: unknown): Record<string, Manager> {
  if (!isRecord(value) || own(value).length === 0) wiring(`${where}.managers must be a non-empty object`);
  const managers: Record<string, Manager> = {};
  for (const [name, entry] of own(value)) {
    const at = `${where}.managers.${name}`;
    if (!isRecord(entry)) wiring(`${at} must be an object`);
    for (const [key] of own(entry)) if (!MANAGER_KEYS.has(key)) wiring(`${at}.${key} is not a key this verb reads`);
    if (!isStrings(entry["lockfiles"]) || !["pnpm-lock", "yarn-lock", "npm-lock"].includes(String(entry["format"]))) {
      wiring(`${at} needs lockfiles and a format of pnpm-lock, yarn-lock or npm-lock`);
    }
    const lockfiles = entry["lockfiles"];
    if (!lockfiles.every(bareName)) wiring(`${at}.lockfiles must be bare file names`);
    let markers: Manager["markers"];
    if (entry["format"] === "yarn-lock") {
      const declared = entry["lockfileMarkers"];
      if (!isRecord(declared)) wiring(`${at}.lockfileMarkers must be an object`);
      markers = { berry: compile(declared["berry"], `${at}.lockfileMarkers.berry`), classic: compile(declared["classic"], `${at}.lockfileMarkers.classic`) };
    } else if ("lockfileMarkers" in entry) {
      wiring(`${at}.lockfileMarkers belongs to a yarn-lock manager only`);
    }
    managers[name] = markers === undefined
      ? { lockfiles, format: entry["format"] as Format }
      : { lockfiles, format: entry["format"] as Format, markers };
  }
  return managers;
}

/**
 * Read row `rowName` of the contract at `path`. Every refusal is a {@link Wiring}
 * error naming the key: the contract is the caller's, so a fault in it is a
 * wiring stop (exit 2), never a verdict about the tree.
 */
export function loadRow(path: string, rowName: string): AuditRow {
  if (!isAbsolute(path)) {
    wiring(`--contract must be an absolute path; a relative one would be resolved somewhere a caller did not choose, and the destination must never come from the audited tree`);
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    wiring(`cannot read the contract ${path} as JSON`);
  }
  const audit = isRecord(data) ? data["dependencyAudit"] : undefined;
  if (!isRecord(audit)) wiring(`${path} has no dependencyAudit object`);
  if (rowName.startsWith("$") || !Object.hasOwn(audit, rowName)) wiring(`${path} has no dependencyAudit.${rowName} row`);
  const row = audit[rowName];
  const where = `dependencyAudit.${rowName}`;
  if (!isRecord(row)) wiring(`${where} must be an object`);

  const ecosystem = row["ecosystem"];
  if (typeof ecosystem !== "string" || ecosystem === "") wiring(`${where}.ecosystem must be a non-empty string`);
  if (!Object.hasOwn(READERS, ecosystem)) {
    wiring(`${where}.ecosystem ${JSON.stringify(ecosystem)} has no reader in this verb (it reads ${Object.keys(READERS).join(" and ")})`);
  }
  const reader = READERS[ecosystem] as AuditRow["reader"];
  const keys = reader === "lockfile" ? NODE_KEYS : SWIFT_KEYS;
  for (const [key] of own(row)) if (!keys.has(key)) wiring(`${where}.${key} is not a key this verb reads on a ${ecosystem} row`);
  for (const key of PROSE_KEYS) if (key in row && typeof row[key] !== "string") wiring(`${where}.${key} must be a string`);

  if (!isStrings(row["stacks"])) wiring(`${where}.stacks must be a non-empty string array`);
  if (!isStrings(row["severityLevels"])) wiring(`${where}.severityLevels must be a non-empty string array`);
  if (!isStrings(row["severityFloor"])) wiring(`${where}.severityFloor must be a non-empty string array`);
  const levels = row["severityLevels"].map((level: string): string => level.toUpperCase());
  const floor = row["severityFloor"].map((level: string): string => level.toUpperCase());
  if (!floor.every((level: string): boolean => levels.includes(level))) wiring(`${where}.severityFloor must be drawn from severityLevels`);
  if (levels.includes("UNRATED")) wiring(`${where}.severityLevels must not name UNRATED, which is this verb's word for a severity outside them`);
  const timeout = row["timeoutSeconds"];
  if (!Number.isSafeInteger(timeout) || (timeout as number) < 1) wiring(`${where}.timeoutSeconds must be an integer >= 1`);

  const common: CommonRow = {
    name: rowName,
    stacks: row["stacks"],
    endpoint: endpointUrl(`${where}.endpoint`, row["endpoint"]),
    vulnEndpoint: vulnBase(`${where}.vulnEndpoint`, row["vulnEndpoint"]),
    ecosystem,
    severityLevels: levels,
    severityFloor: floor,
    timeoutSeconds: timeout as number,
    maxResponseBytes: bound(row, where, "maxResponseBytes"),
    maxEntries: bound(row, where, "maxEntries"),
    maxDepth: bound(row, where, "maxDepth"),
    maxLockfileBytes: bound(row, where, "maxLockfileBytes"),
  };
  if (reader === "swift-resolved") return { ...common, reader };

  const hosts = row["registryHosts"];
  if (!isStrings(hosts) || !hosts.every((host: string): boolean => /^[a-z0-9.-]+$/.test(host))) {
    wiring(`${where}.registryHosts must be a non-empty array of host names`);
  }
  let unsupported: Record<string, string> = {};
  if ("unsupportedLockfiles" in row) {
    const value = row["unsupportedLockfiles"];
    if (!isRecord(value) || !own(value).every(([, name]): boolean => typeof name === "string" && name !== "")) {
      wiring(`${where}.unsupportedLockfiles must be an object of lockfile -> manager name strings`);
    }
    unsupported = Object.fromEntries(own(value)) as Record<string, string>;
    if (!Object.keys(unsupported).every(bareName)) wiring(`${where}.unsupportedLockfiles keys must be bare file names`);
  }
  let config: Record<string, string[]> = {};
  if ("auditConfigKeys" in row) {
    const value = row["auditConfigKeys"];
    if (!isRecord(value) || !own(value).every(([, keyList]): boolean => isStrings(keyList))) {
      wiring(`${where}.auditConfigKeys must be an object of file -> non-empty string arrays`);
    }
    config = Object.fromEntries(own(value)) as Record<string, string[]>;
    if (!Object.keys(config).every(bareName)) wiring(`${where}.auditConfigKeys keys must be bare file names`);
  }
  return {
    ...common,
    reader,
    registryHosts: hosts,
    managers: managersOf(where, row["managers"]),
    unsupportedLockfiles: unsupported,
    auditConfigKeys: config,
  };
}
