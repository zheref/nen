// src/surface/command.test.ts -- the family through ../index.ts, so the exit
// codes and the --json documents are the ones a caller actually gets.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "../index.js";
import { markerFor } from "./mirror.js";
import { CHECK_CONTRACT, CHECK_INSTALLED_CONTRACT, GENERATE_CONTRACT } from "./command.js";

const SKILLS = join(process.cwd(), "src", "surface", "fixtures", "skills");
const AGENTS = join(process.cwd(), "src", "surface", "fixtures", "agents");

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

const tempDir = (): string => mkdtempSync(join(tmpdir(), "nen-surface-cmd-"));

const generateArgv = (surface: string, out: string, extra: readonly string[] = []): readonly string[] => [
  "surface",
  "mirror",
  "generate",
  "--source",
  SKILLS,
  "--agents",
  AGENTS,
  "--surface",
  surface,
  "--out",
  out,
  "--invocation-prefix",
  "demo:",
  ...extra,
];

const checkArgv = (surface: string, out: string, extra: readonly string[] = []): readonly string[] => [
  "surface",
  "mirror",
  "check",
  "--source",
  SKILLS,
  "--agents",
  AGENTS,
  "--surface",
  surface,
  "--out",
  out,
  "--invocation-prefix",
  "demo:",
  ...extra,
];

const PACKS = join(process.cwd(), "src", "surface", "fixtures", "packs");
const MODEL_AGENTS = join(process.cwd(), "src", "surface", "fixtures", "models", "agents");
const json = (result: { out: string[] }): Record<string, unknown> => JSON.parse(result.out.join("\n")) as Record<string, unknown>;

describe("nen surface mirror generate", () => {
  it("writes the mirror and reports the three lists", async () => {
    const out = tempDir();
    const result = await capture(generateArgv("cursor", out));
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "surface: cursor (.cursor/skills/<name>/SKILL.md)",
      `out: ${out}`,
      "written: agents/scout.md, alpha/SKILL.md, beta/SKILL.md",
      "unchanged: (none)",
      "deleted (orphaned): (none)",
      "skipped (shared includes, not personas): _shared.md",
      "truncated (description over the 30-char budget; summary: added): alpha, beta",
      "hooks: none",
      "rules: none",
      "permissions: none",
      "manifest: none",
    ]);
    expect(readdirSync(out).sort()).toEqual(["agents", "alpha", "beta"]);
  });

  it("prints the row's caveat on stderr, so --json stays ONE document", async () => {
    const out = tempDir();
    const result = await capture([...generateArgv("codex", out), "--json"]);
    expect(result.err.join("\n")).toContain("AGENTS.md as prose");
    const document = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(document["contract"]).toBe(GENERATE_CONTRACT);
    expect(document["surface"]).toBe("codex");
    expect(document["skillsPath"]).toBe(".agents/skills/<name>/SKILL.md");
    expect(document["dryRun"]).toBe(false);
    expect(document["written"]).toEqual(["AGENTS.md", "alpha/SKILL.md", "beta/SKILL.md"]);
  });

  it("--dry-run reports what it would write and writes nothing", async () => {
    const out = tempDir();
    const result = await capture([...generateArgv("codex", out), "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out[1]).toBe(`out: ${out} (--dry-run: nothing written)`);
    expect(result.out).toContain("written: AGENTS.md, alpha/SKILL.md, beta/SKILL.md");
    expect(readdirSync(out)).toEqual([]);
  });

  it("mirrors without --agents at all", async () => {
    const out = tempDir();
    const result = await capture([
      "surface",
      "mirror",
      "generate",
      "--source",
      SKILLS,
      "--surface",
      "codex",
      "--out",
      out,
    ]);
    expect(result.code).toBe(0);
    expect(readdirSync(out).sort()).toEqual(["alpha", "beta"]);
  });

  it("leaves an invocation mention alone without --invocation-prefix", async () => {
    const out = tempDir();
    await capture(["surface", "mirror", "generate", "--source", SKILLS, "--surface", "codex", "--out", out]);
    expect(readFileSync(join(out, "beta", "SKILL.md"), "utf8")).toContain("demo:beta");
  });
});

describe("nen surface mirror check", () => {
  it("exits 0 on a mirror with no drift", async () => {
    const out = tempDir();
    await capture(generateArgv("codex", out));
    const result = await capture(checkArgv("codex", out));
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "surface: codex",
      "ok: 3",
      "missing: (none)",
      "extra: (none)",
      "stale: (none)",
      "hand-edited: (none)",
    ]);
  });

  it("exits 1 on drift, and the --json report names every class", async () => {
    const out = tempDir();
    await capture(generateArgv("codex", out));
    rmSync(join(out, "beta", "SKILL.md"));
    writeFileSync(join(out, "alpha", "SKILL.md"), `${markerFor("codex")}\nedited by hand\n`);
    mkdirSync(join(out, "gamma"));
    writeFileSync(join(out, "gamma", "SKILL.md"), `${markerFor("codex")}\norphan\n`);
    const result = await capture([...checkArgv("codex", out), "--json"]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(report["contract"]).toBe(CHECK_CONTRACT);
    expect(report["missing"]).toEqual(["beta/SKILL.md"]);
    expect(report["extra"]).toEqual(["gamma/SKILL.md"]);
    expect(report["handEdited"]).toEqual(["alpha/SKILL.md"]);
  });

  it("calls a mirror generated for another surface STALE, not hand-edited", async () => {
    const out = tempDir();
    await capture(generateArgv("codex", out));
    const result = await capture([...checkArgv("cursor", out), "--json"]);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(report["stale"]).toEqual(["alpha/SKILL.md", "beta/SKILL.md"]);
    expect(report["handEdited"]).toEqual([]);
  });

  it("writes nothing at all -- a check over a drifted mirror leaves it drifted", async () => {
    const out = tempDir();
    await capture(generateArgv("cursor", out));
    rmSync(join(out, "beta"), { recursive: true });
    await capture(checkArgv("cursor", out));
    expect(readdirSync(out).sort()).toEqual(["agents", "alpha"]);
  });
});

describe("the refusals, every one at exit 2", () => {
  const refusal = async (argv: readonly string[]): Promise<string> => {
    const result = await capture(argv);
    expect(result.code).toBe(2);
    return result.err.join("\n");
  };

  it("refuses a surface that is not a row, listing the ones that are", async () => {
    const message = await refusal(generateArgv("emacs", tempDir()));
    expect(message).toContain("is not in the table");
    expect(message).toContain("codex, cursor");
  });

  it("refuses an --out inside --source", async () => {
    const message = await refusal(generateArgv("codex", join(SKILLS, "mirror")));
    expect(message).toContain("resolves inside --source");
  });

  it("refuses --out that IS --source", async () => {
    expect(await refusal(generateArgv("codex", SKILLS))).toContain("resolves inside --source");
  });

  it("refuses a --source with no SKILL.md under it", async () => {
    const message = await refusal([
      "surface",
      "mirror",
      "generate",
      "--source",
      tempDir(),
      "--surface",
      "codex",
      "--out",
      tempDir(),
    ]);
    expect(message).toContain("holds no <name>/SKILL.md");
  });

  it("refuses a missing --source, --surface or --out by name", async () => {
    expect(await refusal(["surface", "mirror", "generate", "--surface", "codex", "--out", tempDir()])).toContain(
      "--source is required",
    );
    expect(await refusal(["surface", "mirror", "generate", "--source", SKILLS, "--out", tempDir()])).toContain(
      "--surface is required",
    );
    expect(await refusal(["surface", "mirror", "generate", "--source", SKILLS, "--surface", "codex"])).toContain(
      "--out is required",
    );
  });

  it("refuses an empty --agents rather than silently mirroring no personas", async () => {
    const argv = ["surface", "mirror", "generate", "--source", SKILLS, "--surface", "codex", "--out", tempDir(), "--agents", ""];
    expect(await refusal(argv)).toContain("--agents was given an empty value");
  });

  it("refuses --dry-run on check, which never writes anyway", async () => {
    const out = tempDir();
    await capture(generateArgv("codex", out));
    expect(await refusal([...checkArgv("codex", out), "--dry-run"])).toContain(
      "not read by 'surface mirror check'",
    );
  });

  it("refuses to overwrite a file this verb did not write", async () => {
    const out = tempDir();
    mkdirSync(join(out, "alpha"));
    writeFileSync(join(out, "alpha", "SKILL.md"), "hand written\n");
    const message = await refusal(generateArgv("codex", out));
    expect(message).toContain("refusing to overwrite");
    expect(readFileSync(join(out, "alpha", "SKILL.md"), "utf8")).toBe("hand written\n");
  });

  it("refuses a subcommand this family has not got", async () => {
    expect(await refusal(["surface", "mirror"])).toContain("unknown 'surface mirror' subcommand");
    expect(await refusal(["surface", "mirror", "install"])).toContain("unknown 'surface mirror' subcommand");
    expect(await refusal(["surface", "install"])).toContain("unknown 'surface' subcommand");
  });
});

describe("--help", () => {
  it("lists every surface the table carries", async () => {
    const result = await capture(["surface", "--help"]);
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    expect(text).toContain("codex");
    expect(text).toContain("cursor");
    expect(text).toContain("src/surface/rules.ts");
  });
});

// ---------------------------------------------------------------------------
// zheref/nen#227: the files beside the skills, the stamp, and --installed
// ---------------------------------------------------------------------------

describe("the antigravity row", () => {
  it("mirrors skills and personas with the documented keys and the /name spelling", async () => {
    const out = tempDir();
    const result = await capture([...generateArgv("antigravity", out), "--json"]);
    expect(result.code).toBe(0);
    expect(json(result)["written"]).toEqual(["agents/scout.md", "alpha/SKILL.md", "beta/SKILL.md"]);
    const persona = readFileSync(join(out, "agents", "scout.md"), "utf8");
    expect(persona).toContain("tools: Read, Grep, Glob");
    expect(persona).not.toContain("color:");
    expect(readFileSync(join(out, "alpha", "SKILL.md"), "utf8")).toContain("Run `/alpha` first");
    expect(json(result)["skippedAgents"]).toEqual(["_shared.md"]);
  });
});

describe("--hooks", () => {
  it("writes the row's manifest with the events renamed, in the universe", async () => {
    const out = tempDir();
    const result = await capture([...generateArgv("antigravity", out, ["--hooks", join(PACKS, "hooks.json")]), "--json"]);
    expect(result.code).toBe(0);
    expect(json(result)["hooks"]).toBe("written");
    expect(json(result)["written"]).toEqual(expect.arrayContaining(["hooks.json", "hooks/bell.sh", "hooks/guard.sh"]));
    // The scripts travel with the manifest: mode 755, marker on line 2 after
    // the shebang (line 1 when there is none), command carried verbatim.
    expect(statSync(join(out, "hooks", "bell.sh")).mode & 0o777).toBe(0o755);
    expect(readFileSync(join(out, "hooks", "bell.sh"), "utf8").split("\n").slice(0, 2)).toEqual([
      "#!/bin/sh",
      "# GENERATED by nen surface mirror (surface: antigravity) -- do not edit; edit the source and regenerate",
    ]);
    expect(readFileSync(join(out, "hooks", "guard.sh"), "utf8").startsWith("# GENERATED by nen surface mirror")).toBe(true);
    expect(readFileSync(join(out, "hooks.json"), "utf8")).toContain("${CLAUDE_PLUGIN_ROOT}/hooks/bell.sh");
    expect(json(result)["notes"]).toEqual([
      "--hooks carries PostToolUse, which no row maps; only Stop, PreToolUse and SessionStart are carried",
    ]);
    const doc = JSON.parse(readFileSync(join(out, "hooks.json"), "utf8")) as { hooks: Record<string, unknown> };
    expect(Object.keys(doc.hooks)).toEqual(["Stop", "PreToolUse", "PreInvocation"]);
    // A regenerate without --hooks removes it as an orphan: it is ours.
    const again = await capture([...generateArgv("antigravity", out), "--json"]);
    expect(json(again)["deleted"]).toEqual(["hooks.json", "hooks/bell.sh", "hooks/guard.sh"]);
  });

  it("says 'not supported' on a row with no hooks, and writes nothing for it", async () => {
    const out = tempDir();
    // No shipped row has hooks: null; the report path is exercised through the
    // unit layer (mirror.test.ts). Here: an empty --hooks value is refused.
    const result = await capture(generateArgv("cursor", out, ["--hooks", ""]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--hooks was given an empty value/);
  });

  it("--hooks-root rebases the root variable and wraps a command that still expands", async () => {
    const out = tempDir();
    const root = "${HATSU_PLUGIN_ROOT:-$HOME/.gemini/config/plugins/demo}";
    const result = await capture([...generateArgv("antigravity", out, ["--hooks", join(PACKS, "hooks.json"), "--hooks-root", root]), "--json"]);
    expect(result.code).toBe(0);
    const doc = JSON.parse(readFileSync(join(out, "hooks.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(doc.hooks["Stop"]?.[0]?.hooks[0]?.command).toBe(`sh -c 'exec "${root}/hooks/bell.sh" "$@"' --`);
    // A command with no `$` left is not wrapped.
    expect(doc.hooks["PreInvocation"]?.[0]?.hooks[0]?.command).toBe("sh -c 'echo warm'");
    const literal = await capture([...generateArgv("cursor", tempDir(), ["--hooks", join(PACKS, "hooks.json"), "--hooks-root", "/opt/demo"]), "--json"]);
    expect(literal.code).toBe(0);
    // check with the same flags is clean; with a different root it is hand-edited.
    expect((await capture(checkArgv("antigravity", out, ["--hooks", join(PACKS, "hooks.json"), "--hooks-root", root]))).code).toBe(0);
    const other = await capture([...checkArgv("antigravity", out, ["--hooks", join(PACKS, "hooks.json"), "--hooks-root", "/elsewhere"]), "--json"]);
    expect(json(other)["handEdited"]).toEqual(["hooks.json"]);
  });

  it("refuses --hooks-root without --hooks, on the verbatim row, and empty", async () => {
    const alone = await capture(generateArgv("cursor", tempDir(), ["--hooks-root", "/x"]));
    expect(alone.code).toBe(2);
    expect(alone.err.join("\n")).toMatch(/--hooks-root rebases.*no --hooks was given/);
    const installed = tempDir();
    const verbatim = await capture([
      "surface", "mirror", "check", "--source", SKILLS, "--surface", "claude-code", "--installed", installed,
      "--hooks", join(PACKS, "hooks.json"), "--hooks-root", "/x",
    ]);
    expect(verbatim.code).toBe(2);
    expect(verbatim.err.join("\n")).toMatch(/--hooks-root is refused on 'claude-code'/);
    const empty = await capture(generateArgv("cursor", tempDir(), ["--hooks", join(PACKS, "hooks.json"), "--hooks-root", ""]));
    expect(empty.code).toBe(2);
  });

  it("refuses a manifest naming a script that is not beside it", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "hooks.json"), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/hooks/ghost.sh"}]}]}}');
    const result = await capture(generateArgv("cursor", tempDir(), ["--hooks", join(dir, "hooks.json")]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/names '\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/ghost\.sh'.*is not a file/);
  });
});

describe("--manifest", () => {
  it("writes antigravity's plugin.json with the documented keys, and 'not supported' elsewhere", async () => {
    const out = tempDir();
    const result = await capture([...generateArgv("antigravity", out, ["--manifest", join(PACKS, "plugin.json")]), "--json"]);
    expect(result.code).toBe(0);
    expect(json(result)["manifest"]).toBe("written");
    expect(JSON.parse(readFileSync(join(out, "plugin.json"), "utf8"))).toEqual({
      $generated: "GENERATED by nen surface mirror (surface: antigravity) -- do not edit; edit the source and regenerate",
      name: "demo",
      version: "0.1.0",
      description: "A demo plugin.",
    });
    expect((await capture(checkArgv("antigravity", out, ["--manifest", join(PACKS, "plugin.json")]))).code).toBe(0);
    const codex = await capture([...generateArgv("codex", tempDir(), ["--manifest", join(PACKS, "plugin.json")]), "--json"]);
    expect(json(codex)["manifest"]).toBe("not supported");
    expect(json(codex)["written"]).not.toContain("plugin.json");
  });

  it("refuses a manifest missing a key the surface requires, and one that is not an object", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "plugin.json"), '{"name":"demo"}');
    const missing = await capture(generateArgv("antigravity", tempDir(), ["--manifest", join(dir, "plugin.json")]));
    expect(missing.code).toBe(2);
    expect(missing.err.join("\n")).toMatch(/--manifest has no 'description'/);
    writeFileSync(join(dir, "plugin.json"), "[]");
    expect((await capture(generateArgv("antigravity", tempDir(), ["--manifest", join(dir, "plugin.json")]))).code).toBe(2);
  });
});

describe("--models", () => {
  const modelsArgv = (surface: string, out: string, extra: readonly string[] = []): readonly string[] => [
    "surface", "mirror", "generate", "--source", SKILLS, "--agents", MODEL_AGENTS, "--surface", surface, "--out", out,
    "--models", join(PACKS, "workflow.json"), "--json", ...extra,
  ];

  it("rewrites a persona's tier to the surface's alias and carries inherit where documented", async () => {
    const out = tempDir();
    const result = await capture(modelsArgv("cursor", out));
    expect(result.code).toBe(0);
    expect(readFileSync(join(out, "agents", "deep.md"), "utf8")).toContain("model: claude-4-opus");
    expect(readFileSync(join(out, "agents", "heir.md"), "utf8")).toContain("model: inherit");
    expect(readFileSync(join(out, "agents", "plain.md"), "utf8")).not.toContain("model:");
    expect(json(result)["droppedInherit"]).toEqual([]);
  });

  it("names an alias outside antigravity's documented set without failing", async () => {
    const out = tempDir();
    const economy = tempDir();
    writeFileSync(join(economy, "cheap.md"), "---\nname: cheap\ndescription: Cheap.\nmodel: economy\n---\n\nCheap.\n");
    const result = await capture([
      "surface", "mirror", "generate", "--source", SKILLS, "--agents", economy, "--surface", "antigravity", "--out", out,
      "--models", join(PACKS, "workflow.json"), "--json",
    ]);
    expect(result.code).toBe(0);
    expect(json(result)["undocumentedAliases"]).toEqual(["cheap: flash_lite"]);
    expect(readFileSync(join(out, "agents", "cheap.md"), "utf8")).toContain("model: flash_lite");
  });

  it("gives codex the [agents] fragment and one TOML persona apiece, dropping inherit with a line", async () => {
    const out = tempDir();
    const result = await capture(modelsArgv("codex", out));
    expect(result.code).toBe(0);
    expect(json(result)["written"]).toEqual([
      "AGENTS.md", "agents/deep.toml", "agents/heir.toml", "agents/plain.toml", "alpha/SKILL.md", "beta/SKILL.md", "config.toml.fragment",
    ]);
    expect(json(result)["droppedInherit"]).toEqual(["heir"]);
    const fragment = readFileSync(join(out, "config.toml.fragment"), "utf8");
    expect(fragment.split("\n")[0]).toMatch(/^# GENERATED by nen surface mirror \(surface: codex\)/);
    expect(fragment).toContain('[agents]\ndefault_subagent_model = "gpt-5-mini"');
    const deep = readFileSync(join(out, "agents", "deep.toml"), "utf8");
    expect(deep).toContain('name = "deep"');
    expect(deep).toContain('model = "gpt-5"');
    expect(deep).toContain('developer_instructions = """\nDeep reads everything. It never skims.\n"""');
    expect(readFileSync(join(out, "agents", "heir.toml"), "utf8")).not.toContain("model =");
    // check sees the same universe, so the second run is clean.
    const check = await capture([
      "surface", "mirror", "check", "--source", SKILLS, "--agents", MODEL_AGENTS, "--surface", "codex", "--out", out,
      "--models", join(PACKS, "workflow.json"),
    ]);
    expect(check.code).toBe(0);
  });

  it("reads a source persona's own alias back through --source-surface, defaulting to claude-code", async () => {
    // fixtures/agents/scout.md says `model: sonnet`: claude-code's fast tier.
    const out = tempDir();
    const cursor = await capture([...generateArgv("cursor", out, ["--models", join(PACKS, "workflow.json")]), "--json"]);
    expect(cursor.code).toBe(0);
    expect(readFileSync(join(out, "agents", "scout.md"), "utf8")).toContain("model: gpt-4.1");
    const ag = tempDir();
    const antigravity = await capture([...generateArgv("antigravity", ag, ["--models", join(PACKS, "workflow.json")]), "--json"]);
    expect(readFileSync(join(ag, "agents", "scout.md"), "utf8")).toContain("model: flash");
    expect(json(antigravity)["undocumentedAliases"]).toEqual([]);
    // Naming a source surface the file lacks is refused only when a persona needs it.
    const plain = tempDir();
    const unneeded = await capture(modelsArgv("cursor", plain, ["--source-surface", "nowhere"]));
    expect(unneeded.code).toBe(0);
    const needed = await capture(generateArgv("cursor", tempDir(), ["--models", join(PACKS, "workflow.json"), "--source-surface", "nowhere"]));
    expect(needed.code).toBe(2);
    expect(needed.err.join("\n")).toMatch(/'scout\.md' says 'model: sonnet'.*no 'models\.nowhere'/);
    const empty = await capture(generateArgv("cursor", tempDir(), ["--models", join(PACKS, "workflow.json"), "--source-surface", ""]));
    expect(empty.code).toBe(2);
    expect(empty.err.join("\n")).toMatch(/--source-surface was given an empty value/);
  });

  it("refuses an undeclared tier at exit 2, by pointer", async () => {
    const out = tempDir();
    const strange = tempDir();
    writeFileSync(join(strange, "odd.md"), "---\nname: odd\ndescription: Odd.\nmodel: gigantic\n---\n\nOdd.\n");
    const result = await capture([
      "surface", "mirror", "generate", "--source", SKILLS, "--agents", strange, "--surface", "cursor", "--out", out,
      "--models", join(PACKS, "workflow.json"),
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/'odd\.md' says 'model: gigantic', which is neither a tier of 'models\.cursor'/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("refuses a workflow with no models.<surface> at exit 2", async () => {
    const out = tempDir();
    const workflow = join(tempDir(), "workflow.json");
    writeFileSync(workflow, '{"models":{"cursor":{"fast":"x"}}}');
    const result = await capture([
      "surface", "mirror", "generate", "--source", SKILLS, "--agents", MODEL_AGENTS, "--surface", "codex", "--out", out, "--models", workflow,
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/no 'models\.codex'.*Known surfaces in the file: cursor/);
  });
});

describe("--rules", () => {
  it("writes the rules file under the row's directory, with cursor's frontmatter", async () => {
    const out = tempDir();
    const result = await capture([...generateArgv("cursor", out, ["--rules", join(PACKS, "rules.md")]), "--json"]);
    expect(result.code).toBe(0);
    expect(json(result)["rules"]).toEqual({ path: "rules/rules.mdc", chars: expect.any(Number) as number, limit: null });
    const text = readFileSync(join(out, "rules", "rules.mdc"), "utf8");
    expect(text.startsWith("---\ndescription: rules\nalwaysApply: true\n---\n<!-- GENERATED by nen surface mirror (surface: cursor)")).toBe(true);
    // The invocation mention inside the rules is NOT rewritten: the rules are
    // the caller's prose, carried verbatim.
    expect(text).toContain("`demo:alpha`");
  });

  it("refuses a rules file over antigravity's documented limit at exit 2, writing nothing", async () => {
    const out = tempDir();
    const long = join(tempDir(), "long.md");
    writeFileSync(long, "y".repeat(12_000));
    const result = await capture(generateArgv("antigravity", out, ["--rules", long]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/over the 12000-character limit/);
    expect(readdirSync(out)).toEqual([]);
  });

  it("says 'not supported' on a row with no rules file", async () => {
    const out = tempDir();
    const result = await capture([...generateArgv("codex", out, ["--rules", join(PACKS, "rules.md")]), "--json"]);
    expect(result.code).toBe(0);
    expect(json(result)["rules"]).toBe("not supported");
    expect(json(result)["written"]).not.toContain("rules/rules.md");
  });
});

describe("--permissions", () => {
  it("writes the pack in the row's shape, and 'not supported' where the surface has none", async () => {
    const out = tempDir();
    const cursor = await capture([...generateArgv("cursor", out, ["--permissions", join(PACKS, "permissions.json")]), "--json"]);
    expect(cursor.code).toBe(0);
    expect(json(cursor)["permissions"]).toBe("written");
    const doc = JSON.parse(readFileSync(join(out, "cli.json"), "utf8")) as { permissions: { allow: string[] } };
    expect(doc.permissions.allow[0]).toBe("Shell(nen *)");

    const codexOut = tempDir();
    const codex = await capture([...generateArgv("codex", codexOut, ["--permissions", join(PACKS, "permissions.json")]), "--json"]);
    expect(json(codex)["written"]).toContain("config.toml");
    expect(readFileSync(join(codexOut, "config.toml"), "utf8")).toContain('approval_policy = "on-failure"');

    const agOut = tempDir();
    const antigravity = await capture([...generateArgv("antigravity", agOut, ["--permissions", join(PACKS, "permissions.json")]), "--json"]);
    expect(antigravity.code).toBe(0);
    expect(json(antigravity)["permissions"]).toBe("not supported");
    expect(readFileSync(join(agOut, "agents", "scout.md"), "utf8")).not.toContain("commandExecutionPolicy");
  });

  it("never overwrites a config.toml it did not write", async () => {
    const out = tempDir();
    writeFileSync(join(out, "config.toml"), 'approval_policy = "never"\n');
    const result = await capture(generateArgv("codex", out, ["--permissions", join(PACKS, "permissions.json")]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/refusing to overwrite a file.*config\.toml/);
    expect(readFileSync(join(out, "config.toml"), "utf8")).toBe('approval_policy = "never"\n');
  });
});

describe("--stamp", () => {
  it("writes the stamp into the marker, and check --stamp reads it back as ok", async () => {
    const out = tempDir();
    const generated = await capture([...generateArgv("codex", out, ["--stamp", "0.43.0"]), "--json"]);
    expect(generated.code).toBe(0);
    expect(json(generated)["stamp"]).toBe("0.43.0");
    expect(readFileSync(join(out, "beta", "SKILL.md"), "utf8")).toContain(
      "<!-- GENERATED by nen surface mirror (surface: codex, stamp: 0.43.0) -- do not edit; edit the source and regenerate -->",
    );
    const same = await capture([...checkArgv("codex", out, ["--stamp", "0.43.0"]), "--json"]);
    expect(same.code).toBe(0);
    expect(json(same)["stamp"]).toBe("0.43.0");
    // Without --stamp the stamp is masked: not drift.
    expect((await capture(checkArgv("codex", out))).code).toBe(0);
  });

  it("reports an older stamp as STALE, and an unstamped file as stale only when asked", async () => {
    const out = tempDir();
    await capture(generateArgv("codex", out, ["--stamp", "0.42.0"]));
    const newer = await capture([...checkArgv("codex", out, ["--stamp", "0.43.0"]), "--json"]);
    expect(newer.code).toBe(1);
    expect(json(newer)["stale"]).toEqual(["AGENTS.md", "alpha/SKILL.md", "beta/SKILL.md"]);
    expect(json(newer)["handEdited"]).toEqual([]);

    const plain = tempDir();
    await capture(generateArgv("codex", plain));
    expect((await capture(checkArgv("codex", plain))).code).toBe(0);
    const asked = await capture([...checkArgv("codex", plain, ["--stamp", "0.43.0"]), "--json"]);
    expect(asked.code).toBe(1);
    expect(json(asked)["stale"]).toHaveLength(3);
  });

  it("refuses a stamp that is not a version", async () => {
    const result = await capture(generateArgv("codex", tempDir(), ["--stamp", "latest"]));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--stamp 'latest' is not a MAJOR\.MINOR\.PATCH version/);
  });
});

describe("check --installed", () => {
  const installedArgv = (surface: string, installed: string, extra: readonly string[] = []): readonly string[] => [
    "surface", "mirror", "check", "--source", SKILLS, "--agents", AGENTS, "--surface", surface, "--installed", installed,
    "--invocation-prefix", "demo:", "--json", ...extra,
  ];

  it("exits 0 on a fresh install and 1 naming the drifted file after a byte changes", async () => {
    const installed = tempDir();
    await capture(generateArgv("cursor", installed));
    const fresh = await capture(installedArgv("cursor", installed));
    expect(fresh.code).toBe(0);
    expect(json(fresh)["contract"]).toBe(CHECK_INSTALLED_CONTRACT);
    expect(json(fresh)["installed"]).toBe(installed);
    expect(json(fresh)["ok"]).toEqual(["agents/scout.md", "alpha/SKILL.md", "beta/SKILL.md"]);

    const path = join(installed, "alpha", "SKILL.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}!`);
    rmSync(join(installed, "beta", "SKILL.md"));
    const drifted = await capture(installedArgv("cursor", installed));
    expect(drifted.code).toBe(1);
    expect(json(drifted)["handEdited"]).toEqual(["alpha/SKILL.md"]);
    expect(json(drifted)["missing"]).toEqual(["beta/SKILL.md"]);
  });

  it("compares a claude-code plugin tree verbatim: the source IS the generation", async () => {
    const installed = tempDir();
    mkdirSync(join(installed, "skills"));
    for (const name of ["alpha", "beta"]) {
      mkdirSync(join(installed, "skills", name));
      writeFileSync(join(installed, "skills", name, "SKILL.md"), readFileSync(join(SKILLS, name, "SKILL.md")));
    }
    mkdirSync(join(installed, "agents"));
    writeFileSync(join(installed, "agents", "scout.md"), readFileSync(join(AGENTS, "scout.md")));
    writeFileSync(join(installed, "agents", "_shared.md"), readFileSync(join(AGENTS, "_shared.md")));
    const fresh = await capture(installedArgv("claude-code", installed));
    expect(fresh.code).toBe(0);
    expect(json(fresh)["ok"]).toEqual(["agents/scout.md", "skills/alpha/SKILL.md", "skills/beta/SKILL.md"]);
    // No marker to read: a changed byte is hand-edited, and an extra persona
    // file is extra -- while the shared include beside it is nobody's drift.
    writeFileSync(join(installed, "agents", "scout.md"), "changed\n");
    writeFileSync(join(installed, "agents", "ghost.md"), "---\nname: ghost\n---\n");
    const drifted = await capture(installedArgv("claude-code", installed));
    expect(drifted.code).toBe(1);
    expect(json(drifted)["handEdited"]).toEqual(["agents/scout.md"]);
    expect(json(drifted)["extra"]).toEqual(["agents/ghost.md"]);
    expect(json(drifted)["stale"]).toEqual([]);
  });

  it("refuses --installed together with --out, and generate on the verbatim row", async () => {
    const both = await capture([...checkArgv("cursor", tempDir(), ["--installed", tempDir()])]);
    expect(both.code).toBe(2);
    expect(both.err.join("\n")).toMatch(/--installed replaces --out/);
    const generate = await capture(generateArgv("claude-code", tempDir()));
    expect(generate.code).toBe(2);
    expect(generate.err.join("\n")).toMatch(/verbatim row.*nothing to generate/);
    const onGenerate = await capture(generateArgv("cursor", tempDir(), ["--installed", tempDir()]));
    expect(onGenerate.code).toBe(2);
    expect(onGenerate.err.join("\n")).toMatch(/--installed is not read by 'surface mirror generate'/);
  });
});
