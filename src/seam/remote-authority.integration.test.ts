// src/seam/remote-authority.integration.test.ts -- the DIFFERENTIAL proof that
// `readRemoteAuthority` names the host git actually connects to, or no host at
// all (SEC-7, zheref/nen#373, Feitan hanten round 3).
//
// WHY A REAL GIT. Every reader nen had before this one was a regex that agreed
// with itself; three rounds of review found a URL where it disagreed with git
// (`https://evil/x@good:o/n`, `ssh://[evil]@good/o/n`, `ssh://good:22#@evil/o/n`).
// So the oracle here is git: `git ls-remote <url>` runs with a stub GIT_SSH that
// records the argv git hands to ssh and exits 1, so nothing is ever contacted.
// ssh splits `user@host` at the LAST `@` (OpenSSH's strrchr), so that is the
// host git connects to. The assertion is one line: nen's host EQUALS git's, or
// nen reads null and the host check refuses. A row where git never calls ssh
// (a git:// or https:// URL) must read null.
//
// The config is isolated -- no system or global file, a scratch HOME -- so a
// developer's `url.<base>.insteadOf` cannot rewrite a row. POSIX-only: the stub
// is a shell script. Hosts are `.invalid`/`.example`; nothing resolves.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRemoteAuthority } from "./exec.js";

const POSIX = process.platform !== "win32";
const HAVE_GIT = spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

let root = "";
let stub = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "nen-remote-authority-"));
  mkdirSync(join(root, "home"));
  stub = join(root, "ssh-stub.sh");
  writeFileSync(stub, '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$NEN_TEST_SSH_LOG"\nexit 1\n', "utf8");
  chmodSync(stub, 0o755);
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

/** The host git hands to ssh for `url`, lower-cased after ssh's own last-`@` split -- or null when git never called ssh. */
function gitSshHost(url: string, index: number): { host: string | null; stderr: string } {
  const log = join(root, `argv-${String(index)}.txt`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "home"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_SSH: stub,
    GIT_SSH_VARIANT: "ssh",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "ssh",
    NEN_TEST_SSH_LOG: log,
  };
  delete env["GIT_SSH_COMMAND"];
  delete env["GIT_CONFIG_PARAMETERS"];
  const result = spawnSync("git", ["ls-remote", url], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
  if (!existsSync(log)) return { host: null, stderr: result.stderr ?? "" };
  const argv = readFileSync(log, "utf8").split("\n").filter((line): boolean => line !== "");
  // `[-o SendEnv=GIT_PROTOCOL] [-p <port>] <host> <command>`: the host is the one before the command.
  const handed = argv[argv.length - 2] ?? "";
  return { host: handed.slice(handed.lastIndexOf("@") + 1).toLowerCase(), stderr: result.stderr ?? "" };
}

const ROWS: readonly string[] = [
  // Feitan round 3, item 1: git's host_end() strips a leading [..] or @[..].
  "ssh://[evil.invalid]@good.example/o/n",
  "ssh://git@[evil.invalid]@good.example/o/n",
  "ssh://[evil.invalid]:22@good.example/o/n",
  "ssh://[evil.invalid:2222]@good.example/o/n",
  "git://[evil.invalid]@good.example/o/n",
  // Item 2: git ends an ssh host at '/', not at '?' or '#'.
  "ssh://good.example:22#@evil.invalid/o/n",
  "ssh://good.example:22?@evil.invalid/o/n",
  "ssh://good.example?@evil.invalid/o/n",
  // Round 2's rows.
  "https://evil.invalid/x@good.example:o/n",
  "evil.invalid:x@good.example:o/n",
  "ssh://evil.invalid/x@good.example/o/n",
  "[evil.invalid]@good.example:o/n",
  // Controls: plain spellings where nen must name git's host, not merely refuse.
  "ssh://git@good.example/o/n",
  "ssh://git@good.example:2222/o/n",
  "git@good.example:o/n",
  "good.example:o/n",
  "ssh://u:pa@good.example/o/n",
];

describe.skipIf(!POSIX || !HAVE_GIT)("readRemoteAuthority agrees with the host git hands to ssh, or reads none (zheref/nen#373)", () => {
  it("every row: nen's host equals git's, or nen reads null", () => {
    const table = ROWS.map((url, index) => ({ url, git: gitSshHost(url, index).host, nen: readRemoteAuthority(url)?.host.toLowerCase() ?? null }));
    for (const row of table) {
      if (row.nen !== null) expect(row.nen, `${row.url}: nen read '${row.nen}', git connects to '${String(row.git)}'`).toBe(row.git);
    }
    // The spoofs themselves are refused, not merely consistent.
    for (const row of table.slice(0, 12)) {
      if (row.nen !== null) expect(row.nen, row.url).not.toBe("good.example");
    }
    // The controls prove the oracle reads hosts at all: nen and git agree on a real host.
    for (const row of table.slice(12)) {
      expect(row.git, row.url).toBe("good.example");
      expect(row.nen, row.url).toBe("good.example");
    }
  });
});
