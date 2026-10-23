// src/spec/member.testkit.ts -- throwaway member repositories for the spec
// family's tests: a real git repository per test, every slug a placeholder.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const MEMBER_SLUG = "fixture-owner/fixture-app";

export const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Write each file (path -> text) under root. */
export function put(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

/** A git repository holding `files` in one commit, origin set to the member slug. Returns its path and the commit. */
export function memberRepo(files: Readonly<Record<string, string>>, origin = `https://github.com/${MEMBER_SLUG}.git`): { root: string; sha: string } {
  const root = mkdtempSync(join(tmpdir(), "nen-spec-member-"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "commit.gpgsign", "false");
  put(root, files);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "one");
  git(root, "remote", "add", "origin", origin);
  return { root, sha: git(root, "rev-parse", "HEAD") };
}

/** One more commit on a member repository: writes `files`, deletes `remove`. */
export function commit(root: string, files: Readonly<Record<string, string>>, remove: readonly string[] = []): string {
  put(root, files);
  for (const path of remove) git(root, "rm", "-q", path);
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "next");
  return git(root, "rev-parse", "HEAD");
}

export const numbered = (prefix: string, count: number): string => Array.from({ length: count }, (_, index): string => `${prefix} ${index + 1}`).join("\n") + "\n";
