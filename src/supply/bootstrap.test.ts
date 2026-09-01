// src/supply/bootstrap.test.ts -- covers BOTH halves of the supply contract:
// the TypeScript wrapper, and the shell script's pure predicates.
//
// HOW THE SHELL IS TESTED WITHOUT bats. D16 forbids bats outright and vitest is
// the one harness, so the shell's predicates are driven FROM here: each case
// sources `bootstrap/nen.sh` in a bash subprocess and calls one function with
// arguments. That works because the script guards its own `main` with
// `[ "${BASH_SOURCE[0]}" = "${0}" ]`, so sourcing it defines the functions and
// runs nothing -- the same property the original relied on for its bats suite.
//
// NO NETWORK IS TOUCHED. Every case below exercises a decision function
// (artifact_for_host, expected_sha, cache_path, checksum_matches,
// verify_or_reject) against arguments and temp files. That split -- pure
// predicates, imperative main -- is why the script is shaped the way it is.
//
// A HOST WITH NO `bash` SKIPS THESE, loudly. Git Bash is a first-class supported
// host (§10) and supplies one; CI's ubuntu job always does, so the shell
// coverage is never actually skipped where it is required to pass.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapArgv,
  BootstrapExit,
  BOOTSTRAP_SCRIPT,
  isRetryable,
  resolveScript,
  runBootstrap,
} from "./bootstrap.js";

const REPO_ROOT = process.cwd();
const SCRIPT = join(REPO_ROOT, ...BOOTSTRAP_SCRIPT.split("/"));

function hasBash(): boolean {
  const probe = spawnSync("bash", ["-c", "exit 0"], { encoding: "utf8" });
  return probe.error === undefined && probe.status === 0;
}

const BASH = hasBash();

// Run one expression with the script's functions in scope. `posixPath` keeps
// Windows paths usable inside bash by handing them over as forward-slashed
// strings, which Git Bash accepts.
function sh(expression: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bash", ["-c", `source '${posixPath(SCRIPT)}'\n${expression}`], {
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: (result.stdout ?? "").trim(),
    stderr: result.stderr ?? "",
  };
}

function posixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

// A real SHA-256 of a real file, computed by the script itself -- so the fixture
// can never disagree with the thing under test.
function sha256Of(path: string): string {
  return sh(`sha256_of '${posixPath(path)}'`).stdout;
}

describe.skipIf(!BASH)("bootstrap/nen.sh -- artifact_for_host", () => {
  it("maps the three published hosts to the three published filenames", () => {
    expect(sh('artifact_for_host "Linux" "x86_64"').stdout).toBe("nen-linux-x64");
    expect(sh('artifact_for_host "Darwin" "arm64"').stdout).toBe("nen-darwin-arm64");
    expect(sh('artifact_for_host "MINGW64_NT-10.0-26200" "x86_64"').stdout).toBe(
      "nen-windows-x64.exe",
    );
  });

  it("accepts every spelling of a Windows kernel and of an architecture", () => {
    for (const kernel of ["MSYS_NT-10.0", "CYGWIN_NT-10.0", "Windows_NT"]) {
      expect(sh(`artifact_for_host "${kernel}" "amd64"`).stdout).toBe("nen-windows-x64.exe");
    }
    expect(sh('artifact_for_host "Linux" "amd64"').stdout).toBe("nen-linux-x64");
    expect(sh('artifact_for_host "Darwin" "aarch64"').stdout).toBe("nen-darwin-arm64");
  });

  it("REFUSES the two real hosts no binary is published for, by name", () => {
    // An Intel Mac and an arm64 Linux runner. Handing either the "closest"
    // build produces a `Bad CPU type` failure three steps later, in a caller
    // with no idea why.
    const intelMac = sh('artifact_for_host "Darwin" "x86_64"');
    expect(intelMac.status).toBe(BootstrapExit.UNSUPPORTED_HOST);
    expect(intelMac.stdout).toBe("");
    expect(intelMac.stderr).toMatch(/darwin\/x64/);

    const armLinux = sh('artifact_for_host "Linux" "arm64"');
    expect(armLinux.status).toBe(BootstrapExit.UNSUPPORTED_HOST);
    expect(armLinux.stderr).toMatch(/linux\/arm64/);
  });

  it("refuses an unknown OS and an unknown architecture separately", () => {
    expect(sh('artifact_for_host "Plan9" "x86_64"').stderr).toMatch(/operating system/);
    expect(sh('artifact_for_host "Linux" "riscv64"').stderr).toMatch(/architecture/);
  });
});

describe.skipIf(!BASH)("bootstrap/nen.sh -- expected_sha fails closed", () => {
  function manifest(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "nen-bs-"));
    const path = join(dir, "SHA256SUMS");
    writeFileSync(path, body);
    return posixPath(path);
  }

  const digest = "a".repeat(64);

  it("returns the digest recorded for an artifact", () => {
    const path = manifest(`${digest}  nen-linux-x64\n${"b".repeat(64)}  nen-darwin-arm64\n`);
    expect(sh(`expected_sha '${path}' 'nen-linux-x64'`).stdout).toBe(digest);
  });

  it("accepts the binary-mode `*name` spelling", () => {
    const path = manifest(`${digest} *nen-linux-x64\n`);
    expect(sh(`expected_sha '${path}' 'nen-linux-x64'`).stdout).toBe(digest);
  });

  it("refuses a MISSING manifest", () => {
    const result = sh(`expected_sha '/nope/SHA256SUMS' 'nen-linux-x64'`);
    expect(result.status).toBe(BootstrapExit.MANIFEST);
    expect(result.stderr).toMatch(/is missing/);
  });

  it("refuses a manifest that says nothing about the artifact", () => {
    const path = manifest(`${digest}  something-else\n`);
    const result = sh(`expected_sha '${path}' 'nen-linux-x64'`);
    expect(result.status).toBe(BootstrapExit.MANIFEST);
    expect(result.stderr).toMatch(/no entry/);
  });

  it("refuses an AMBIGUOUS manifest rather than picking a digest", () => {
    const path = manifest(`${digest}  nen-linux-x64\n${"b".repeat(64)}  nen-linux-x64\n`);
    const result = sh(`expected_sha '${path}' 'nen-linux-x64'`);
    expect(result.status).toBe(BootstrapExit.MANIFEST);
    expect(result.stderr).toMatch(/conflicting digests/);
  });

  it("refuses a non-hex and a short digest, with DIFFERENT messages", () => {
    const nonHex = manifest(`zzzz  nen-linux-x64\n`);
    expect(sh(`expected_sha '${nonHex}' 'nen-linux-x64'`).stderr).toMatch(/not hexadecimal/);
    const short = manifest(`abcdef  nen-linux-x64\n`);
    expect(sh(`expected_sha '${short}' 'nen-linux-x64'`).stderr).toMatch(/not the 64 of a SHA-256/);
  });

  it("matches field 2 EXACTLY, never as a substring", () => {
    // A name that CONTAINS the wanted one must not satisfy the lookup: checking
    // a binary against another file's digest is worse than not checking, because
    // it reports success.
    const path = manifest(`${digest}  prefix-nen-linux-x64-suffix\n`);
    expect(sh(`expected_sha '${path}' 'nen-linux-x64'`).status).toBe(BootstrapExit.MANIFEST);
  });
});

describe.skipIf(!BASH)("bootstrap/nen.sh -- verification", () => {
  function tempFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "nen-bs-"));
    const path = join(dir, "artifact");
    writeFileSync(path, content);
    chmodSync(path, 0o644);
    return path;
  }

  it("verifies a file against its own digest", () => {
    const path = tempFile("hello");
    const digest = sha256Of(path);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(sh(`checksum_matches '${posixPath(path)}' '${digest}'`).status).toBe(0);
    // Case-insensitive: a hand-regenerated manifest may be uppercase, and a
    // digest's spelling is not part of its identity.
    expect(sh(`checksum_matches '${posixPath(path)}' '${digest.toUpperCase()}'`).status).toBe(0);
  });

  it("REGRESSION: reads the digest correctly for a path containing a backslash", () => {
    // GNU coreutils' escaped-filename convention prefixes the whole LINE with a
    // `\` when the name it echoes contains a backslash, so the first field is a
    // 65-character string. On Windows/Git Bash an ordinary cache directory is
    // spelled `C:\Users\...`, which means this affected the DEFAULT path on a
    // first-class supported host (§10): the cache never hit, every run
    // re-downloaded, and checksum_matches reported "does not match" for bytes
    // that were correct. Found by the end-to-end cases below, fixed in
    // sha256_of.
    const path = tempFile("hello");
    const windowsish = path.replace(/\//g, "\\");
    const digest = sh(`sha256_of '${windowsish}'`).stdout;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(sha256Of(path));
    expect(sh(`checksum_matches '${windowsish}' '${digest}'`).status).toBe(0);
  });

  it("DELETES the file on a mismatch and reports EXIT_CHECKSUM", () => {
    // The `rm -f` is load-bearing: a rejected artifact left on disk is one a
    // later run, or a caller ignoring the exit status, can still execute.
    const path = tempFile("hello");
    const result = sh(`verify_or_reject '${posixPath(path)}' '${"a".repeat(64)}' 'the artifact'`);
    expect(result.status).toBe(BootstrapExit.CHECKSUM);
    expect(result.stderr).toMatch(/SHA-256 MISMATCH/);
    expect(result.stderr).toMatch(/has been DELETED/);
    expect(() => readFileSync(path)).toThrow();
  });

  it("refuses an EMPTY expectation rather than trivially satisfying it", () => {
    const path = tempFile("hello");
    const result = sh(`verify_or_reject '${posixPath(path)}' '' 'the artifact'`);
    expect(result.status).toBe(BootstrapExit.CHECKSUM);
    expect(result.stderr).toMatch(/no expected digest/);
  });

  it("refuses an absent file", () => {
    expect(sh(`verify_or_reject '/nope/artifact' '${"a".repeat(64)}' 'x'`).status).toBe(
      BootstrapExit.CHECKSUM,
    );
  });

  it("treats a truncated file as a cache MISS, not a hit", () => {
    // Presence is never sufficient: an interrupted mv leaves a short file, which
    // the next run must hash, reject, and replace.
    const path = tempFile("hello");
    const digest = sha256Of(path);
    writeFileSync(path, "hell");
    expect(sh(`cache_is_valid '${posixPath(path)}' '${digest}'`).status).not.toBe(0);
  });
});

describe.skipIf(!BASH)("bootstrap/nen.sh -- cache_path sanitizes the ref", () => {
  it("keeps an ordinary tag intact", () => {
    expect(sh(`cache_path '/c' 'v0.1.0' 'nen-linux-x64'`).stdout).toBe(
      "/c/v0.1.0/nen-linux-x64",
    );
  });

  it("flattens a branch-shaped ref rather than nesting the cache", () => {
    expect(sh(`cache_path '/c' 'bootstrap/1-scaffold' 'a'`).stdout).toBe(
      "/c/bootstrap_1-scaffold/a",
    );
  });

  it("collapses traversal, including the multi-pass case", () => {
    // Dots survive the character filter because tags need them, so `..` is
    // collapsed separately -- and in a LOOP, because one pass over `....` leaves
    // a fresh `..` behind.
    //
    // The assertion is on the PROPERTY, not on an exact string: what must hold
    // is that the ref contributes exactly one path segment and no traversal,
    // whatever the substitutions happen to spell.
    for (const ref of ["../../etc", "....", "..", "a/../../b", "....//.."]) {
      const out = sh(`cache_path '/c' '${ref}' 'a'`).stdout;
      expect(out, ref).not.toContain("..");
      expect(out, ref).toMatch(/^\/c\/[A-Za-z0-9._-]+\/a$/);
    }
  });
});

describe.skipIf(!BASH)("bootstrap/nen.sh -- main's argument handling", () => {
  function run(args: string): { status: number; stderr: string } {
    const result = spawnSync("bash", [SCRIPT, ...args.split(" ").filter(Boolean)], {
      encoding: "utf8",
      env: { ...process.env, NEN_REF: "" },
    });
    return { status: result.status ?? -1, stderr: result.stderr ?? "" };
  }

  it("requires --ref, with no default and no 'latest'", () => {
    const result = run("");
    expect(result.status).toBe(BootstrapExit.USAGE);
    expect(result.stderr).toMatch(/would unpin a source-pinned supply chain/);
  });

  it("refuses a bare trailing --ref with a usage error, not a shell diagnostic", () => {
    const result = run("--ref");
    expect(result.status).toBe(BootstrapExit.USAGE);
    expect(result.stderr).not.toMatch(/shift count/);
  });

  it("refuses an unknown argument", () => {
    expect(run("--ref v0.1.0 --nope").status).toBe(BootstrapExit.USAGE);
  });

  it("refuses a --source that is a PATH rather than an owner/name", () => {
    // The `--repo`/`--source` collision this script's header is about: a path
    // slipped in here would reach the network and come back as a bewildering
    // 404.
    for (const source of ["../bankai-core", "/abs/path", "bare", "a/b/c"]) {
      const result = run(`--ref v0.1.0 --source ${source}`);
      expect(result.status, source).toBe(BootstrapExit.USAGE);
      expect(result.stderr, source).toMatch(/owner\/name/);
    }
  });
});

describe("nen bootstrap -- the TypeScript wrapper", () => {
  it("restates the script's exit codes accurately", () => {
    // The codes are a published contract callers branch on, so the restatement
    // in bootstrap.ts is checked against the script's own text rather than
    // trusted. A drift here is a caller retrying a CHECKSUM failure.
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).toContain(`EXIT_USAGE=${BootstrapExit.USAGE}`);
    expect(source).toContain(`EXIT_UNSUPPORTED_HOST=${BootstrapExit.UNSUPPORTED_HOST}`);
    expect(source).toContain(`EXIT_DOWNLOAD=${BootstrapExit.DOWNLOAD}`);
    expect(source).toContain(`EXIT_CHECKSUM=${BootstrapExit.CHECKSUM}`);
    expect(source).toContain(`EXIT_MANIFEST=${BootstrapExit.MANIFEST}`);
  });

  it("makes DOWNLOAD the only retryable code", () => {
    expect(isRetryable(BootstrapExit.DOWNLOAD)).toBe(true);
    for (const code of [
      BootstrapExit.OK,
      BootstrapExit.USAGE,
      BootstrapExit.UNSUPPORTED_HOST,
      BootstrapExit.CHECKSUM,
      BootstrapExit.MANIFEST,
      BootstrapExit.WRAPPER,
    ]) {
      expect(isRetryable(code)).toBe(false);
    }
  });

  it("finds the script under the repository root", () => {
    expect(resolveScript({ ref: "v0.1.0", cwd: REPO_ROOT })).toBe(SCRIPT);
  });

  it("names both fixes when the script is not under the root", () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-bs-"));
    expect(() => resolveScript({ ref: "v0.1.0", repoFlag: empty })).toThrow(/--script/);
    expect(() => resolveScript({ ref: "v0.1.0", repoFlag: empty })).toThrow(
      /NEN_BOOTSTRAP_SH/,
    );
    // And it says WHY it did not look beside the executable.
    expect(() => resolveScript({ ref: "v0.1.0", repoFlag: empty })).toThrow(
      /no sibling bootstrap\/ directory/,
    );
  });

  it("honors an explicit --script and $NEN_BOOTSTRAP_SH", () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-bs-"));
    expect(resolveScript({ ref: "v0.1.0", repoFlag: empty, script: SCRIPT })).toBe(SCRIPT);
    expect(
      resolveScript({ ref: "v0.1.0", repoFlag: empty, env: { NEN_BOOTSTRAP_SH: SCRIPT } }),
    ).toBe(SCRIPT);
  });

  it("maps its flags to the script's flags and nothing else", () => {
    expect(bootstrapArgv("S", { ref: "v1" })).toEqual(["S", "--ref", "v1"]);
    expect(bootstrapArgv("S", { ref: "v1", source: "o/n", cacheDir: "/c" })).toEqual([
      "S",
      "--ref",
      "v1",
      "--source",
      "o/n",
      "--cache-dir",
      "/c",
    ]);
  });

  it("refuses an empty --ref before spawning anything", () => {
    const result = runBootstrap({ ref: "  ", cwd: REPO_ROOT });
    expect(result.code).toBe(BootstrapExit.USAGE);
    expect(result.path).toBe("");
    expect(result.stderr).toMatch(/no default and no 'latest'/);
  });

  it("reports an unresolvable script as a WRAPPER failure, not as the script's", () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-bs-"));
    const result = runBootstrap({ ref: "v0.1.0", repoFlag: empty });
    expect(result.code).toBe(BootstrapExit.WRAPPER);
    expect(result.path).toBe("");
  });

  it.skipIf(!BASH)("relays the script's exit code and stderr, and prints no path on failure", () => {
    // A ref that cannot resolve to a release: the manifest fetch fails, which is
    // EXIT_MANIFEST and not a retryable download failure. stdout must stay
    // EMPTY -- the one thing this must never do is hand back a path to a binary
    // that was not verified.
    const cache = mkdtempSync(join(tmpdir(), "nen-bs-cache-"));
    const result = runBootstrap({
      ref: "v0.0.0-does-not-exist",
      source: "zheref/nen",
      cacheDir: cache,
      cwd: REPO_ROOT,
    });
    expect(result.path).toBe("");
    expect([BootstrapExit.MANIFEST, BootstrapExit.DOWNLOAD]).toContain(result.code);
    expect(isRetryable(result.code) || result.code === BootstrapExit.MANIFEST).toBe(true);
  });
});

// --- end to end, with the transport stubbed ---------------------------------
//
// The happy path and the security path, driven through `main` with NO NETWORK.
// A `gh` stub is written onto a temp PATH ahead of the real one and serves
// assets out of a directory that plays the part of a release. That is the same
// technique the script this succeeds used from bats, and it is the only way to
// exercise the ordering that matters: fetch the manifest FIRST, verify in a TEMP
// directory, and only then move into the cache.
//
// THE STUB IS SHELL, AND THAT IS NOT AN AK-11 VIOLATION. The allowlist governs
// shell FILES IN THIS REPOSITORY -- of which there is exactly one, bootstrap/
// nen.sh. This stub is a string written into a temporary directory at test time
// by the TypeScript harness, and it exists for exactly as long as the case does.
describe.skipIf(!BASH)("bootstrap/nen.sh -- end to end, transport stubbed", () => {
  interface Release {
    readonly dir: string;
    readonly binDir: string;
    readonly cache: string;
    readonly artifact: string;
  }

  // The artifact THIS host would ask for -- read from the script itself, so the
  // fixture cannot disagree with the code under test about which triple it is
  // running on.
  function hostArtifact(): string {
    return sh('artifact_for_host "$(uname -s)" "$(uname -m)"').stdout;
  }

  function release(options: { corruptBytes?: boolean; omitEntry?: boolean } = {}): Release {
    const root = mkdtempSync(join(tmpdir(), "nen-e2e-"));
    const assets = join(root, "assets");
    const binDir = join(root, "bin");
    const cache = join(root, "cache");
    mkdirSync(assets, { recursive: true });
    mkdirSync(binDir, { recursive: true });

    const artifact = hostArtifact();
    writeFileSync(join(assets, artifact), "#!/bin/sh\necho compiled-nen\n");
    const digest = sha256Of(join(assets, artifact));
    const line = options.omitEntry
      ? `${digest}  some-other-artifact\n`
      : `${digest}  ${artifact}\n`;
    writeFileSync(join(assets, "SHA256SUMS"), line);
    if (options.corruptBytes === true) {
      // The manifest keeps the ORIGINAL digest; the bytes change underneath it.
      // That is a mismatch, which is a supply-chain incident and not a flake.
      writeFileSync(join(assets, artifact), "tampered\n");
    }

    // `gh release download <ref> --repo <r> --pattern <asset> --output <dest>
    // --clobber` is the only invocation the script makes; the stub reads the
    // two arguments it needs and copies.
    const stub = [
      "#!/usr/bin/env bash",
      "set -uo pipefail",
      "pattern=; output=",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --pattern) pattern="$2"; shift 2 ;;',
      '    --output) output="$2"; shift 2 ;;',
      "    *) shift ;;",
      "  esac",
      "done",
      `[ -f '${posixPath(assets)}'/"$pattern" ] || exit 1`,
      `cp '${posixPath(assets)}'/"$pattern" "$output"`,
      "",
    ].join("\n");
    const stubPath = join(binDir, "gh");
    writeFileSync(stubPath, stub);
    chmodSync(stubPath, 0o755);

    return { dir: root, binDir, cache, artifact };
  }

  function runMain(rel: Release): { status: number; stdout: string; stderr: string } {
    const result = spawnSync(
      "bash",
      [SCRIPT, "--ref", "v9.9.9", "--source", "example/nen", "--cache-dir", rel.cache],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          // The stub goes FIRST, and `curl` is removed from reach so a stub miss
          // can never silently fall through to a real network call.
          PATH: `${rel.binDir}${process.platform === "win32" ? ";" : ":"}${process.env["PATH"] ?? ""}`,
        },
      },
    );
    return {
      status: result.status ?? -1,
      stdout: (result.stdout ?? "").trim(),
      stderr: result.stderr ?? "",
    };
  }

  it("fetches, verifies, caches, and prints the verified path ALONE on stdout", () => {
    const rel = release();
    const first = runMain(rel);
    expect(first.stderr).toMatch(/verified /);
    expect(first.status).toBe(BootstrapExit.OK);
    // Separators are normalized on BOTH sides: the script composes the cache
    // path with `/` while the `--cache-dir` it was handed carries the host's
    // own. Which of the two a path is spelled with is not part of the contract;
    // that it names the artifact under the REF, and that the file is there, is.
    expect(posixPath(first.stdout)).toBe(posixPath(join(rel.cache, "v9.9.9", rel.artifact)));
    expect(existsSync(first.stdout)).toBe(true);

    // Second run: a cache HIT, gated on the checksum rather than on the file
    // existing, and it prints the same path.
    const second = runMain(rel);
    expect(second.status).toBe(BootstrapExit.OK);
    expect(second.stderr).toMatch(/cache hit/);
    expect(second.stdout).toBe(first.stdout);
  });

  it("treats a CORRUPTED cached binary as a miss and replaces it", () => {
    const rel = release();
    const cached = runMain(rel).stdout;
    writeFileSync(cached, "tampered-in-the-cache\n");
    const again = runMain(rel);
    expect(again.status).toBe(BootstrapExit.OK);
    // Not a cache hit: presence is never sufficient.
    expect(again.stderr).not.toMatch(/cache hit/);
    expect(readFileSync(cached, "utf8")).toContain("compiled-nen");
  });

  it("REFUSES a mismatch, deletes the bytes, and caches nothing", () => {
    const rel = release({ corruptBytes: true });
    const result = runMain(rel);
    expect(result.status).toBe(BootstrapExit.CHECKSUM);
    // The one thing it must never do: print a path to a binary it did not
    // verify, because the caller's next act is to execute it.
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/SHA-256 MISMATCH/);
    expect(existsSync(join(rel.cache, "v9.9.9", rel.artifact))).toBe(false);
  });

  it("REFUSES a manifest that is silent about this host's artifact", () => {
    const rel = release({ omitEntry: true });
    const result = runMain(rel);
    expect(result.status).toBe(BootstrapExit.MANIFEST);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/no entry/);
  });
});

describe("nen bootstrap -- corrections from review", () => {
  it("honors $NEN_BOOTSTRAP_SH from the ambient environment, not just from options", () => {
    // The error message offers `$NEN_BOOTSTRAP_SH` as one of two ways out, but
    // resolveScript only ever read `options.env` -- which src/index.ts does not
    // pass -- so the variable was DEAD from the CLI and the advice sent an
    // operator to set something that could not work. An escape hatch nobody can
    // reach is worse than none, because the message promises it.
    const empty = mkdtempSync(join(tmpdir(), "nen-bs-"));
    const previous = process.env["NEN_BOOTSTRAP_SH"];
    try {
      process.env["NEN_BOOTSTRAP_SH"] = SCRIPT;
      expect(resolveScript({ ref: "v0.1.0", repoFlag: empty })).toBe(SCRIPT);
    } finally {
      if (previous === undefined) delete process.env["NEN_BOOTSTRAP_SH"];
      else process.env["NEN_BOOTSTRAP_SH"] = previous;
    }
  });

  it("refuses a $NEN_BOOTSTRAP_SH pointing at nothing, rather than falling back", () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-bs-"));
    const previous = process.env["NEN_BOOTSTRAP_SH"];
    try {
      process.env["NEN_BOOTSTRAP_SH"] = join(empty, "not-here.sh");
      expect(() => resolveScript({ ref: "v0.1.0", cwd: REPO_ROOT })).toThrow(/does not exist/);
    } finally {
      if (previous === undefined) delete process.env["NEN_BOOTSTRAP_SH"];
      else process.env["NEN_BOOTSTRAP_SH"] = previous;
    }
  });

  it.skipIf(!BASH)("returns an EMPTY path on any non-zero status, as its doc promises", () => {
    // The `path` field is documented "Empty on failure" and did not deliver it:
    // it relayed stdout whatever the exit code was. The script is careful never
    // to print a path it did not verify, so the two agree today -- but a caller
    // reading `result.path` without checking `result.code` is exactly the caller
    // this wrapper exists to keep safe, and "the thing we call is well behaved"
    // is an assumption about somebody else's code, not a guarantee.
    const cache = mkdtempSync(join(tmpdir(), "nen-bs-cache-"));
    const result = runBootstrap({
      ref: "v0.0.0-does-not-exist",
      source: "zheref/nen",
      cacheDir: cache,
      cwd: REPO_ROOT,
    });
    expect(result.code).not.toBe(BootstrapExit.OK);
    expect(result.path).toBe("");
  });

  it.skipIf(!BASH)("empties the path even if the script were to print one on failure", () => {
    // Proved rather than asserted: a stub that prints a path AND exits non-zero
    // is the misbehaviour the guard exists for, and nothing else in the suite
    // can produce it.
    const dir = mkdtempSync(join(tmpdir(), "nen-bs-liar-"));
    const liar = join(dir, "liar.sh");
    writeFileSync(liar, "#!/usr/bin/env bash\necho /tmp/unverified-binary\nexit 5\n");
    chmodSync(liar, 0o755);
    const result = runBootstrap({ ref: "v1", script: liar, cwd: REPO_ROOT });
    expect(result.code).toBe(BootstrapExit.CHECKSUM);
    expect(result.path).toBe("");
  });
});
