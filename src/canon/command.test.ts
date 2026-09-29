import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { canonCommand, CHECK_CONTRACT, GENERATE_CONTRACT, PIN_CONTRACT } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";
import { fileMarker } from "./mirror.js";

async function capture(
  argv: readonly string[],
  // `null` is a real case, not a default-filler: the invocation that never
  // typed --repo at all (zheref/nen#28's subject).
  repoFlag: string | null = BANKAI_REPO,
): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const seams: Seams = {
    run: (): CommandResult => {
      throw new Error("canon makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("this verb has no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("this verb has no watched form");
    },
    platform: "linux",
  };
  const code = await runFamily(canonCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

function resolveArgs(values: Record<string, string>): string[] {
  const argv = ["canon", "resolve"];
  for (const [key, value] of Object.entries(values)) argv.push(`--${key}`, value);
  return argv;
}

describe("nen canon resolve -- CLI wiring", () => {
  it("resolves the scenario recorded for the target and derives the stack path", async () => {
    const result = await capture(
      resolveArgs({
        target: "zheref/KroApple",
        "always-load": "handbooks/uzf-core.md,handbooks/security-baseline.md",
        "stack-dir": "handbooks/stacks",
      }),
    );
    expect(result.code).toBe(0);
    const text = result.out.join("\n");
    expect(text).toMatch(/scenario: swiftui-tca-uzf-v2/);
    expect(text).toMatch(/always load: handbooks\/uzf-core\.md, handbooks\/security-baseline\.md/);
    expect(text).toMatch(/stack handbook: handbooks\/stacks\/swiftui-tca-uzf-v2\/architecture\.md/);
  });

  it("exits 1 with a 'not recorded anywhere' reason when the target repo is unrecorded", async () => {
    const result = await capture(
      resolveArgs({
        target: "zheref/nonexistent",
        "always-load": "handbooks/uzf-core.md",
        "stack-dir": "handbooks/stacks",
      }),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/is not recorded anywhere/);
  });

  // zheref/nen#28: the same three-way cause split repo scenario got, seen
  // through this verb. A repo the registry records WITHOUT a consumers[]
  // scenario used to produce the byte-identical "not a consumer" refusal an
  // unknown repo gets.
  it("exits 1 telling a recorded non-consumer apart from an unknown repo", async () => {
    const result = await capture(
      resolveArgs({
        target: "zheref/KroCloud",
        "always-load": "handbooks/uzf-core.md",
        "stack-dir": "handbooks/stacks",
      }),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/is recorded in .*under 'pending_onboarding'/);
  });

  // zheref/nen#219: the path the issue exists for. A tool repository recorded
  // under maintained_tools[] -- never a consumer of anything -- resolves its
  // pinned handbook through the scenario its own row states, and a
  // disagreement between its rows is repo scenario's refusal, seen here too.
  it("resolves a maintained tool's stack handbook from the scenario on its maintained_tools[] row", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-canon-listed-"));
    mkdirSync(join(root, "nen"));
    writeFileSync(
      join(root, "nen", "repos.json"),
      JSON.stringify({
        consumers: [],
        product_codes: { HA: "zheref/hatsu" },
        maintained_tools: [{ repo: "zheref/hatsu", role: "workflow prose", scenario: "bun-cli" }],
      }),
    );
    const result = await capture(
      resolveArgs({ target: "zheref/hatsu", "always-load": "handbooks/uzf-core.md", "stack-dir": "handbooks/stacks" }),
      root,
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/stack handbook: handbooks\/stacks\/bun-cli\/architecture\.md/);
  });

  it("refuses a maintained tool whose rows state different scenarios, as repo scenario does", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-canon-listed-"));
    mkdirSync(join(root, "nen"));
    writeFileSync(
      join(root, "nen", "repos.json"),
      JSON.stringify({
        consumers: [],
        maintained_tools: [{ repo: "zheref/hatsu", scenario: "bun-cli" }],
        pending_onboarding: [{ repo: "zheref/hatsu", scenario: "other" }],
      }),
    );
    const result = await capture(
      resolveArgs({ target: "zheref/hatsu", "always-load": "handbooks/uzf-core.md", "stack-dir": "handbooks/stacks" }),
      root,
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/with more than one scenario -- 'bun-cli' \(its maintained_tools\[0\] row\), 'other' \(its pending_onboarding\[0\] row\)/);
  });

  // zheref/nen#28: --repo is listed unbracketed on the usage line, so omitting
  // it is refused at the parser like --target/--stack-dir/--always-load --
  // never silently defaulted to the cwd to fail later as "no such file".
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(
      resolveArgs({
        target: "zheref/KroApple",
        "always-load": "handbooks/uzf-core.md",
        "stack-dir": "handbooks/stacks",
      }),
      null,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("requires --target and --stack-dir", async () => {
    expect((await capture(resolveArgs({}))).code).toBe(2);
    expect((await capture(resolveArgs({ target: "o/n" }))).code).toBe(2);
  });

  // Review finding #19: --always-load used to be optional and silently
  // resolved to "(none)" -- indistinguishable from "this repo truly loads
  // nothing unconditionally".
  it("requires --always-load", async () => {
    const result = await capture(resolveArgs({ target: "zheref/KroApple", "stack-dir": "handbooks/stacks" }));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--always-load/);
  });

  it("refuses an empty --always-load rather than silently resolving to '(none)'", async () => {
    const result = await capture(
      resolveArgs({ target: "zheref/KroApple", "always-load": "", "stack-dir": "handbooks/stacks" }),
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/named no paths/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["canon", "bogus"])).code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// canon mirror generate | check
// ---------------------------------------------------------------------------

interface Fixture {
  /** The consumer repository the mirror is rendered into. */
  readonly root: string;
  /** The canon rules directory -- OUTSIDE the consumer, as a handbooks checkout is. */
  readonly rulesDir: string;
  /** Repo-relative path of the canon-values file inside the consumer. */
  readonly canonValues: string;
}

const ALL = "claude-code,codex,cursor,antigravity";

function fixture(surfacesLine = "surfaces: claude-code, codex, cursor, antigravity\n"): Fixture {
  const base = mkdtempSync(join(tmpdir(), "nen-canon-verb-"));
  const root = join(base, "consumer");
  mkdirSync(root);
  const rulesDir = join(base, "handbooks", "stacks", "scenario-x", "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, "01-a.md"), "# A\n\nHello {{NAME}}.\n");
  writeFileSync(join(rulesDir, "02-b.md"), "# B\n\nSecond.\n");
  writeFileSync(join(rulesDir, "README.md"), "the index");
  writeFileSync(join(rulesDir, "placeholders.md"), "the token registry");
  mkdirSync(join(root, ".claude"));
  writeFileSync(join(root, ".claude", "canon-values.yml"), `scenario: scenario-x\n${surfacesLine}values:\n  NAME: World\n`);
  return { root, rulesDir, canonValues: ".claude/canon-values.yml" };
}

function mirrorArgs(sub: "generate" | "check", fx: Fixture, extra: readonly string[] = []): string[] {
  return [
    "canon", "mirror", sub,
    "--rules-dir", fx.rulesDir,
    "--canon-values", fx.canonValues,
    "--source", "owner/handbooks",
    "--ref", "v1.2.0",
    "--not-mirrored", "README.md,placeholders.md",
    ...extra,
  ];
}

function json(result: { out: string[] }): Record<string, unknown> {
  return JSON.parse(result.out.join("\n")) as Record<string, unknown>;
}

/** Write a consumer registry under `root` whose maintained_tools carry the given pins (`null` = no pinned field). */
function writeRegistry(root: string, tools: Readonly<Record<string, string | null>>): void {
  mkdirSync(join(root, "nen"), { recursive: true });
  const maintained = Object.entries(tools).map(([repo, pinned]): Record<string, string> =>
    pinned === null ? { repo, role: "a tool" } : { repo, role: "a tool", pinned },
  );
  writeFileSync(join(root, "nen", "repos.json"), JSON.stringify({ consumers: [], maintained_tools: maintained, product_codes: {} }, null, 2));
}

/** The mirror args without --source/--ref, so the pin has to come from the registry -- `extra` is appended AFTER the filter, so a test can put one of them back. */
function unpinnedArgs(sub: "generate" | "check", fx: Fixture, extra: readonly string[] = []): string[] {
  const base = mirrorArgs(sub, fx).filter((arg, index, all): boolean => {
    const previous = all[index - 1];
    return arg !== "--source" && arg !== "--ref" && previous !== "--source" && previous !== "--ref";
  });
  return [...base, ...extra];
}

describe("nen canon pin -- the canon pin is data in the consumer's own registry", () => {
  it("reads the one pinned maintained tool as source and ref, naming where it was recorded", async () => {
    const fx = fixture();
    writeRegistry(fx.root, { "owner/handbooks": "v1.2.0", "owner/tool": null });
    const result = await capture(["canon", "pin"], fx.root);
    expect(result.code, result.err.join("\n")).toBe(0);
    expect(result.out).toEqual(["source: owner/handbooks", "ref: v1.2.0", `recorded in: ${join(fx.root, "nen", "repos.json")} (maintained_tools[].pinned)`]);
    const doc = json(await capture(["canon", "pin", "--json"], fx.root));
    expect(doc).toEqual({ contract: PIN_CONTRACT, source: "owner/handbooks", ref: "v1.2.0", tagShaped: true, recordedIn: "nen/repos.json (maintained_tools[].pinned)" });
  });

  it("exits 1 naming the field when the consumer has no registry, or pins nothing", async () => {
    const fx = fixture();
    const none = await capture(["canon", "pin"], fx.root);
    expect(none.code).toBe(1);
    expect(none.err.join("\n")).toMatch(/has no nen\/repos\.json, so no canon pin is recorded.*maintained_tools\[\]\.pinned/);
    writeRegistry(fx.root, { "owner/tool": null });
    const unpinned = await capture(["canon", "pin"], fx.root);
    expect(unpinned.code).toBe(1);
    expect(unpinned.err.join("\n")).toMatch(/pins no maintained tool/);
  });

  it("needs --source when several tools are pinned, and refuses a --source the registry does not pin", async () => {
    const fx = fixture();
    writeRegistry(fx.root, { "owner/handbooks": "v1.2.0", "owner/other": "v3.0.0" });
    const ambiguous = await capture(["canon", "pin"], fx.root);
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.err.join("\n")).toMatch(/pins 2 maintained tools \(owner\/handbooks, owner\/other\); name the canonical one with --source/);
    const chosen = await capture(["canon", "pin", "--source", "owner/other"], fx.root);
    expect(chosen.code).toBe(0);
    expect(chosen.out[1]).toBe("ref: v3.0.0");
    const unknown = await capture(["canon", "pin", "--source", "owner/nowhere"], fx.root);
    expect(unknown.code).toBe(1);
    expect(unknown.err.join("\n")).toMatch(/records no 'pinned' tag for owner\/nowhere under maintained_tools \(pinned there: owner\/handbooks, owner\/other\)/);
  });

  it("reports a recorded pin that is not tag-shaped, and exits 1: a branch is not a pin", async () => {
    const fx = fixture();
    writeRegistry(fx.root, { "owner/handbooks": "main" });
    const result = await capture(["canon", "pin", "--json"], fx.root);
    expect(result.code).toBe(1);
    expect(json(result)["tagShaped"]).toBe(false);
    expect(result.err.join("\n")).toMatch(/the recorded pin 'main' is not tag-shaped/);
  });

  it("refuses an omitted --repo and an empty --source at exit 2", async () => {
    expect((await capture(["canon", "pin"], null)).code).toBe(2);
    const fx = fixture();
    const empty = await capture(["canon", "pin", "--source", ""], fx.root);
    expect(empty.code).toBe(2);
    expect(empty.err.join("\n")).toMatch(/--source was given an empty value/);
  });
});

describe("nen canon mirror -- --source and --ref default to the consumer's recorded pin", () => {
  it("renders and checks with neither flag when the registry pins exactly one tool, and the marker names that pin", async () => {
    const fx = fixture();
    writeRegistry(fx.root, { "owner/handbooks": "v1.2.0" });
    const generated = await capture(unpinnedArgs("generate", fx, ["--surfaces", "claude-code"]), fx.root);
    expect(generated.code, generated.err.join("\n")).toBe(0);
    expect(readFileSync(join(fx.root, ".claude", "rules", "01-a.md"), "utf8")).toMatch(/^<!-- GENERATED by nen canon mirror from owner\/handbooks@v1\.2\.0: scenario-x\/01-a\.md/);
    expect((await capture(unpinnedArgs("check", fx, ["--surfaces", "claude-code"]), fx.root)).code).toBe(0);
    // Moving the recorded pin, with no flag anywhere, is what makes the mirror stale.
    writeRegistry(fx.root, { "owner/handbooks": "v1.3.0" });
    const moved = await capture(unpinnedArgs("check", fx, ["--surfaces", "claude-code"]), fx.root);
    expect(moved.code).toBe(1);
    expect(moved.out.join("\n")).toMatch(/stale: \.claude\/rules\/01-a\.md, \.claude\/rules\/02-b\.md/);
  });

  it("lets a flag override the recorded pin, and --source pick among several", async () => {
    const fx = fixture();
    writeRegistry(fx.root, { "owner/handbooks": "v1.2.0", "owner/other": "v3.0.0" });
    const picked = await capture([...unpinnedArgs("generate", fx, ["--surfaces", "claude-code", "--source", "owner/other", "--dry-run"]), "--json"], fx.root);
    expect(picked.code, picked.err.join("\n")).toBe(0);
    expect(json(picked)).toMatchObject({ source: "owner/other", ref: "v3.0.0" });
    const overridden = await capture([...unpinnedArgs("generate", fx, ["--surfaces", "claude-code", "--source", "owner/other", "--ref", "v9.9.9", "--dry-run"]), "--json"], fx.root);
    expect(json(overridden)).toMatchObject({ source: "owner/other", ref: "v9.9.9" });
  });

  it("refuses by name when neither the flags nor the registry give a pin, saying both ways to supply it", async () => {
    const fx = fixture();
    const noRegistry = await capture(unpinnedArgs("generate", fx), fx.root);
    expect(noRegistry.code).toBe(2);
    expect(noRegistry.err.join("\n")).toMatch(/--source not given and .* has no nen\/repos\.json\. Name the canonical handbooks repository with --source .* or record it under maintained_tools with a 'pinned' tag/);
    writeRegistry(fx.root, { "owner/handbooks": "v1.2.0", "owner/other": "v3.0.0" });
    const ambiguous = await capture(unpinnedArgs("generate", fx), fx.root);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.err.join("\n")).toMatch(/--source not given and .* pins 2 maintained tools/);
    writeRegistry(fx.root, { "owner/handbooks": null });
    const unpinnedSource = await capture(unpinnedArgs("generate", fx, ["--source", "owner/handbooks"]), fx.root);
    expect(unpinnedSource.code).toBe(2);
    expect(unpinnedSource.err.join("\n")).toMatch(/--ref not given and .* records no 'pinned' tag for owner\/handbooks under maintained_tools\. Pass --ref <tag>, or record the pin/);
  });

  it("refuses a recorded pin that is not tag-shaped, naming it as the recorded pin rather than a flag", async () => {
    const fx = fixture();
    writeRegistry(fx.root, { "owner/handbooks": "main" });
    const result = await capture(unpinnedArgs("generate", fx), fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/the recorded pin for owner\/handbooks 'main' is not tag-shaped/);
  });
});

describe("nen canon mirror generate -- CLI wiring", () => {
  it("renders every declared surface into its own location under --repo, and says so", async () => {
    const fx = fixture();
    const result = await capture(mirrorArgs("generate", fx), fx.root);
    expect(result.code, result.err.join("\n")).toBe(0);
    expect(readdirSync(join(fx.root, ".claude", "rules")).sort()).toEqual(["01-a.md", "02-b.md"]);
    expect(readdirSync(join(fx.root, ".cursor", "rules")).sort()).toEqual(["01-a.mdc", "02-b.mdc"]);
    expect(readdirSync(join(fx.root, ".agents", "rules")).sort()).toEqual(["01-a.md", "02-b.md"]);
    expect(readFileSync(join(fx.root, "AGENTS.md"), "utf8")).toMatch(/^<!-- BEGIN GENERATED by nen canon mirror from owner\/handbooks@v1\.2\.0: scenario-x/);
    expect(readFileSync(join(fx.root, ".claude", "rules", "01-a.md"), "utf8")).toContain("Hello World.");
    const text = result.out.join("\n");
    expect(text).toMatch(/^source: owner\/handbooks@v1\.2\.0 \(scenario scenario-x\)/);
    expect(text).toMatch(/surface: claude-code -> \.claude\/rules\/\n  written: \.claude\/rules\/01-a\.md, \.claude\/rules\/02-b\.md/);
    expect(text).toMatch(/surface: codex -> AGENTS\.md\n  written: AGENTS\.md/);
    // Each surface's caveat is printed on stderr, never acted on.
    expect(result.err.join("\n")).toMatch(/nen: note: codex: AGENTS\.md is read as plain prose by more than this surface/);
  });

  it("carries a versioned --json contract with one entry per surface", async () => {
    const fx = fixture();
    const result = await capture([...mirrorArgs("generate", fx), "--json"], fx.root);
    expect(result.code).toBe(0);
    const doc = json(result);
    expect(doc["contract"]).toBe(GENERATE_CONTRACT);
    expect(doc["source"]).toBe("owner/handbooks");
    expect(doc["ref"]).toBe("v1.2.0");
    expect(doc["scenario"]).toBe("scenario-x");
    expect(doc["dryRun"]).toBe(false);
    const surfaces = doc["surfaces"] as { surface: string; location: string; written: string[] }[];
    expect(surfaces.map((entry): string => entry.surface)).toEqual(["claude-code", "codex", "cursor", "antigravity"]);
    expect(surfaces[2]).toMatchObject({ location: ".cursor/rules/", written: [".cursor/rules/01-a.mdc", ".cursor/rules/02-b.mdc"] });
  });

  it("takes the surface list from --surfaces over the file's, and renders only those", async () => {
    const fx = fixture();
    const result = await capture(mirrorArgs("generate", fx, ["--surfaces", "codex"]), fx.root);
    expect(result.code).toBe(0);
    expect(existsSync(join(fx.root, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(fx.root, ".claude", "rules"))).toBe(false);
  });

  it("with --dry-run reports every write and performs none", async () => {
    const fx = fixture();
    const result = await capture([...mirrorArgs("generate", fx), "--dry-run"], fx.root);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/\(--dry-run: nothing written\)/);
    expect(result.out.join("\n")).toMatch(/written: AGENTS\.md/);
    expect(readdirSync(fx.root)).toEqual([".claude"]);
    expect(readdirSync(join(fx.root, ".claude"))).toEqual(["canon-values.yml"]);
  });

  it("preserves the consumer's own AGENTS.md prose and appends the block after it", async () => {
    const fx = fixture();
    writeFileSync(join(fx.root, "AGENTS.md"), "# Consumer\n\nProject specifics, hand-written.\n");
    expect((await capture(mirrorArgs("generate", fx, ["--surfaces", "codex"]), fx.root)).code).toBe(0);
    const text = readFileSync(join(fx.root, "AGENTS.md"), "utf8");
    expect(text.startsWith("# Consumer\n\nProject specifics, hand-written.\n\n<!-- BEGIN GENERATED by nen canon mirror")).toBe(true);
    expect(text.endsWith("<!-- END GENERATED by nen canon mirror -->\n")).toBe(true);
  });

  it("REFUSES the whole run at exit 2 when any surface's destination is a hand-written file, writing nothing anywhere", async () => {
    const fx = fixture();
    mkdirSync(join(fx.root, ".cursor", "rules"), { recursive: true });
    writeFileSync(join(fx.root, ".cursor", "rules", "01-a.mdc"), "---\nalwaysApply: true\n---\n# Mine\n");
    const result = await capture(mirrorArgs("generate", fx), fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/refusing to write the mirror -- nothing was written on any surface:\n  cursor: \.cursor\/rules\/01-a\.mdc exists and carries no/);
    // The surfaces BEFORE cursor in the list were not written either.
    expect(existsSync(join(fx.root, ".claude", "rules"))).toBe(false);
    expect(existsSync(join(fx.root, "AGENTS.md"))).toBe(false);
  });

  it("deletes a marked orphan and leaves the consumer's own unmarked file, listing it as foreign", async () => {
    const fx = fixture();
    mkdirSync(join(fx.root, ".claude", "rules"), { recursive: true });
    writeFileSync(join(fx.root, ".claude", "rules", "99-old.md"), `${fileMarker({ source: "owner/handbooks", ref: "v1.1.0", scenario: "scenario-x" }, "99-old.md")}\nold\n`);
    writeFileSync(join(fx.root, ".claude", "rules", "house.md"), "# the consumer's own\n");
    const result = await capture([...mirrorArgs("generate", fx, ["--surfaces", "claude-code"]), "--json"], fx.root);
    expect(result.code).toBe(0);
    const [claude] = json(result)["surfaces"] as { deleted: string[]; foreign: string[] }[];
    expect(claude).toMatchObject({ deleted: [".claude/rules/99-old.md"], foreign: [".claude/rules/house.md"] });
    expect(existsSync(join(fx.root, ".claude", "rules", "house.md"))).toBe(true);
  });

  it("refuses an OMITTED --repo at exit 2, naming the flag: this verb writes into the consumer", async () => {
    const fx = fixture();
    const result = await capture(mirrorArgs("generate", fx), null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required\. It is the CONSUMER repository/);
  });

  it("refuses a --ref that is not tag-shaped: the pin discipline is a tag, never a floating branch", async () => {
    const fx = fixture();
    for (const ref of ["main", "abc1234", "1.2.0", "refs/tags/v1"]) {
      const result = await capture(mirrorArgs("generate", fx).map((arg): string => (arg === "v1.2.0" ? ref : arg)), fx.root);
      expect(result.code, ref).toBe(2);
      expect(result.err.join("\n"), ref).toMatch(/--ref '.*' is not tag-shaped .* cut the tag first/);
    }
    for (const ref of ["v1.2", "v1.2.3", "v0.6.0-rc1"]) {
      const result = await capture(mirrorArgs("generate", fx, ["--dry-run"]).map((arg): string => (arg === "v1.2.0" ? ref : arg)), fx.root);
      expect(result.code, ref).toBe(0);
    }
  });

  it("refuses a --source that is not an owner/name slug", async () => {
    const fx = fixture();
    const result = await capture(mirrorArgs("generate", fx).map((arg): string => (arg === "owner/handbooks" ? "../somewhere" : arg)), fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--source '\.\.\/somewhere' is not an owner\/name slug/);
  });

  it("refuses an unknown surface, an empty surface list, and a run with no surface list anywhere -- each naming the known ones", async () => {
    const fx = fixture();
    const unknown = await capture(mirrorArgs("generate", fx, ["--surfaces", "codex,vim"]), fx.root);
    expect(unknown.code).toBe(2);
    // The known list is the table's own order (src/surface/rules.ts), not an alphabetical one.
    expect(unknown.err.join("\n")).toMatch(/surface 'vim' is not one a canon mirror can be rendered into\. Known: codex, cursor, antigravity, claude-code/);
    expect((await capture(mirrorArgs("generate", fx, ["--surfaces", ""]), fx.root)).err.join("\n")).toMatch(/--surfaces was given an empty value/);

    const undeclared = fixture("");
    const none = await capture(mirrorArgs("generate", undeclared), undeclared.root);
    expect(none.code).toBe(2);
    expect(none.err.join("\n")).toMatch(/--surfaces not given and the canon-values file has no 'surfaces:' field/);

    const declaredEmpty = fixture("surfaces:\n");
    expect((await capture(mirrorArgs("generate", declaredEmpty), declaredEmpty.root)).err.join("\n")).toMatch(/names no surfaces/);
  });

  // zheref/nen#101: an unreadable --canon-values is the named exit-2 refusal,
  // not a raw errno at exit 1.
  it("refuses an unreadable --canon-values at exit 2, naming the path and its purpose", async () => {
    const fx = fixture();
    const result = await capture(mirrorArgs("generate", fx).map((arg): string => (arg === fx.canonValues ? "nope.yml" : arg)), fx.root);
    expect(result.code).toBe(2);
    const said = result.err.join("\n");
    expect(said).toMatch(/could not read .*nope\.yml.*ENOENT/);
    expect(said).toMatch(/every mirrored rule is keyed by/);
  });

  it("refuses an unbound token at exit 2, naming the file and the token", async () => {
    const fx = fixture();
    writeFileSync(join(fx.rulesDir, "03-c.md"), "{{UNBOUND}}\n");
    const result = await capture(mirrorArgs("generate", fx), fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/03-c\.md: \{\{UNBOUND\}\} has no canon-values binding/);
    expect(existsSync(join(fx.root, "AGENTS.md"))).toBe(false);
  });

  it("refuses a --rules-dir that sits inside a rendered surface's location", async () => {
    const fx = fixture();
    mkdirSync(join(fx.root, ".claude", "rules"), { recursive: true });
    writeFileSync(join(fx.root, ".claude", "rules", "01-a.md"), "# a\n");
    const result = await capture(mirrorArgs("generate", fx).map((arg): string => (arg === fx.rulesDir ? ".claude/rules" : arg)), fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--rules-dir '\.claude\/rules' resolves inside 'claude-code''s rules location/);
  });

  it("refuses the one-directory shape's flags by name, saying where each meaning went", async () => {
    const fx = fixture();
    const result = await capture(mirrorArgs("generate", fx, ["--out-dir", ".claude/rules"]), fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown option '--out-dir'/);
    expect(result.err.join("\n")).toMatch(/the mirror's location is now each surface's own rules location under --repo/);
    const header = await capture(mirrorArgs("generate", fx, ["--header-template", "x"]), fx.root);
    expect(header.err.join("\n")).toMatch(/the generated-from marker is nen's own now/);
  });

  it("refuses --markdown-out on generate: a flag accepted and ignored is worse than one refused", async () => {
    const fx = fixture();
    const result = await capture(mirrorArgs("generate", fx, ["--markdown-out", "drift.md"]), fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--markdown-out is not read by 'canon mirror generate'/);
  });

  it("refuses an unknown 'canon mirror' subcommand", async () => {
    expect((await capture(["canon", "mirror", "bogus"])).code).toBe(2);
  });
});

describe("nen canon mirror check -- CLI wiring", () => {
  it("exits 0 with no drift right after a generate, then 1 naming the drift per surface once the canon moves", async () => {
    const fx = fixture();
    expect((await capture(mirrorArgs("generate", fx), fx.root)).code).toBe(0);
    const clean = await capture(mirrorArgs("check", fx), fx.root);
    expect(clean.code, clean.err.join("\n")).toBe(0);
    expect(clean.out.join("\n")).toMatch(/surface: antigravity -> \.agents\/rules\/\n  ok: 2\n  missing: \(none\)/);
    expect(clean.out.at(-1)).toBe("drift: none");

    writeFileSync(join(fx.rulesDir, "01-a.md"), "# A\n\nHello {{NAME}}, changed upstream.\n");
    const dirty = await capture([...mirrorArgs("check", fx), "--json"], fx.root);
    expect(dirty.code).toBe(1);
    const doc = json(dirty);
    expect(doc["contract"]).toBe(CHECK_CONTRACT);
    expect(doc["drift"]).toBe(true);
    const surfaces = doc["surfaces"] as { surface: string; handEdited: string[]; ok: string[] }[];
    expect(surfaces.find((entry): boolean => entry.surface === "claude-code")).toMatchObject({ handEdited: [".claude/rules/01-a.md"], ok: [".claude/rules/02-b.md"] });
    expect(surfaces.find((entry): boolean => entry.surface === "codex")).toMatchObject({ handEdited: ["01-a.md"], ok: ["02-b.md"] });
  });

  it("reports STALE on every surface when the pin moved and nothing was regenerated, and writes the --markdown-out table", async () => {
    const fx = fixture();
    expect((await capture(mirrorArgs("generate", fx), fx.root)).code).toBe(0);
    const result = await capture(
      [...mirrorArgs("check", fx, ["--markdown-out", "drift.md"]).map((arg): string => (arg === "v1.2.0" ? "v1.3.0" : arg))],
      fx.root,
    );
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/surface: cursor -> \.cursor\/rules\/\n  ok: 0\n  missing: \(none\)\n  extra: \(none\)\n  stale: \.cursor\/rules\/01-a\.mdc, \.cursor\/rules\/02-b\.mdc/);
    const table = readFileSync(join(fx.root, "drift.md"), "utf8");
    expect(table).toContain("| Surface | File | Issue |");
    expect(table).toContain("| `codex` | `01-a.md` | stale (generated for another pin) |");
    expect(table).toContain("| `antigravity` | `.agents/rules/02-b.md` | stale (generated for another pin) |");
  });

  it("reads an unrendered consumer as all missing, and a foreign file as not drift", async () => {
    const fx = fixture();
    mkdirSync(join(fx.root, ".claude", "rules"), { recursive: true });
    writeFileSync(join(fx.root, ".claude", "rules", "mine.md"), "# mine\n");
    const result = await capture(mirrorArgs("check", fx, ["--surfaces", "claude-code"]), fx.root);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/missing: \.claude\/rules\/01-a\.md, \.claude\/rules\/02-b\.md/);
    expect(result.out.join("\n")).toMatch(/foreign \(the consumer's own, not drift\): \.claude\/rules\/mine\.md/);
  });

  it("refuses --dry-run on check: check writes nothing to begin with", async () => {
    const fx = fixture();
    const result = await capture(mirrorArgs("check", fx, ["--dry-run"]), fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--dry-run is not read by 'canon mirror check'/);
  });

  it("refuses an empty --markdown-out value", async () => {
    const fx = fixture();
    expect((await capture(mirrorArgs("generate", fx), fx.root)).code).toBe(0);
    const result = await capture(mirrorArgs("check", fx, ["--markdown-out", ""]), fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--markdown-out was given an empty value/);
  });

  it("accepts --surfaces on the command line for the consumer that declares none in the file", async () => {
    const fx = fixture("");
    expect((await capture(mirrorArgs("generate", fx, ["--surfaces", ALL]), fx.root)).code).toBe(0);
    expect((await capture(mirrorArgs("check", fx, ["--surfaces", ALL]), fx.root)).code).toBe(0);
  });
});

describe("nen canon mirror -- the scenario is held to the plain-token rule the markers depend on (Copilot, PR #274)", () => {
  it("refuses a scenario with a path separator or whitespace at exit 2, writing nothing", async () => {
    const fx = fixture();
    for (const scenario of ["foo/bar", "two words", "..", ".hidden"]) {
      const result = await capture(mirrorArgs("generate", fx, ["--scenario", scenario]), fx.root);
      expect(result.code, scenario).toBe(2);
      expect(result.err.join("\n"), scenario).toMatch(/scenario '.*' is not a plain token .* written into every mirror file's marker/);
    }
    expect(existsSync(join(fx.root, "AGENTS.md"))).toBe(false);
  });

  it("accepts the interior dots, underscores and hyphens real scenarios carry", async () => {
    const fx = fixture();
    const result = await capture(mirrorArgs("generate", fx, ["--scenario", "swiftui_tca.v2-beta", "--dry-run", "--surfaces", "codex"]), fx.root);
    expect(result.code, result.err.join("\n")).toBe(0);
  });
});
