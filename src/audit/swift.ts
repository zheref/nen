// src/audit/swift.ts -- a SwiftPM tree's exact pins, read from Package.resolved
// (zheref/nen#508, AC-2 and SC-2).
//
// WHY THIS IS HERE AT ALL. SwiftPM ships no advisory command of its own, so the
// `swift` row of Hatsu's contracts/scans.json told its reader to take the pins
// from Package.resolved and POST them to OSV BY HAND: a procedure executed in
// prose, with no owner and no exit-code contract. This reader is that
// procedure, made deterministic, with the same refusals the Node reader has.
//
// WHERE THE FILE IS. A Swift package keeps `Package.resolved` at its root; an
// Xcode project keeps it inside the project or workspace bundle, at
// `<name>.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`
// or `<name>.xcworkspace/xcshareddata/swiftpm/Package.resolved`. Every one of
// those present directly under the audited directory is read and their pins
// are unioned. No component of any of those paths may be a symbolic link
// (AC-5): a linked bundle would let the tree choose what is read.
//
// WHAT A PIN IS. Format 1 (`object.pins[]`: `package`, `repositoryURL`,
// `state.version`) and formats 2 and 3 (`pins[]`: `identity`, `kind`,
// `location`, `state.version`). A `remoteSourceControl` pin -- format 1 pins
// are all remote -- with a semantic `state.version` and a git location on a
// host is queried under OSV's SwiftURL name, which is the location as
// `host/path`, no scheme and no `.git` (OSV names swift-nio-http2
// `github.com/apple/swift-nio-http2`). A pin on a branch or a bare revision
// has no version OSV can match and is UNQUERIED, never clean (AC-6); so is a
// `registry` pin, whose identity is not a URL. A `localSourceControl` pin is
// the tree's own code and counts as local. A pin whose location or version is
// registry-shaped and does not parse is NOT SCANNED.

import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readRegular, VERSION } from "./lockfiles.js";
import { isRecord, type SwiftRow } from "./row.js";
import { notScanned, tally, type Entry, type Resolution } from "./verdict.js";

const RESOLVED = "Package.resolved";
const q = (value: string): string => JSON.stringify(value);

/** True when `dir/rel` exists and NO component of `rel` is a symbolic link; refused when one is. */
function plainPath(dir: string, parts: readonly string[]): { present: boolean; refused?: string } {
  let at = dir;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    let stat;
    try {
      stat = lstatSync(at);
    } catch {
      return { present: false };
    }
    if (stat.isSymbolicLink()) return { present: true, refused: `${parts.slice(0, i + 1).join("/")} is a symlink, never followed` };
    if (i < parts.length - 1 && !stat.isDirectory()) return { present: false };
  }
  return { present: true };
}

/** Every Package.resolved this tree carries, as path components under `dir`. */
export function resolvedFiles(dir: string): string[][] {
  const found: string[][] = [[RESOLVED]];
  let names: string[] = [];
  try {
    names = readdirSync(dir).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    if (name.endsWith(".xcodeproj")) found.push([name, "project.xcworkspace", "xcshareddata", "swiftpm", RESOLVED]);
    else if (name.endsWith(".xcworkspace")) found.push([name, "xcshareddata", "swiftpm", RESOLVED]);
  }
  return found;
}

/**
 * OSV's SwiftURL name for a git location: `host/path`, scheme, credentials,
 * `.git` and a trailing slash removed, the host lower-cased. `undefined` when
 * the location is not a remote git URL at all (a local path, `file:`).
 */
export function swiftUrlName(location: string): string | undefined {
  let host: string;
  let path: string;
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(location);
  if (scp !== null) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    let url: URL;
    try {
      url = new URL(location);
    } catch {
      return undefined;
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return undefined;
    host = url.hostname;
    path = url.pathname;
  }
  const trimmed = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
  return `${host.toLowerCase()}/${trimmed}`;
}

const SWIFT_NAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\/[A-Za-z0-9._~-]+)+$/;

function pinEntry(file: string, value: unknown, index: number, format: number): Entry {
  if (!isRecord(value)) notScanned(`${file} pin ${String(index)} is not an object`);
  const state = value["state"];
  if (!isRecord(state)) notScanned(`${file} pin ${String(index)} has no state object (truncated)`);
  const kind = format === 1 ? "remoteSourceControl" : value["kind"];
  const location = format === 1 ? value["repositoryURL"] : value["location"];
  const label = typeof (format === 1 ? value["package"] : value["identity"]) === "string"
    ? String(format === 1 ? value["package"] : value["identity"])
    : `pin ${String(index)}`;
  if (kind === "localSourceControl") return { kind: "local" };
  if (kind !== "remoteSourceControl") return { kind: "unqueried" };
  if (typeof location !== "string" || location === "") notScanned(`${file} pin ${q(label)} has no location (truncated)`);
  const version = state["version"];
  if (version === undefined || version === null) return { kind: "unqueried" }; // a branch or a bare revision
  const name = swiftUrlName(location);
  if (name === undefined) return { kind: "unqueried" };
  if (typeof version !== "string" || !VERSION.test(version) || !SWIFT_NAME.test(name)) {
    notScanned(`${file} pin ${q(label)} is registry-shaped but its location or version does not parse`);
  }
  return { kind: "registry", pin: { name, version } };
}

/** Parse one Package.resolved's text into entries; strict on its shape. */
export function parseResolved(file: string, text: string, maxEntries: number): Entry[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    notScanned(`${file} does not parse as JSON (truncated or not a Package.resolved)`);
  }
  if (!isRecord(doc)) notScanned(`${file} is not a JSON object`);
  const format = doc["version"];
  let pins: unknown;
  if (format === 1) {
    const object = doc["object"];
    pins = isRecord(object) ? object["pins"] : undefined;
  } else if (format === 2 || format === 3) {
    pins = doc["pins"];
  } else {
    notScanned(`${file} version is not one this parser reads (1, 2, 3)`);
  }
  if (!Array.isArray(pins)) notScanned(`${file} has no pins array`);
  if (pins.length > maxEntries) notScanned(`${file} has more than ${String(maxEntries)} entries (maxEntries)`);
  return pins.map((pin: unknown, index: number): Entry => pinEntry(file, pin, index, format));
}

/** Resolve a SwiftPM tree at `dir` under `row`. */
export function resolveSwift(dir: string, row: SwiftRow): Resolution {
  const read: string[] = [];
  const entries: Entry[] = [];
  for (const parts of resolvedFiles(dir)) {
    const rel = parts.join("/");
    const path = plainPath(dir, parts);
    if (path.refused !== undefined) notScanned(path.refused);
    if (!path.present) continue;
    const parent = join(dir, ...parts.slice(0, -1));
    const file = readRegular(parent, RESOLVED, row.maxLockfileBytes);
    if (file.refused !== undefined) notScanned(`${rel}: ${file.refused}`);
    if (file.text === undefined) continue;
    read.push(rel);
    entries.push(...parseResolved(rel, file.text, row.maxEntries));
    if (entries.length > row.maxEntries) notScanned(`${read.join(", ")} have more than ${String(row.maxEntries)} entries together (maxEntries)`);
  }
  if (read.length === 0) notScanned(`no ${RESOLVED} at the root of the path or in an Xcode project or workspace beside it`);
  const { pins, local, unqueried } = tally(entries);
  if (pins.length === 0 && unqueried === 0) notScanned(`no pins parsed from ${read.join(", ")}`);
  return { manager: "swiftpm", files: read, source: "resolved graph", pins, local, unqueried, evidence: [] };
}
