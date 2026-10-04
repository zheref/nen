// src/surface/plugin.test.ts -- `nen surface mirror check --plugin`
// (zheref/nen#339), through ../index.ts so the exits and the --json documents
// are the ones a caller gets. HERMETIC: every source, copy, config directory
// and stand-in checkout is a fresh temp dir; --config-dir and --repo are given
// on every run, so the host's own Claude Code config and the working
// directory's checkout are never read. The cases port zheref/hatsu's
// scripts/plugin_cache_check_fixture.sh, verdict for verdict.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "../index.js";
import { CHECK_PLUGIN_CONTRACT } from "./command.js";
import { overallVerdict, resolveConfigDir, safe, validateTrees, type CopyJudgement } from "./plugin.js";

const PLUGIN = "demo";
const TREES = "claude/skills,claude/agents,hooks,scripts";

async function capture(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  return { code: await run(argv, io), out, err };
}

const json = (result: { out: string[] }): Record<string, unknown> => JSON.parse(result.out.join("\n")) as Record<string, unknown>;
const copiesOf = (result: { out: string[] }): CopyJudgement[] => json(result)["copies"] as CopyJudgement[];

/** A git environment with nothing of the caller's: no GIT_DIR leaking in from a hook, no global identity needed. */
const GIT_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]): boolean => !key.startsWith("GIT_")));
function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "init.defaultBranch=main", ...args], {
    cwd,
    env: GIT_ENV,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

interface World {
  readonly work: string;
  readonly src: string;
  readonly cfg: string;
  /** A directory that is no checkout: the --repo every run stands in unless a case says otherwise. */
  readonly nowhere: string;
  fresh(name: string): string;
}

function world(): World {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "nen-surface-plugin-")));
  const src = join(work, "src");
  for (const dir of ["claude/skills/ten", "claude/agents", "hooks", "scripts", "docs", ".claude-plugin"]) {
    mkdirSync(join(src, ...dir.split("/")), { recursive: true });
  }
  writeFileSync(join(src, ".claude-plugin", "plugin.json"), `{"name":"${PLUGIN}","version":"1.2.0"}\n`);
  writeFileSync(join(src, ".claude-plugin", "marketplace.json"), `{"name":"${PLUGIN}","plugins":[]}\n`);
  writeFileSync(join(src, "claude", "skills", "ten", "SKILL.md"), "ten\n");
  writeFileSync(join(src, "claude", "agents", "lead.md"), "lead\n");
  writeFileSync(join(src, "hooks", "hooks.json"), "{}\n");
  writeFileSync(join(src, "scripts", "guard.sh"), "#!/bin/sh\n");
  writeFileSync(join(src, "docs", "README.md"), "not shipped\n");
  const cfg = join(work, "cfg");
  mkdirSync(join(cfg, "plugins"), { recursive: true });
  const nowhere = join(work, "nowhere");
  mkdirSync(nowhere);
  return {
    work,
    src,
    cfg,
    nowhere,
    fresh(name: string): string {
      const target = join(work, name);
      rmSync(target, { recursive: true, force: true });
      cpSync(src, target, { recursive: true, verbatimSymlinks: true });
      rmSync(join(target, ".git"), { recursive: true, force: true });
      return target;
    },
  };
}

function argv(w: World, source: string, installed: string, extra: readonly string[] = [], repo: string = w.nowhere): readonly string[] {
  return [
    "surface", "mirror", "check", "--surface", "claude-code", "--plugin", PLUGIN, "--source", source,
    "--installed", installed, "--trees", TREES, "--config-dir", w.cfg, "--repo", repo, "--json", ...extra,
  ];
}

const record = (w: World, value: unknown): void => {
  writeFileSync(join(w.cfg, "plugins", "installed_plugins.json"), typeof value === "string" ? value : `${JSON.stringify(value)}\n`);
};
const clearCfg = (w: World): void => {
  rmSync(w.cfg, { recursive: true, force: true });
  mkdirSync(join(w.cfg, "plugins"), { recursive: true });
};

describe("check --plugin, an explicit copy", () => {
  it("reads an identical copy identical (exit 0) under its own contract", async () => {
    const w = world();
    const result = await capture(argv(w, w.src, w.fresh("same")));
    expect(result.code).toBe(0);
    expect(json(result)["contract"]).toBe(CHECK_PLUGIN_CONTRACT);
    expect(json(result)["verdict"]).toBe("identical");
    expect(json(result)["exit"]).toBe(0);
    expect(json(result)["record"]).toBe("not read");
    expect(copiesOf(result)[0]?.differences).toEqual([]);
  });

  it("names every differing path by side (exit 1)", async () => {
    const w = world();
    const copy = w.fresh("drift");
    writeFileSync(join(copy, "claude", "skills", "ten", "SKILL.md"), "ten, edited\n");
    writeFileSync(join(copy, "claude", "agents", "gone.md"), "old\n");
    rmSync(join(copy, "hooks", "hooks.json"));
    writeFileSync(join(copy, ".claude-plugin", "marketplace.json"), `{"name":"${PLUGIN}","plugins":[{}]}\n`);
    writeFileSync(join(copy, "scripts", "guard.sh"), "#!/bin/sh\nexit 1\n");
    const result = await capture(argv(w, w.src, copy));
    expect(result.code).toBe(1);
    expect(json(result)["verdict"]).toBe("different");
    expect(copiesOf(result)[0]?.differences).toEqual([
      { kind: "differs", path: ".claude-plugin/marketplace.json" },
      { kind: "only-in-copy", path: "claude/agents/gone.md" },
      { kind: "differs", path: "claude/skills/ten/SKILL.md" },
      { kind: "only-in-source", path: "hooks/hooks.json" },
      { kind: "differs", path: "scripts/guard.sh" },
    ]);
    const text = await capture(argv(w, w.src, copy).filter((arg): boolean => arg !== "--json"));
    expect(text.out).toContain("  differs:        claude/skills/ten/SKILL.md");
    expect(text.out).toContain("  only in source: hooks/hooks.json");
    expect(text.out).toContain("  only in copy:   claude/agents/gone.md");
    expect(text.out.at(-1)).toBe("verdict: different");
  });

  it("prints both versions when the manifest differs", async () => {
    const w = world();
    const copy = w.fresh("manifest");
    writeFileSync(join(copy, ".claude-plugin", "plugin.json"), `{"name":"${PLUGIN}","version":"1.1.0"}\n`);
    const result = await capture(argv(w, w.src, copy));
    expect(result.code).toBe(1);
    const judged = copiesOf(result)[0];
    expect([judged?.copyVersion, judged?.sourceVersion]).toEqual(["1.1.0", "1.2.0"]);
    expect(judged?.reason).toMatch(/plugin 1\.1\.0.*plugin 1\.2\.0/);
  });

  it("never compares a tree the plugin does not ship, nor .DS_Store", async () => {
    const w = world();
    const copy = w.fresh("unshipped");
    writeFileSync(join(copy, "docs", "README.md"), "changed\n");
    writeFileSync(join(copy, "claude", "skills", ".DS_Store"), "x");
    expect((await capture(argv(w, w.src, copy))).code).toBe(0);
  });

  it("is wiring (exit 2) for a copy of another plugin, a hollow dir, a missing dir -- never drift", async () => {
    const w = world();
    const other = w.fresh("other");
    writeFileSync(join(other, ".claude-plugin", "plugin.json"), '{"name":"otherplug","version":"1.0.0"}\n');
    const named = await capture(argv(w, w.src, other));
    expect(named.code).toBe(2);
    expect(named.err.join("\n")).toMatch(/is not a copy of 'demo'/);
    expect(named.out).toEqual([]);
    mkdirSync(join(w.work, "hollow"));
    expect((await capture(argv(w, w.src, join(w.work, "hollow")))).code).toBe(2);
    expect((await capture(argv(w, w.src, join(w.work, "nope")))).code).toBe(2);
    expect((await capture(argv(w, w.work, w.fresh("same")))).err.join("\n")).toMatch(/--source .* is not a root of 'demo'/);
  });

  it("compares a symlink by its target, never opening it", async () => {
    const w = world();
    const out = w.fresh("linkout");
    symlinkSync("/etc/hosts", join(out, "claude", "agents", "out.md"));
    const result = await capture(argv(w, w.src, out));
    expect(result.code).toBe(1);
    expect(copiesOf(result)[0]?.differences).toEqual([{ kind: "only-in-copy", path: "claude/agents/out.md" }]);

    const twinA = w.fresh("twinA");
    const twinB = w.fresh("twinB");
    symlinkSync("../README.md", join(twinA, "claude", "agents", "r.md"));
    symlinkSync("../README.md", join(twinB, "claude", "agents", "r.md"));
    expect((await capture(argv(w, twinA, twinB))).code).toBe(0);
    rmSync(join(twinB, "claude", "agents", "r.md"));
    symlinkSync("../OTHER.md", join(twinB, "claude", "agents", "r.md"));
    const differs = await capture(argv(w, twinA, twinB));
    expect(differs.code).toBe(1);
    expect(copiesOf(differs)[0]?.differences).toEqual([{ kind: "differs-symlink", path: "claude/agents/r.md" }]);
  });

  const hasBun = spawnSync("bun", ["--version"], { encoding: "utf8" }).status === 0;
  it.skipIf(process.platform === "win32" || !hasBun)("never opens a symlink to a FIFO (a check that did would hang, bounded here)", () => {
    const w = world();
    const copy = w.fresh("fifo");
    const pipe = join(w.work, "pipe");
    expect(spawnSync("mkfifo", [pipe]).status).toBe(0);
    rmSync(join(copy, "claude", "agents", "lead.md"));
    symlinkSync(pipe, join(copy, "claude", "agents", "lead.md"));
    // A FIFO in a tree itself is no shipped file: not listed, not opened.
    expect(spawnSync("mkfifo", [join(copy, "hooks", "raw.fifo")]).status).toBe(0);
    // In a child, under a timeout: in-process, an opened FIFO would block the whole suite.
    const child = spawnSync("bun", [join(process.cwd(), "src", "index.ts"), ...argv(w, w.src, copy)], {
      encoding: "utf8",
      timeout: 30_000,
      env: GIT_ENV,
    });
    expect(child.signal).toBeNull();
    expect(child.status).toBe(1);
    const report = JSON.parse(child.stdout) as { copies: CopyJudgement[] };
    expect(report.copies[0]?.differences).toEqual([{ kind: "differs-symlink", path: "claude/agents/lead.md" }]);
  });

  it.skipIf(process.platform === "win32")("never compares or prints raw a name with a control character", async () => {
    const w = world();
    const copy = w.fresh("cntrl");
    writeFileSync(join(copy, "claude", "skills", "\u001b[2J.md"), "x\n");
    const result = await capture(argv(w, w.src, copy));
    expect(result.code).toBe(1);
    expect(copiesOf(result)[0]?.differences).toEqual([{ kind: "unexpected-in-copy", path: "claude/skills/?[2J.md" }]);
    const text = await capture(argv(w, w.src, copy).filter((arg): boolean => arg !== "--json"));
    expect(text.out.join("\n")).not.toContain("\u001b");
    expect(text.out.join("\n")).toContain("is never compared");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("is wiring for an unreadable file or directory, never identical or missing", async () => {
    const w = world();
    const locked = w.fresh("locked");
    chmodSync(join(locked, "scripts", "guard.sh"), 0o000);
    const file = await capture(argv(w, w.src, locked));
    chmodSync(join(locked, "scripts", "guard.sh"), 0o644);
    expect(file.code).toBe(2);
    expect(json(file)["verdict"]).toBe("wiring");
    const lockedDir = w.fresh("lockeddir");
    chmodSync(join(lockedDir, "claude", "agents"), 0o000);
    const dir = await capture(argv(w, w.src, lockedDir));
    chmodSync(join(lockedDir, "claude", "agents"), 0o755);
    expect(dir.code).toBe(2);
    expect(copiesOf(dir)[0]?.reason).toMatch(/could not be listed/);
    expect(copiesOf(dir)[0]?.differences).toEqual([]);
  });
});

describe("check --plugin, a copy is never its own evidence", () => {
  it("is not comparable (exit 4) when the copy IS the source and nothing independent exists", async () => {
    const w = world();
    git(w.src, "init", "-q");
    git(w.src, "add", "-A");
    git(w.src, "commit", "-qm", "init");
    symlinkSync(w.src, join(w.work, "linked"));
    const result = await capture(argv(w, w.src, join(w.work, "linked")));
    expect(result.code).toBe(4);
    expect(json(result)["verdict"]).toBe("not comparable");
    expect(result.out.join("\n")).not.toMatch(/"identical"/);

    // --independent-source naming that same git checkout: identical BY LINK.
    const byLink = await capture(argv(w, w.src, join(w.work, "linked"), ["--independent-source", w.src]));
    expect(byLink.code).toBe(0);
    expect(copiesOf(byLink)[0]).toMatchObject({ byLink: true, namedBy: "independent-source" });

    // ...but a link to a source that is no git checkout is no evidence at all.
    const plain = w.fresh("plain");
    const notGit = await capture(argv(w, plain, plain, ["--independent-source", plain]));
    expect(notGit.code).toBe(4);
    expect(copiesOf(notGit)[0]?.reason).toMatch(/not a git checkout/);

    // The copy given as --source is compared with the independent source instead.
    const drift = w.fresh("drift");
    writeFileSync(join(drift, "claude", "skills", "ten", "SKILL.md"), "stale\n");
    const compared = await capture(argv(w, drift, drift, ["--independent-source", w.src]));
    expect(compared.code).toBe(1);
    expect(copiesOf(compared)[0]?.namedBy).toBe("independent-source");
    expect(copiesOf(compared)[0]?.reason).toMatch(/named by independent-source/);
  });

  it("takes the stand-in checkout only on its trunk or on the served copy's branch", async () => {
    const w = world();
    git(w.src, "init", "-q");
    git(w.src, "add", "-A");
    git(w.src, "commit", "-qm", "init");
    const drift = w.fresh("drift");
    writeFileSync(join(drift, "claude", "skills", "ten", "SKILL.md"), "stale\n");
    const onTrunk = await capture(argv(w, drift, drift, [], w.src));
    expect(onTrunk.code).toBe(1);
    expect(copiesOf(onTrunk)[0]?.namedBy).toBe("checkout");

    git(w.src, "checkout", "-q", "-b", "feat/x");
    const onFeature = await capture(argv(w, drift, drift, [], w.src));
    expect(onFeature.code).toBe(4);
    expect(copiesOf(onFeature)[0]?.reason).toMatch(/feat\/x, a feature branch/);

    // A served checkout on that same branch: the stand-in IS what it should serve.
    const served = join(w.work, "servedgit");
    git(w.work, "clone", "-q", w.src, served);
    git(served, "checkout", "-q", "feat/x");
    writeFileSync(join(served, "claude", "skills", "ten", "SKILL.md"), "changed\n");
    const sameBranch = await capture(argv(w, served, served, [], w.src));
    expect(sameBranch.code).toBe(1);
    expect(copiesOf(sameBranch)[0]?.namedBy).toBe("checkout");

    // The trunk is the checkout's own nen/workflow.json branch.base when it names one.
    mkdirSync(join(w.src, "nen"));
    writeFileSync(join(w.src, "nen", "workflow.json"), '{"branch":{"base":"feat/x"}}\n');
    expect((await capture(argv(w, drift, drift, [], w.src))).code).toBe(1);
  });

  it("takes the marketplace's directory source", async () => {
    const w = world();
    const drift = w.fresh("drift");
    writeFileSync(join(drift, "claude", "skills", "ten", "SKILL.md"), "stale\n");
    record(w, { version: 2, plugins: { [`${PLUGIN}@mk`]: [{ installPath: drift }] } });
    writeFileSync(join(w.cfg, "plugins", "known_marketplaces.json"), JSON.stringify({ mk: { source: { source: "directory", path: w.src } } }));
    const result = await capture(argv(w, drift, "auto"));
    expect(result.code).toBe(1);
    expect(copiesOf(result)[0]?.namedBy).toBe("marketplace");
  });
});

describe("check --plugin --installed auto", () => {
  it("is not installed (exit 3) with no entry and no skills install; other plugins are ignored", async () => {
    const w = world();
    const none = await capture(argv(w, w.src, "auto"));
    expect(none.code).toBe(3);
    expect(json(none)).toMatchObject({ verdict: "not installed", record: "absent", copies: [] });
    record(w, { version: 2, plugins: { "other@x": [{ installPath: w.fresh("drift") }] } });
    expect((await capture(argv(w, w.src, "auto"))).code).toBe(3);
  });

  it("reads the recorded installPath, once per real path, and reports the worst", async () => {
    const w = world();
    const same = w.fresh("same");
    record(w, { version: 2, plugins: { [`${PLUGIN}@hatsu`]: [{ installPath: same }, { installPath: same }] } });
    const once = await capture(argv(w, w.src, "auto"));
    expect(once.code).toBe(0);
    expect(copiesOf(once)).toHaveLength(1);
    expect(json(once)["record"]).toBe("read");

    const drift = w.fresh("drift");
    writeFileSync(join(drift, "hooks", "hooks.json"), "[]\n");
    record(w, { version: 2, plugins: { [`${PLUGIN}@hatsu`]: [{ installPath: drift }, { installPath: same }] } });
    expect((await capture(argv(w, w.src, "auto"))).code).toBe(1);

    // The recorded copy given as --source, nothing independent: not comparable.
    record(w, { version: 2, plugins: { [`${PLUGIN}@hatsu`]: [{ installPath: same }] } });
    expect((await capture(argv(w, same, "auto"))).code).toBe(4);
  });

  it("is a broken install (exit 5), never not installed, for every unusable record", async () => {
    const w = world();
    const other = w.fresh("other");
    writeFileSync(join(other, ".claude-plugin", "plugin.json"), '{"name":"otherplug"}\n');
    const cases: readonly [unknown, RegExp][] = [
      [{ plugins: { [`${PLUGIN}@hatsu`]: [{ scope: "user" }] } }, /carries no usable installPath/],
      [{ plugins: { [`${PLUGIN}@hatsu`]: [] } }, /carries no usable installPath/],
      [{ plugins: { [`${PLUGIN}@hatsu`]: [{ installPath: null }] } }, /carries no usable installPath/],
      [{ plugins: { [`${PLUGIN}@hatsu`]: [{ installPath: join(w.work, "gone") }] } }, /stale record/],
      [{ plugins: { [`${PLUGIN}@hatsu`]: [{ installPath: other }] } }, /holds no 'demo' plugin/],
      ["not json", /not readable: it is not JSON/],
    ];
    for (const [value, reason] of cases) {
      record(w, value);
      const result = await capture(argv(w, w.src, "auto"));
      expect(result.code).toBe(5);
      expect(json(result)["verdict"]).toBe("broken install");
      expect(copiesOf(result)[0]?.reason).toMatch(reason);
    }
  });

  it("refuses an installPath with an embedded newline as ONE install, never split", async () => {
    const w = world();
    const same = w.fresh("same");
    record(w, { version: 2, plugins: { [`${PLUGIN}@hatsu`]: [{ installPath: `${same}\n${same}` }] } });
    const result = await capture(argv(w, w.src, "auto"));
    expect(result.code).toBe(5);
    expect(copiesOf(result)).toHaveLength(1);
    expect(copiesOf(result)[0]?.reason).toMatch(/control character; never read/);
    expect(copiesOf(result)[0]?.path).not.toContain("\n");
    expect(result.out.join("\n")).not.toMatch(/"identical"/);
  });

  it.skipIf(process.platform === "win32")("judges the skills-directory install: dangling, looping, by link, stale", async () => {
    const w = world();
    clearCfg(w);
    mkdirSync(join(w.cfg, "skills"));
    const link = join(w.cfg, "skills", PLUGIN);
    symlinkSync(join(w.work, "moved"), link);
    const dangling = await capture(argv(w, w.src, "auto"));
    expect(dangling.code).toBe(5);
    expect(copiesOf(dangling)[0]?.reason).toMatch(/dangling or looping link/);
    rmSync(link);
    symlinkSync(link, link);
    expect((await capture(argv(w, w.src, "auto"))).code).toBe(5);
    rmSync(link);

    git(w.src, "init", "-q");
    git(w.src, "add", "-A");
    git(w.src, "commit", "-qm", "init");
    symlinkSync(w.src, link);
    const byLink = await capture(argv(w, w.src, "auto", ["--independent-source", w.src]));
    expect(byLink.code).toBe(0);
    expect(copiesOf(byLink)[0]).toMatchObject({ label: `skills/${PLUGIN}`, byLink: true });
    rmSync(link);

    const drift = w.fresh("drift");
    writeFileSync(join(drift, "scripts", "guard.sh"), "#!/bin/sh\nexit 1\n");
    symlinkSync(drift, link);
    expect((await capture(argv(w, w.src, "auto"))).code).toBe(1);
  });
});

describe("check --plugin's refusals", () => {
  it("refuses mirror inputs, a non-claude-code surface, a missing --trees, and plugin flags without --plugin", async () => {
    const w = world();
    const copy = w.fresh("same");
    const stamp = await capture([...argv(w, w.src, copy), "--stamp", "1.0.0"]);
    expect(stamp.code).toBe(2);
    expect(stamp.err.join("\n")).toMatch(/--stamp is not read with --plugin/);
    const surface = await capture(argv(w, w.src, copy).map((arg): string => (arg === "claude-code" ? "cursor" : arg)));
    expect(surface.code).toBe(2);
    expect(surface.err.join("\n")).toMatch(/has no plugin cache/);
    const noTrees = argv(w, w.src, copy).filter((arg): boolean => arg !== "--trees" && arg !== TREES);
    expect((await capture(noTrees)).err.join("\n")).toMatch(/--trees is required with --plugin/);
    const escape = await capture([...argv(w, w.src, copy).filter((arg): boolean => arg !== TREES && arg !== "--trees"), "--trees", "../x"]);
    expect(escape.code).toBe(2);
    const without = await capture(["surface", "mirror", "check", "--surface", "claude-code", "--source", w.src, "--installed", copy, "--trees", TREES]);
    expect(without.code).toBe(2);
    expect(without.err.join("\n")).toMatch(/--trees is read only with --plugin/);
    const auto = await capture(["surface", "mirror", "check", "--surface", "claude-code", "--source", w.src, "--installed", "auto"]);
    expect(auto.code).toBe(2);
    expect(auto.err.join("\n")).toMatch(/--installed auto reads the host's install record/);
  });
});

describe("plugin.ts helpers", () => {
  it("resolves the config dir from the flag, then CLAUDE_CONFIG_DIR, then HOME", () => {
    expect(resolveConfigDir("/x", { CLAUDE_CONFIG_DIR: "/y" })).toBe("/x");
    expect(resolveConfigDir(null, { CLAUDE_CONFIG_DIR: "/y", HOME: "/h" })).toBe("/y");
    expect(resolveConfigDir(null, { HOME: "/h" })).toBe(join("/h", ".claude"));
    expect(resolveConfigDir(null, {}, "/fallback")).toBe(join("/fallback", ".claude"));
  });

  it("validates trees and makes names safe", () => {
    expect(validateTrees(["a", "b/c", "a"])).toEqual(["a", "b/c"]);
    for (const bad of ["/abs", "a/../b", "./a", "a//b", "a\nb"]) expect(() => validateTrees([bad])).toThrow(/plain relative path/);
    expect(safe("a\u0007b\u009bc")).toBe("a?b?c");
  });

  it("ranks the overall verdict worst first, and none as not installed", () => {
    const of = (verdict: CopyJudgement["verdict"]): CopyJudgement =>
      ({ verdict }) as CopyJudgement;
    expect(overallVerdict([])).toBe("not installed");
    expect(overallVerdict([of("identical"), of("not comparable")])).toBe("not comparable");
    expect(overallVerdict([of("not comparable"), of("broken install")])).toBe("broken install");
    expect(overallVerdict([of("broken install"), of("different")])).toBe("different");
    expect(overallVerdict([of("different"), of("wiring")])).toBe("wiring");
  });
});
