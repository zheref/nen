// src/spec/membership.ts -- the files a member's BUILD SYSTEM owns, read from
// the build system's own declarations at one commit (SP-14: "totals taken from
// the member's build-system file set, never a filename glob").
//
// THREE READERS, ONE PER GOVERNED SCENARIO'S BUILD SYSTEM, each reading only
// what that build system writes down:
//
//   xcode     every `*.xcodeproj/project.pbxproj` under the lane: each native
//             target's Sources and Resources build-phase files, resolved
//             through the group tree, plus every file under a target's
//             file-system-synchronized root group minus its membership
//             exceptions (the Xcode 16 form).
//   gradle    `settings.gradle(.kts)`'s `include(...)` modules; each module's
//             convention source sets (`src/<set>/{kotlin,java}`, and
//             `src/<set>/res/values*/strings.xml`) plus any `srcDir(...)` /
//             `srcDirs(...)` string its build file names.
//   tsconfig  `tsconfig.json`'s `files` / `include` / `exclude` (TypeScript's
//             own defaults when absent), relative `extends` followed for the
//             keys a child does not state, and every `references[].path`
//             project read the same way.
//
// WHAT A READER CANNOT READ IS SAID, NEVER GUESSED. A `projectDir` override, a
// package `extends`, a file reference outside the tree: each is an `unread`
// entry with its reason, and the inventory is `partial`, never complete.

import { dirname } from "node:path/posix";
import { globMatcher, joinPath, normalise, under, type MemberTree } from "./tree.js";

export type MembershipSource = "xcode" | "gradle" | "tsconfig";

export interface Unread {
  readonly path: string;
  readonly reason: string;
}

export interface Membership {
  readonly source: MembershipSource;
  /** The build-system files the membership was read from. */
  readonly read: readonly string[];
  /** Owned file paths, sorted, each present at the sha. */
  readonly files: readonly string[];
  readonly unread: readonly Unread[];
}

// ---------------------------------------------------------------- xcode

type Plist = string | Plist[] | { [key: string]: Plist };

/** An OpenStep property list (the pbxproj format): dicts, arrays, quoted and bare strings, both comment forms. */
export function parsePlist(text: string): Plist {
  let at = 0;
  const fail = (why: string): never => {
    throw new Error(`pbxproj: ${why} at offset ${at}`);
  };
  const skip = (): void => {
    for (;;) {
      while (at < text.length && /\s/.test(text[at] as string)) at += 1;
      if (text.startsWith("//", at)) {
        const end = text.indexOf("\n", at);
        at = end === -1 ? text.length : end + 1;
      } else if (text.startsWith("/*", at)) {
        const end = text.indexOf("*/", at + 2);
        if (end === -1) fail("unclosed comment");
        at = end + 2;
      } else return;
    }
  };
  const value = (): Plist => {
    skip();
    const char = text[at];
    if (char === "{") {
      at += 1;
      const dict: { [key: string]: Plist } = {};
      for (;;) {
        skip();
        if (text[at] === "}") {
          at += 1;
          return dict;
        }
        const key = value();
        if (typeof key !== "string") fail("a non-string key");
        skip();
        if (text[at] !== "=") fail("expected '='");
        at += 1;
        dict[key as string] = value();
        skip();
        if (text[at] !== ";") fail("expected ';'");
        at += 1;
      }
    }
    if (char === "(") {
      at += 1;
      const list: Plist[] = [];
      for (;;) {
        skip();
        if (text[at] === ")") {
          at += 1;
          return list;
        }
        list.push(value());
        skip();
        if (text[at] === ",") at += 1;
        else if (text[at] !== ")") fail("expected ',' or ')'");
      }
    }
    if (char === '"') {
      at += 1;
      let out = "";
      while (at < text.length && text[at] !== '"') {
        if (text[at] === "\\") {
          const next = text[at + 1] ?? "";
          out += next === "n" ? "\n" : next === "t" ? "\t" : next;
          at += 2;
        } else {
          out += text[at];
          at += 1;
        }
      }
      if (at >= text.length) fail("unclosed string");
      at += 1;
      return out;
    }
    const bare = /^[A-Za-z0-9_$+./:\-<>]+/.exec(text.slice(at));
    if (bare === null) return fail("unexpected character");
    at += bare[0].length;
    return bare[0];
  };
  const root = value();
  skip();
  if (at !== text.length) fail("trailing text");
  return root;
}

type Dict = { readonly [key: string]: Plist };
const isDict = (value: Plist | undefined): value is Dict => value !== undefined && typeof value === "object" && !Array.isArray(value);
const str = (value: Plist | undefined): string | null => (typeof value === "string" ? value : null);
const list = (value: Plist | undefined): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

function readXcodeProject(tree: MemberTree, pbxproj: string, unread: Unread[], owned: Set<string>): void {
  const text = tree.read(pbxproj);
  if (text === null) {
    unread.push({ path: pbxproj, reason: "could not be read at the sha" });
    return;
  }
  let root: Plist;
  try {
    root = parsePlist(text);
  } catch (error) {
    unread.push({ path: pbxproj, reason: (error as Error).message });
    return;
  }
  const objects = isDict(root) && isDict(root["objects"]) ? root["objects"] : null;
  if (objects === null) {
    unread.push({ path: pbxproj, reason: "carries no objects dictionary" });
    return;
  }
  const projectDir = dirname(dirname(pbxproj)) === "." ? "" : dirname(dirname(pbxproj));
  const parent = new Map<string, string>();
  for (const [id, object] of Object.entries(objects)) {
    if (!isDict(object)) continue;
    for (const child of list(object["children"])) parent.set(child, id);
  }
  const pathOf = (id: string, seen = new Set<string>()): string | null => {
    const object = objects[id];
    if (!isDict(object) || seen.has(id)) return null;
    seen.add(id);
    const own = str(object["path"]) ?? "";
    const tree_ = str(object["sourceTree"]) ?? "<group>";
    if (tree_ === "SOURCE_ROOT") return normalise(joinPath(projectDir, own));
    if (tree_ !== "<group>") return null;
    const up = parent.get(id);
    if (up === undefined) return normalise(joinPath(projectDir, own));
    const base = pathOf(up, seen);
    return base === null ? null : normalise(joinPath(base, own));
  };
  const addRef = (id: string, where: string): void => {
    const ref = objects[id];
    if (!isDict(ref)) {
      unread.push({ path: pbxproj, reason: `${where}: file reference ${id} is not in the objects dictionary` });
      return;
    }
    const path = pathOf(id);
    const shown = str(ref["path"]) ?? str(ref["name"]) ?? id;
    if (path === null) {
      // A product, an SDK framework or an absolute path lives outside the tree; it is not product code.
      if (ref["isa"] === "PBXFileReference" && (str(ref["sourceTree"]) ?? "<group>") !== "<group>" && str(ref["sourceTree"]) !== "SOURCE_ROOT") return;
      unread.push({ path: pbxproj, reason: `${where}: '${shown}' does not resolve to a path inside the checkout` });
      return;
    }
    if (ref["isa"] === "PBXGroup" || ref["isa"] === "PBXVariantGroup") {
      for (const child of list(ref["children"])) addRef(child, where);
      return;
    }
    if (tree.has(path)) owned.add(path);
    else if (!tree.files.some((file): boolean => file.startsWith(`${path}/`))) unread.push({ path, reason: `${where}: listed by ${pbxproj} but not a file at the sha` });
    else for (const file of tree.files) if (file.startsWith(`${path}/`)) owned.add(file);
  };
  for (const [targetId, target] of Object.entries(objects)) {
    if (!isDict(target) || target["isa"] !== "PBXNativeTarget") continue;
    const name = str(target["name"]) ?? targetId;
    for (const phaseId of list(target["buildPhases"])) {
      const phase = objects[phaseId];
      if (!isDict(phase) || (phase["isa"] !== "PBXSourcesBuildPhase" && phase["isa"] !== "PBXResourcesBuildPhase")) continue;
      for (const buildFileId of list(phase["files"])) {
        const buildFile = objects[buildFileId];
        const ref = isDict(buildFile) ? str(buildFile["fileRef"]) : null;
        if (ref === null) {
          unread.push({ path: pbxproj, reason: `target ${name}: build file ${buildFileId} names no fileRef` });
          continue;
        }
        addRef(ref, `target ${name}`);
      }
    }
    for (const groupId of list(target["fileSystemSynchronizedGroups"])) {
      const group = objects[groupId];
      const dir = pathOf(groupId);
      if (!isDict(group) || dir === null) {
        unread.push({ path: pbxproj, reason: `target ${name}: synchronized group ${groupId} does not resolve inside the checkout` });
        continue;
      }
      const excluded = new Set<string>();
      for (const exceptionId of list(group["exceptions"])) {
        const exception = objects[exceptionId];
        if (!isDict(exception) || str(exception["target"]) !== targetId) continue;
        for (const relative of list(exception["membershipExceptions"])) {
          const full = normalise(joinPath(dir, relative));
          if (full !== null) excluded.add(full);
        }
      }
      for (const file of tree.files) {
        if (!under(dir, file) || file === dir) continue;
        if ([...excluded].some((path): boolean => under(path, file))) continue;
        owned.add(file);
      }
    }
  }
}

function xcode(tree: MemberTree, cwd: string): Membership {
  const projects = tree.files.filter((file): boolean => under(cwd, file) && /(^|\/)[^/]+\.xcodeproj\/project\.pbxproj$/.test(file) && !/(^|\/)Pods\//.test(file));
  const unread: Unread[] = [];
  const owned = new Set<string>();
  if (projects.length === 0) unread.push({ path: cwd === "" ? "." : cwd, reason: "no *.xcodeproj/project.pbxproj at the sha; the Xcode project is the membership and there is none to read" });
  for (const project of projects) readXcodeProject(tree, project, unread, owned);
  return { source: "xcode", read: projects, files: [...owned].sort(), unread };
}

// ---------------------------------------------------------------- gradle

const SOURCE_EXTENSIONS = /\.(kt|kts|java)$/;

function gradle(tree: MemberTree, cwd: string): Membership {
  const settings = [joinPath(cwd, "settings.gradle.kts"), joinPath(cwd, "settings.gradle")].find((path): boolean => tree.has(path));
  const unread: Unread[] = [];
  const owned = new Set<string>();
  if (settings === undefined) {
    unread.push({ path: joinPath(cwd, "settings.gradle(.kts)"), reason: "no Gradle settings file at the sha; its include list is the membership and there is none to read" });
    return { source: "gradle", read: [], files: [], unread };
  }
  const read = [settings];
  const text = (tree.read(settings) ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  if (/\bprojectDir\b/.test(text)) unread.push({ path: settings, reason: "sets a projectDir; nen reads the include list's default module paths only, so a relocated module is not read" });
  const modules = new Set<string>();
  for (const call of text.matchAll(/\binclude\s*\(?([^)\n]*)\)?/g)) {
    for (const name of (call[1] as string).matchAll(/["']:?([A-Za-z0-9_.:-]+)["']/g)) modules.add((name[1] as string).replace(/:/g, "/"));
  }
  if (modules.size === 0) unread.push({ path: settings, reason: "includes no module" });
  for (const module of [...modules].sort()) {
    const dir = joinPath(cwd, module);
    const buildFile = [joinPath(dir, "build.gradle.kts"), joinPath(dir, "build.gradle")].find((path): boolean => tree.has(path));
    const roots = new Set<string>();
    for (const file of tree.files) {
      const match = new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/src/([^/]+)/(kotlin|java)/`).exec(file);
      if (match !== null) roots.add(`${dir}/src/${match[1] as string}/${match[2] as string}`);
    }
    if (buildFile !== undefined) {
      read.push(buildFile);
      const body = (tree.read(buildFile) ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      for (const call of body.matchAll(/\bsrcDirs?\s*(?:\(|\+=|=)?\s*([^\n)]*)/g)) {
        for (const value of (call[1] as string).matchAll(/["']([^"'$]+)["']/g)) {
          const path = normalise(joinPath(dir, value[1] as string));
          if (path === null || !under(cwd, path)) unread.push({ path: buildFile, reason: `srcDir '${value[1] as string}' leaves the checkout` });
          else roots.add(path);
        }
      }
    } else unread.push({ path: dir, reason: "an included module with no build.gradle(.kts) at the sha" });
    for (const file of tree.files) {
      if ([...roots].some((root): boolean => under(root, file)) && SOURCE_EXTENSIONS.test(file)) owned.add(file);
      if (new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/src/[^/]+/res/values[^/]*/strings\\.xml$`).test(file)) owned.add(file);
    }
  }
  return { source: "gradle", read, files: [...owned].sort(), unread };
}

// ---------------------------------------------------------------- tsconfig

/** tsconfig's JSON-with-comments, trailing commas allowed. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index += 1;
      } else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
    } else if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 1;
    } else out += char;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

interface TsProject {
  files: string[] | null;
  include: string[] | null;
  exclude: string[] | null;
  allowJs: boolean | null;
  outDir: string | null;
  /** The directory the inherited keys resolve against, per key. */
  base: { files: string; include: string; exclude: string; outDir: string };
}

function tsconfig(tree: MemberTree, cwd: string): Membership {
  const unread: Unread[] = [];
  const owned = new Set<string>();
  const read: string[] = [];
  const done = new Set<string>();
  const load = (path: string, chain: Set<string>): TsProject | null => {
    if (chain.has(path)) {
      unread.push({ path, reason: "extends itself through a cycle" });
      return null;
    }
    const text = tree.read(path);
    if (text === null) {
      unread.push({ path, reason: "not a file at the sha" });
      return null;
    }
    if (!read.includes(path)) read.push(path);
    let raw: Record<string, unknown>;
    try {
      raw = parseJsonc(text) as Record<string, unknown>;
    } catch (error) {
      unread.push({ path, reason: `not JSON(C): ${(error as Error).message}` });
      return null;
    }
    const dir = dirname(path) === "." ? "" : dirname(path);
    const strings = (key: string): string[] | null => (Array.isArray(raw[key]) ? (raw[key] as unknown[]).filter((item): item is string => typeof item === "string") : null);
    const options = (raw["compilerOptions"] ?? {}) as Record<string, unknown>;
    let parentProject: TsProject | null = null;
    const ext = raw["extends"];
    for (const entry of typeof ext === "string" ? [ext] : Array.isArray(ext) ? ext.filter((item): item is string => typeof item === "string") : []) {
      if (!entry.startsWith(".")) {
        unread.push({ path, reason: `extends '${entry}', a package nen does not resolve; only its own keys were read` });
        continue;
      }
      const target = normalise(joinPath(dir, entry.endsWith(".json") ? entry : `${entry}.json`));
      if (target === null) {
        unread.push({ path, reason: `extends '${entry}', outside the checkout` });
        continue;
      }
      parentProject = load(target, new Set([...chain, path]));
    }
    const own = (key: "files" | "include" | "exclude"): string[] | null => strings(key);
    return {
      files: own("files") ?? parentProject?.files ?? null,
      include: own("include") ?? parentProject?.include ?? null,
      exclude: own("exclude") ?? parentProject?.exclude ?? null,
      allowJs: typeof options["allowJs"] === "boolean" ? (options["allowJs"] as boolean) : (parentProject?.allowJs ?? null),
      outDir: typeof options["outDir"] === "string" ? (options["outDir"] as string) : (parentProject?.outDir ?? null),
      base: {
        files: own("files") !== null ? dir : (parentProject?.base.files ?? dir),
        include: own("include") !== null ? dir : (parentProject?.base.include ?? dir),
        exclude: own("exclude") !== null ? dir : (parentProject?.base.exclude ?? dir),
        outDir: typeof options["outDir"] === "string" ? dir : (parentProject?.base.outDir ?? dir),
      },
    };
  };
  const project = (path: string): void => {
    if (done.has(path)) return;
    done.add(path);
    const config = load(path, new Set());
    if (config === null) return;
    const extensions = config.allowJs === true ? /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/ : /\.(ts|tsx|mts|cts)$/;
    for (const file of config.files ?? []) {
      const full = normalise(joinPath(config.base.files, file));
      if (full !== null && tree.has(full)) owned.add(full);
      else unread.push({ path, reason: `files[] names '${file}', not a file at the sha` });
    }
    const include = config.include ?? (config.files === null ? ["**/*"] : []);
    const exclude = config.exclude ?? ["node_modules", "bower_components", "jspm_packages", ...(config.outDir === null ? [] : [config.outDir])];
    const toMatcher = (base: string, pattern: string): RegExp | null => {
      const full = normalise(joinPath(base, pattern));
      if (full === null) return null;
      const last = full.split("/").pop() ?? "";
      return globMatcher(/[*?]/.test(last) || /\.[A-Za-z0-9]+$/.test(last) ? full : `${full}/**/*`);
    };
    const includes = include.map((pattern): RegExp | null => toMatcher(config.base.include, pattern)).filter((matcher): matcher is RegExp => matcher !== null);
    const excludes = exclude.map((pattern): RegExp | null => toMatcher(config.base.exclude, pattern)).filter((matcher): matcher is RegExp => matcher !== null);
    for (const file of tree.files) {
      if (!extensions.test(file) || /\.d\.[cm]?ts$/.test(file)) continue;
      if (includes.some((matcher): boolean => matcher.test(file)) && !excludes.some((matcher): boolean => matcher.test(file))) owned.add(file);
    }
    const text = tree.read(path);
    const raw = text === null ? {} : ((): Record<string, unknown> => {
      try {
        return parseJsonc(text) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const dir = dirname(path) === "." ? "" : dirname(path);
    for (const reference of Array.isArray(raw["references"]) ? (raw["references"] as unknown[]) : []) {
      const target = typeof (reference as { path?: unknown }).path === "string" ? normalise(joinPath(dir, (reference as { path: string }).path)) : null;
      if (target === null) {
        unread.push({ path, reason: "a references[] entry with no path inside the checkout" });
        continue;
      }
      project(target.endsWith(".json") ? target : joinPath(target, "tsconfig.json"));
    }
  };
  const rootConfig = joinPath(cwd, "tsconfig.json");
  if (!tree.has(rootConfig)) unread.push({ path: rootConfig, reason: "no tsconfig.json at the sha; its include list is the membership and there is none to read" });
  else project(rootConfig);
  return { source: "tsconfig", read, files: [...owned].sort(), unread };
}

export function readMembership(source: MembershipSource, tree: MemberTree, cwd: string): Membership {
  switch (source) {
    case "xcode":
      return xcode(tree, cwd);
    case "gradle":
      return gradle(tree, cwd);
    case "tsconfig":
      return tsconfig(tree, cwd);
  }
}
