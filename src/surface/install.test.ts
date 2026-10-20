// src/surface/install.test.ts -- `nen surface install|status` (zheref/nen#298),
// through ../index.ts so the exits and the --json documents are the ones a
// caller gets.
//
// HERMETIC. Every checkout, config directory and link is a fresh temp dir;
// --config-dir is given on every run and HOME points into the fixture, so the
// host's own ~/.claude, ~/.codex and ~/.gemini are never read or written. Every
// `git`, `claude`, `codex` and `agy` call is SCRIPTED (../seam/scripted.ts): an
// unscripted call throws, so a verb that ran a mutating CLI nobody expected
// fails the test rather than reaching a real tool. Where a real CLI would
// change a registry file (an uninstall), the fixture makes that change itself,
// on the scripted call. The plugin is a made-up name: names are data.

import { describe, expect, it } from "vitest";
import { existsSync, lstatSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { CommandResult } from "../seam/exec.js";
import { statusTreesExit } from "./install-command.js";
import {
  normalizeRemote,
  commandText,
  install,
  shellQuote,
  type InstallInputs,
  codexEnabled,
  codexInstalledRoot,
  lastLine,
  parseClaudeList,
  parseCodexMarketplaces,
  parseCodexPlugins,
  readJsonObject,
  servedSelector,
  surfaceConfigDir,
  INSTALL_CONTRACT,
  STATUS_CONTRACT,
} from "./install.js";

const PLUGIN = "zephyr";
const MARKET = "zephyr-market";
const SKILLS_ID = `${PLUGIN}@skills-dir`;
const MARKET_ID = `${PLUGIN}@${MARKET}`;
const POSIX = process.platform !== "win32";

/** The re-point temporaries (`.<plugin>.nen-relink-<pid>-<random>`) left in `dir`: there should never be any. */
function temporaries(dir: string): string[] {
  return readdirSync(dir).filter((name): boolean => name.startsWith(`.${PLUGIN}.nen-relink-`));
}

/** Remove a directory link on the REAL host: a junction goes by rmdir, a symlink by unlink. */
function hostRemoveLink(path: string): void {
  if (POSIX) unlinkSync(path);
  else rmdirSync(path);
}

/** A directory link: a junction on Windows (no admin rights needed), a symlink elsewhere. */
function link(target: string, path: string): void {
  symlinkSync(target, path, POSIX ? undefined : "junction");
}

interface World {
  readonly work: string;
  readonly root: string;
  readonly cfg: string;
  readonly home: string;
  /** Another checkout of the same plugin. */
  readonly other: string;
}

function checkout(dir: string, version = "1.0.0", options: { overlay?: boolean; market?: boolean } = {}): string {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: PLUGIN, version }, null, 2));
  if (options.market !== false) {
    writeFileSync(join(dir, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: MARKET, plugins: [{ name: PLUGIN, source: "./" }] }, null, 2));
  }
  if (options.overlay !== false) {
    mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
    writeFileSync(join(dir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: PLUGIN, version }, null, 2));
  }
  mkdirSync(join(dir, "gen", "ag"), { recursive: true });
  writeFileSync(join(dir, "gen", "ag", "plugin.json"), JSON.stringify({ name: PLUGIN, version, description: "d" }, null, 2));
  mkdirSync(join(dir, "skills", "one"), { recursive: true });
  writeFileSync(join(dir, "skills", "one", "SKILL.md"), "one\n");
  return realpathSync.native(dir);
}

function world(): World {
  const work = realpathSync.native(mkdtempSync(join(tmpdir(), "nen-surface-install-")));
  const root = checkout(join(work, "root"));
  const other = checkout(join(work, "other"), "0.9.0");
  const cfg = join(work, "cfg");
  mkdirSync(cfg);
  const home = join(work, "home");
  mkdirSync(home);
  return { work, root, cfg, home, other };
}

const git = (top: string): ScriptedCall => ({ match: "git rev-parse --show-toplevel", result: { stdout: `${top}\n` } });
const ok = (match: string, stdout = ""): ScriptedCall => ({ match, result: { stdout } });
const claudeList = (entries: readonly Record<string, unknown>[]): ScriptedCall => ok("claude plugin list --json", JSON.stringify(entries, null, 2));
const servedLink = (w: World, extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  id: SKILLS_ID,
  version: "1.0.0",
  scope: "user",
  enabled: true,
  installPath: join(w.cfg, "skills", PLUGIN),
  ...extra,
});

/** A ScriptedSeams whose named calls also change the fixture, as the real CLI would. */
function seams(w: World, script: readonly ScriptedCall[], effects: Readonly<Record<string, () => void>> = {}): ScriptedSeams {
  const scripted = new ScriptedSeams(script, { env: { HOME: w.home }, platform: process.platform });
  const original = scripted.run;
  scripted.run = (command, args, options): CommandResult => {
    const result = original(command, args, options);
    effects[[command, ...args].join(" ")]?.();
    return result;
  };
  return scripted;
}

async function capture(argv: readonly string[], s: ScriptedSeams): Promise<{ code: number; out: string[]; err: string[]; doc: () => Record<string, unknown> }> {
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
  const code = await run(argv, io, s);
  return { code, out, err, doc: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

const installArgs = (w: World, surface: string, ...rest: string[]): string[] => [
  "surface",
  "install",
  "--surface",
  surface,
  "--plugin",
  PLUGIN,
  "--root",
  w.root,
  "--config-dir",
  w.cfg,
  ...rest,
];
const statusArgs = (w: World, surface: string, ...rest: string[]): string[] => [
  "surface",
  "status",
  "--surface",
  surface,
  "--plugin",
  PLUGIN,
  "--config-dir",
  w.cfg,
  ...rest,
];

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

const commandsOf = (s: ScriptedSeams): string[] => s.calls.map((call): string => [call.command, ...call.args].join(" "));

// ---------------------------------------------------------------------------
// parsers
// ---------------------------------------------------------------------------

describe("the tool-output parsers", () => {
  it("reads claude plugin list --json whole, refusing a shape it does not know", () => {
    expect(parseClaudeList('[{"id":"a@b","version":"1","enabled":true,"installPath":"/x"}]')).toEqual([{ id: "a@b", version: "1", enabled: true, installPath: "/x" }]);
    expect(parseClaudeList('[{"id":"a@b"}]')).toEqual([{ id: "a@b", version: null, enabled: null, installPath: null }]);
    expect(parseClaudeList("not json")).toBe("its output is not JSON");
    expect(parseClaudeList('{"id":"a"}')).toBe("its output is not a JSON array");
    expect(parseClaudeList("[1]")).toBe("element 0 is not an object");
    expect(parseClaudeList('[{"name":"a"}]')).toBe("element 0 carries no string 'id'");
  });

  it("reads every row of a 12,000-row codex list, the match at the very end (the SIGPIPE lesson)", () => {
    const filler = Array.from({ length: 12_000 }, (_, i): string => `filler${i}@plugin  installed, enabled  9.9.9  /nowhere/filler`).join("\n");
    const rows = parseCodexPlugins(`${filler}\n${MARKET_ID}  installed, enabled  1.0.0  /cache/zephyr/1.0.0\n`);
    expect(rows).toHaveLength(12_001);
    expect(rows[12_000]).toEqual({ id: MARKET_ID, status: "installed, enabled", version: "1.0.0", path: "/cache/zephyr/1.0.0" });
    const markets = parseCodexMarketplaces(`MARKETPLACE  ROOT\n${Array.from({ length: 12_000 }, (_, i): string => `m${i}  /r${i}`).join("\n")}\n${MARKET}        /my root\n`);
    expect(markets).toHaveLength(12_001);
    expect(markets[12_000]).toEqual({ name: MARKET, root: "/my root" });
  });

  it("reads a codex row in single-space columns, and a one-word status", () => {
    expect(parseCodexPlugins("a@b installed, enabled 1.0.0 /p")).toEqual([{ id: "a@b", status: "installed, enabled", version: "1.0.0", path: "/p" }]);
    expect(parseCodexPlugins("a@b available")).toEqual([{ id: "a@b", status: "available", version: null, path: null }]);
    expect(parseCodexPlugins("a@b available 2.0.0 /some path")).toEqual([{ id: "a@b", status: "available", version: "2.0.0", path: "/some path" }]);
    expect(parseCodexPlugins("PLUGIN  STATUS\r\n\r\n")).toEqual([]);
    expect(codexEnabled("installed, enabled")).toBe(true);
    expect(codexEnabled("Installed,Enabled")).toBe(true);
    expect(codexEnabled("installed, disabled")).toBe(false);
  });

  it("finds the first Installed plugin root line through any amount of output", () => {
    const noise = Array.from({ length: 5_000 }, (): string => "Downloading dependency filler...").join("\n");
    expect(codexInstalledRoot(`${noise}\nInstalled plugin root: /c/1\nInstalled plugin root: /c/2\n`)).toBe("/c/1");
    expect(codexInstalledRoot("nothing")).toBeNull();
  });

  it("quotes a last line inert, redacted and capped", () => {
    expect(lastLine("first\n\u001b[2Klast https://u:secret@host/x\n\n")).toBe("[2Klast https://u:***@host/x");
    expect(lastLine("")).toBe("(no output)");
    expect(lastLine("x".repeat(500))).toHaveLength(200);
  });

  it("reads a JSON object file: absent, read, or why not -- never a guess", () => {
    const w = world();
    expect(readJsonObject(join(w.work, "none.json"))).toEqual({ state: "absent" });
    writeFileSync(join(w.work, "a.json"), "[]");
    expect(readJsonObject(join(w.work, "a.json"))).toMatchObject({ state: "bad" });
    writeFileSync(join(w.work, "b.json"), "{");
    expect(readJsonObject(join(w.work, "b.json"))).toMatchObject({ state: "bad" });
    mkdirSync(join(w.work, "c.json"));
    expect(readJsonObject(join(w.work, "c.json"))).toMatchObject({ state: "bad" });
    if (POSIX) {
      symlinkSync(join(w.work, "gone"), join(w.work, "d.json"));
      expect(readJsonObject(join(w.work, "d.json"))).toMatchObject({ state: "bad" });
    }
    writeFileSync(join(w.work, "e.json"), "{}");
    expect(readJsonObject(join(w.work, "e.json"))).toEqual({ state: "read", value: {} });
  });

  it("resolves each surface's directory from the flag, its variable, then HOME", () => {
    expect(surfaceConfigDir("claude-code", "/f", {})).toBe("/f");
    expect(surfaceConfigDir("claude-code", null, { CLAUDE_CONFIG_DIR: "/c", HOME: "/h" })).toBe("/c");
    expect(surfaceConfigDir("claude-code", null, { HOME: "/h" })).toBe(join("/h", ".claude"));
    expect(surfaceConfigDir("codex", null, { CODEX_HOME: "/x", HOME: "/h" })).toBe("/x");
    expect(surfaceConfigDir("codex", null, { HOME: "/h" })).toBe(join("/h", ".codex"));
    expect(surfaceConfigDir("antigravity", null, { GEMINI_CONFIG_DIR: "/g" })).toBe("/g");
    expect(surfaceConfigDir("antigravity", null, { HOME: "/h" })).toBe(join("/h", ".gemini"));
    expect(surfaceConfigDir("antigravity", "/f", { HOME: "/h" })).toBe("/f");
  });

  it("selects the copies Claude Code serves: enabled marketplace copies win over the skills directory", () => {
    const none = servedSelector(PLUGIN, [MARKET_ID], {});
    expect(none(MARKET_ID)).toBe("not enabled in settings.json enabledPlugins");
    expect(none(SKILLS_ID)).toBeNull();
    const market = servedSelector(PLUGIN, [MARKET_ID], { [MARKET_ID]: true });
    expect(market(MARKET_ID)).toBeNull();
    expect(market(SKILLS_ID)).toMatch(/takes precedence/);
    const disabled = servedSelector(PLUGIN, [], { [SKILLS_ID]: false });
    expect(disabled(SKILLS_ID)).toBe("disabled in settings.json enabledPlugins");
  });
});

// ---------------------------------------------------------------------------
// install: refusals that need no surface
// ---------------------------------------------------------------------------

describe("surface install: usage and --root refusals (exit 2)", () => {
  it("refuses an unknown surface, a bad plugin name and missing flags", async () => {
    const w = world();
    for (const argv of [
      ["surface", "install", "--surface", "cursor", "--plugin", PLUGIN, "--root", w.root],
      ["surface", "install", "--surface", "codex", "--plugin", "a@b", "--root", w.root],
      ["surface", "install", "--surface", "codex", "--plugin", PLUGIN],
      ["surface", "install", "--plugin", PLUGIN, "--root", w.root],
      ["surface", "install", "--surface", "codex", "--plugin", PLUGIN, "--root", ""],
    ]) {
      const result = await capture(argv, seams(w, []));
      expect(result.code, argv.join(" ")).toBe(2);
    }
  });

  it("refuses a flag it does not read rather than ignoring it", async () => {
    const w = world();
    const result = await capture(installArgs(w, "claude-code", "--trees", "skills"), seams(w, []));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--trees is not read by 'surface install'/);
    const mirror = await capture(["surface", "mirror", "generate", "--source", w.root, "--surface", "codex", "--out", w.cfg, "--root", w.root], seams(w, []));
    expect(mirror.code).toBe(2);
  });

  it("refuses --surface-dir off antigravity, and requires it on antigravity", async () => {
    const w = world();
    expect((await capture(installArgs(w, "codex", "--surface-dir", "gen/ag"), seams(w, []))).code).toBe(2);
    const missing = await capture(installArgs(w, "antigravity"), seams(w, []));
    expect(missing.code).toBe(2);
    expect(missing.err.join("\n")).toMatch(/--surface-dir is required/);
  });

  it("refuses a --root that is no root of the plugin, not a checkout, not its toplevel, or a plugin cache", async () => {
    const w = world();
    const elsewhere = join(w.work, "elsewhere");
    mkdirSync(join(elsewhere, ".claude-plugin"), { recursive: true });
    writeFileSync(join(elsewhere, ".claude-plugin", "plugin.json"), '{"name":"another"}');
    const notPlugin = await capture(["surface", "install", "--surface", "codex", "--plugin", PLUGIN, "--root", elsewhere, "--config-dir", w.cfg], seams(w, []));
    expect(notPlugin.code).toBe(2);
    expect(notPlugin.err.join("\n")).toMatch(/is not a root of 'zephyr'/);

    const notDir = await capture(["surface", "install", "--surface", "codex", "--plugin", PLUGIN, "--root", join(w.work, "nope"), "--config-dir", w.cfg], seams(w, []));
    expect(notDir.code).toBe(2);

    const notGit = await capture(installArgs(w, "codex"), seams(w, [{ match: "git rev-parse --show-toplevel", result: { code: 128, stderr: "fatal: not a git repository" } }]));
    expect(notGit.code).toBe(2);
    expect(notGit.err.join("\n")).toMatch(/is not a git checkout .*not a git repository/);

    const noGit = await capture(installArgs(w, "codex"), seams(w, [{ match: "git rev-parse --show-toplevel", result: { spawnFailed: true, code: -1 } }]));
    expect(noGit.code).toBe(2);
    expect(noGit.err.join("\n")).toMatch(/git could not be started/);

    const notTop = await capture(installArgs(w, "codex"), seams(w, [git(w.work)]));
    expect(notTop.code).toBe(2);
    expect(notTop.err.join("\n")).toMatch(/not the toplevel/);

    const cache = checkout(join(w.work, "plugins", "cache", MARKET, PLUGIN, "1.0.0"));
    const cached = await capture(["surface", "install", "--surface", "codex", "--plugin", PLUGIN, "--root", cache, "--config-dir", w.cfg], seams(w, []));
    expect(cached.code).toBe(2);
    expect(cached.err.join("\n")).toMatch(/plugins\/cache\//);
  });
});

// ---------------------------------------------------------------------------
// install: claude-code
// ---------------------------------------------------------------------------

describe("surface install --surface claude-code", () => {
  it("links a fresh install, runs the CLI against --config-dir, and reads it back (exit 0)", async () => {
    const w = world();
    const s = seams(w, [git(w.root), ok("claude --version", "2.1.284"), claudeList([servedLink(w)])]);
    const result = await capture([...installArgs(w, "claude-code"), "--json"], s);
    expect(result.code).toBe(0);
    const dest = join(w.cfg, "skills", PLUGIN);
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(realpathSync.native(dest)).toBe(w.root);
    const doc = result.doc();
    expect(doc).toMatchObject({ contract: INSTALL_CONTRACT, verdict: "ok", exit: 0, link: "linked", destination: dest, readBack: { checked: true } });
    expect(doc["served"]).toMatchObject({ id: SKILLS_ID, version: "1.0.0" });
    expect(commandsOf(s)).toEqual(["git rev-parse --show-toplevel", "claude --version", "claude plugin list --json"]);
    for (const call of s.calls.filter((c): boolean => c.command === "claude")) expect(call.env).toEqual({ CLAUDE_CONFIG_DIR: w.cfg });
  });

  it("--dry-run writes nothing and runs no mutating or reading CLI step", async () => {
    const w = world();
    writeJson(join(w.cfg, "plugins", "installed_plugins.json"), { version: 2, plugins: { [MARKET_ID]: [{ installPath: "/x" }] } });
    writeJson(join(w.cfg, "plugins", "known_marketplaces.json"), { [MARKET]: { source: { source: "directory", path: w.root } } });
    const s = seams(w, [git(w.root), ok("claude --version")]);
    const result = await capture([...installArgs(w, "claude-code"), "--dry-run"], s);
    expect(result.code).toBe(0);
    expect(existsSync(join(w.cfg, "skills"))).toBe(false);
    expect(commandsOf(s)).toEqual(["git rev-parse --show-toplevel", "claude --version"]);
    const text = result.out.join("\n");
    expect(text).toMatch(/would link: .*skills[\\/]zephyr -> /);
    expect(text).toMatch(/would run: claude plugin uninstall zephyr@zephyr-market/);
    expect(text).toMatch(/would run: claude plugin marketplace remove zephyr-market/);
    expect(text).toMatch(/read back: NOT CHECKED/);
  });

  it("reports an already-correct link unchanged, and re-points one of ours from another checkout", async () => {
    const w = world();
    const dest = join(w.cfg, "skills", PLUGIN);
    mkdirSync(join(w.cfg, "skills"));
    link(w.root, dest);
    const same = await capture([...installArgs(w, "claude-code"), "--json"], seams(w, [git(w.root), ok("claude --version"), claudeList([servedLink(w)])]));
    expect(same.code).toBe(0);
    expect(same.doc()).toMatchObject({ link: "already linked", steps: [] });

    const v = world();
    const destV = join(v.cfg, "skills", PLUGIN);
    mkdirSync(join(v.cfg, "skills"));
    link(v.other, destV);
    const moved = await capture([...installArgs(v, "claude-code"), "--json"], seams(v, [git(v.root), ok("claude --version"), claudeList([servedLink(v)])]));
    expect(moved.code).toBe(0);
    expect(moved.doc()).toMatchObject({ link: "re-pointed", previous: v.other });
    expect(realpathSync.native(destV)).toBe(v.root);
    expect(temporaries(join(v.cfg, "skills"))).toEqual([]);
  });

  it("never replaces what it did not make: a real directory, a file, a foreign or dangling link (exit 3, untouched)", async () => {
    const cases: Array<[string, (dest: string, w: World) => void, RegExp]> = [
      ["a real directory", (dest): void => mkdirSync(dest), /a real directory/],
      ["a file", (dest): void => writeFileSync(dest, "mine"), /a file/],
      ["a foreign link", (dest, w): void => link(w.work, dest), /no root of 'zephyr'/],
      ["a dangling link", (dest, w): void => symlinkSync(join(w.work, "gone"), dest), /does not resolve/],
    ];
    for (const [name, make, why] of cases) {
      if (!POSIX && name === "a dangling link") continue;
      const w = world();
      const dest = join(w.cfg, "skills", PLUGIN);
      mkdirSync(join(w.cfg, "skills"));
      make(dest, w);
      const before = lstatSync(dest);
      const s = seams(w, [git(w.root), ok("claude --version")]);
      const result = await capture([...installArgs(w, "claude-code"), "--json"], s);
      expect(result.code, name).toBe(3);
      expect(result.doc(), name).toMatchObject({ verdict: "refused", exit: 3, steps: [] });
      expect(String(result.doc()["reason"]), name).toMatch(why);
      expect(lstatSync(dest).ino, name).toBe(before.ino);
      if (before.isSymbolicLink()) expect(readlinkSync(dest)).toBeTruthy();
      // R2: the plan refuses before the CLI is probed.
      expect(commandsOf(s), name).toEqual(["git rev-parse --show-toplevel"]);
    }
  });

  it("hands over a prior marketplace install from the checkout's own marketplace, reading each step back", async () => {
    const w = world();
    const record = join(w.cfg, "plugins", "installed_plugins.json");
    const known = join(w.cfg, "plugins", "known_marketplaces.json");
    writeJson(record, { version: 2, plugins: { [MARKET_ID]: [{ installPath: join(w.cfg, "plugins", "cache", MARKET, PLUGIN, "0.9.0") }] } });
    writeJson(known, { [MARKET]: { source: { source: "directory", path: w.root } } });
    const s = seams(
      w,
      [git(w.root), ok("claude --version"), ok(`claude plugin uninstall ${MARKET_ID}`), ok(`claude plugin marketplace remove ${MARKET}`), claudeList([servedLink(w)])],
      {
        [`claude plugin uninstall ${MARKET_ID}`]: (): void => writeJson(record, { version: 2, plugins: {} }),
        [`claude plugin marketplace remove ${MARKET}`]: (): void => writeJson(known, {}),
      },
    );
    const result = await capture([...installArgs(w, "claude-code"), "--json"], s);
    expect(result.code).toBe(0);
    expect(commandsOf(s)).toEqual([
      "git rev-parse --show-toplevel",
      "claude --version",
      `claude plugin uninstall ${MARKET_ID}`,
      `claude plugin marketplace remove ${MARKET}`,
      "claude plugin list --json",
    ]);
    const steps = result.doc()["steps"] as Array<{ kind: string; done: boolean }>;
    expect(steps.map((step): string => step.kind)).toEqual(["mkdir", "link", "run", "run"]);
    expect(steps.every((step): boolean => step.done)).toBe(true);
  });

  it("fails when an uninstall or a marketplace removal does not take (exit 1)", async () => {
    const w = world();
    writeJson(join(w.cfg, "plugins", "installed_plugins.json"), { version: 2, plugins: { [MARKET_ID]: [{ installPath: "/x" }] } });
    const stuck = await capture([...installArgs(w, "claude-code"), "--json"], seams(w, [git(w.root), ok("claude --version"), ok(`claude plugin uninstall ${MARKET_ID}`)]));
    expect(stuck.code).toBe(1);
    expect(String(stuck.doc()["reason"])).toMatch(/still recorded in installed_plugins.json/);

    const v = world();
    const recordV = join(v.cfg, "plugins", "installed_plugins.json");
    writeJson(recordV, { version: 2, plugins: { [MARKET_ID]: [{ installPath: "/x" }] } });
    writeJson(join(v.cfg, "plugins", "known_marketplaces.json"), { [MARKET]: { source: { source: "directory", path: v.root } } });
    const kept = await capture(
      [...installArgs(v, "claude-code"), "--json"],
      seams(v, [git(v.root), ok("claude --version"), ok(`claude plugin uninstall ${MARKET_ID}`), ok(`claude plugin marketplace remove ${MARKET}`)], {
        [`claude plugin uninstall ${MARKET_ID}`]: (): void => writeJson(recordV, { version: 2, plugins: {} }),
      }),
    );
    expect(kept.code).toBe(1);
    expect(String(kept.doc()["reason"])).toMatch(/still records zephyr-market/);

    const x = world();
    writeJson(join(x.cfg, "plugins", "installed_plugins.json"), { version: 2, plugins: { [MARKET_ID]: [{ installPath: "/x" }] } });
    const refused = await capture(
      [...installArgs(x, "claude-code"), "--json"],
      seams(x, [git(x.root), ok("claude --version"), { match: `claude plugin uninstall ${MARKET_ID}`, result: { code: 1, stderr: "Error: plugin is locked" } }]),
    );
    expect(refused.code).toBe(1);
    expect(String(refused.doc()["reason"])).toBe(`claude plugin uninstall ${MARKET_ID} failed: Error: plugin is locked`);
  });

  it("never edits settings.json: a declaration still standing is an action owed, with its command (exit 4)", async () => {
    const w = world();
    const settings = join(w.cfg, "settings.json");
    writeJson(settings, {
      enabledPlugins: { [MARKET_ID]: true, [SKILLS_ID]: false, "other@x": true },
      extraKnownMarketplaces: { [MARKET]: { source: { source: "git", url: "https://example.invalid/x.git" } } },
    });
    const before = readFileSync(settings, "utf8");
    const result = await capture([...installArgs(w, "claude-code"), "--json"], seams(w, [git(w.root), ok("claude --version"), claudeList([servedLink(w)])]));
    expect(result.code).toBe(4);
    expect(readFileSync(settings, "utf8")).toBe(before);
    const doc = result.doc();
    expect(doc["verdict"]).toBe("owed");
    const actions = doc["actions"] as Array<{ what: string; command: string | null }>;
    // The directory is shell-quoted as any token is: a Windows path carries '\\'.
    const dir = shellQuote(w.cfg);
    expect(actions.map((action): string | null => action.command)).toEqual([
      `CLAUDE_CONFIG_DIR=${dir} claude plugin disable ${MARKET_ID} --scope user`,
      `CLAUDE_CONFIG_DIR=${dir} claude plugin enable ${SKILLS_ID} --scope user`,
      `CLAUDE_CONFIG_DIR=${dir} claude plugin marketplace remove ${MARKET}`,
    ]);
    const text = await capture(installArgs(w, "claude-code"), seams(w, [git(w.root), ok("claude --version"), claudeList([servedLink(w)])]));
    expect(text.out.join("\n")).toMatch(/action owed: .*enables zephyr@zephyr-market[\s\S]*run: CLAUDE_CONFIG_DIR=/);
  });

  it("names the config directory in a suggested command only when it is not the default", async () => {
    const w = world();
    const cfg = join(w.home, ".claude");
    mkdirSync(cfg);
    writeJson(join(cfg, "settings.json"), { enabledPlugins: { [MARKET_ID]: true } });
    const s = seams(w, [git(w.root), ok("claude --version"), claudeList([{ ...servedLink(w), installPath: join(cfg, "skills", PLUGIN) }])]);
    const result = await capture(["surface", "install", "--surface", "claude-code", "--plugin", PLUGIN, "--root", w.root, "--json"], s);
    expect(result.code).toBe(4);
    expect((result.doc()["actions"] as Array<{ command: string }>)[0]?.command).toBe(`claude plugin disable ${MARKET_ID} --scope user`);
    // N12: the default directory is the CLI's own, so it is never passed on.
    expect(s.calls.filter((call): boolean => call.command === "claude").map((call) => call.env)).toEqual([{}, {}]);
  });

  it("refuses a marketplace copy from a marketplace the checkout does not publish (exit 3, nothing linked)", async () => {
    const w = world();
    writeJson(join(w.cfg, "plugins", "installed_plugins.json"), { version: 2, plugins: { [`${PLUGIN}@elsewhere`]: [{ installPath: "/x" }] } });
    const result = await capture([...installArgs(w, "claude-code"), "--json"], seams(w, [git(w.root)]));
    expect(result.code).toBe(3);
    expect(String(result.doc()["reason"])).toMatch(/zephyr@elsewhere is installed from a marketplace this checkout does not publish/);
    expect(existsSync(join(w.cfg, "skills"))).toBe(false);
  });

  it("refuses before linking when claude is missing and a handover is owed (exit 5)", async () => {
    const w = world();
    writeJson(join(w.cfg, "settings.json"), { enabledPlugins: { [MARKET_ID]: true } });
    const result = await capture([...installArgs(w, "claude-code"), "--json"], seams(w, [git(w.root), { match: "claude --version", result: { spawnFailed: true, code: -1, stderr: "spawn claude ENOENT" } }]));
    expect(result.code).toBe(5);
    expect(String(result.doc()["reason"])).toMatch(/claude could not be started, and a handover is owed .*a change is owed/);
    expect(existsSync(join(w.cfg, "skills"))).toBe(false);
  });

  it("links when claude is missing and nothing is owed, but never calls that clean (exit 5, NOT CHECKED)", async () => {
    const w = world();
    const result = await capture(installArgs(w, "claude-code"), seams(w, [git(w.root), { match: "claude --version", result: { spawnFailed: true, code: -1 } }]));
    expect(result.code).toBe(5);
    expect(realpathSync.native(join(w.cfg, "skills", PLUGIN))).toBe(w.root);
    expect(result.out.join("\n")).toMatch(/read back: NOT CHECKED/);
    const v = world();
    const dry = await capture([...installArgs(v, "claude-code"), "--dry-run"], seams(v, [git(v.root), { match: "claude --version", result: { spawnFailed: true, code: -1 } }]));
    expect(dry.code).toBe(5);
    expect(existsSync(join(v.cfg, "skills"))).toBe(false);
  });

  it("refuses (exit 2) when a Claude Code file cannot be trusted, before anything is linked", async () => {
    for (const [file, content] of [
      ["settings.json", "{ not json"],
      ["settings.json", '{"enabledPlugins": []}'],
      [join("plugins", "installed_plugins.json"), "nope"],
      [join("plugins", "known_marketplaces.json"), "[]"],
    ] as const) {
      const w = world();
      mkdirSync(join(w.cfg, "plugins"), { recursive: true });
      writeFileSync(join(w.cfg, file), content);
      const result = await capture(installArgs(w, "claude-code"), seams(w, [git(w.root)]));
      expect(result.code, `${file}: ${content}`).toBe(2);
      expect(existsSync(join(w.cfg, "skills")), file).toBe(false);
    }
  });

  it("fails the read-back on a shadow still enabled, a missing entry, another path, another version, a broken list (exit 1)", async () => {
    const cases: Array<[string, (w: World) => ScriptedCall, RegExp]> = [
      ["shadow", (w): ScriptedCall => claudeList([servedLink(w), { id: MARKET_ID, enabled: true, installPath: "/c" }]), /still shows zephyr@zephyr-market enabled/],
      ["missing", (): ScriptedCall => claudeList([]), /no zephyr@skills-dir entry/],
      ["disabled", (w): ScriptedCall => claudeList([servedLink(w, { enabled: false })]), /shows zephyr@skills-dir not enabled/],
      ["no served version", (w): ScriptedCall => claudeList([servedLink(w, { version: null })]), /reports no version for zephyr@skills-dir/],
      ["elsewhere", (w): ScriptedCall => claudeList([servedLink(w, { installPath: w.other })]), /which is not/],
      ["version", (w): ScriptedCall => claudeList([servedLink(w, { version: "0.1.0" })]), /serves version 0.1.0/],
      ["not json", (): ScriptedCall => ok("claude plugin list --json", "Plugins:\n  zephyr"), /could not be read: its output is not JSON/],
      ["exit", (): ScriptedCall => ({ match: "claude plugin list --json", result: { code: 2, stderr: "boom" } }), /failed: boom/],
      ["signal", (): ScriptedCall => ({ match: "claude plugin list --json", result: { code: 1, signal: "SIGPIPE", stdout: "[" } }), /killed by SIGPIPE/],
    ];
    for (const [name, list, why] of cases) {
      const w = world();
      const result = await capture([...installArgs(w, "claude-code"), "--json"], seams(w, [git(w.root), ok("claude --version"), list(w)]));
      expect(result.code, name).toBe(1);
      expect(String(result.doc()["reason"]), name).toMatch(why);
    }
  });

  it("fails on a claude that runs and refuses --version (exit 1), and on a marketplace.json it cannot read (exit 2)", async () => {
    const w = world();
    const broken = await capture(installArgs(w, "claude-code"), seams(w, [git(w.root), { match: "claude --version", result: { code: 3, stderr: "bad config" } }]));
    expect(broken.code).toBe(1);
    const v = world();
    writeFileSync(join(v.root, ".claude-plugin", "marketplace.json"), '{"name":"a b"}');
    expect((await capture(installArgs(v, "claude-code"), seams(v, [git(v.root)]))).code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// install: codex
// ---------------------------------------------------------------------------

const HEADER = "MARKETPLACE  ROOT";
const fillerPlugins = Array.from({ length: 12_000 }, (_, i): string => `filler${i}@plugin  installed, enabled  9.9.9  /nowhere/filler`).join("\n");
const fillerMarkets = Array.from({ length: 12_000 }, (_, i): string => `filler-market${i}  /nowhere/${i}`).join("\n");

describe("surface install --surface codex", () => {
  it("adds the checkout's marketplace, installs from it and reads the version back through 12,000 rows (exit 0)", async () => {
    const w = world();
    const cache = join(w.cfg, "plugins", "cache", MARKET, PLUGIN, "1.0.0");
    const s = seams(w, [
      git(w.root),
      ok("codex plugin list", `${fillerPlugins}\n`),
      ok("codex plugin marketplace list", `${HEADER}\n${fillerMarkets}\n`),
      ok(`codex plugin marketplace add ${w.root}`, `Added marketplace \`${MARKET}\``),
      ok("codex plugin marketplace list", `${HEADER}\n${fillerMarkets}\n${MARKET}  ${w.root}\n`),
      ok(`codex plugin add ${MARKET_ID}`, `${"Downloading dependency filler...\n".repeat(3000)}Installed plugin root: ${cache}\n`),
      ok("codex plugin list", `${fillerPlugins}\n${MARKET_ID}  installed, enabled  1.0.0  ${cache}\n`),
    ]);
    const result = await capture([...installArgs(w, "codex"), "--json"], s);
    expect(result.code).toBe(0);
    const doc = result.doc();
    expect(doc).toMatchObject({ verdict: "ok", destination: null, link: null, served: { id: MARKET_ID, version: "1.0.0", path: cache } });
    expect(String((doc["readBack"] as { detail: string }).detail)).toMatch(/compared against .codex-plugin\/plugin.json/);
    for (const call of s.calls.filter((c): boolean => c.command === "codex")) expect(call.env).toEqual({ CODEX_HOME: w.cfg });
  });

  it("does not add a marketplace already at this checkout, and compares against the Claude manifest with no overlay", async () => {
    const w = world();
    const root = checkout(join(w.work, "plain"), "2.0.0", { overlay: false });
    const s = seams(w, [git(root), ok("codex plugin list", ""), ok("codex plugin marketplace list", `${HEADER}\n${MARKET}  ${root}\n`), ok(`codex plugin add ${MARKET_ID}`), ok("codex plugin list", `${MARKET_ID}  installed, enabled  2.0.0  /c\n`)]);
    const result = await capture(["surface", "install", "--surface", "codex", "--plugin", PLUGIN, "--root", root, "--config-dir", w.cfg], s);
    expect(result.code).toBe(0);
    expect(commandsOf(s)).not.toContain(`codex plugin marketplace add ${root}`);
    expect(result.out.join("\n")).toMatch(/compared against .claude-plugin\/plugin.json/);
  });

  it("refuses a same-named marketplace at another root (exit 3), adding nothing", async () => {
    const w = world();
    const s = seams(w, [git(w.root), ok("codex plugin list", ""), ok("codex plugin marketplace list", `${HEADER}\n${MARKET}  ${w.other}\n`)]);
    const result = await capture([...installArgs(w, "codex"), "--json"], s);
    expect(result.code).toBe(3);
    expect(String(result.doc()["reason"])).toMatch(/already points at/);
    expect(commandsOf(s)).toHaveLength(3);
  });

  it("fails the read-back on a wrong version, a disabled row, a missing row, an add that did not register (exit 1)", async () => {
    const at = (w: World): ScriptedCall => ok("codex plugin marketplace list", `${HEADER}\n${MARKET}  ${w.root}\n`);
    const cases: Array<[string, (w: World) => ScriptedCall[], RegExp]> = [
      ["version", (w): ScriptedCall[] => [at(w), ok(`codex plugin add ${MARKET_ID}`), ok("codex plugin list", `${MARKET_ID}  installed, enabled  0.9.0  /c`)], /at 0.9.0, but .codex-plugin\/plugin.json says 1.0.0/],
      ["disabled", (w): ScriptedCall[] => [at(w), ok(`codex plugin add ${MARKET_ID}`), ok("codex plugin list", `${MARKET_ID}  installed, disabled  1.0.0  /c`)], /expected installed and enabled/],
      ["missing", (w): ScriptedCall[] => [at(w), ok(`codex plugin add ${MARKET_ID}`), ok("codex plugin list", fillerPlugins)], /no zephyr@zephyr-market row/],
      ["no version", (w): ScriptedCall[] => [at(w), ok(`codex plugin add ${MARKET_ID}`), ok("codex plugin list", `${MARKET_ID}  installed, enabled`)], /reports no version for zephyr@zephyr-market/],
      ["unregistered", (w): ScriptedCall[] => [ok("codex plugin marketplace list", HEADER), ok(`codex plugin marketplace add ${w.root}`), ok("codex plugin marketplace list", HEADER)], /does not show 'zephyr-market'/],
      ["add fails", (w): ScriptedCall[] => [at(w), { match: `codex plugin add ${MARKET_ID}`, result: { code: 1, stdout: "Error: network down\n" } }], /codex plugin add zephyr@zephyr-market failed: Error: network down/],
    ];
    for (const [name, script, why] of cases) {
      const w = world();
      const result = await capture([...installArgs(w, "codex"), "--json"], seams(w, [git(w.root), ok("codex plugin list", ""), ...script(w)]));
      expect(result.code, name).toBe(1);
      expect(String(result.doc()["reason"]), name).toMatch(why);
    }
  });

  it("reports codex missing (exit 5), and refuses a checkout with no marketplace or an unversioned overlay (exit 2)", async () => {
    const w = world();
    const missing = await capture([...installArgs(w, "codex"), "--json"], seams(w, [git(w.root), { match: "codex plugin list", result: { spawnFailed: true, code: -1 } }]));
    expect(missing.code).toBe(5);

    const bare = checkout(join(w.work, "bare"), "1.0.0", { market: false });
    expect((await capture(["surface", "install", "--surface", "codex", "--plugin", PLUGIN, "--root", bare, "--config-dir", w.cfg], seams(w, [git(bare)]))).code).toBe(2);

    const v = world();
    writeFileSync(join(v.root, ".codex-plugin", "plugin.json"), '{"name":"zephyr"}');
    expect((await capture(installArgs(v, "codex"), seams(v, [git(v.root)]))).code).toBe(2);

    const x = world();
    writeFileSync(join(x.root, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: MARKET, plugins: [{ name: "else" }] }));
    expect((await capture(installArgs(x, "codex"), seams(x, [git(x.root)]))).code).toBe(2);
  });

  it("--dry-run reads the marketplace list and runs nothing that changes the host", async () => {
    const w = world();
    const s = seams(w, [git(w.root), ok("codex plugin list", ""), ok("codex plugin marketplace list", HEADER)]);
    const result = await capture([...installArgs(w, "codex"), "--dry-run"], s);
    expect(result.code).toBe(0);
    expect(commandsOf(s)).toEqual(["git rev-parse --show-toplevel", "codex plugin list", "codex plugin marketplace list"]);
    expect(result.out.join("\n")).toMatch(/would run: codex plugin marketplace add [\s\S]*would run: codex plugin add zephyr@zephyr-market/);
  });
});

// ---------------------------------------------------------------------------
// install: antigravity
// ---------------------------------------------------------------------------

describe("surface install --surface antigravity", () => {
  it("links <root>/<surface-dir> into the global plugins directory and validates it (exit 0)", async () => {
    const w = world();
    const dest = join(w.cfg, "config", "plugins", PLUGIN);
    const s = seams(w, [git(w.root), ok(`agy plugin validate ${dest}`, "[ok]")]);
    const result = await capture([...installArgs(w, "antigravity", "--surface-dir", "gen/ag"), "--json"], s);
    expect(result.code).toBe(0);
    expect(realpathSync.native(dest)).toBe(join(w.root, "gen", "ag"));
    expect(result.doc()).toMatchObject({ verdict: "ok", served: { version: "1.0.0" }, readBack: { checked: true } });
  });

  it("re-points a link to another checkout's surface dir; agy missing is tool missing (exit 5, N9)", async () => {
    const w = world();
    const dest = join(w.cfg, "config", "plugins", PLUGIN);
    mkdirSync(join(w.cfg, "config", "plugins"), { recursive: true });
    link(join(w.other, "gen", "ag"), dest);
    const result = await capture([...installArgs(w, "antigravity", "--surface-dir", "gen/ag"), "--json"], seams(w, [git(w.root), { match: `agy plugin validate ${dest}`, result: { spawnFailed: true, code: -1 } }]));
    expect(result.code).toBe(5);
    expect(result.doc()).toMatchObject({ link: "re-pointed", verdict: "tool missing", readBack: { checked: false } });
    expect(realpathSync.native(dest)).toBe(join(w.root, "gen", "ag"));
  });

  it("refuses a copy agy installed (a real directory) and a link to another checkout's root (exit 3)", async () => {
    const w = world();
    const dest = join(w.cfg, "config", "plugins", PLUGIN);
    mkdirSync(dest, { recursive: true });
    expect((await capture(installArgs(w, "antigravity", "--surface-dir", "gen/ag"), seams(w, [git(w.root)]))).code).toBe(3);
    const v = world();
    const destV = join(v.cfg, "config", "plugins", PLUGIN);
    mkdirSync(join(v.cfg, "config", "plugins"), { recursive: true });
    link(v.other, destV);
    expect((await capture(installArgs(v, "antigravity", "--surface-dir", "gen/ag"), seams(v, [git(v.root)]))).code).toBe(3);
  });

  it("fails when agy plugin validate rejects the link (exit 1)", async () => {
    const w = world();
    const dest = join(w.cfg, "config", "plugins", PLUGIN);
    const result = await capture([...installArgs(w, "antigravity", "--surface-dir", "gen/ag"), "--json"], seams(w, [git(w.root), { match: `agy plugin validate ${dest}`, result: { code: 1, stdout: "[error] skills: 0 processed" } }]));
    expect(result.code).toBe(1);
    expect(String(result.doc()["reason"])).toMatch(/agy plugin validate .* failed: \[error\] skills: 0 processed/);
  });

  it("refuses a --surface-dir that leaves the checkout, is no directory, or holds no plugin.json naming the plugin (exit 2)", async () => {
    const w = world();
    mkdirSync(join(w.root, "empty"));
    for (const dir of ["../x", "/abs", "gen/none", "empty", "gen/./ag"]) {
      expect((await capture(installArgs(w, "antigravity", "--surface-dir", dir), seams(w, [git(w.root)]))).code, dir).toBe(2);
    }
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe("surface status --surface claude-code", () => {
  it("reports what is served, and that it is this checkout at its version (exit 0)", async () => {
    const w = world();
    mkdirSync(join(w.cfg, "skills"));
    link(w.root, join(w.cfg, "skills", PLUGIN));
    const s = seams(w, [claudeList([servedLink(w), { id: "unrelated@x", enabled: true }])]);
    const result = await capture([...statusArgs(w, "claude-code", "--root", w.root), "--json"], s);
    expect(result.code).toBe(0);
    expect(result.doc()).toMatchObject({ contract: STATUS_CONTRACT, verdict: "serving", exit: 0, served: [{ id: SKILLS_ID, version: "1.0.0" }] });
    expect(String(result.doc()["link"])).toBe(`linked to ${w.root}`);
    expect(commandsOf(s)).toEqual(["claude plugin list --json"]);
  });

  it("reports a mismatch: another checkout, another version, a shadow (exit 1)", async () => {
    const w = world();
    const cases: Array<[string, readonly Record<string, unknown>[], RegExp]> = [
      ["cache", [{ id: MARKET_ID, version: "1.0.0", enabled: true, installPath: w.other }], /not /],
      ["version", [servedLink(w, { version: "0.5.0" })], /at version 0.5.0/],
      ["shadow", [servedLink(w), { id: MARKET_ID, enabled: true, installPath: w.other }], /another enabled copy shadows it/],
    ];
    mkdirSync(join(w.cfg, "skills"));
    link(w.root, join(w.cfg, "skills", PLUGIN));
    for (const [name, entries, why] of cases) {
      const result = await capture([...statusArgs(w, "claude-code", "--root", w.root), "--json"], seams(w, [claudeList(entries)]));
      expect(result.code, name).toBe(1);
      expect(String(result.doc()["reason"]), name).toMatch(why);
    }
  });

  it("warns of a reload that would bring a marketplace copy back", async () => {
    const w = world();
    writeJson(join(w.cfg, "settings.json"), { enabledPlugins: { [MARKET_ID]: true }, extraKnownMarketplaces: { [MARKET]: {} } });
    const result = await capture([...statusArgs(w, "claude-code", "--root", w.root), "--json"], seams(w, [claudeList([])]));
    expect(result.code).toBe(3);
    const warnings = result.doc()["warnings"] as string[];
    expect(warnings.join("\n")).toMatch(/enables zephyr@zephyr-market/);
    expect(warnings.join("\n")).toMatch(/extraKnownMarketplaces.zephyr-market/);
  });

  it("is not installed (3), tool missing (5), wiring on a failed list or untrusted settings (2)", async () => {
    const w = world();
    expect((await capture(statusArgs(w, "claude-code"), seams(w, [claudeList([{ id: SKILLS_ID, enabled: false }])]))).code).toBe(3);
    const missing = await capture(statusArgs(w, "claude-code"), seams(w, [{ match: "claude plugin list --json", result: { spawnFailed: true, code: -1 } }]));
    expect(missing.code).toBe(5);
    expect(missing.out.join("\n")).toMatch(/read back: NOT CHECKED/);
    expect((await capture(statusArgs(w, "claude-code"), seams(w, [{ match: "claude plugin list --json", result: { code: 1, stderr: "x" } }]))).code).toBe(2);
    expect((await capture(statusArgs(w, "claude-code"), seams(w, [ok("claude plugin list --json", "{}")]))).code).toBe(2);
    writeFileSync(join(w.cfg, "settings.json"), "{");
    expect((await capture(statusArgs(w, "claude-code"), seams(w, [claudeList([])]))).code).toBe(2);
  });

  it("--trees judges only the copies Claude Code serves (zheref/nen#339's deferral)", async () => {
    const w = world();
    const source = checkout(join(w.work, "source"));
    const cache = join(w.cfg, "plugins", "cache", MARKET, PLUGIN, "0.9.0");
    checkout(cache, "0.9.0");
    writeJson(join(w.cfg, "plugins", "installed_plugins.json"), { version: 2, plugins: { [MARKET_ID]: [{ installPath: cache }] } });
    mkdirSync(join(w.cfg, "skills"));
    link(w.root, join(w.cfg, "skills", PLUGIN));

    // Not enabled: the marketplace copy is set aside, the skills link judged identical to --source.
    const linkServed = await capture([...statusArgs(w, "claude-code", "--trees", "skills", "--source", source), "--json"], seams(w, [claudeList([servedLink(w)])]));
    expect(linkServed.code).toBe(0);
    const judgement = linkServed.doc()["judgement"] as { verdict: string; copies: Array<{ label: string }>; skipped: Array<{ label: string; reason: string }> };
    expect(judgement.verdict).toBe("identical");
    expect(judgement.copies.map((copy): string => copy.label)).toEqual([`skills/${PLUGIN}`]);
    expect(judgement.skipped).toEqual([{ label: `the ${MARKET_ID} entry`, reason: "not enabled in settings.json enabledPlugins" }]);

    // Enabled: the stale marketplace copy is what is served, and it is judged different.
    writeJson(join(w.cfg, "settings.json"), { enabledPlugins: { [MARKET_ID]: true } });
    const cacheServed = await capture([...statusArgs(w, "claude-code", "--trees", "skills", "--root", source), "--json"], seams(w, [claudeList([{ id: MARKET_ID, enabled: true, version: "0.9.0", installPath: cache }])]));
    expect(cacheServed.code).toBe(1);
    const second = cacheServed.doc()["judgement"] as { verdict: string; skipped: Array<{ reason: string }> };
    expect(second.verdict).toBe("different");
    expect(second.skipped[0]?.reason).toMatch(/takes precedence/);
    const text = await capture(statusArgs(w, "claude-code", "--trees", "skills", "--root", source), seams(w, [claudeList([])]));
    expect(text.out.join("\n")).toMatch(/judged \(the served copies only\):[\s\S]*skipped -- skills\/zephyr/);
  });

  it("refuses judge flags without --trees, --trees off claude-code, and --trees with no source", async () => {
    const w = world();
    expect((await capture(statusArgs(w, "claude-code", "--source", w.root), seams(w, []))).code).toBe(2);
    expect((await capture(statusArgs(w, "codex", "--trees", "skills"), seams(w, []))).code).toBe(2);
    expect((await capture(statusArgs(w, "claude-code", "--trees", "skills"), seams(w, []))).code).toBe(2);
    expect((await capture(statusArgs(w, "claude-code", "--trees", "nope", "--root", w.root), seams(w, []))).code).toBe(2);
    expect((await capture(statusArgs(w, "claude-code", "--surface-dir", "gen/ag"), seams(w, []))).code).toBe(2);
    expect((await capture(statusArgs(w, "claude-code", "--root", w.work), seams(w, []))).code).toBe(2);
    expect((await capture(statusArgs(w, "claude-code", "--dry-run"), seams(w, []))).code).toBe(2);
  });
});

describe("surface status --surface codex", () => {
  it("reads the served row through 12,000 rows, and its marketplace root (exit 0)", async () => {
    const w = world();
    const s = seams(w, [ok("codex plugin list", `${fillerPlugins}\n${MARKET_ID}  installed, enabled  1.0.0  /c\n`), ok("codex plugin marketplace list", `${HEADER}\n${fillerMarkets}\n${MARKET}  ${w.root}\n`)]);
    const result = await capture([...statusArgs(w, "codex", "--root", w.root), "--json"], s);
    expect(result.code).toBe(0);
    expect(result.doc()).toMatchObject({ verdict: "serving", served: [{ id: MARKET_ID, version: "1.0.0", status: "installed, enabled" }] });
  });

  it("reports a mismatch: another marketplace root, another version, another id (exit 1)", async () => {
    const w = world();
    const cases: Array<[string, string, string, RegExp]> = [
      ["root", `${MARKET_ID}  installed, enabled  1.0.0  /c`, `${MARKET}  ${w.other}`, /is at .*, not /],
      ["version", `${MARKET_ID}  installed, enabled  0.2.0  /c`, `${MARKET}  ${w.root}`, /at 0.2.0, but/],
      ["id", `${PLUGIN}@else  installed, enabled  1.0.0  /c`, `else  ${w.root}`, /not zephyr@zephyr-market/],
    ];
    for (const [name, row, market, why] of cases) {
      const result = await capture([...statusArgs(w, "codex", "--root", w.root), "--json"], seams(w, [ok("codex plugin list", row), ok("codex plugin marketplace list", `${HEADER}\n${market}`)]));
      expect(result.code, name).toBe(1);
      expect(String(result.doc()["reason"]), name).toMatch(why);
    }
  });

  it("is not installed (3), tool missing (5), wiring on a failed list (2)", async () => {
    const w = world();
    expect((await capture(statusArgs(w, "codex"), seams(w, [ok("codex plugin list", `${MARKET_ID}  installed, disabled  1.0.0`), ok("codex plugin marketplace list", HEADER)]))).code).toBe(3);
    expect((await capture(statusArgs(w, "codex"), seams(w, [{ match: "codex plugin list", result: { spawnFailed: true, code: -1 } }]))).code).toBe(5);
    expect((await capture(statusArgs(w, "codex"), seams(w, [{ match: "codex plugin list", result: { code: 2, stderr: "bad" } }]))).code).toBe(2);
    expect((await capture(statusArgs(w, "codex"), seams(w, [ok("codex plugin list", MARKET_ID + "  installed, enabled  1.0.0"), { match: "codex plugin marketplace list", result: { code: 2 } }]))).code).toBe(2);
  });
});

describe("surface status --surface antigravity", () => {
  it("reads the linked plugin.json, validates it, and compares it against <root>/<surface-dir>", async () => {
    const w = world();
    const dest = join(w.cfg, "config", "plugins", PLUGIN);
    mkdirSync(join(w.cfg, "config", "plugins"), { recursive: true });
    link(join(w.root, "gen", "ag"), dest);
    const serving = await capture([...statusArgs(w, "antigravity", "--root", w.root, "--surface-dir", "gen/ag"), "--json"], seams(w, [ok(`agy plugin validate ${dest}`)]));
    expect(serving.code).toBe(0);
    expect(serving.doc()).toMatchObject({ verdict: "serving", served: [{ version: "1.0.0" }] });

    const elsewhere = await capture([...statusArgs(w, "antigravity", "--root", w.other, "--surface-dir", "gen/ag"), "--json"], seams(w, [ok(`agy plugin validate ${dest}`)]));
    expect(elsewhere.code).toBe(1);

    const rejected = await capture(statusArgs(w, "antigravity"), seams(w, [{ match: `agy plugin validate ${dest}`, result: { code: 1, stdout: "[error]" } }]));
    expect(rejected.code).toBe(1);

    const noAgy = await capture(statusArgs(w, "antigravity", "--surface-dir", "gen/ag"), seams(w, [{ match: `agy plugin validate ${dest}`, result: { spawnFailed: true, code: -1 } }]));
    expect(noAgy.code).toBe(5);
    expect(noAgy.out.join("\n")).toMatch(/read back: NOT CHECKED/);
  });

  it("is not installed when absent or holding another plugin, and warns of a copied directory", async () => {
    const w = world();
    expect((await capture(statusArgs(w, "antigravity"), seams(w, []))).code).toBe(3);
    const dest = join(w.cfg, "config", "plugins", PLUGIN);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "plugin.json"), '{"name":"else"}');
    expect((await capture(statusArgs(w, "antigravity"), seams(w, []))).code).toBe(3);
    writeFileSync(join(dest, "plugin.json"), JSON.stringify({ name: PLUGIN, version: "3.0.0" }));
    const copied = await capture([...statusArgs(w, "antigravity"), "--json"], seams(w, [ok(`agy plugin validate ${dest}`)]));
    expect(copied.code).toBe(0);
    expect((copied.doc()["warnings"] as string[])[0]).toMatch(/a real directory, a copy/);
    expect((await capture(statusArgs(w, "antigravity", "--root", w.root), seams(w, []))).code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Nobunaga round 1 on zheref/nen#298: one test per finding, each failing
// without its fix.
// ---------------------------------------------------------------------------

/** install() called directly, for the seams the command line cannot reach (the moment between plan and write). */
function direct(w: World, s: ScriptedSeams, hooks: InstallInputs["hooks"]): ReturnType<typeof install> {
  return install({ surface: "claude-code", plugin: PLUGIN, root: w.root, configDir: w.cfg, surfaceDir: null, dryRun: false, seams: s, configExplicit: true, hooks });
}

describe("surface install: Nobunaga round 1", () => {
  it("N2: a destination swapped for a file between the plan and the write is refused, and the file survives", () => {
    const w = world();
    const dest = join(w.cfg, "skills", PLUGIN);
    mkdirSync(join(w.cfg, "skills"));
    link(w.other, dest);
    const s = seams(w, [ok("claude --version")]);
    const report = direct(w, s, {
      beforePlace: (): void => {
        if (POSIX) unlinkSync(dest);
        else rmdirSync(dest);
        writeFileSync(dest, "the user's own file");
      },
    });
    expect(report.verdict).toBe("refused");
    expect(report.reason).toMatch(/changed after it was inspected .*a file/);
    expect(readFileSync(dest, "utf8")).toBe("the user's own file");
    expect(report.steps.map((step) => step.outcome)).toEqual(["failed"]);
    // only the read-only probe ran; the write was refused, nothing else ran
    expect(commandsOf(s)).toEqual(["claude --version"]);

    const v = world();
    const destV = join(v.cfg, "skills", PLUGIN);
    const appeared = direct(v, seams(v, [ok("claude --version")]), {
      beforePlace: (): void => writeFileSync(destV, "appeared"),
    });
    expect(appeared.verdict).toBe("refused");
    expect(readFileSync(destV, "utf8")).toBe("appeared");
  });

  it("N2: a link re-pointed to another target between plan and write is refused too", () => {
    const w = world();
    const dest = join(w.cfg, "skills", PLUGIN);
    mkdirSync(join(w.cfg, "skills"));
    link(w.other, dest);
    const third = checkout(join(w.work, "third"));
    const report = direct(w, seams(w, [ok("claude --version")]), {
      beforePlace: (): void => {
        if (POSIX) unlinkSync(dest);
        else rmdirSync(dest);
        link(third, dest);
      },
    });
    expect(report.verdict).toBe("refused");
    expect(realpathSync.native(dest)).toBe(third);
  });

  it("N3: a read-back problem an owed action accounts for is owed (exit 4), not failed", async () => {
    const w = world();
    writeJson(join(w.cfg, "settings.json"), { enabledPlugins: { [SKILLS_ID]: false } });
    const result = await capture([...installArgs(w, "claude-code"), "--json"], seams(w, [git(w.root), ok("claude --version"), claudeList([servedLink(w, { enabled: false })])]));
    expect(result.code).toBe(4);
    expect(String(result.doc()["reason"])).toMatch(/account.*for the read-back: .*not enabled/);
    // An unexplained problem beside it still fails.
    const v = world();
    writeJson(join(v.cfg, "settings.json"), { enabledPlugins: { [SKILLS_ID]: false } });
    const mixed = await capture([...installArgs(v, "claude-code"), "--json"], seams(v, [git(v.root), ok("claude --version"), claudeList([servedLink(v, { enabled: false, version: "0.0.1" })])]));
    expect(mixed.code).toBe(1);
    // A shadow still enabled, accounted for by its owed disable, is owed too.
    const x = world();
    writeJson(join(x.cfg, "settings.json"), { enabledPlugins: { [MARKET_ID]: true } });
    const shadow = await capture([...installArgs(x, "claude-code"), "--json"], seams(x, [git(x.root), ok("claude --version"), claudeList([servedLink(x), { id: MARKET_ID, enabled: true }])]));
    expect(shadow.code).toBe(4);
  });

  it("N4: a root plugin.json with no version fails the read-back, as status reports a mismatch", async () => {
    const w = world();
    writeFileSync(join(w.root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: PLUGIN }));
    const result = await capture([...installArgs(w, "claude-code"), "--json"], seams(w, [git(w.root), ok("claude --version"), claudeList([servedLink(w)])]));
    expect(result.code).toBe(1);
    expect(String(result.doc()["reason"])).toMatch(/carries no version/);
    mkdirSync(join(w.cfg, "skills"), { recursive: true });
    const status = await capture([...statusArgs(w, "claude-code", "--root", w.root), "--json"], seams(w, [claudeList([servedLink(w)])]));
    expect(status.code).toBe(1);
    expect(String(status.doc()["reason"])).toMatch(/carries no version/);
  });

  it("N4: a linked Antigravity plugin.json with no version fails the read-back", async () => {
    const w = world();
    writeFileSync(join(w.root, "gen", "ag", "plugin.json"), JSON.stringify({ name: PLUGIN }));
    const dest = join(w.cfg, "config", "plugins", PLUGIN);
    const result = await capture([...installArgs(w, "antigravity", "--surface-dir", "gen/ag"), "--json"], seams(w, [git(w.root), ok(`agy plugin validate ${dest}`)]));
    expect(result.code).toBe(1);
    expect(String(result.doc()["reason"])).toMatch(/carries no version/);
  });

  it("N5: a step that failed is shown as failed, never done -- in --json and in text", async () => {
    const w = world();
    writeJson(join(w.cfg, "plugins", "installed_plugins.json"), { version: 2, plugins: { [MARKET_ID]: [{ installPath: "/x" }] } });
    const script = [git(w.root), ok("claude --version"), { match: `claude plugin uninstall ${MARKET_ID}`, result: { code: 1, stderr: "locked" } }];
    const result = await capture([...installArgs(w, "claude-code"), "--json"], seams(w, script));
    expect(result.code).toBe(1);
    const steps = result.doc()["steps"] as Array<{ kind: string; done: boolean; outcome: string }>;
    expect(steps.map((step) => [step.kind, step.done, step.outcome])).toEqual([
      ["mkdir", true, "ok"],
      ["link", true, "ok"],
      ["run", false, "failed"],
    ]);
    const v = world();
    writeJson(join(v.cfg, "plugins", "installed_plugins.json"), { version: 2, plugins: { [MARKET_ID]: [{ installPath: "/x" }] } });
    const text = await capture(installArgs(v, "claude-code"), seams(v, [git(v.root), ok("claude --version"), { match: `claude plugin uninstall ${MARKET_ID}`, result: { code: 1, stderr: "locked" } }]));
    expect(text.out.join("\n")).toMatch(/FAILED run: claude plugin uninstall zephyr@zephyr-market/);
  });

  it("N6: codex refuses before plugin add when the plugin is installed from another marketplace (exit 3)", async () => {
    const w = world();
    const s = seams(w, [git(w.root), ok("codex plugin list", `${fillerPlugins}\n${PLUGIN}@elsewhere  installed, enabled  0.1.0  /c\n`)]);
    const result = await capture([...installArgs(w, "codex"), "--json"], s);
    expect(result.code).toBe(3);
    expect(String(result.doc()["reason"])).toMatch(/zephyr@elsewhere is installed from a marketplace this checkout does not publish/);
    expect(commandsOf(s)).toEqual(["git rev-parse --show-toplevel", "codex plugin list"]);
    // A row merely available from another marketplace is no install.
    const v = world();
    const available = await capture(
      [...installArgs(v, "codex"), "--dry-run"],
      seams(v, [git(v.root), ok("codex plugin list", `${PLUGIN}@elsewhere  not installed  0.1.0`), ok("codex plugin marketplace list", HEADER)]),
    );
    expect(available.code).toBe(0);
  });

  it("N6: codex status is a mismatch when more than one row of the plugin is enabled", async () => {
    const w = world();
    const result = await capture(
      [...statusArgs(w, "codex"), "--json"],
      seams(w, [ok("codex plugin list", `${MARKET_ID}  installed, enabled  1.0.0  /a\n${PLUGIN}@b  installed, enabled  1.0.0  /b\n`), ok("codex plugin marketplace list", HEADER)]),
    );
    expect(result.code).toBe(1);
    expect(String(result.doc()["reason"])).toMatch(/2 rows are enabled/);
  });

  it("N7: status --trees takes the worse exit when the status could not read the surface", async () => {
    expect(statusTreesExit({ verdict: "serving" }, { verdict: "identical" })).toBe(0);
    expect(statusTreesExit({ verdict: "mismatch" }, { verdict: "identical" })).toBe(0);
    expect(statusTreesExit({ verdict: "tool missing" }, { verdict: "identical" })).toBe(5);
    expect(statusTreesExit({ verdict: "tool missing" }, { verdict: "different" })).toBe(1);
    expect(statusTreesExit({ verdict: "wiring" }, { verdict: "different" })).toBe(2);
    expect(statusTreesExit({ verdict: "tool missing" }, { verdict: "not installed" })).toBe(5);
    const w = world();
    const source = checkout(join(w.work, "source"));
    mkdirSync(join(w.cfg, "skills"));
    link(w.root, join(w.cfg, "skills", PLUGIN));
    const result = await capture(
      [...statusArgs(w, "claude-code", "--trees", "skills", "--source", source), "--json"],
      seams(w, [{ match: "claude plugin list --json", result: { spawnFailed: true, code: -1 } }]),
    );
    expect((result.doc()["judgement"] as { verdict: string }).verdict).toBe("identical");
    expect(result.code).toBe(5);
  });

  it("N8: every token of a suggested command and of a would-run line is shell-quoted", async () => {
    expect(shellQuote("plain-1.0")).toBe("plain-1.0");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("$(x)")).toBe("'$(x)'");
    expect(commandText(["claude", "plugin", "disable", "z@a;rm -rf ~", "--scope", "user"])).toBe("claude plugin disable 'z@a;rm -rf ~' --scope user");
    const w = world();
    writeJson(join(w.cfg, "settings.json"), { enabledPlugins: { [`${PLUGIN}@a;touch x`]: true } });
    const result = await capture([...installArgs(w, "claude-code"), "--json"], seams(w, [git(w.root), ok("claude --version"), claudeList([servedLink(w)])]));
    expect((result.doc()["actions"] as Array<{ command: string }>)[0]?.command).toBe(`CLAUDE_CONFIG_DIR=${shellQuote(w.cfg)} claude plugin disable 'zephyr@a;touch x' --scope user`);
    const spaced = checkout(join(w.work, "with space"));
    const dry = await capture(
      ["surface", "install", "--surface", "codex", "--plugin", PLUGIN, "--root", spaced, "--config-dir", w.cfg, "--dry-run"],
      seams(w, [git(spaced), ok("codex plugin list", ""), ok("codex plugin marketplace list", HEADER)]),
    );
    expect(dry.out.join("\n")).toContain(`would run: codex plugin marketplace add '${spaced}'`);
  });

  it("N8: a marketplace name outside [A-Za-z0-9._-], or with a leading '-', is refused (exit 2)", async () => {
    for (const name of ["-x", "a;b", "a b", "$(x)", "a/b", ""]) {
      const w = world();
      writeFileSync(join(w.root, ".claude-plugin", "marketplace.json"), JSON.stringify({ name, plugins: [{ name: PLUGIN }] }));
      for (const surface of ["claude-code", "codex"]) {
        const result = await capture(installArgs(w, surface), seams(w, [git(w.root), ok("codex plugin list", "")]));
        expect(result.code, `${surface} ${name}`).toBe(2);
        expect(result.err.join("\n")).toMatch(/carries no usable 'name'/);
      }
    }
  });

  it("N12: the config directory reaches the CLI only when --config-dir or the environment named it", async () => {
    const w = world();
    const flagged = seams(w, [git(w.root), ok("codex plugin list", ""), ok("codex plugin marketplace list", HEADER)]);
    await capture([...installArgs(w, "codex"), "--dry-run"], flagged);
    expect(flagged.calls.filter((call) => call.command === "codex").map((call) => call.env)).toEqual([{ CODEX_HOME: w.cfg }, { CODEX_HOME: w.cfg }]);
    const fromEnv = new ScriptedSeams([git(w.root), ok("codex plugin list", ""), ok("codex plugin marketplace list", HEADER)], { env: { HOME: w.home, CODEX_HOME: w.cfg } });
    await capture(["surface", "install", "--surface", "codex", "--plugin", PLUGIN, "--root", w.root, "--dry-run"], fromEnv);
    expect(fromEnv.calls.find((call) => call.command === "codex")?.env).toEqual({ CODEX_HOME: w.cfg });
    const byDefault = seams(w, [git(w.root), ok("codex plugin list", ""), ok("codex plugin marketplace list", HEADER)]);
    await capture(["surface", "install", "--surface", "codex", "--plugin", PLUGIN, "--root", w.root, "--dry-run"], byDefault);
    expect(byDefault.calls.find((call) => call.command === "codex")?.env).toEqual({});
  });

  it("N13: on Windows a refused rename over a junction falls back to rmdir-then-rename", () => {
    const w = world();
    const dest = join(w.cfg, "skills", PLUGIN);
    mkdirSync(join(w.cfg, "skills"));
    link(w.other, dest);
    let renames = 0;
    const removed: string[] = [];
    const removeLink = (path: string): void => {
      removed.push(path);
      if (POSIX) unlinkSync(path);
      else rmdirSync(path);
    };
    const s = new ScriptedSeams([ok("claude --version"), claudeList([servedLink(w)])], { env: { HOME: w.home }, platform: "win32" });
    const report = direct(w, s, {
      linkOps: {
        symlink: (target, path): void => link(target, path),
        rename: (from, to): void => {
          renames += 1;
          if (renames === 1) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          renameSync(from, to);
        },
        rmdir: removeLink,
        unlink: (): void => {
          throw new Error("a junction is never unlinked on win32");
        },
      },
    });
    expect(report.verdict).toBe("ok");
    expect(report.link).toBe("re-pointed");
    expect(removed).toEqual([dest]);
    expect(realpathSync.native(dest)).toBe(w.root);
  });

  it("N13: off Windows a refused rename is a failed step, the old link left in place", () => {
    const w = world();
    const dest = join(w.cfg, "skills", PLUGIN);
    mkdirSync(join(w.cfg, "skills"));
    link(w.other, dest);
    // The PLATFORM SEAM says linux on every host -- the real host would take
    // the Windows fallback on a Windows runner -- and the one removal this
    // path makes (the temporary) is a link removal on every host.
    const s = new ScriptedSeams([ok("claude --version")], { env: { HOME: w.home }, platform: "linux" });
    const report = direct(w, s, {
      linkOps: {
        symlink: (target, path): void => link(target, path),
        unlink: hostRemoveLink,
        rename: (): void => {
          throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
        },
      },
    });
    expect(report.verdict).toBe("failed");
    expect(report.reason).toMatch(/could not re-point .*EXDEV.*left in place/);
    expect(report.steps.map((step) => step.outcome)).toEqual(["failed"]);
    expect(realpathSync.native(dest)).toBe(w.other);
    expect(temporaries(join(w.cfg, "skills"))).toEqual([]);
  });

  it("N13: on Windows a rename that fails after the old junction is removed restores the previous link", () => {
    const w = world();
    const dest = join(w.cfg, "skills", PLUGIN);
    mkdirSync(join(w.cfg, "skills"));
    link(w.other, dest);
    const removed: string[] = [];
    const s = new ScriptedSeams([ok("claude --version")], { env: { HOME: w.home }, platform: "win32" });
    const report = direct(w, s, {
      linkOps: {
        symlink: (target, path): void => link(target, path),
        rmdir: (path): void => {
          removed.push(path);
          hostRemoveLink(path);
        },
        rename: (): void => {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      },
    });
    expect(report.verdict).toBe("failed");
    expect(report.reason).toMatch(/the previous link to .* was put back/);
    // the old junction went, then the temporary was dropped -- both as links
    expect(removed[0]).toBe(dest);
    expect(removed[1]).toMatch(/[\\/]\.zephyr\.nen-relink-\d+-[0-9a-f]{12}$/);
    expect(realpathSync.native(dest)).toBe(w.other);
    expect(temporaries(join(w.cfg, "skills"))).toEqual([]);
  });

  it("N16: a write whose read-back resolves elsewhere is failed (1), not refused", () => {
    const w = world();
    const report = direct(w, seams(w, [ok("claude --version")]), {
      linkOps: { symlink: (_target, path): void => link(w.other, path) },
    });
    expect(report.verdict).toBe("failed");
    expect(report.reason).toMatch(/does not resolve to/);
  });

  it("N17/F5: the temporary is a fresh pid-and-random name; nothing already beside the destination is touched", () => {
    const w = world();
    const dest = join(w.cfg, "skills", PLUGIN);
    const oldStyle = join(w.cfg, "skills", `.${PLUGIN}.nen-relink`);
    mkdirSync(join(w.cfg, "skills"));
    link(w.other, dest);
    writeFileSync(oldStyle, "not ours");
    const report = direct(w, seams(w, [ok("claude --version"), claudeList([servedLink(w)])]), undefined);
    expect(report.verdict).toBe("ok");
    expect(readFileSync(oldStyle, "utf8")).toBe("not ours");
    expect(realpathSync.native(dest)).toBe(w.root);
    expect(temporaries(join(w.cfg, "skills"))).toEqual([]);
  });
});

describe("surface install: Nobunaga round 2", () => {
  it("R2: plans before it probes -- a destination not ours is refused (exit 3) even with claude missing", async () => {
    const w = world();
    const dest = join(w.cfg, "skills", PLUGIN);
    mkdirSync(dest, { recursive: true });
    const result = await capture([...installArgs(w, "claude-code"), "--json"], seams(w, [git(w.root), { match: "claude --version", result: { spawnFailed: true, code: -1 } }]));
    expect(result.code).toBe(3);
    expect(String(result.doc()["reason"])).toMatch(/a real directory/);
    expect(lstatSync(dest).isDirectory()).toBe(true);
    // ... and it is refused before the CLI is even asked about.
    const s = seams(w, [git(w.root)]);
    expect((await capture(installArgs(w, "claude-code"), s)).code).toBe(3);
    expect(commandsOf(s)).toEqual(["git rev-parse --show-toplevel"]);
  });

  it("R4: a token starting with '=' is quoted (zsh expands =cmd)", () => {
    expect(shellQuote("=ls")).toBe("'=ls'");
    expect(shellQuote("a=b")).toBe("a=b");
    expect(commandText(["claude", "plugin", "disable", "=x@y"])).toBe("claude plugin disable '=x@y'");
  });

  it("EEXIST: a destination taken between the re-check and the write is refused (exit 3), nothing written", async () => {
    const w = world();
    const dest = join(w.cfg, "skills", PLUGIN);
    const report = direct(w, seams(w, [ok("claude --version")]), {
      linkOps: {
        symlink: (target, path): void => {
          writeFileSync(path, "raced in");
          link(target, path);
        },
      },
    });
    expect(report.verdict).toBe("refused");
    expect(report.reason).toMatch(/EEXIST/);
    expect(readFileSync(dest, "utf8")).toBe("raced in");
    expect(report.steps.map((step) => [step.kind, step.outcome])).toEqual([
      ["mkdir", "ok"],
      ["link", "failed"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Feitan's security review on NN-PR-#392, and Nobunaga's extra round.
// ---------------------------------------------------------------------------

/** Rename the checkout's marketplace. */
function marketplaceNamed(root: string, name: string): void {
  writeFileSync(join(root, ".claude-plugin", "marketplace.json"), JSON.stringify({ name, plugins: [{ name: PLUGIN }] }));
}

describe("surface install: Feitan (security) and Nobunaga's extra round", () => {
  it("F1: a known marketplace of the same name from ANOTHER source is never removed -- refused (exit 3)", async () => {
    const w = world();
    marketplaceNamed(w.root, "shared-market");
    writeJson(join(w.cfg, "plugins", "installed_plugins.json"), { version: 2, plugins: { "unrelated@shared-market": [{ installPath: "/u" }] } });
    writeJson(join(w.cfg, "plugins", "known_marketplaces.json"), { "shared-market": { source: { source: "github", repo: "someone-else/other-repo" } } });
    const s = seams(w, [git(w.root), ok("git remote get-url origin", "git@github.com:me/zephyr.git\n")]);
    const result = await capture([...installArgs(w, "claude-code"), "--dry-run", "--json"], s);
    expect(result.code).toBe(3);
    expect(String(result.doc()["reason"])).toMatch(/'shared-market' comes from the git source github.com\/someone-else\/other-repo, not this checkout/);
    expect(commandsOf(s)).not.toContain("claude plugin marketplace remove shared-market");
    // zheref/nen#373: a recorded secret carrying a '/' is dropped with the rest of the userinfo.
    writeJson(join(w.cfg, "plugins", "known_marketplaces.json"), { "shared-market": { source: { source: "git", url: "https://oauth2:FAKE0000/with-slash@gitlab.example/o/n" } } });
    const slashed = await capture([...installArgs(w, "claude-code"), "--dry-run", "--json"], seams(w, [git(w.root), ok("git remote get-url origin", "git@github.com:me/zephyr.git\n")]));
    expect(slashed.code).toBe(3);
    expect(String(slashed.doc()["reason"])).toMatch(/comes from a git source that is not a remote URL, not this checkout/);
    expect([...slashed.out, ...slashed.err].join("\n")).not.toMatch(/fake0000|with-slash|oauth2/i);
    // SEC-7: a foreign source whose PATH carries '@github.com/me/zephyr' is not this checkout's.
    writeJson(join(w.cfg, "plugins", "known_marketplaces.json"), { "shared-market": { source: { source: "git", url: "https://evil.example/x@github.com/me/zephyr" } } });
    const pathAt = seams(w, [git(w.root), ok("git remote get-url origin", "git@github.com:me/zephyr.git\n")]);
    const foreign = await capture([...installArgs(w, "claude-code"), "--dry-run", "--json"], pathAt);
    expect(foreign.code).toBe(3);
    expect(commandsOf(pathAt)).not.toContain("claude plugin marketplace remove shared-market");
    writeJson(join(w.cfg, "plugins", "known_marketplaces.json"), { "shared-market": { source: { source: "github", repo: "someone-else/other-repo" } } });
    // A directory source elsewhere, or none recorded, is not ours either.
    for (const known of [{ source: { source: "directory", path: w.other } }, {}]) {
      const v = world();
      writeJson(join(v.cfg, "plugins", "known_marketplaces.json"), { [MARKET]: known });
      expect((await capture([...installArgs(v, "claude-code"), "--dry-run"], seams(v, [git(v.root)]))).code).toBe(3);
    }
  });

  it("F1: a marketplace other plugins depend on is left known -- owed (exit 4), naming them, never removed", async () => {
    const w = world();
    const record = join(w.cfg, "plugins", "installed_plugins.json");
    writeJson(record, { version: 2, plugins: { [MARKET_ID]: [{ installPath: "/x" }], [`other@${MARKET}`]: [{ installPath: "/o" }] } });
    writeJson(join(w.cfg, "plugins", "known_marketplaces.json"), { [MARKET]: { source: { source: "git", url: "https://GitHub.com/me/zephyr.git/" } } });
    const s = seams(
      w,
      [git(w.root), ok("git remote get-url origin", "git@github.com:me/zephyr.git\n"), ok("claude --version"), ok(`claude plugin uninstall ${MARKET_ID}`), claudeList([servedLink(w)])],
      { [`claude plugin uninstall ${MARKET_ID}`]: (): void => writeJson(record, { version: 2, plugins: { [`other@${MARKET}`]: [{ installPath: "/o" }] } }) },
    );
    const result = await capture([...installArgs(w, "claude-code"), "--json"], s);
    expect(result.code).toBe(4);
    expect(commandsOf(s)).not.toContain(`claude plugin marketplace remove ${MARKET}`);
    const actions = result.doc()["actions"] as Array<{ what: string; command: string }>;
    expect(actions[0]?.what).toMatch(/also the source of other@zephyr-market/);
    expect(actions[0]?.command).toBe(`CLAUDE_CONFIG_DIR=${shellQuote(w.cfg)} claude plugin marketplace remove ${MARKET}`);
  });

  it("F1: ours, installed, and nothing else on it -- the one remove runs; ours but not installed -- none", async () => {
    const w = world();
    const record = join(w.cfg, "plugins", "installed_plugins.json");
    const known = join(w.cfg, "plugins", "known_marketplaces.json");
    writeJson(record, { version: 2, plugins: { [MARKET_ID]: [{ installPath: "/x" }] } });
    writeJson(known, { [MARKET]: { source: { source: "directory", path: w.root } } });
    expect((await capture([...installArgs(w, "claude-code"), "--dry-run"], seams(w, [git(w.root), ok("claude --version")]))).out.join("\n")).toMatch(
      /would run: claude plugin marketplace remove zephyr-market/,
    );
    const v = world();
    writeJson(join(v.cfg, "plugins", "known_marketplaces.json"), { [MARKET]: { source: { source: "directory", path: v.root } } });
    const none = await capture([...installArgs(v, "claude-code"), "--dry-run"], seams(v, [git(v.root), ok("claude --version")]));
    expect(none.code).toBe(0);
    expect(none.out.join("\n")).not.toMatch(/marketplace remove/);
  });

  it("F-C: normalises a remote to host/path -- absolute URLs and scp syntax only, the host alone lower-cased", () => {
    for (const url of [
      "git@GitHub.com:me/zephyr.git",
      "https://github.com/me/zephyr",
      "https://user:tok@GITHUB.com/me/zephyr.git/",
      "ssh://git@github.com:22/me/zephyr.git",
      "git+https://github.com/me/zephyr",
    ]) {
      expect(normalizeRemote(url), url).toBe("github.com/me/zephyr");
    }
    // the path keeps its case
    expect(normalizeRemote("https://github.com/Me/Zephyr")).toBe("github.com/Me/Zephyr");
    // ':NN' is a port only after scheme:// -- in scp syntax it is part of the path
    expect(normalizeRemote("git@host:22/me/zephyr.git")).toBe("host/22/me/zephyr");
    // neither an absolute URL nor user@host:path -- never a remote, never a match
    for (const url of ["../zephyr", "/srv/git/zephyr.git", "zephyr", "host:me/zephyr", "file:relative", "", "https://github.com/"]) {
      expect(normalizeRemote(url), url).toBeNull();
    }
    // SEC-7 (Feitan round 2, zheref/nen#373): the host is the RAW authority's. An '@' past
    // the authority is ambiguous and never a match; scp's host part ends at the first ':'.
    for (const url of ["https://evil.example/x@github.com/me/zephyr", "https://oauth2:tok/with-slash@github.com/me/zephyr", "oauth2:tok/x@github.com:me/zephyr", "ssh://[evil.invalid]@github.com/me/zephyr", "ssh://git@[evil.invalid]@github.com/me/zephyr", "ssh://github.com:22#@evil.invalid/me/zephyr", "file://github.com/me/zephyr"]) {
      expect(normalizeRemote(url), url).toBeNull();
      expect(normalizeRemote(url), url).not.toBe("github.com/me/zephyr");
    }
  });

  it("F2: refuses a root inside a surface's own directory, by real path, or equal to a marketplace's installLocation (exit 2)", async () => {
    const w = world();
    const inCfg = checkout(join(w.cfg, "plugins", "marketplaces", "m"));
    const first = await capture(["surface", "install", "--surface", "claude-code", "--plugin", PLUGIN, "--root", inCfg, "--config-dir", w.cfg], seams(w, [git(inCfg)]));
    expect(first.code).toBe(2);
    expect(first.err.join("\n")).toMatch(/an agent surface's own directory/);
    // Another surface's default directory counts too.
    const inCodex = checkout(join(w.home, ".codex", "plugins", "x"));
    expect((await capture(["surface", "install", "--surface", "claude-code", "--plugin", PLUGIN, "--root", inCodex, "--config-dir", w.cfg], seams(w, [git(inCodex)]))).code).toBe(2);
    // Reached through a link, it is still inside (real-path containment, not a pattern).
    const alias = join(w.work, "alias");
    link(inCfg, alias);
    const viaLink = await capture(["surface", "install", "--surface", "claude-code", "--plugin", PLUGIN, "--root", alias, "--config-dir", w.cfg], seams(w, [git(inCfg)]));
    expect(viaLink.code).toBe(2);
    expect(viaLink.err.join("\n")).toMatch(/an agent surface's own directory/);
    const v = world();
    writeJson(join(v.cfg, "plugins", "known_marketplaces.json"), { m: { source: { source: "git", url: "x" }, installLocation: v.root } });
    const located = await capture([...installArgs(v, "claude-code")], seams(v, [git(v.root)]));
    expect(located.code).toBe(2);
    expect(located.err.join("\n")).toMatch(/installLocation/);
  });

  it("F3: a marketplace name that is all dots or ends in '.' is refused (exit 2); 'a.b' is fine", async () => {
    for (const name of [".", "..", "a.", "...", ".hidden"]) {
      const w = world();
      marketplaceNamed(w.root, name);
      expect((await capture(installArgs(w, "codex"), seams(w, [git(w.root)]))).code, name).toBe(2);
    }
    const w = world();
    marketplaceNamed(w.root, "a.b_c-1");
    expect((await capture([...installArgs(w, "codex"), "--dry-run"], seams(w, [git(w.root), ok("codex plugin list", ""), ok("codex plugin marketplace list", HEADER)]))).code).toBe(0);
  });

  it("F4: --plugin is an allowlist, refusing Windows reserved names, ':' and a trailing space (exit 2)", async () => {
    const w = world();
    for (const name of ["CON", "lpt1", "Com9", "nul", "a:b", "a ", ".x", "x.", "a b", "a@b"]) {
      const result = await capture(["surface", "install", "--surface", "codex", "--plugin", name, "--root", w.root, "--config-dir", w.cfg], seams(w, []));
      expect(result.code, name).toBe(2);
      expect(result.err.join("\n"), name).toMatch(/is not a plugin name/);
    }
    for (const name of ["con1", "my-plugin.v2", "_x"]) {
      const result = await capture(["surface", "status", "--surface", "antigravity", "--plugin", name, "--config-dir", w.cfg], seams(w, []));
      expect(result.code, name).toBe(3);
    }
  });

  it("F5: a taken temporary name (EEXIST) is retried with a fresh one", () => {
    const w = world();
    const dest = join(w.cfg, "skills", PLUGIN);
    mkdirSync(join(w.cfg, "skills"));
    link(w.other, dest);
    const tried: string[] = [];
    const report = direct(w, seams(w, [ok("claude --version"), claudeList([servedLink(w)])]), {
      linkOps: {
        symlink: (target, path): void => {
          tried.push(path);
          if (tried.length === 1) throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
          link(target, path);
        },
      },
    });
    expect(report.verdict).toBe("ok");
    expect(tried).toHaveLength(2);
    expect(tried[0]).not.toBe(tried[1]);
    for (const path of tried) expect(path).toMatch(new RegExp(`[\\\\/]\\.zephyr\\.nen-relink-${process.pid}-[0-9a-f]{12}$`));
    expect(temporaries(join(w.cfg, "skills"))).toEqual([]);
  });

  it("F5: the destination is lstat'ed again right before the rename -- swapped then, it is refused and survives", () => {
    const w = world();
    const dest = join(w.cfg, "skills", PLUGIN);
    mkdirSync(join(w.cfg, "skills"));
    link(w.other, dest);
    const report = direct(w, seams(w, [ok("claude --version")]), {
      linkOps: {
        symlink: (target, path): void => {
          link(target, path);
          hostRemoveLink(dest);
          writeFileSync(dest, "swapped in");
        },
        unlink: hostRemoveLink,
        rmdir: hostRemoveLink,
      },
    });
    expect(report.verdict).toBe("refused");
    expect(report.reason).toMatch(/changed immediately before the rename/);
    expect(readFileSync(dest, "utf8")).toBe("swapped in");
    expect(temporaries(join(w.cfg, "skills"))).toEqual([]);
  });

  it("F6: --config-dir with a control character is refused; an enabledPlugins key with one is flagged, never a command", async () => {
    const w = world();
    for (const verb of [installArgs(w, "codex"), statusArgs(w, "codex")]) {
      const argv = verb.map((arg): string => (arg === w.cfg ? `${w.cfg}\u001b[2J` : arg));
      const result = await capture(argv, seams(w, []));
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/--config-dir carries a control character/);
    }
    const v = world();
    writeJson(join(v.cfg, "settings.json"), { enabledPlugins: { [`${PLUGIN}@x\u001b[2J`]: true } });
    const result = await capture([...installArgs(v, "claude-code"), "--json"], seams(v, [git(v.root), ok("claude --version"), claudeList([servedLink(v)])]));
    expect(result.code).toBe(4);
    const actions = result.doc()["actions"] as Array<{ what: string; command: string | null }>;
    expect(actions[0]?.command).toBeNull();
    expect(actions[0]?.what).toMatch(/a key carrying a control character: flagged, and no command is suggested/);
    expect(actions[0]?.what).not.toContain("\u001b");
  });

  it.skipIf(!POSIX)("N3: the previous link is put back with the target TEXT it carried, and read back before saying so", () => {
    const w = world();
    const dest = join(w.cfg, "skills", PLUGIN);
    mkdirSync(join(w.cfg, "skills"));
    const raw = join("..", "..", "other");
    symlinkSync(raw, dest);
    const failingRename = (): void => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    const s = (): ScriptedSeams => new ScriptedSeams([ok("claude --version")], { env: { HOME: w.home }, platform: "win32" });
    const restored = direct(w, s(), { linkOps: { rmdir: hostRemoveLink, unlink: hostRemoveLink, rename: failingRename } });
    expect(restored.verdict).toBe("failed");
    expect(restored.reason).toMatch(/was put back/);
    expect(readlinkSync(dest)).toBe(raw);

    // A restore that "succeeds" but leaves nothing there is not claimed.
    let calls = 0;
    const lost = direct(w, s(), {
      linkOps: {
        rmdir: hostRemoveLink,
        unlink: hostRemoveLink,
        rename: failingRename,
        symlink: (target, path): void => {
          calls += 1;
          if (calls === 1) symlinkSync(target, path);
        },
      },
    });
    expect(lost.verdict).toBe("failed");
    expect(lost.reason).toMatch(/putting the previous link to .* back also failed -- .* is absent/);
    expect(existsSync(dest)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Feitan's confirmation pass on NN-PR-#392 at aacdb81.
// ---------------------------------------------------------------------------

describe("surface install: Feitan's confirmation pass", () => {
  it("F-A: a recorded source URL carrying user:token@ never reaches the text or --json output", async () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const w = world();
    writeJson(join(w.cfg, "plugins", "known_marketplaces.json"), { [MARKET]: { source: { source: "git", url: `https://someone:${secret}@github.com/someone/else.git` } } });
    const script = (): ScriptedCall[] => [git(w.root), ok("git remote get-url origin", "git@github.com:me/zephyr.git\n")];
    const json = await capture([...installArgs(w, "claude-code"), "--json"], seams(w, script()));
    const text = await capture(installArgs(w, "claude-code"), seams(w, script()));
    expect(json.code).toBe(3);
    expect(String(json.doc()["reason"])).toMatch(/the git source github.com\/someone\/else, not this checkout/);
    for (const out of [json.out.join("\n"), json.err.join("\n"), text.out.join("\n"), text.err.join("\n")]) {
      expect(out).not.toContain(secret);
      expect(out).not.toContain("someone:");
    }
  });

  it("F-A: a Codex marketplace root carrying credentials is redacted in a refusal and in status", async () => {
    const w = world();
    const root = "https://me:hunter2@example.invalid/market.git";
    const refused = await capture([...installArgs(w, "codex"), "--json"], seams(w, [git(w.root), ok("codex plugin list", ""), ok("codex plugin marketplace list", `${HEADER}\n${MARKET}  ${root}\n`)]));
    expect(refused.code).toBe(3);
    expect(refused.out.join("\n")).not.toContain("hunter2");
    const status = await capture(
      [...statusArgs(w, "codex"), "--json"],
      seams(w, [ok("codex plugin list", `${MARKET_ID}  installed, enabled  1.0.0  ${root}\n`), ok("codex plugin marketplace list", `${HEADER}\n${MARKET}  ${root}\n`)]),
    );
    expect(status.out.join("\n")).not.toContain("hunter2");
  });

  it("F-A: a Codex marketplace root whose userinfo is a bare token is redacted too (Feitan round 2, zheref/nen#373)", async () => {
    const w = world();
    const root = "https://FAKE0000tok@example.invalid/market.git";
    const refused = await capture([...installArgs(w, "codex"), "--json"], seams(w, [git(w.root), ok("codex plugin list", ""), ok("codex plugin marketplace list", `${HEADER}\n${MARKET}  ${root}\n`)]));
    expect(refused.code).toBe(3);
    expect([...refused.out, ...refused.err].join("\n")).not.toMatch(/fake0000/i);
    expect([...refused.out, ...refused.err].join("\n")).toContain("https://***@example.invalid/market.git");
    const status = await capture(
      [...statusArgs(w, "codex"), "--json"],
      seams(w, [ok("codex plugin list", `${MARKET_ID}  installed, enabled  1.0.0  ${root}\n`), ok("codex plugin marketplace list", `${HEADER}\n${MARKET}  ${root}\n`)]),
    );
    expect([...status.out, ...status.err].join("\n")).not.toMatch(/fake0000/i);
  });

  it("F-B: a plugin installed from the marketplace during the uninstall leaves it known -- owed (exit 4), no remove", async () => {
    const w = world();
    const record = join(w.cfg, "plugins", "installed_plugins.json");
    writeJson(record, { version: 2, plugins: { [MARKET_ID]: [{ installPath: "/x" }] } });
    writeJson(join(w.cfg, "plugins", "known_marketplaces.json"), { [MARKET]: { source: { source: "directory", path: w.root } } });
    const s = seams(w, [git(w.root), ok("claude --version"), ok(`claude plugin uninstall ${MARKET_ID}`), claudeList([servedLink(w)])], {
      [`claude plugin uninstall ${MARKET_ID}`]: (): void => writeJson(record, { version: 2, plugins: { [`other@${MARKET}`]: [{ installPath: "/o" }] } }),
    });
    const result = await capture([...installArgs(w, "claude-code"), "--json"], s);
    expect(result.code).toBe(4);
    expect(commandsOf(s)).not.toContain(`claude plugin marketplace remove ${MARKET}`);
    expect((result.doc()["actions"] as Array<{ what: string }>)[0]?.what).toMatch(/became the source of other@zephyr-market during the hand-over/);
  });

  it("F-B: a source that changed during the uninstall leaves it known -- owed (exit 4), no remove", async () => {
    const w = world();
    const record = join(w.cfg, "plugins", "installed_plugins.json");
    const known = join(w.cfg, "plugins", "known_marketplaces.json");
    writeJson(record, { version: 2, plugins: { [MARKET_ID]: [{ installPath: "/x" }] } });
    writeJson(known, { [MARKET]: { source: { source: "directory", path: w.root } } });
    const s = seams(w, [git(w.root), ok("claude --version"), ok(`claude plugin uninstall ${MARKET_ID}`), claudeList([servedLink(w)])], {
      [`claude plugin uninstall ${MARKET_ID}`]: (): void => {
        writeJson(record, { version: 2, plugins: {} });
        writeJson(known, { [MARKET]: { source: { source: "directory", path: w.other } } });
      },
    });
    const result = await capture([...installArgs(w, "claude-code"), "--json"], s);
    expect(result.code).toBe(4);
    expect(commandsOf(s)).not.toContain(`claude plugin marketplace remove ${MARKET}`);
    expect((result.doc()["actions"] as Array<{ what: string }>)[0]?.what).toMatch(/recorded source changed during the hand-over/);
  });

  it("F-D: a surface directory from the ENVIRONMENT carrying a control character is refused too (exit 2)", async () => {
    const w = world();
    for (const [surface, variable] of [["claude-code", "CLAUDE_CONFIG_DIR"], ["codex", "CODEX_HOME"], ["antigravity", "GEMINI_CONFIG_DIR"]] as const) {
      const s = new ScriptedSeams([], { env: { HOME: w.home, [variable]: `${w.cfg}\u001b[2J` } });
      for (const argv of [
        ["surface", "install", "--surface", surface, "--plugin", PLUGIN, "--root", w.root, ...(surface === "antigravity" ? ["--surface-dir", "gen/ag"] : [])],
        ["surface", "status", "--surface", surface, "--plugin", PLUGIN],
      ]) {
        const result = await capture(argv, s);
        expect(result.code, `${variable} ${argv[1]}`).toBe(2);
        expect(result.err.join("\n")).toMatch(/taken from the environment carries a control character/);
      }
    }
  });

  it("F2 corrected: a root equal to a DIRECTORY-source marketplace's installLocation is the hand-over, not refused; a clone's is", async () => {
    const w = world();
    const record = join(w.cfg, "plugins", "installed_plugins.json");
    const known = join(w.cfg, "plugins", "known_marketplaces.json");
    writeJson(record, { version: 2, plugins: { [MARKET_ID]: [{ installPath: "/x" }] } });
    writeJson(known, { [MARKET]: { source: { source: "directory", path: w.root }, installLocation: w.root } });
    const dry = await capture([...installArgs(w, "claude-code"), "--dry-run"], seams(w, [git(w.root), ok("claude --version")]));
    expect(dry.code).toBe(0);
    expect(dry.out.join("\n")).toMatch(/would run: claude plugin marketplace remove zephyr-market/);
    const v = world();
    writeJson(join(v.cfg, "plugins", "known_marketplaces.json"), { m: { source: { source: "github", repo: "a/b" }, installLocation: v.root } });
    expect((await capture(installArgs(v, "claude-code"), seams(v, [git(v.root)]))).code).toBe(2);
  });

  it("ruling: a codex run with its own --config-dir never reads the default Claude known_marketplaces.json", async () => {
    const w = world();
    // The DEFAULT Claude directory (under HOME) records the root as a clone's installLocation.
    writeJson(join(w.home, ".claude", "plugins", "known_marketplaces.json"), { m: { source: { source: "git", url: "https://x.invalid/m.git" }, installLocation: w.root } });
    const sandboxed = await capture([...installArgs(w, "codex"), "--dry-run"], seams(w, [git(w.root), ok("codex plugin list", ""), ok("codex plugin marketplace list", HEADER)]));
    expect(sandboxed.code).toBe(0);
    // With no directory of its own, the default is consulted, and the clone's location refused.
    const unsandboxed = await capture(["surface", "install", "--surface", "codex", "--plugin", PLUGIN, "--root", w.root, "--dry-run"], seams(w, [git(w.root)]));
    expect(unsandboxed.code).toBe(2);
    expect(unsandboxed.err.join("\n")).toMatch(/installLocation/);
  });
});
