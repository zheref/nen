// src/surface/plugin.test.ts -- `nen surface mirror check --plugin`
// (zheref/nen#339), through ../index.ts so the exits and the --json documents
// are the ones a caller gets. HERMETIC: every source, copy, config directory
// and stand-in checkout is a fresh temp dir; --config-dir and --repo are given
// on every run, so the host's own Claude Code config and the working
// directory's checkout are never read. The cases port zheref/hatsu's
// scripts/plugin_cache_check_fixture.sh, verdict for verdict.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "../index.js";
import { CHECK_PLUGIN_CONTRACT } from "./command.js";
import { overallVerdict, resolveConfigDir, safe, sameIdentity, validateTrees, type CopyJudgement } from "./plugin.js";

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
    expect(copiesOf(notGit)[0]?.reason).toMatch(/no proof/);

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
      ["not json", /not usable: it is not JSON/],
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

describe("check --plugin, hanten round 1 (zheref/nen#339)", () => {
  const withTrees = (args: readonly string[], trees: string): string[] => {
    const out = [...args];
    out[out.indexOf("--trees") + 1] = trees;
    return out;
  };
  const initGit = (dir: string): void => {
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
  };

  it("N1: refuses a --trees entry that is not a real directory in the source, never reading it identical", async () => {
    const w = world();
    const copy = w.fresh("same");
    const typo = await capture(withTrees(argv(w, w.src, copy), "claude/skils,hooks"));
    expect(typo.code).toBe(2);
    expect(typo.err.join("\n")).toMatch(/--trees entry 'claude\/skils' does not exist in the source/);
    expect(typo.out).toEqual([]);
    const file = await capture(withTrees(argv(w, w.src, copy), "hooks/hooks.json"));
    expect(file.code).toBe(2);
    expect(file.err.join("\n")).toMatch(/reaches a file/);
    // An INDEPENDENT source missing the tree is wiring in the report, not an empty tree.
    const thin = w.fresh("thin");
    rmSync(join(thin, "scripts"), { recursive: true });
    const report = await capture(argv(w, copy, copy, ["--independent-source", thin]));
    expect(report.code).toBe(2);
    expect(json(report)["verdict"]).toBe("wiring");
    expect(copiesOf(report)[0]?.reason).toMatch(/--trees entry 'scripts' does not exist in the source/);
  });

  it.skipIf(process.platform === "win32")("N2: a copy whose 'claude' links into the source is different, never followed", async () => {
    const w = world();
    const copy = w.fresh("linkedclaude");
    rmSync(join(copy, "claude"), { recursive: true });
    symlinkSync(join(w.src, "claude"), join(copy, "claude"));
    const result = await capture(argv(w, w.src, copy));
    expect(result.code).toBe(1);
    expect(copiesOf(result)[0]?.differences).toEqual([{ kind: "differs-symlink", path: "claude" }]);
    // A linked .claude-plugin is no copy of the plugin at all: refused, never followed.
    const manifest = w.fresh("linkedmanifest");
    rmSync(join(manifest, ".claude-plugin"), { recursive: true });
    symlinkSync(join(w.src, ".claude-plugin"), join(manifest, ".claude-plugin"));
    expect((await capture(argv(w, w.src, manifest))).code).toBe(2);
    // ...and a source whose tree passes through a link is refused as a tree.
    const via = w.fresh("via");
    rmSync(join(via, "hooks"), { recursive: true });
    symlinkSync(join(w.src, "hooks"), join(via, "hooks"));
    const viaLink = await capture(argv(w, via, w.fresh("same")));
    expect(viaLink.code).toBe(2);
    expect(viaLink.err.join("\n")).toMatch(/reaches a symbolic link at 'hooks'/);
  });

  it.skipIf(process.platform !== "linux")("N3: sets aside a name that is not UTF-8, never printing its raw byte", async () => {
    const w = world();
    const copy = w.fresh("latin");
    const dir = Buffer.from(join(copy, "claude", "skills"));
    writeFileSync(Buffer.concat([dir, Buffer.from("/bad"), Buffer.from([0xff]), Buffer.from(".md")]), "x\n");
    expect(readdirSync(join(copy, "claude", "skills"), { encoding: "buffer" }).some((name): boolean => name.includes(0xff))).toBe(true);
    const result = await capture(argv(w, w.src, copy));
    expect(result.code).toBe(1);
    const differences = copiesOf(result)[0]?.differences ?? [];
    expect(differences).toHaveLength(1);
    expect(differences[0]?.kind).toBe("unexpected-in-copy");
    const text = await capture(argv(w, w.src, copy).filter((arg): boolean => arg !== "--json"));
    for (const line of [...result.out, ...text.out]) expect(Buffer.from(line, "utf8").includes(0xff)).toBe(false);
  });

  it("N4: validates --independent-source, and refuses it when no copy is --source", async () => {
    const w = world();
    const copy = w.fresh("same");
    const notRoot = await capture(argv(w, copy, copy, ["--independent-source", w.nowhere]));
    expect(notRoot.code).toBe(2);
    expect(notRoot.err.join("\n")).toMatch(/--independent-source .* is not a root of 'demo'/);
    const unread = await capture(argv(w, w.src, copy, ["--independent-source", w.src]));
    expect(unread.code).toBe(2);
    expect(unread.err.join("\n")).toMatch(/consulted only when a judged copy IS --source/);
    record(w, { plugins: { [`${PLUGIN}@hatsu`]: [{ installPath: copy }] } });
    const auto = await capture(argv(w, w.src, "auto", ["--independent-source", w.src]));
    expect(auto.code).toBe(2);
    expect(auto.err.join("\n")).toMatch(/consulted only when a judged copy IS --source/);
  });

  it("N6: splits --trees on both separators on every host, and refuses ':'", async () => {
    const w = world();
    const copy = w.fresh("same");
    for (const tree of ["..\\x", "claude\\..\\x", "c:skills"]) {
      const result = await capture(withTrees(argv(w, w.src, copy), tree));
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/not a plain relative path/);
    }
    expect((await capture(withTrees(argv(w, w.src, copy), "claude\\skills"))).code).toBe(0);
    const name = await capture(argv(w, w.src, copy).map((arg): string => (arg === PLUGIN ? "a\\b" : arg)));
    expect(name.code).toBe(2);
    expect((await capture(argv(w, w.src, copy).map((arg): string => (arg === PLUGIN ? ".." : arg)))).code).toBe(2);
  });

  it("N7: a file where the source has a directory is drift, naming the source files by side", async () => {
    const w = world();
    const copy = w.fresh("flat");
    rmSync(join(copy, "claude"), { recursive: true });
    writeFileSync(join(copy, "claude"), "not a directory\n");
    const result = await capture(argv(w, w.src, copy));
    expect(result.code).toBe(1);
    expect(copiesOf(result)[0]?.differences).toEqual([
      { kind: "only-in-copy", path: "claude" },
      { kind: "only-in-source", path: "claude/agents/lead.md" },
      { kind: "only-in-source", path: "claude/skills/ten/SKILL.md" },
    ]);
  });

  it("N8: a served checkout that IS the stand-in is identical by link only on its trunk", async () => {
    const w = world();
    initGit(w.src);
    const onTrunk = await capture(argv(w, w.src, w.src, [], w.src));
    expect(onTrunk.code).toBe(0);
    expect(copiesOf(onTrunk)[0]).toMatchObject({ byLink: true, namedBy: "checkout" });
    git(w.src, "checkout", "-q", "-b", "feat/y");
    const onFeature = await capture(argv(w, w.src, w.src, [], w.src));
    expect(onFeature.code).toBe(4);
    expect(copiesOf(onFeature)[0]?.reason).toMatch(/feat\/y, a feature branch/);
  });

  it.skipIf(process.platform === "win32")("N9: an install record that is a dangling link is a broken install", async () => {
    const w = world();
    symlinkSync(join(w.work, "nothing.json"), join(w.cfg, "plugins", "installed_plugins.json"));
    const result = await capture(argv(w, w.src, "auto"));
    expect(result.code).toBe(5);
    expect(json(result)["record"]).toBe("unreadable");
    expect(copiesOf(result)[0]?.reason).toMatch(/dangling or looping link/);
  });

  it("N10: identity is the real path OR the device and inode", () => {
    expect(sameIdentity({ real: "/a", dev: 1, ino: 2 }, { real: "/A", dev: 1, ino: 2 })).toBe(true);
    expect(sameIdentity({ real: "/a", dev: 1, ino: 2 }, { real: "/a", dev: 3, ino: 4 })).toBe(true);
    expect(sameIdentity({ real: "/a", dev: 1, ino: 2 }, { real: "/b", dev: 1, ino: 3 })).toBe(false);
  });

  it("N11: never echoes a control character from --surface", async () => {
    const w = world();
    const result = await capture(argv(w, w.src, w.fresh("same")).map((arg): string => (arg === "claude-code" ? "x\u001b[2J" : arg)));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).not.toContain("\u001b");
  });

  it("N13: an inherited GIT_DIR does not redirect the stand-in probes", async () => {
    const w = world();
    initGit(w.src);
    const drift = w.fresh("drift");
    writeFileSync(join(drift, "claude", "skills", "ten", "SKILL.md"), "stale\n");
    const saved = process.env["GIT_DIR"];
    process.env["GIT_DIR"] = join(w.nowhere, "not-a-repo");
    try {
      const result = await capture(argv(w, drift, drift, [], w.src));
      expect(result.code).toBe(1);
      expect(copiesOf(result)[0]?.namedBy).toBe("checkout");
    } finally {
      if (saved === undefined) delete process.env["GIT_DIR"];
      else process.env["GIT_DIR"] = saved;
    }
  });
});

describe("check --plugin, Copilot round 1 on NN-PR-#378: an inspection failure is not absence", () => {
  const noPerms = process.platform === "win32" || process.getuid?.() === 0;
  const initGit = (dir: string): void => {
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
  };
  /** Runs `body` with `path` at mode 000, always restoring it. */
  async function locked<T>(path: string, body: () => Promise<T>): Promise<T> {
    chmodSync(path, 0o000);
    try {
      return await body();
    } finally {
      chmodSync(path, 0o755);
    }
  }

  it.skipIf(process.platform === "win32")("1: a reason is made inert at the human boundary, and kept as built under --json", async () => {
    const w = world();
    const same = w.fresh("same");
    const odd = join(w.work, "odd\u001b[2Jdir");
    symlinkSync(same, odd);
    mkdirSync(join(w.cfg, "skills"));
    symlinkSync(odd, join(w.cfg, "skills", PLUGIN));
    record(w, { plugins: { [`${PLUGIN}@hatsu`]: [{ installPath: join(w.work, "gone\u0007here") }] } });
    const text = await capture(argv(w, w.src, "auto").filter((arg): boolean => arg !== "--json"));
    for (const line of text.out) expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    const machine = await capture(argv(w, w.src, "auto"));
    expect(copiesOf(machine).map((copy): string => copy.verdict).sort()).toEqual(["broken install", "identical"]);
    expect(text.out.some((line): boolean => line.startsWith("broken install -- "))).toBe(true);
  });

  it.skipIf(noPerms)("2: an unreadable plugin.json in a recorded copy is wiring (2), not 'holds no plugin' (5)", async () => {
    const w = world();
    const copy = w.fresh("lockedmanifest");
    record(w, { plugins: { [`${PLUGIN}@hatsu`]: [{ installPath: copy }] } });
    const manifest = join(copy, ".claude-plugin", "plugin.json");
    const result = await locked(manifest, async () => capture(argv(w, w.src, "auto")));
    expect(result.code).toBe(2);
    expect(json(result)["verdict"]).toBe("wiring");
    expect(copiesOf(result)[0]?.reason).toMatch(/could not be read \(EACCES\)/);
    expect(copiesOf(result)[0]?.reason).not.toMatch(/holds no/);
    // A manifest that is there and names another plugin is still a broken install.
    writeFileSync(manifest, '{"name":"otherplug"}\n');
    expect((await capture(argv(w, w.src, "auto"))).code).toBe(5);
  });

  it.skipIf(noPerms)("3: an unreadable parent in a source tree is a wiring REPORT, not a missing-tree refusal", async () => {
    const w = world();
    const copy = w.fresh("same");
    const result = await locked(join(w.src, "claude"), async () => capture(argv(w, w.src, copy)));
    expect(result.code).toBe(2);
    expect(result.out).not.toEqual([]);
    expect(json(result)["verdict"]).toBe("wiring");
    expect(copiesOf(result)[0]?.reason).toMatch(/unreadable: claude\/skills under the source/);
    expect(result.err.join("\n")).not.toMatch(/does not exist in the source/);
  });

  it.skipIf(process.platform === "win32")("4: symlink targets are compared as bytes, never as decoded strings", async () => {
    const w = world();
    const left = w.fresh("left");
    const right = w.fresh("right");
    // 0xfe and 0xff both decode to U+FFFD: equal as strings, different as bytes.
    symlinkSync(Buffer.from([0x61, 0xfe]), join(left, "claude", "agents", "t.md"));
    symlinkSync(Buffer.from([0x61, 0xff]), join(right, "claude", "agents", "t.md"));
    const result = await capture(argv(w, left, right));
    expect(result.code).toBe(1);
    expect(copiesOf(result)[0]?.differences).toEqual([{ kind: "differs-symlink", path: "claude/agents/t.md" }]);
  });

  it.skipIf(process.platform === "win32")("5: a looping <config>/plugins is broken (5); an unreadable one is wiring (2)", async () => {
    const w = world();
    rmSync(join(w.cfg, "plugins"), { recursive: true });
    symlinkSync(join(w.cfg, "plugins"), join(w.cfg, "plugins"));
    const loop = await capture(argv(w, w.src, "auto"));
    expect(loop.code).toBe(5);
    expect(json(loop)["record"]).toBe("unreadable");
    expect(copiesOf(loop)[0]?.reason).toMatch(/ELOOP/);
    if (noPerms) return;
    rmSync(join(w.cfg, "plugins"));
    mkdirSync(join(w.cfg, "plugins"));
    record(w, { plugins: {} });
    const unreadable = await locked(join(w.cfg, "plugins"), async () => capture(argv(w, w.src, "auto")));
    expect(unreadable.code).toBe(2);
    expect(copiesOf(unreadable)[0]?.reason).toMatch(/could not be read \(EACCES\)/);
    const file = join(w.cfg, "plugins", "installed_plugins.json");
    chmodSync(file, 0o000);
    const lockedFile = await capture(argv(w, w.src, "auto"));
    chmodSync(file, 0o644);
    expect(lockedFile.code).toBe(2);
  });

  it("6: identical by link needs git's own toplevel to be the copy -- an empty .git or an enclosing repo is no proof", async () => {
    const w = world();
    const empty = w.fresh("emptygit");
    mkdirSync(join(empty, ".git"));
    const hollow = await capture(argv(w, empty, empty, ["--independent-source", empty]));
    expect(hollow.code).toBe(4);
    expect(copiesOf(hollow)[0]?.reason).toMatch(/no proof/);

    const outer = join(w.work, "outer");
    mkdirSync(outer);
    writeFileSync(join(outer, "README"), "outer\n");
    initGit(outer);
    const inner = join(outer, "inner");
    cpSync(w.src, inner, { recursive: true });
    mkdirSync(join(inner, ".git"));
    const enclosed = await capture(argv(w, inner, inner, ["--independent-source", inner]));
    expect(enclosed.code).toBe(4);
    expect(copiesOf(enclosed)[0]?.byLink).toBe(false);

    initGit(w.src);
    const proven = await capture(argv(w, w.src, w.src, ["--independent-source", w.src]));
    expect(proven.code).toBe(0);
    expect(copiesOf(proven)[0]?.byLink).toBe(true);
  });

  it.skipIf(process.platform === "win32")("7: a recorded path that is gone or loops is broken (5); one that cannot be inspected is wiring (2)", async () => {
    const w = world();
    const loopDir = join(w.work, "loopdir");
    symlinkSync(loopDir, loopDir);
    record(w, { plugins: { [`${PLUGIN}@hatsu`]: [{ installPath: join(loopDir, "copy") }] } });
    const loop = await capture(argv(w, w.src, "auto"));
    expect(loop.code).toBe(5);
    expect(copiesOf(loop)[0]?.reason).toMatch(/ELOOP/);
    if (noPerms) return;
    const fence = join(w.work, "fence");
    mkdirSync(fence);
    cpSync(w.src, join(fence, "copy"), { recursive: true });
    record(w, { plugins: { [`${PLUGIN}@hatsu`]: [{ installPath: join(fence, "copy") }] } });
    const fenced = await locked(fence, async () => capture(argv(w, w.src, "auto")));
    expect(fenced.code).toBe(2);
    expect(json(fenced)["verdict"]).toBe("wiring");
    expect(copiesOf(fenced)[0]?.reason).toMatch(/could not be inspected \(EACCES\)/);
  });

  it.skipIf(process.platform === "win32")("8: <config>/skills -- only ENOENT is absent; a loop is broken, a permission error wiring", async () => {
    const w = world();
    symlinkSync(join(w.cfg, "skills"), join(w.cfg, "skills"));
    const loop = await capture(argv(w, w.src, "auto"));
    expect(loop.code).toBe(5);
    expect(copiesOf(loop)[0]?.label).toBe(`skills/${PLUGIN}`);
    rmSync(join(w.cfg, "skills"));
    if (noPerms) return;
    mkdirSync(join(w.cfg, "skills"));
    symlinkSync(w.fresh("same"), join(w.cfg, "skills", PLUGIN));
    const fenced = await locked(join(w.cfg, "skills"), async () => capture(argv(w, w.src, "auto")));
    expect(fenced.code).toBe(2);
    expect(json(fenced)["verdict"]).toBe("wiring");
    expect(json(fenced)["verdict"]).not.toBe("not installed");
  });
});
