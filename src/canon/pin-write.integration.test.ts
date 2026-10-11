// src/canon/pin-write.integration.test.ts -- zheref/nen#291's acceptance
// against a REAL git: `nen canon pin --write <tag>` moves the pin in the row
// the read path answers from, changing one value and no other byte, and only
// to a tag the canon checkout is seen to carry.
//
// The fixture shape is ./checkout.integration.test.ts's: repo-local identity,
// no network (origin is a URL that is never contacted), and a SKIP where git
// is missing. The canon checkout sits on the OLD tag throughout: a pin is
// moved before the checkout is, and HEAD is not this verb's to verify.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { defaultSeams, type Seams } from "../seam/exec.js";
import { checkTaxonomy } from "../schema/taxonomy.js";
import { canonCommand, PIN_WRITE_CONTRACT } from "./command.js";

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-c", "user.name=nen test", "-c", "user.email=nen@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} exited ${result.status ?? "?"}: ${result.stderr}`);
  return (result.stdout ?? "").trim();
}

const HAVE_GIT = spawnSync("git", ["--version"]).status === 0;
const ORIGIN = "https://github.com/owner/handbooks.git";

// Hand-kept on purpose: two-space and four-space indents, a $comment, a compact
// row, an earlier row for the same tool in another case (which the LAST row
// shadows), a consumer pinned to the same tag, keys in no canonical order.
const REGISTRY = `{
  "$comment": "the consumer's own registry; hand-kept",
  "consumers": [ { "repo": "owner/consumer", "consumes": [], "pinned": "v1.2.0" } ],
  "maintained_tools": [
    {"repo":"Owner/Handbooks","role":"an earlier row","pinned":"v0.9.0"},
    { "repo": "owner/tool", "role": "a tool" },
    {
        "role": "the canon",
        "pinned": "v1.2.0",
        "repo": "owner/handbooks",
        "checkout_env": "NEN_TEST_CANON"
    }
  ],
  "product_codes": {}
}
`;

let base = "";
let canon = "";
let tagCommit = "";

beforeAll(() => {
  if (!HAVE_GIT) return;
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "nen-canon-pin-write-it-")));
  canon = join(base, "handbooks");
  mkdirSync(join(canon, "handbooks"), { recursive: true });
  writeFileSync(join(canon, "handbooks", "a.md"), "one\n");
  git(canon, ["init", "--quiet"]);
  git(canon, ["add", "-A"]);
  git(canon, ["commit", "--quiet", "-m", "one"]);
  git(canon, ["tag", "v1.2.0"]);
  writeFileSync(join(canon, "handbooks", "a.md"), "two\n");
  git(canon, ["commit", "--quiet", "-am", "two"]);
  git(canon, ["tag", "-a", "v1.3.0", "-m", "an annotated tag"]);
  tagCommit = git(canon, ["rev-parse", "v1.3.0^{commit}"]);
  git(canon, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "v1.2.0"]);
  git(canon, ["remote", "add", "origin", ORIGIN]);
});

afterAll(() => {
  if (base !== "") rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});

/** A fresh consumer with the hand-kept registry, so each case starts from the same bytes. */
function consumer(text = REGISTRY): string {
  const root = mkdtempSync(join(base, "consumer-"));
  mkdirSync(join(root, "nen"));
  writeFileSync(join(root, "nen", "repos.json"), text);
  writeFileSync(join(root, "nen", "labels.json"), JSON.stringify({ labels: [] }));
  git(root, ["init", "--quiet"]);
  git(root, ["remote", "add", "origin", "git@github.com:owner/consumer.git"]);
  return root;
}

const SEAMS = (): Seams => ({ ...defaultSeams(), env: { NEN_TEST_CANON: canon } });

async function run(root: string, argv: readonly string[], json = false, seams: Seams = SEAMS()): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(canonCommand, argv, root, json, io, seams);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const registryOf = (root: string): string => readFileSync(join(root, "nen", "repos.json"), "utf8");

describe.skipIf(!HAVE_GIT)("canon pin --write -- the pin moves without an editor (zheref/nen#291)", () => {
  it("moves the pin in the LAST row: the diff is exactly that one value, every other byte preserved", async () => {
    const root = consumer();
    const result = await run(root, ["canon", "pin", "--write", "v1.3.0"]);
    expect(result.code, result.err).toBe(0);
    const after = registryOf(root);
    expect(after).toBe(REGISTRY.replace('"pinned": "v1.2.0",\n        "repo"', '"pinned": "v1.3.0",\n        "repo"'));
    // The diff, line by line: one line, one value.
    const was = REGISTRY.split("\n");
    const now = after.split("\n");
    const changed = was.map((line, index): [string, string | undefined] => [line, now[index]]).filter(([a, b]): boolean => a !== b);
    expect(changed).toEqual([['        "pinned": "v1.2.0",', '        "pinned": "v1.3.0",']]);
    expect(result.out).toContain("pin: v1.2.0 -> v1.3.0");
    expect(result.out).toContain(`tag: v1.3.0 is ${tagCommit.slice(0, 12)} in ${canon} (resolved from env $NEN_TEST_CANON (nen/repos.json maintained_tools[2].checkout_env))`);
    expect(result.out).toContain("recorded in: " + join(root, "nen", "repos.json") + " (maintained_tools[2].pinned, line 9)");
    expect(result.out).toContain("read back: owner/handbooks pinned to v1.3.0");
    // The stale mirror is said out loud, naming the regenerate.
    expect(result.out).toContain(`mirror: now STALE -- regenerate it in the same commit (POSIX shell): nen canon mirror generate --repo '${root}' --canon-values <path>`);
    expect(result.err).toMatch(/nen: note: the canon mirror now names v1\.2\.0, not v1\.3\.0: it is STALE\. Regenerate it and commit it WITH this pin \(POSIX shell\): nen canon mirror generate/);
    // The read path now answers with the new pin.
    const read = await run(root, ["canon", "pin"]);
    expect(read.out).toContain("ref: v1.3.0");
    // No temporary file was left beside it.
    expect(readdirSync(join(root, "nen")).sort()).toEqual(["labels.json", "repos.json"]);
  });

  it("nen schema check reads the result unchanged: the repos.json row passes, and only its pin moved", async () => {
    const root = consumer();
    const before = checkTaxonomy({ repoFlag: root }).checks.find((check): boolean => check.file === "nen/repos.json");
    expect(before?.ok).toBe(true);
    expect((await run(root, ["canon", "pin", "--write", "v1.3.0"])).code).toBe(0);
    const after = checkTaxonomy({ repoFlag: root }).checks.find((check): boolean => check.file === "nen/repos.json");
    expect(after?.ok, after?.detail).toBe(true);
    expect(after?.detail).toBe(before?.detail.replace("owner/handbooks@v1.2.0", "owner/handbooks@v1.3.0"));
    expect(after?.detail).toContain("owner/handbooks@v1.3.0");
  });

  it("--dry-run prints before -> after and writes nothing", async () => {
    const root = consumer();
    const result = await run(root, ["canon", "pin", "--write", "v1.3.0", "--dry-run"]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("pin: v1.2.0 -> v1.3.0");
    expect(result.out).toContain("written: nothing (--dry-run)");
    expect(result.out).toMatch(/mirror: would be STALE/);
    expect(result.err).toBe("");
    expect(registryOf(root)).toBe(REGISTRY);
  });

  it("carries a versioned --json document", async () => {
    const root = consumer();
    const result = await run(root, ["canon", "pin", "--write", "v1.3.0", "--source", "OWNER/handbooks", "--dry-run"], true);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      contract: PIN_WRITE_CONTRACT,
      source: "owner/handbooks",
      before: "v1.2.0",
      after: "v1.3.0",
      changed: true,
      dryRun: true,
      written: false,
      ok: true,
      recordedIn: "nen/repos.json (maintained_tools[2].pinned)",
      row: 2,
      line: 9,
      tag: { commit: tagCommit, checkout: canon, resolvedFrom: { kind: "env", status: "used" } },
      mirror: { stale: true },
    });
  });

  it("refuses a tag that does not resolve as refs/tags/<tag> on the canon, naming it, and writes nothing", async () => {
    const root = consumer();
    const result = await run(root, ["canon", "pin", "--write", "v1.4.0"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/refusing to pin owner\/handbooks to v1\.4\.0: tag-missing: '.*' has no tag v1\.4\.0\..*refs\/tags\/v1\.4\.0.*nothing was written/s);
    // Nobunaga N7: at tag depth the advice is the fetch, never a checkout.
    expect(result.err).toContain("fetch --tags origin); nen fetches nothing.");
    expect(result.err).not.toMatch(/check v1\.4\.0 out/);
    expect(registryOf(root)).toBe(REGISTRY);
  });

  it("emits a failure document under --json on an exit-1 refusal, as canon checkout does (Nobunaga N5)", async () => {
    const root = consumer();
    const result = await run(root, ["canon", "pin", "--write", "v1.4.0"], true);
    expect(result.code).toBe(1);
    const doc = JSON.parse(result.out) as Record<string, unknown>;
    expect(doc).toEqual({
      contract: PIN_WRITE_CONTRACT,
      ok: false,
      failure: { code: "tag-missing", message: expect.stringMatching(/^refusing to pin owner\/handbooks to v1\.4\.0: tag-missing: /) as unknown },
    });
  });

  it("reports target on every run, and writtenTo only when a write happened (Nobunaga N9)", async () => {
    const root = consumer();
    const real = realpathSync.native(join(root, "nen", "repos.json"));
    const dry = JSON.parse((await run(root, ["canon", "pin", "--write", "v1.3.0", "--dry-run"], true)).out) as Record<string, unknown>;
    expect(dry).toMatchObject({ written: false, target: real, writtenTo: null });
    const wet = JSON.parse((await run(root, ["canon", "pin", "--write", "v1.3.0"], true)).out) as Record<string, unknown>;
    expect(wet).toMatchObject({ written: true, target: real, writtenTo: real });
    const same = JSON.parse((await run(root, ["canon", "pin", "--write", "v1.3.0"], true)).out) as Record<string, unknown>;
    expect(same).toMatchObject({ changed: false, written: false, target: real, writtenTo: null });
  });

  it.skipIf(process.platform === "win32")("names no link when the consumer ROOT is the link and nen/repos.json is not (Nobunaga N10)", async () => {
    const root = consumer();
    const alias = join(mkdtempSync(join(base, "alias-")), "consumer");
    symlinkSync(root, alias);
    const result = await run(alias, ["canon", "pin", "--write", "v1.3.0"]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(`written: ${realpathSync.native(join(root, "nen", "repos.json"))}, read back`);
    expect(result.out).not.toContain("through the link");
  });

  it("names no link for a case-variant --repo on a case-insensitive filesystem (Nobunaga N10)", async (ctx) => {
    const root = consumer();
    const variant = root.replace(/consumer-/, "CONSUMER-");
    // Only a case-insensitive filesystem reaches the same directory by another case.
    if (!existsSync(join(variant, "nen", "repos.json"))) ctx.skip();
    const result = await run(variant, ["canon", "pin", "--write", "v1.3.0"]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).not.toContain("through the link");
    expect(registryOf(root)).toContain('"pinned": "v1.3.0",');
  });

  it("quotes the root in the regenerate command and carries it as argv in --json (Nobunaga N4)", async () => {
    const spaced = mkdtempSync(join(base, "it's a consumer "));
    const root = join(spaced, "repo");
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "repos.json"), REGISTRY);
    git(root, ["init", "--quiet"]);
    git(root, ["remote", "add", "origin", "git@github.com:owner/consumer.git"]);
    const text = await run(root, ["canon", "pin", "--write", "v1.3.0", "--dry-run"]);
    expect(text.code, text.err).toBe(0);
    expect(text.out).toContain(`--repo '${root.replace(/'/g, "'\\''")}' --canon-values`);
    const doc = JSON.parse((await run(root, ["canon", "pin", "--write", "v1.3.0", "--dry-run"], true)).out) as { mirror: { regenerateArgv: string[] } };
    expect(doc.mirror.regenerateArgv.slice(0, 6)).toEqual(["nen", "canon", "mirror", "generate", "--repo", root]);
  });

  it.skipIf(process.platform === "win32")("refuses a nen/repos.json that links OUT of the repository, naming both paths, and leaves both files alone (Nobunaga N2)", async () => {
    const root = consumer();
    const outside = join(mkdtempSync(join(base, "elsewhere-")), "repos.json");
    writeFileSync(outside, REGISTRY);
    rmSync(join(root, "nen", "repos.json"));
    symlinkSync(outside, join(root, "nen", "repos.json"));
    const result = await run(root, ["canon", "pin", "--write", "v1.3.0"], true);
    expect(result.code).toBe(1);
    const realOutside = realpathSync.native(outside);
    expect(result.err).toContain(`${join(root, "nen", "repos.json")} resolves to ${realOutside}, which is outside the consumer`);
    expect((JSON.parse(result.out) as { failure: { code: string } }).failure.code).toBe("registry-outside-repo");
    expect(readFileSync(outside, "utf8")).toBe(REGISTRY);
    expect(lstatSync(join(root, "nen", "repos.json")).isSymbolicLink()).toBe(true);
  });

  it.skipIf(process.platform === "win32")("writes through a link that stays inside the repository, naming the real file written", async () => {
    const root = consumer();
    mkdirSync(join(root, "registry"));
    const real = join(root, "registry", "repos.json");
    writeFileSync(real, REGISTRY);
    rmSync(join(root, "nen", "repos.json"));
    symlinkSync(real, join(root, "nen", "repos.json"));
    const result = await run(root, ["canon", "pin", "--write", "v1.3.0"]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(`written: ${realpathSync.native(real)} (through the link ${join(root, "nen", "repos.json")}), read back`);
    expect(lstatSync(join(root, "nen", "repos.json")).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf8")).toContain('"pinned": "v1.3.0",\n        "repo": "owner/handbooks"');
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("names a failed replace at exit 1: the pin was not moved, and no temporary file is left (Nobunaga N6)", async () => {
    const root = consumer();
    chmodSync(join(root, "nen"), 0o555);
    try {
      const result = await run(root, ["canon", "pin", "--write", "v1.3.0"]);
      expect(result.code).toBe(1);
      expect(result.err).toContain(`the pin was not moved; ${realpathSync.native(join(root, "nen", "repos.json"))} could not be replaced: EACCES.`);
      expect(readdirSync(join(root, "nen")).sort()).toEqual(["labels.json", "repos.json"]);
    } finally {
      chmodSync(join(root, "nen"), 0o755);
    }
    expect(registryOf(root)).toBe(REGISTRY);
  });

  it("refuses a branch name that happens to be tag-shaped: only refs/tags counts", async () => {
    git(canon, ["branch", "v1.5.0", "v1.3.0"]);
    const root = consumer();
    const result = await run(root, ["canon", "pin", "--write", "v1.5.0"]);
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/tag-missing/);
    expect(registryOf(root)).toBe(REGISTRY);
  });

  it("refuses a checkout of another source, and one on another host -- the identity checks 'canon checkout' makes", async () => {
    const root = consumer();
    const wrong = await run(root, ["canon", "pin", "--write", "v1.3.0", "--canon-checkout", root]);
    expect(wrong.code).toBe(1);
    expect(wrong.err).toMatch(/refusing to pin owner\/handbooks to v1\.3\.0: wrong-source/);
    git(root, ["remote", "set-url", "origin", "https://gitlab.example/owner/consumer.git"]);
    const host = await run(root, ["canon", "pin", "--write", "v1.3.0"]);
    expect(host.code).toBe(1);
    expect(host.err).toMatch(/wrong-host/);
    expect(registryOf(root)).toBe(REGISTRY);
  });

  // Feitan F1: a git on PATH that swaps nen/ for a link out of the repository
  // while the tag is being resolved. The containment check and the read now
  // come AFTER every git call, so the swapped-in file is refused, never written.
  it.skipIf(process.platform === "win32")("refuses a nen/ swapped for an outside link during the tag rev-parse, leaving the outside file unchanged", async () => {
    const root = consumer();
    const outsideDir = mkdtempSync(join(base, "outside-"));
    writeFileSync(join(outsideDir, "repos.json"), REGISTRY);
    writeFileSync(join(outsideDir, "labels.json"), "{}");
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const shim = mkdtempSync(join(base, "shim-"));
    const script = [
      "#!/bin/sh",
      'case "$*" in',
      `  *"refs/tags/v1.3.0^{commit}"*) if [ ! -L '${root}/nen' ]; then mv '${root}/nen' '${root}/nen.moved' && ln -s '${outsideDir}' '${root}/nen'; fi ;;`,
      "esac",
      `exec '${realGit}' "$@"`,
      "",
    ].join("\n");
    writeFileSync(join(shim, "git"), script, { mode: 0o755 });
    const previous = process.env["PATH"];
    process.env["PATH"] = `${shim}:${previous ?? ""}`;
    let result;
    try {
      result = await run(root, ["canon", "pin", "--write", "v1.3.0"], true);
    } finally {
      process.env["PATH"] = previous;
    }
    // The shim really ran: nen/ is the outside link now.
    expect(lstatSync(join(root, "nen")).isSymbolicLink()).toBe(true);
    expect(result.code, result.err).toBe(1);
    expect((JSON.parse(result.out) as { failure: { code: string } }).failure.code).toBe("registry-outside-repo");
    expect(readFileSync(join(outsideDir, "repos.json"), "utf8")).toBe(REGISTRY);
    expect(readdirSync(outsideDir).sort()).toEqual(["labels.json", "repos.json"]);
  });

  it.skipIf(process.platform === "win32")("refuses when the picked row changes while the tag is resolved (registry-changed)", async () => {
    const root = consumer();
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const shim = mkdtempSync(join(base, "shim-edit-"));
    const edited = REGISTRY.replace('"pinned": "v1.2.0",\n        "repo"', '"pinned": "v1.2.1",\n        "repo"');
    writeFileSync(join(base, "edited.json"), edited);
    writeFileSync(join(shim, "git"), ["#!/bin/sh", 'case "$*" in', `  *"refs/tags/v1.3.0^{commit}"*) cp '${join(base, "edited.json")}' '${join(root, "nen", "repos.json")}' ;;`, "esac", `exec '${realGit}' "$@"`, ""].join("\n"), { mode: 0o755 });
    const previous = process.env["PATH"];
    process.env["PATH"] = `${shim}:${previous ?? ""}`;
    let result;
    try {
      result = await run(root, ["canon", "pin", "--write", "v1.3.0"]);
    } finally {
      process.env["PATH"] = previous;
    }
    expect(result.code).toBe(1);
    expect(result.err).toMatch(/changed while the tag was being resolved/);
    expect(registryOf(root)).toBe(edited);
  });

  it("refuses a symbolic ref under refs/tags/ that names a branch (Feitan F2)", async () => {
    git(canon, ["symbolic-ref", "refs/tags/v8.0.0", "refs/heads/" + git(canon, ["for-each-ref", "--format=%(refname:short)", "refs/heads/", "--count=1"])]);
    try {
      const root = consumer();
      const result = await run(root, ["canon", "pin", "--write", "v8.0.0"]);
      expect(result.code).toBe(1);
      expect(result.err).toMatch(/tag-missing: .*refs\/tags\/v8\.0\.0 is a symbolic ref to refs\/heads\//);
      expect(registryOf(root)).toBe(REGISTRY);
    } finally {
      git(canon, ["update-ref", "--no-deref", "-d", "refs/tags/v8.0.0"]);
    }
  });

  it("refuses to move a recorded pin that is not tag-shaped, as the read form refuses it", async () => {
    const text = REGISTRY.replace('"pinned": "v1.2.0",\n        "repo"', '"pinned": "main",\n        "repo"');
    const root = consumer(text);
    const result = await run(root, ["canon", "pin", "--write", "v1.3.0"], true);
    expect(result.code).toBe(1);
    expect((JSON.parse(result.out) as { failure: { code: string } }).failure.code).toBe("pin-not-tag-shaped");
    expect(registryOf(root)).toBe(text);
  });

  it("refuses a duplicated pinned on the edited row as not-one-value-edit (Feitan F3)", async () => {
    const text = REGISTRY.replace('"role": "the canon",', '"role": "the canon",\n        "pinned": "v1.2.0",');
    const root = consumer(text);
    const result = await run(root, ["canon", "pin", "--write", "v1.3.0"], true);
    expect(result.code).toBe(1);
    expect((JSON.parse(result.out) as { failure: { code: string } }).failure.code).toBe("not-one-value-edit");
    expect(registryOf(root)).toBe(text);
  });

  it("writes nothing and exits 0 when the tag is the pin already", async () => {
    const root = consumer();
    const result = await run(root, ["canon", "pin", "--write", "v1.2.0"]);
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("pin: v1.2.0 -> v1.2.0 (unchanged)");
    expect(result.out).toContain("written: nothing (the pin is already that tag)");
    expect(result.out).not.toMatch(/STALE/);
    expect(registryOf(root)).toBe(REGISTRY);
  });

  it("does not need the checkout to sit on the tag, or to be clean: that is the regenerate's to verify", async () => {
    writeFileSync(join(canon, "untracked.md"), "scratch\n");
    try {
      const root = consumer();
      const result = await run(root, ["canon", "pin", "--write", "v1.3.0", "--dry-run"]);
      expect(result.code, result.err).toBe(0);
    } finally {
      rmSync(join(canon, "untracked.md"));
    }
  });
});
