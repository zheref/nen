// src/github/target.integration.test.ts -- a token-bearing, unparseable origin
// is never echoed with its credential (SEC-5, zheref/nen#373).
//
// WHY A REAL PROCESS. The unit rows prove each echo site calls the redactor.
// Only the spawned entry point proves the WHOLE of what a caller sees -- stdout
// and stderr, the text form and --json, through the usage-error wrapping a
// verb puts around a TargetError -- carries no trace of the token. The origin
// is set with the real git, so the URL reaches nen exactly as `git remote
// get-url` answers it. The token is a made-up literal, deliberately too short
// for the GitHub token shape, so this file passes only if the USERINFO is
// redacted rather than the token's pattern.
//
// It SKIPS where `git` or `bun` is missing, as ../stage/list.integration.test.ts does.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "ghp_FAKE0000";
const HAVE_GIT = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
const HAVE_BUN = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
/** This repository's own entry point, spawned as a process. */
const ENTRY = join(process.cwd(), "src", "index.ts");

let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nen-373-"));
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

/** A fresh repository whose origin is `url`, carrying an empty registry so the repo verbs reach the origin. */
function repoWithOrigin(name: string, url: string): string {
  const repo = join(root, name);
  mkdirSync(join(repo, "nen"), { recursive: true });
  for (const args of [["init", "-q"], ["remote", "add", "origin", url]]) {
    const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} exited ${String(result.status)}: ${result.stderr}`);
  }
  writeFileSync(join(repo, "nen", "repos.json"), `${JSON.stringify({ maintained_tools: [], consumers: [], product_codes: {} })}\n`, "utf8");
  return repo;
}

function nen(cwd: string, argv: readonly string[]): { code: number | null; stdout: string; stderr: string } {
  // No GitHub token reaches the child: every row refuses before any `gh` call.
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  delete env["GH_TOKEN"];
  delete env["GITHUB_TOKEN"];
  const result = spawnSync("bun", [ENTRY, ...argv], { cwd, encoding: "utf8", env });
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe.skipIf(!HAVE_GIT || !HAVE_BUN)("a token-bearing, unparseable origin (zheref/nen#373)", () => {
  const SHAPES = [
    ["a token alone as the userinfo", `https://${TOKEN}@github.com/owner/name/extra`],
    ["a user and a token", `https://user:${TOKEN}@github.com/owner/name/extra`],
  ] as const;

  for (const [label, url] of SHAPES) {
    it(`runner inventory (targetFromRemote) -- ${label}: the token is in neither stream, text or --json`, () => {
      const repo = repoWithOrigin(`runner-${label.replace(/\W+/g, "-")}`, url);
      for (const json of [false, true]) {
        const result = nen(repo, ["runner", "inventory", ...(json ? ["--json"] : [])]);
        expect(result.code).toBe(2);
        expect(result.stdout + result.stderr).not.toContain(TOKEN);
        expect(result.stdout + result.stderr).toContain("https://***@github.com/owner/name/extra");
      }
    });
  }

  it("repo resolve and repo classify refuse an unparseable origin without its token", () => {
    const repo = repoWithOrigin("repo-verbs", `https://user:${TOKEN}@github.com/only`);
    for (const argv of [["repo", "resolve", "--repo", repo], ["repo", "resolve", "--repo", repo, "--json"], ["repo", "classify", "--repo", repo], ["repo", "classify", "--repo", repo, "--json"]]) {
      const result = nen(repo, argv);
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(TOKEN);
      expect(result.stdout + result.stderr).toContain("https://***@github.com/only");
    }
  });
});
