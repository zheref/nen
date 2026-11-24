import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { realContainment } from "../repo/contain.js";
import { VerbUsageError } from "../cli/command.js";

/** Metadata only, and only for the directory the caller explicitly selected. */
export function readAgentSpecs(root: string, directory: string): readonly { name: string; path: string; bytes: number; sha256: string }[] {
  const dir = resolve(root, directory);
  const read = (path: string): void => { const check = realContainment(root, path); if (!check.contained || check.link !== null || lstatSync(path).isSymbolicLink()) throw new VerbUsageError(`agents directory/spec is redirected or outside --repo: ${path}`); };
  read(dir);
  if (!lstatSync(dir).isDirectory()) throw new VerbUsageError("--agents-dir must name a directory.");
  return readdirSync(dir).filter(name => name.endsWith(".md")).sort().map(name => {
    const path = join(dir, name); read(path);
    if (!lstatSync(path).isFile()) throw new VerbUsageError(`agent spec is not a regular file: ${name}`);
    const bytes = readFileSync(path);
    return { name: name.slice(0, -3), path: relative(root, path).split("\\").join("/"), bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}
