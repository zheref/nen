// src/canon/checkout.integration.test.ts -- zheref/nen#294's acceptance,
// against a REAL git: a mirror check written as one literal argv runs
// unchanged on two "machines" whose canon checkouts live in different places.
//
// A MACHINE HERE IS AN ENVIRONMENT. What differs between two hosts, for this
// verb, is exactly what `Seams.env` carries: one exports the variable the
// registry names, the other has only a HOME whose cache slot holds a clone.
// The registry, the argv and the consumer tree are byte-identical between the
// two runs -- that identity is the claim under test.
//
// The fixture shape is ../commit/readback.integration.test.ts's: repo-local
// identity, no network (origin is a URL that is never contacted), and a SKIP
// where git is missing.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { defaultSeams, type Seams } from "../seam/exec.js";
import { CHECKOUT_CONTRACT } from "./checkout.js";
import { canonCommand } from "./command.js";

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
const REGISTRY = {
  consumers: [],
  maintained_tools: [
    { repo: "owner/tool", role: "a tool" },
    {
      repo: "owner/handbooks",
      role: "the canon",
      pinned: "v1.2.0",
      checkout_env: "NEN_TEST_CANON",
      checkout: "${XDG_CACHE_HOME:-${HOME}/.cache}/canon/owner/handbooks",
    },
  ],
  product_codes: {},
};

/** THE argv -- one literal list, used verbatim on both machines. */
const MIRROR = (sub: "generate" | "check"): string[] => [
  "canon", "mirror", sub,
  "--canon-values", ".claude/canon-values.yml",
  "--stack-dir", "handbooks/stacks",
  "--leaf", "rules",
  "--not-mirrored", "README.md,placeholders.md",
];

let base = "";
let consumer = "";
let canonA = "";
let homeB = "";
let canonB = "";

beforeAll(() => {
  if (!HAVE_GIT) return;
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "nen-canon-checkout-it-")));
  // Machine A keeps its canon wherever it likes, and says so in the variable.
  canonA = join(base, "machine-a", "src", "handbooks");
  const rules = join(canonA, "handbooks", "stacks", "scenario-x", "rules");
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, "01-a.md"), "# A\n\nHello {{NAME}}.\n");
  writeFileSync(join(rules, "02-b.md"), "# B\n\nSecond.\n");
  writeFileSync(join(rules, "README.md"), "the index\n");
  writeFileSync(join(rules, "placeholders.md"), "the registry\n");
  git(canonA, ["init", "--quiet"]);
  git(canonA, ["add", "-A"]);
  git(canonA, ["commit", "--quiet", "-m", "canon"]);
  git(canonA, ["tag", "v1.2.0"]);
  git(canonA, ["remote", "add", "origin", ORIGIN]);
  // Machine B has no variable, only a HOME whose cache slot holds a clone.
  homeB = join(base, "machine-b", "home");
  canonB = join(homeB, ".cache", "canon", "owner", "handbooks");
  mkdirSync(join(canonB, ".."), { recursive: true });
  git(base, ["clone", "--quiet", canonA, canonB]);
  git(canonB, ["remote", "set-url", "origin", ORIGIN]);
  git(canonB, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "v1.2.0"]);

  consumer = join(base, "consumer");
  mkdirSync(join(consumer, "nen"), { recursive: true });
  mkdirSync(join(consumer, ".claude"));
  writeFileSync(join(consumer, "nen", "repos.json"), JSON.stringify(REGISTRY, null, 2));
  writeFileSync(join(consumer, ".claude", "canon-values.yml"), "scenario: scenario-x\nsurfaces: claude-code\nvalues:\n  NAME: World\n");
  // The consumer's own origin is the host the canon is held to (Nobunaga N4).
  git(consumer, ["init", "--quiet"]);
  git(consumer, ["remote", "add", "origin", "git@github.com:owner/consumer.git"]);
});

afterAll(() => {
  if (base !== "") rmSync(base, { recursive: true, force: true, maxRetries: 3 });
});

function machine(env: Readonly<Record<string, string | undefined>>): Seams {
  return { ...defaultSeams(), env };
}
const MACHINE_A = (): Seams => machine({ NEN_TEST_CANON: canonA, HOME: join(base, "machine-a", "home") });
const MACHINE_B = (): Seams => machine({ HOME: homeB });

async function run(argv: readonly string[], seams: Seams, json = false): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(canonCommand, argv, consumer, json, io, seams);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe.skipIf(!HAVE_GIT)("canon checkout + mirror -- one literal argv, two machines (zheref/nen#294)", () => {
  it("machine A resolves its checkout from the variable the registry names", async () => {
    const result = await run(["canon", "checkout"], MACHINE_A(), true);
    expect(result.code, result.err).toBe(0);
    const doc = JSON.parse(result.out) as Record<string, unknown>;
    expect(doc).toMatchObject({
      contract: CHECKOUT_CONTRACT,
      ok: true,
      source: "owner/handbooks",
      ref: "v1.2.0",
      path: canonA,
      resolvedFrom: { kind: "env", from: "$NEN_TEST_CANON (nen/repos.json maintained_tools[1].checkout_env)" },
      verified: { originSlug: "owner/handbooks", host: "github.com", tag: "v1.2.0", clean: true },
      failure: null,
    });
  });

  it("machine B, with no variable, resolves the declared cache slot from its HOME", async () => {
    const result = await run(["canon", "checkout"], MACHINE_B());
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain(`checkout: ${canonB}`);
    expect(result.out).toContain("resolved from: declared-path '${XDG_CACHE_HOME:-${HOME}/.cache}/canon/owner/handbooks'");
    expect(result.out).toContain("passed over: env $NEN_TEST_CANON");
    expect(result.out).toMatch(/verified: origin https:\/\/github\.com\/owner\/handbooks\.git names owner\/handbooks on github\.com; HEAD [0-9a-f]{12} is v1\.2\.0; clean/);
  });

  it("generates on A and checks clean on B with the SAME argv, naming the checkout and how it resolved", async () => {
    const generated = await run(MIRROR("generate"), MACHINE_A());
    expect(generated.code, generated.err).toBe(0);
    expect(generated.out).toContain(`canon checkout: ${canonA} (resolved from env $NEN_TEST_CANON`);
    expect(readFileSync(join(consumer, ".claude", "rules", "01-a.md"), "utf8")).toMatch(/owner\/handbooks@v1\.2\.0: scenario-x\/01-a\.md/);
    const checked = await run(MIRROR("check"), MACHINE_B(), true);
    expect(checked.code, checked.err).toBe(0);
    const doc = JSON.parse(checked.out) as Record<string, unknown>;
    expect(doc).toMatchObject({ drift: false, rulesDir: join(canonB, "handbooks", "stacks", "scenario-x", "rules"), canonCheckout: { ok: true, path: canonB, resolvedFrom: { kind: "declared-path" } } });
  });

  it("fails closed at exit 2 -- never drift's 1 -- when B's checkout leaves the pin, and again when it is dirty", async () => {
    git(canonB, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "-b", "moved"]);
    writeFileSync(join(canonB, "extra.md"), "x\n");
    git(canonB, ["add", "extra.md"]);
    git(canonB, ["commit", "--quiet", "-m", "moved"]);
    const offPin = await run(MIRROR("check"), MACHINE_B());
    expect(offPin.code).toBe(2);
    expect(offPin.err).toMatch(/the canon checkout did not resolve \(off-pin\)/);
    const verb = await run(["canon", "checkout"], MACHINE_B(), true);
    expect(verb.code).toBe(1);
    expect(JSON.parse(verb.out)).toMatchObject({ ok: false, failure: { code: "off-pin" } });

    git(canonB, ["-c", "advice.detachedHead=false", "checkout", "--quiet", "v1.2.0"]);
    writeFileSync(join(canonB, "scratch.txt"), "local\n");
    const dirty = await run(MIRROR("check"), MACHINE_B());
    expect(dirty.code).toBe(2);
    expect(dirty.err).toMatch(/\(dirty\)/);
    rmSync(join(canonB, "scratch.txt"));
    expect((await run(MIRROR("check"), MACHINE_B())).code).toBe(0);
  });

  it("does not fall through: A's variable pointing nowhere fails though B's cache slot would verify", async () => {
    const seams = machine({ NEN_TEST_CANON: join(base, "nowhere"), HOME: homeB });
    const result = await run(MIRROR("check"), seams);
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/\(not-found\)/);
  });
});

describe.skipIf(!HAVE_GIT)("mirror's checkout form -- the rules directory stays inside the checkout", () => {
  it("refuses an absolute --stack-dir and one that climbs out of the checkout, at exit 2", async () => {
    const absolute = await run(["canon", "mirror", "check", "--canon-values", ".claude/canon-values.yml", "--stack-dir", "/etc", "--leaf", "rules"], MACHINE_A());
    expect(absolute.code).toBe(2);
    expect(absolute.err).toMatch(/neither may be absolute/);
    const climbing = await run(["canon", "mirror", "check", "--canon-values", ".claude/canon-values.yml", "--stack-dir", "../../..", "--leaf", "x"], MACHINE_A());
    expect(climbing.code).toBe(2);
    expect(climbing.err).toMatch(/is not inside the canon checkout/);
  });
});

/** A fresh canon repository at `at`: the scenario-x rules, `extra` files beside them, committed, tagged v1.2.0, origin `origin`. */
function makeCanon(at: string, origin = ORIGIN, extra: (root: string) => void = (): void => undefined): string {
  const rules = join(at, "handbooks", "stacks", "scenario-x", "rules");
  mkdirSync(rules, { recursive: true });
  writeFileSync(join(rules, "01-a.md"), "# A\n\nHello {{NAME}}.\n");
  writeFileSync(join(rules, "README.md"), "the index\n");
  writeFileSync(join(rules, "placeholders.md"), "the registry\n");
  extra(at);
  git(at, ["init", "--quiet"]);
  git(at, ["add", "-A"]);
  git(at, ["commit", "--quiet", "-m", "canon"]);
  git(at, ["tag", "v1.2.0"]);
  git(at, ["remote", "add", "origin", origin]);
  return realpathSync.native(at);
}

let fresh = 0;
function freshCanon(origin = ORIGIN, extra?: (root: string) => void): string {
  fresh += 1;
  return makeCanon(join(base, `canon-${fresh}`), origin, extra);
}

async function verdict(canon: string): Promise<Record<string, unknown>> {
  const result = await run(["canon", "checkout", "--canon-checkout", canon], machine({}), true);
  return JSON.parse(result.out) as Record<string, unknown>;
}

describe.skipIf(!HAVE_GIT)("Nobunaga round 1 -- the git shapes that verified when they must not", () => {
  it("N1: an untracked file under status.showUntrackedFiles=no is dirty", async () => {
    const canon = freshCanon();
    git(canon, ["config", "status.showUntrackedFiles", "no"]);
    writeFileSync(join(canon, "handbooks", "stacks", "scenario-x", "rules", "99-injected.md"), "# injected\n");
    expect(await verdict(canon)).toMatchObject({ ok: false, failure: { code: "dirty" } });
  });

  it("N1: an ignored file is dirty, and mirror generate writes nothing from it", async () => {
    const canon = freshCanon();
    writeFileSync(join(canon, ".git", "info", "exclude"), "99-*.md\n");
    writeFileSync(join(canon, "handbooks", "stacks", "scenario-x", "rules", "99-injected.md"), "# injected\n");
    expect(await verdict(canon)).toMatchObject({ ok: false, failure: { code: "dirty", message: expect.stringMatching(/!! handbooks\/stacks\/scenario-x\/rules\/99-injected\.md/) as unknown } });
    const generated = await run([...MIRROR("generate"), "--canon-checkout", canon], machine({}));
    expect(generated.code).toBe(2);
    expect(existsSync(join(consumer, ".claude", "rules", "99-injected.md"))).toBe(false);
  });

  it("N1: a skip-worktree edit is dirty", async () => {
    const canon = freshCanon();
    const file = join("handbooks", "stacks", "scenario-x", "rules", "01-a.md");
    git(canon, ["update-index", "--skip-worktree", file]);
    writeFileSync(join(canon, file), "# A\n\nInjected.\n");
    expect(await verdict(canon)).toMatchObject({ ok: false, failure: { code: "dirty", message: expect.stringMatching(/assume-unchanged or skip-worktree \(first: 'S handbooks/) as unknown } });
  });

  it("N1: an assume-unchanged edit is dirty", async () => {
    const canon = freshCanon();
    const file = join("handbooks", "stacks", "scenario-x", "rules", "01-a.md");
    git(canon, ["update-index", "--assume-unchanged", file]);
    writeFileSync(join(canon, file), "# A\n\nInjected.\n");
    expect(await verdict(canon)).toMatchObject({ ok: false, failure: { code: "dirty", message: expect.stringMatching(/first: 'h handbooks/) as unknown } });
  });

  it("N2: an inherited GIT_DIR does not make an unrelated directory verify as the canon", async () => {
    const canon = freshCanon();
    const unrelated = realpathSync.native(mkdtempSync(join(base, "unrelated-")));
    const saved = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = join(canon, ".git");
    try {
      const result = await run(["canon", "checkout", "--canon-checkout", unrelated], { ...defaultSeams(), env: { ...process.env } }, true);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.out)).toMatchObject({ ok: false, failure: { code: "not-a-checkout" } });
    } finally {
      if (saved === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved;
    }
  });

  it("N3: a committed symlink out of the checkout is refused after resolving it, even at a verified tag", async () => {
    const outside = join(base, "outside", "scenario-x", "rules");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "01-a.md"), "# Outside\n");
    const canon = freshCanon(ORIGIN, (root): void => {
      symlinkSync(join(base, "outside"), join(root, "handbooks", "evil"));
    });
    expect(await verdict(canon)).toMatchObject({ ok: true });
    const result = await run(["canon", "mirror", "check", "--canon-values", ".claude/canon-values.yml", "--stack-dir", "handbooks/evil", "--leaf", "rules", "--canon-checkout", canon], machine({}));
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/is not inside the canon checkout .*\(symbolic links resolved\)/);
  });

  it("N3: an excluded symlink out of the checkout never gets that far: it is dirty", async () => {
    const canon = freshCanon();
    symlinkSync(join(base, "outside"), join(canon, "handbooks", "evil"));
    writeFileSync(join(canon, ".git", "info", "exclude"), "handbooks/evil\n");
    const result = await run(["canon", "mirror", "check", "--canon-values", ".claude/canon-values.yml", "--stack-dir", "handbooks/evil", "--leaf", "rules", "--canon-checkout", canon], machine({}));
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/\(dirty\)/);
  });

  it("N4: a canon whose origin is on another host than the consumer's is refused", async () => {
    const canon = freshCanon("https://evil.example/owner/handbooks.git");
    expect(await verdict(canon)).toMatchObject({ ok: false, failure: { code: "wrong-host", message: expect.stringMatching(/evil\.example.*github\.com/) as unknown } });
  });

  it("N7: verifying rewrites nothing -- the index mtime is unchanged though a tracked file's stat went stale", async () => {
    const canon = freshCanon();
    const tracked = join(canon, "handbooks", "stacks", "scenario-x", "rules", "01-a.md");
    const later = new Date(Date.now() + 60_000);
    utimesSync(tracked, later, later);
    const index = join(canon, ".git", "index");
    const before = statSync(index).mtimeMs;
    expect(await verdict(canon)).toMatchObject({ ok: true });
    expect(statSync(index).mtimeMs).toBe(before);
  });
});

describe.skipIf(!HAVE_GIT)("Nobunaga round 2 -- objects and hooks that lie about the tree", () => {
  it("R1: a replace ref swapping the tag's commit for an EVIL one does not make the modified tree verify", async () => {
    const canon = freshCanon();
    const tagCommit = git(canon, ["rev-parse", "v1.2.0^{commit}"]);
    writeFileSync(join(canon, "handbooks", "stacks", "scenario-x", "rules", "99-injected.md"), "# injected\n");
    git(canon, ["add", "-A"]);
    const evil = git(canon, ["commit-tree", git(canon, ["write-tree"]), "-m", "EVIL"]);
    git(canon, ["replace", tagCommit, evil]);
    // Git itself, replace objects honoured, calls this tree clean.
    expect(git(canon, ["status", "--porcelain"])).toBe("");
    expect(await verdict(canon)).toMatchObject({ ok: false, failure: { code: "dirty", message: expect.stringMatching(/99-injected\.md/) as unknown } });
  });

  it.skipIf(process.platform === "win32")("R2: a v2 fsmonitor hook answering 'nothing changed' does not hide a tracked edit", async () => {
    const canon = freshCanon();
    const hook = join(base, `fsmonitor-${fresh}.sh`);
    writeFileSync(hook, "#!/bin/sh\nprintf 'tok\\0'\n");
    chmodSync(hook, 0o755);
    git(canon, ["config", "core.fsmonitor", hook]);
    git(canon, ["config", "core.fsmonitorHookVersion", "2"]);
    git(canon, ["status", "--porcelain"]);
    git(canon, ["status", "--porcelain"]);
    writeFileSync(join(canon, "handbooks", "stacks", "scenario-x", "rules", "01-a.md"), "# A\n\nHello {{EVIL}}.\n");
    // Git itself, trusting the hook, calls this tree clean.
    expect(git(canon, ["status", "--porcelain"])).toBe("");
    expect(await verdict(canon)).toMatchObject({ ok: false, failure: { code: "dirty", message: expect.stringMatching(/M handbooks\/stacks\/scenario-x\/rules\/01-a\.md/) as unknown } });
  });
});
