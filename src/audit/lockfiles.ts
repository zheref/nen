// src/audit/lockfiles.ts -- a Node tree's exact package pins, read from its
// lockfile and never from its package manager (zheref/nen#508; ported from
// Hatsu's interim scripts/dependency_audit_resolve.mts, zheref/hatsu#247).
//
// NO PACKAGE MANAGER IS EVER EXECUTED (AC-3). Running pnpm, yarn or npm inside
// the tree under review runs that tree's .pnpmfile.cjs, yarnPath, plugins and
// .corepack.env, honours its .npmrc registry (a stub answering `{}` reads as
// zero vulnerabilities) and expands its auth tokens toward a host it chose.
// So nothing here spawns, and nothing reads the process environment:
//
//   1. `packageManager` in the tree's package.json selects the manager -- its
//      name before the last `@`; the version is never used, since nothing runs.
//      Only where the field is ABSENT does the one lockfile present select it.
//   2. The lockfile is PARSED STRICTLY: a line the parser does not read, a
//      truncated file or entry, or a registry-shaped entry whose name or
//      version does not parse is NOT SCANNED, never skipped (AC-5). Each entry
//      is a registry package (no URL, or https on the row's `registryHosts`),
//      local (workspace, link, directory), or unqueried (git, file:, a tarball
//      on another host -- AC-6).
//   3. Redirect and suppression keys in the tree's own config, and another
//      manager's lockfile beside the selected one, are EVIDENCE: reported,
//      never honoured.
//
// EVERY FILE IS A REGULAR FILE DIRECTLY IN THE AUDITED DIRECTORY. A symbolic
// link is never followed (AC-5) -- a link to a file outside the tree would let
// the tree choose what is read -- and a file over the row's `maxLockfileBytes`
// is not read at all.

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAlias, isMap, isScalar, parseDocument, visit, type Document, type Node, type Pair } from "yaml";
import { join } from "node:path";
import { isRecord, type Manager, type NodeRow } from "./row.js";
import { notScanned, tally, type Entry, type Evidence, type Resolution } from "./verdict.js";

const q = (value: string): string => JSON.stringify(value);

/**
 * A file directly in `dir`: its text, a refusal naming why it was not read, or
 * neither when absent.
 *
 * OPENED, THEN CHECKED, THEN READ FROM THE SAME DESCRIPTOR (F4, SEC-7). An
 * lstat followed by a read by path is check-then-use: a concurrent writer could
 * swap the file for a symbolic link between the two calls. `O_NOFOLLOW` makes
 * the open itself refuse a link (ELOOP), `O_NONBLOCK` keeps a FIFO planted at
 * the name from blocking the open, and the type and size are read off the
 * descriptor that is then read. The lstat first is kept for the host with no
 * `O_NOFOLLOW` (Windows), where it is the only link check there is.
 */
export function readRegular(dir: string, file: string, maxBytes: number): { text?: string; refused?: string } {
  const path = join(dir, file);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return {};
  }
  if (stat.isSymbolicLink()) return { refused: `${file} is a symlink, never followed` };
  if (!stat.isFile()) return { refused: `${file} is not a regular file` };
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ELOOP") return { refused: `${file} is a symlink, never followed` };
    if (code === "ENOENT") return {};
    return { refused: `${file} is unreadable` };
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { refused: `${file} is not a regular file` };
    if (opened.size > maxBytes) return { refused: `${file} is larger than ${String(maxBytes)} bytes (maxLockfileBytes)` };
    // At most min(size, maxBytes) + 1 bytes into one fixed buffer (F9): a file
    // that grew after the fstat, or past the bound, is refused, never read to EOF.
    const cap = Math.min(opened.size, maxBytes) + 1;
    const buffer = Buffer.alloc(cap);
    let read = 0;
    for (let n = -1; n !== 0 && read < cap; read += n) n = readSync(fd, buffer, read, cap - read, null);
    if (read > maxBytes) return { refused: `${file} is larger than ${String(maxBytes)} bytes (maxLockfileBytes)` };
    if (read > opened.size) return { refused: `${file} changed while it was read` };
    return { text: buffer.subarray(0, read).toString("utf8").replace(/^\uFEFF/, "") };
  } catch {
    return { refused: `${file} is unreadable` };
  } finally {
    closeSync(fd);
  }
}

function exists(dir: string, file: string): boolean {
  try {
    lstatSync(join(dir, file));
    return true;
  } catch {
    return false;
  }
}

export const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9._~-][a-z0-9._~-]*$/i;
export const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function splitAt(spec: string): [string, string] | undefined {
  const at = spec.lastIndexOf("@");
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : undefined;
}

function unquote(text: string): string {
  const t = text.trim();
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) return t.slice(1, -1).replace(/''/g, "'");
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) return t.slice(1, -1).replace(/\\"/g, '"');
  return t;
}

/** The parse in progress: which file, under which row, how many entries so far. */
interface Parser {
  readonly lockfile: string;
  readonly row: NodeRow;
  count: number;
}

function onRegistry(p: Parser, url: string | undefined): boolean {
  if (url === undefined) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && p.row.registryHosts.includes(parsed.hostname);
  } catch {
    return false;
  }
}

function registry(p: Parser, name: string, version: string, what: string): Entry {
  if (!NAME.test(name) || !VERSION.test(version)) {
    notScanned(`${p.lockfile} entry ${q(what)} is registry-shaped but its name or version does not parse`);
  }
  return { kind: "registry", pin: { name, version } };
}

/**
 * Whether a registry tarball URL names exactly `name@version`. The tarball's
 * path is `<prefix>/<name>/-/<base>-<version>.tgz`, where `<name>` is the
 * one segment before `/-/` (two for `@scope/pkg`, or one spelled
 * `@scope%2fpkg`) and `<prefix>` is whatever path the registry is mounted
 * under (N8: `https://art.example/api/npm/npm-remote/lodash/-/lodash-4.17.21.tgz`
 * is lodash on a registry served below `/api/npm/npm-remote`). Segments are
 * split BEFORE they are decoded, so `lodash%2f..%2fok` is one segment that
 * names no package; the URL parser has already resolved `..` in the path.
 */
export function tarballNames(url: string, name: string, version: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  const m = /^(.*)\/-\/([^/]+)\.tgz$/.exec(path);
  if (m === null) return false;
  const decode = (segment: string): string | undefined => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return undefined;
    }
  };
  const segments = (m[1] ?? "").split("/");
  const last = decode(segments[segments.length - 1] ?? "");
  const before = decode(segments[segments.length - 2] ?? "");
  const named = name.startsWith("@")
    ? last === name || (before !== undefined && last !== undefined && !before.includes("/") && !last.includes("/") && `${before}/${last}` === name)
    : last === name;
  const base = name.slice(name.lastIndexOf("/") + 1);
  return named && decode(m[2] ?? "") === `${base}-${version}`;
}

/**
 * THE ARTEFACT DECIDES, NOT THE LOCKFILE'S OWN LABEL (F2, SEC-13). A registry
 * entry whose `resolved`/`tarball` URL is present is queried only when the
 * name and version that URL names equal the pair the entry claims: a lockfile
 * that says `ok@1.0.0` while resolving `lodash-4.17.15.tgz` installs lodash,
 * and querying `ok` would read that tree clean. A disagreement, or a registry
 * URL whose path is not a tarball's, is UNQUERIED -- never clean.
 */
function registryPin(p: Parser, name: string, version: string, url: string | undefined, what: string): Entry {
  if (url !== undefined && !tarballNames(url, name, version)) return { kind: "unqueried" };
  return registry(p, name, version, what);
}

function counted(p: Parser): void {
  p.count += 1;
  if (p.count > p.row.maxEntries) notScanned(`${p.lockfile} has more than ${String(p.row.maxEntries)} entries (maxEntries)`);
}

function requireNewline(p: Parser, text: string): void {
  if (text !== "" && !text.endsWith("\n")) notScanned(`${p.lockfile} does not end with a newline (truncated)`);
}

/**
 * THE PNPM LOCKFILE IS READ AS STRICT YAML, BY A YAML PARSER (F5-F8, SEC-13).
 * Whether an entry is local, unqueried or a registry package is decided from
 * the keys of its own `resolution` map as the `yaml` package parses them --
 * the way pnpm's own reader sees the document -- never by a hand-rolled
 * scanner, which hanten round 2 showed disagreeing with YAML on escaped
 * quotes, mid-scalar quotes, multi-line scalars and repeated keys, each a way
 * to hide a vulnerable package. The document must parse with no error and
 * unique keys; an alias, an anchor, an explicit tag or a `<<` merge key
 * anywhere is NOT SCANNED, never resolved; a resolution that is not a map of
 * scalars is NOT SCANNED, never local.
 *
 * BOUNDED BEFORE IT IS PARSED. The byte bound (`maxLockfileBytes`) is applied
 * when the file is read. The parser composes nested collections recursively,
 * so a deep `[[[[...` or a deep indentation would exhaust the stack: the
 * text's flow-bracket depth and its indentation depth (in two-space levels)
 * are each held to `maxDepth` first, counted over the raw text, quotes
 * included, so the count can only over-refuse. No alias is ever expanded: the
 * document is never converted with its aliases resolved, and any alias in it
 * is refused; any throw from the parser is NOT SCANNED.
 */
function pnpmDocument(p: Parser, text: string): Document.Parsed {
  let depth = 0;
  let deepest = 0;
  for (const c of text) {
    if (c === "[" || c === "{") deepest = Math.max(deepest, (depth += 1));
    else if ((c === "]" || c === "}") && depth > 0) depth -= 1;
  }
  const indent = Math.max(0, ...text.split(/\r?\n/).map((line: string): number => /^ */.exec(line)?.[0].length ?? 0));
  if (deepest > p.row.maxDepth || indent / 2 > p.row.maxDepth) notScanned(`pnpm-lock.yaml nests deeper than ${String(p.row.maxDepth)} (maxDepth)`);
  let doc: Document.Parsed;
  try {
    doc = parseDocument(text, { uniqueKeys: true, merge: false, prettyErrors: true, strict: true });
  } catch {
    notScanned("pnpm-lock.yaml does not parse as strict YAML");
  }
  const error = doc.errors[0];
  if (error !== undefined) notScanned(`pnpm-lock.yaml does not parse as strict YAML (${error.code}${error.linePos?.[0] !== undefined ? `, line ${String(error.linePos[0].line)}` : ""})`);
  let refused: string | undefined;
  visit(doc, {
    Node(_key: unknown, node: Node): symbol | void {
      if (isAlias(node)) refused = "an alias";
      else if (node.anchor !== undefined) refused = `an anchor (&${node.anchor})`;
      else if (node.tag !== undefined) refused = `an explicit tag (${node.tag})`;
      return refused === undefined ? undefined : visit.BREAK;
    },
    Pair(_key: unknown, pair: Pair): symbol | void {
      if (isScalar(pair.key) && pair.key.value === "<<") {
        refused = "a << merge key";
        return visit.BREAK;
      }
      return undefined;
    },
  });
  if (refused !== undefined) notScanned(`pnpm-lock.yaml carries ${refused}, which this parser does not resolve`);
  return doc;
}

const RESOLUTION_STRINGS = ["tarball", "directory", "type", "repo", "commit"];

/** One entry's `resolution` map, read from the parsed document: scalar keys to scalar values. */
function pnpmResolution(key: string, value: unknown): Map<string, string> {
  if (value === null || (isScalar(value) && value.value === null)) notScanned(`pnpm-lock.yaml entry ${q(key)} has no body (truncated)`);
  if (!isMap(value)) notScanned(`pnpm-lock.yaml entry ${q(key)} is not a map`);
  const resolution = value.get("resolution", true);
  if (resolution === undefined) notScanned(`pnpm-lock.yaml entry ${q(key)} has no resolution (truncated)`);
  if (!isMap(resolution)) notScanned(`pnpm-lock.yaml entry ${q(key)} has a resolution that is not a map`);
  const entries = new Map<string, string>();
  for (const pair of resolution.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") notScanned(`pnpm-lock.yaml entry ${q(key)} has a resolution key that is not a string`);
    const name = pair.key.value;
    if (!isScalar(pair.value)) notScanned(`pnpm-lock.yaml entry ${q(key)} has a resolution value for ${q(name)} that is not a scalar`);
    const raw = pair.value.value;
    if (RESOLUTION_STRINGS.includes(name) && (typeof raw !== "string" || raw === "")) {
      notScanned(`pnpm-lock.yaml entry ${q(key)} has a resolution ${q(name)} that is not a non-empty string`);
    }
    entries.set(name, String(raw));
  }
  if (entries.size === 0) notScanned(`pnpm-lock.yaml entry ${q(key)} has an empty resolution`);
  return entries;
}

// pnpm: every line of the `packages:` section is read or refused.
const PNPM_KEY = /^ {2}('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s'"#?][^#]*?):(?:[ \t]+(\{.*\}))?[ \t]*(?:#.*)?$/;

/** pnpm-lock.yaml at lockfileVersion 5, 6 or 9: the `packages:` keys. */
export function parsePnpm(p: Parser, text: string): Entry[] {
  requireNewline(p, text);
  const version = /^lockfileVersion:\s*['"]?(\d+)/m.exec(text)?.[1];
  if (version === undefined || !["5", "6", "9"].includes(version)) {
    notScanned(`pnpm-lock.yaml lockfileVersion ${version === undefined ? "is missing" : q(version)} is not one this parser reads (5, 6, 9)`);
  }
  const sections: Array<{ key: string; flow: string | undefined; body: string[] }> = [];
  let inPackages = false;
  text.split(/\r?\n/).forEach((line: string, i: number): void => {
    if (line.trim() === "") return;
    if (/^\S/.test(line)) {
      if (line.startsWith("#")) return;
      if (/^packages:[ \t]*(?:\{\}[ \t]*)?(?:#.*)?$/.test(line)) {
        inPackages = true;
        return;
      }
      inPackages = false;
      return;
    }
    if (!inPackages) return;
    const indent = /^ */.exec(line)?.[0].length ?? 0;
    if (indent === 2) {
      if (line.startsWith("  ?")) notScanned(`pnpm-lock.yaml line ${String(i + 1)} is an explicit ? key, which this parser does not read`);
      const m = PNPM_KEY.exec(line);
      if (m === null) notScanned(`pnpm-lock.yaml line ${String(i + 1)} is not a packages key this parser reads`);
      sections.push({ key: unquote(m[1] ?? ""), flow: m[2], body: [] });
    } else if (indent >= 4 && sections.length > 0) {
      sections[sections.length - 1]?.body.push(line);
    } else {
      notScanned(`pnpm-lock.yaml line ${String(i + 1)} is not indented as a packages entry`);
    }
  });
  for (const s of sections) {
    counted(p);
    if (s.flow === undefined && s.body.length === 0) notScanned(`pnpm-lock.yaml entry ${q(s.key)} has no body (truncated)`);
  }
  const doc = pnpmDocument(p, text);
  const parsed = new Map<string, unknown>();
  const packages = doc.get("packages", true);
  if (sections.length > 0) {
    if (!isMap(packages)) notScanned("pnpm-lock.yaml packages is not a map");
    for (const pair of packages.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== "string") notScanned("pnpm-lock.yaml has a packages key that is not a string");
      parsed.set(pair.key.value, pair.value);
    }
  }
  if (parsed.size !== sections.length || !sections.every((s): boolean => parsed.has(s.key))) {
    notScanned("pnpm-lock.yaml packages keys read by line and by YAML disagree");
  }
  return sections.map((s): Entry => {
    const resolution = pnpmResolution(s.key, parsed.get(s.key));
    const type = resolution.get("type");
    if (resolution.has("directory") || type === "directory") return { kind: "local" };
    if (resolution.has("repo") || resolution.has("commit") || type !== undefined) return { kind: "unqueried" };
    const tarball = resolution.get("tarball");
    if (!onRegistry(p, tarball)) return { kind: "unqueried" };
    const key = s.key.replace(/^\//, "");
    let pair: [string, string] | undefined;
    if (version === "5") {
      const slash = key.lastIndexOf("/");
      pair = slash > 0 ? [key.slice(0, slash), key.slice(slash + 1).replace(/_.*$/, "")] : undefined;
    } else {
      const paren = key.indexOf("(");
      pair = splitAt(paren > 0 ? key.slice(0, paren) : key);
    }
    return registryPin(p, pair?.[0] ?? "", pair?.[1] ?? "", tarball, s.key);
  });
}

/** yarn.lock, berry or classic by the row's declared markers; entries split on column-0 headers. */
export function parseYarn(p: Parser, text: string, markers: NonNullable<Manager["markers"]>): Entry[] {
  requireNewline(p, text);
  const berry = markers.berry.test(text);
  if (!berry && !markers.classic.test(text)) notScanned("yarn.lock matches neither declared lockfile marker (berry, classic)");
  const blocks: Array<{ header: string; body: string[] }> = [];
  text.split(/\r?\n/).forEach((line: string, i: number): void => {
    if (line.trim() === "") return;
    if (/^\S/.test(line)) {
      if (line.startsWith("#")) return;
      const m = /^(\S.*):\s*$/.exec(line);
      if (m === null) notScanned(`yarn.lock line ${String(i + 1)} is not an entry header this parser reads`);
      blocks.push({ header: m[1] ?? "", body: [] });
    } else if (blocks.length > 0) {
      blocks[blocks.length - 1]?.body.push(line);
    } else {
      notScanned(`yarn.lock line ${String(i + 1)} is indented before any entry header`);
    }
  });
  const entries: Entry[] = [];
  for (const { header, body } of blocks) {
    if (berry && header === "__metadata") continue;
    counted(p);
    const block = body.join("\n");
    if (berry) {
      const resolution = /^ {2}resolution:\s*(.+?)\s*$/m.exec(block)?.[1];
      if (resolution === undefined) notScanned(`yarn.lock entry ${q(header)} has no resolution (truncated)`);
      const spec = unquote(resolution);
      const npm = /^(.+?)@npm:(.+)$/.exec(spec);
      if (npm !== null) {
        entries.push(registry(p, npm[1] ?? "", npm[2] ?? "", spec));
        continue;
      }
      const patch = /^(.+?)@patch:([^#]+)#/.exec(spec);
      if (patch !== null) {
        let inner = "";
        try {
          inner = decodeURIComponent(patch[2] ?? "");
        } catch {
          notScanned(`yarn.lock entry ${q(spec)} has an undecodable patch`);
        }
        const real = /^(.+?)@npm:(.+)$/.exec(inner);
        entries.push(real !== null ? registry(p, real[1] ?? "", real[2] ?? "", spec) : { kind: "unqueried" });
        continue;
      }
      entries.push(/^.+?@(?:workspace|link|portal):/.test(spec) ? { kind: "local" } : { kind: "unqueried" });
      continue;
    }
    const version = /^ {2}version:?\s+"?([^"\s]+)"?\s*$/m.exec(block)?.[1];
    if (version === undefined) notScanned(`yarn.lock entry ${q(header)} has no version (truncated)`);
    const resolved = /^ {2}resolved:?\s+"?([^"\s]+)"?\s*$/m.exec(block)?.[1];
    const spec = unquote(header.split(/,\s*/)[0] ?? "");
    const alias = /^(.+?)@npm:(.+)@[^@]*$/.exec(spec);
    const pair = alias !== null ? [alias[2] ?? "", spec.slice(spec.lastIndexOf("@") + 1)] : splitAt(spec);
    const range = pair?.[1] ?? "";
    if (/^(?:link|portal|workspace):/.test(range)) {
      entries.push({ kind: "local" });
      continue;
    }
    if (/^(?:file:|git|https?:|github:)/.test(range) || !onRegistry(p, resolved)) {
      entries.push({ kind: "unqueried" });
      continue;
    }
    entries.push(registryPin(p, alias !== null ? (alias[2] ?? "") : (pair?.[0] ?? ""), version, resolved, spec));
  }
  return entries;
}

function npmEntry(p: Parser, name: string, value: unknown, what: string): Entry {
  if (!isRecord(value)) notScanned(`${p.lockfile} entry ${q(what)} is not an object`);
  const resolved = typeof value["resolved"] === "string" ? value["resolved"] : undefined;
  // A link resolves to a path in the tree (`packages/ws`) and is the tree's own
  // code. One whose `resolved` is a URL installs that URL's artefact, and is
  // read like any other entry (F2): `link: true` is the lockfile's label, the
  // URL is what is fetched.
  if (value["link"] === true && (resolved === undefined || !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(resolved))) return { kind: "local" };
  let version = typeof value["version"] === "string" ? value["version"] : "";
  let real = typeof value["name"] === "string" ? value["name"] : name;
  const alias = /^npm:(.+)@([^@]+)$/.exec(version);
  if (alias !== null) {
    real = alias[1] ?? "";
    version = alias[2] ?? "";
  }
  if (/^(?:file:|git|https?:|github:)/.test(version) || !onRegistry(p, resolved)) return { kind: "unqueried" };
  return registryPin(p, real, version, resolved, what);
}

/** package-lock.json / npm-shrinkwrap.json: v2/v3 by `packages`, v1 by nested `dependencies` under maxDepth. */
export function parseNpm(p: Parser, text: string): Entry[] {
  let lock: unknown;
  try {
    lock = JSON.parse(text);
  } catch {
    notScanned(`${p.lockfile} does not parse as JSON`);
  }
  if (!isRecord(lock)) notScanned(`${p.lockfile} is not a JSON object`);
  const lockfileVersion = lock["lockfileVersion"];
  if (lockfileVersion !== 1 && lockfileVersion !== 2 && lockfileVersion !== 3) {
    notScanned(`${p.lockfile} lockfileVersion is not one this parser reads (1, 2, 3)`);
  }
  const entries: Entry[] = [];
  if (lockfileVersion !== 1) {
    const packages = lock["packages"];
    if (!isRecord(packages)) notScanned(`${p.lockfile} has no packages object`);
    for (const [key, value] of Object.entries(packages)) {
      if (key === "") continue;
      counted(p);
      const at = key.lastIndexOf("node_modules/");
      if (at < 0) {
        entries.push({ kind: "local" }); // a workspace's own source directory
        continue;
      }
      entries.push(npmEntry(p, key.slice(at + "node_modules/".length), value, key));
    }
    return entries;
  }
  const stack: Array<{ deps: unknown; depth: number }> = [{ deps: lock["dependencies"], depth: 1 }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { deps, depth } = next;
    if (deps === undefined) continue;
    if (!isRecord(deps)) notScanned(`${p.lockfile} has a dependencies value that is not an object`);
    if (depth > p.row.maxDepth) notScanned(`${p.lockfile} nests dependencies deeper than ${String(p.row.maxDepth)} (maxDepth)`);
    for (const [name, value] of Object.entries(deps)) {
      counted(p);
      entries.push(npmEntry(p, name, value, name));
      if (isRecord(value)) stack.push({ deps: value["dependencies"], depth: depth + 1 });
    }
  }
  return entries;
}

/** Resolve a Node tree at `dir` under `row`: the manager, its lockfile, and every entry's kind. */
export function resolveNode(dir: string, row: NodeRow): Resolution {
  const manifest = readRegular(dir, "package.json", row.maxLockfileBytes);
  if (manifest.refused !== undefined) notScanned(manifest.refused);
  if (manifest.text === undefined) notScanned("no package.json at the root of the path");
  let pkg: unknown;
  try {
    pkg = JSON.parse(manifest.text);
  } catch {
    notScanned("package.json does not parse as JSON");
  }
  if (!isRecord(pkg)) notScanned("package.json is not a JSON object");
  const field = pkg["packageManager"];
  const managerOf = (name: string): Manager => row.managers[name] as Manager;
  const lockfilesOf = (name: string): string[] => managerOf(name).lockfiles.filter((file: string): boolean => exists(dir, file));
  let manager: string;
  let source: string;
  if (field !== undefined) {
    if (typeof field !== "string") notScanned("packageManager is not a string");
    if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(field)) notScanned("packageManager carries control characters");
    const pair = splitAt(field.trim());
    if (pair === undefined || !/^[a-z0-9][a-z0-9._-]*$/i.test(pair[0]) || pair[1] === "") notScanned(`packageManager ${q(field)} is not <name>@<version>`);
    manager = pair[0].toLowerCase();
    if (!Object.hasOwn(row.managers, manager)) notScanned(`packageManager names ${q(manager)}, which has no dependencyAudit.${row.name} manager`);
    source = `packageManager ${q(field)}`;
  } else {
    const found = Object.keys(row.managers).filter((name: string): boolean => lockfilesOf(name).length > 0);
    if (found.length > 1) notScanned(`no packageManager field and ${found.flatMap(lockfilesOf).join(", ")} are all present (ambiguous)`);
    if (found.length === 0) {
      const foreign = Object.keys(row.unsupportedLockfiles).find((file: string): boolean => exists(dir, file));
      if (foreign !== undefined) notScanned(`${foreign} is a ${row.unsupportedLockfiles[foreign] ?? ""} lockfile, which has no dependencyAudit.${row.name} parser`);
      notScanned("no packageManager field and no lockfile to audit");
    }
    manager = found[0] as string;
    source = "no packageManager field";
  }
  const m = managerOf(manager);
  const lockfile = m.lockfiles.find((file: string): boolean => exists(dir, file));
  if (lockfile === undefined) notScanned(`${source} but no ${m.lockfiles.join(" or ")} to audit`);
  const others = [
    ...Object.keys(row.managers).filter((name: string): boolean => name !== manager).flatMap(lockfilesOf),
    ...Object.keys(row.unsupportedLockfiles).filter((file: string): boolean => exists(dir, file)),
    ...m.lockfiles.filter((file: string): boolean => file !== lockfile && exists(dir, file)),
  ];
  const lock = readRegular(dir, lockfile, row.maxLockfileBytes);
  if (lock.refused !== undefined) notScanned(lock.refused);
  const p: Parser = { lockfile, row, count: 0 };
  const text = lock.text ?? "";
  const entries = m.format === "pnpm-lock"
    ? parsePnpm(p, text)
    : m.format === "yarn-lock"
      ? parseYarn(p, text, m.markers as NonNullable<Manager["markers"]>)
      : parseNpm(p, text);
  const { pins, local, unqueried } = tally(entries);
  if (pins.length === 0 && unqueried === 0) notScanned(`no packages parsed from ${lockfile}`);
  return { manager, files: [lockfile], source, pins, local, unqueried, evidence: auditConfig(dir, row, others) };
}

/** Redirect and suppression keys the tree carries, and other lockfiles: evidence, never honoured. */
function auditConfig(dir: string, row: NodeRow, others: readonly string[]): Evidence[] {
  const hits: Evidence[] = others.map((file: string): Evidence => ({ file, key: "other-lockfile", kind: "other-lockfile" }));
  for (const [file, keys] of Object.entries(row.auditConfigKeys)) {
    const read = readRegular(dir, file, row.maxLockfileBytes);
    if (read.refused !== undefined) {
      hits.push({ file, key: read.refused, kind: "unreadable" });
      continue;
    }
    if (read.text === undefined) continue;
    const present = new Set<string>();
    if (file === "package.json") {
      let pkg: unknown;
      try {
        pkg = JSON.parse(read.text);
      } catch {
        continue;
      }
      for (const key of keys) {
        let node: unknown = pkg;
        for (const part of key.split(".")) node = isRecord(node) ? node[part] : undefined;
        if (node !== undefined) present.add(key);
      }
    } else if (file === ".npmrc") {
      // ini lines; a `*<suffix>` key matches any key ending in it (a scoped `@x:registry`).
      for (const line of read.text.split(/\r?\n/)) {
        const key = /^\s*([^=;#\s][^=]*?)\s*=/.exec(line)?.[1]?.toLowerCase();
        if (key === undefined) continue;
        for (const k of keys) {
          if (k.startsWith("*") ? key.endsWith(k.slice(1).toLowerCase()) : key === k.toLowerCase()) present.add(k);
        }
      }
    } else {
      for (const line of read.text.split(/\r?\n/)) {
        const key = /^([A-Za-z][A-Za-z0-9_-]*)\s*:/.exec(line)?.[1];
        if (key !== undefined && keys.includes(key)) present.add(key);
      }
    }
    for (const key of present) hits.push({ file, key, kind: "key" });
  }
  return hits;
}
