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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
    expect(result.out).toMatch(/mirror: now STALE -- regenerate it in the same commit: nen canon mirror generate --repo /);
    expect(result.err).toMatch(/nen: note: the canon mirror now names v1\.2\.0, not v1\.3\.0: it is STALE\. Regenerate it and commit it WITH this pin: nen canon mirror generate/);
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
