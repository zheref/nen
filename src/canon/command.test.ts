import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { canonCommand, CHECK_CONTRACT, describeWriteFailure, GENERATE_CONTRACT, PIN_CONTRACT } from "./command.js";
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

  it("names an UNRESOLVED MERGE CONFLICT as the cause, not a hand edit, when a generated file is caught mid-merge (zheref/nen#309)", async () => {
    const fx = fixture();
    expect((await capture(mirrorArgs("generate", fx, ["--surfaces", "claude-code"]), fx.root)).code).toBe(0);
    const generated = join(fx.root, ".claude", "rules", "01-a.md");
    const ours = readFileSync(generated, "utf8");
    // A conflicted merge displaces the ownership marker from line 1.
    writeFileSync(generated, `<<<<<<< HEAD\n${ours}=======\n${ours.replace("Hello", "Hi")}>>>>>>> other-branch\n`);
    const result = await capture(mirrorArgs("generate", fx, ["--surfaces", "claude-code"]), fx.root);
    expect(result.code).toBe(2);
    const err = result.err.join("\n");
    expect(err).toMatch(/claude-code: \.claude\/rules\/01-a\.md has an unresolved merge conflict \(line 1: '<<<<<<< HEAD'\)/);
    expect(err).not.toMatch(/hand-written|written by hand/);
    // Still a refusal: the conflicted file is untouched.
    expect(readFileSync(generated, "utf8").startsWith("<<<<<<< HEAD\n")).toBe(true);
  });

  it("REFUSES a marked generated file whose marker survived but whose body holds a conflict hunk, writing nothing (zheref/nen#309)", async () => {
    const fx = fixture();
    expect((await capture(mirrorArgs("generate", fx, ["--surfaces", "claude-code"]), fx.root)).code).toBe(0);
    const generated = join(fx.root, ".claude", "rules", "01-a.md");
    const [markerLine, ...rest] = readFileSync(generated, "utf8").split("\n");
    const conflicted = `${markerLine}\n<<<<<<< HEAD\n${rest.join("\n")}=======\ntheirs\n>>>>>>> other-branch\n`;
    writeFileSync(generated, conflicted);
    const result = await capture(mirrorArgs("generate", fx, ["--surfaces", "claude-code"]), fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/claude-code: \.claude\/rules\/01-a\.md has an unresolved merge conflict \(line 2: '<<<<<<< HEAD'\), so it is not regenerated over/);
    expect(readFileSync(generated, "utf8")).toBe(conflicted);
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

describe("nen canon mirror check --markdown-out -- the parent is created, and a failed write never wears drift's exit 1 (zheref/nen#292)", () => {
  /** A consumer whose mirror was just generated, so `check` at v1.2.0 is CLEAN and at v1.3.0 DRIFTS (every file stale). */
  async function generated(): Promise<Fixture> {
    const fx = fixture();
    expect((await capture(mirrorArgs("generate", fx), fx.root)).code).toBe(0);
    return fx;
  }
  const clean = (fx: Fixture, extra: readonly string[]): string[] => mirrorArgs("check", fx, extra);
  const drifting = (fx: Fixture, extra: readonly string[]): string[] =>
    mirrorArgs("check", fx, extra).map((arg): string => (arg === "v1.2.0" ? "v1.3.0" : arg));

  it("creates a missing parent on a CLEAN mirror and exits 0 -- it used to exit 1 on ENOENT, reading as drift", async () => {
    const fx = await generated();
    expect(existsSync(join(fx.root, "a"))).toBe(false);
    const result = await capture(clean(fx, ["--markdown-out", "a/b/c.md"]), fx.root);
    expect(result.code, result.err.join("\n")).toBe(0);
    expect(result.out.at(-1)).toBe("drift: none");
    expect(readFileSync(join(fx.root, "a", "b", "c.md"), "utf8")).toBe("No drift -- every mirror file on every surface matches a fresh rendering.\n");
  });

  it("creates a missing parent on a DRIFTING mirror and exits 1 -- drift, with the table written", async () => {
    const fx = await generated();
    const result = await capture(drifting(fx, ["--markdown-out", "a/b/c.md"]), fx.root);
    expect(result.code, result.err.join("\n")).toBe(1);
    expect(result.out.at(-1)).toBe("drift: yes");
    const table = readFileSync(join(fx.root, "a", "b", "c.md"), "utf8");
    expect(table).toContain("| Surface | File | Issue |");
    expect(table).toContain("| `codex` | `01-a.md` | stale (generated for another pin) |");
  });

  it("uses an absolute --markdown-out as-is, creating its parent too", async () => {
    const fx = await generated();
    const elsewhere = join(mkdtempSync(join(tmpdir(), "nen-canon-report-")), "deep", "er", "drift.md");
    const result = await capture(clean(fx, ["--markdown-out", elsewhere]), fx.root);
    expect(result.code, result.err.join("\n")).toBe(0);
    expect(existsSync(elsewhere)).toBe(true);
  });

  it("resolves a relative --markdown-out against --repo, not the process's directory -- run from somewhere else", async () => {
    // The issue's trap: `mkdir -p .nen` in the shell's directory creates it in
    // the WRONG tree. Standing the process in a decoy directory is the only way
    // to tell the two bases apart (see ../cli/path-base.test.ts's header).
    const fx = await generated();
    const cwd = mkdtempSync(join(tmpdir(), "nen-canon-cwd-"));
    const previous = process.cwd();
    let result;
    try {
      process.chdir(cwd);
      result = await capture(drifting(fx, ["--markdown-out", ".nen/canon-drift.md"]), fx.root);
    } finally {
      process.chdir(previous);
    }
    expect(result.code, result.err.join("\n")).toBe(1);
    expect(readFileSync(join(fx.root, ".nen", "canon-drift.md"), "utf8")).toContain("| Surface | File | Issue |");
    expect(existsSync(join(cwd, ".nen"))).toBe(false);
  });

  it("refuses a parent that is a FILE at exit 2 on a clean mirror AND a drifting one, naming the typed and resolved path", async () => {
    const fx = await generated();
    writeFileSync(join(fx.root, "blocker"), "a file where a directory has to go\n");
    // `blocker/c.md`: mkdir -p of `blocker` itself raises EEXIST; `blocker/x/c.md`: ENOTDIR. One fact, both spellings.
    for (const target of ["blocker/c.md", "blocker/x/c.md"]) {
      for (const [verdict, argv] of [
        ["none", clean(fx, ["--markdown-out", target, "--json"])],
        ["yes", drifting(fx, ["--markdown-out", target, "--json"])],
      ] as const) {
        const result = await capture(argv, fx.root);
        const err = result.err.join("\n");
        expect(result.code, `${target} drift ${verdict}: ${err}`).toBe(2);
        expect(err).toContain(`--markdown-out '${target}' resolves to '${join(fx.root, ...target.split("/"))}', which could not be written`);
        expect(err).toMatch(/\((EEXIST|ENOTDIR): a component of its parent path exists and is not a directory\)/);
        expect(err).toContain(`The check itself ran (drift: ${verdict})`);
        expect(err).toMatch(/refused at exit 2 -- never exit 1, which means the mirror has drifted/);
        // No verdict document on stdout beside an exit 2: a caller parsing --json must not read "drift: false" off a failed run.
        expect(result.out).toEqual([]);
      }
    }
  });

  it("refuses a --markdown-out that IS a directory at exit 2 (EISDIR), not 1", async () => {
    const fx = await generated();
    mkdirSync(join(fx.root, "reports"));
    const result = await capture(clean(fx, ["--markdown-out", "reports"]), fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain(`'${join(fx.root, "reports")}', which could not be written (EISDIR: that path is a directory)`);
    expect(result.out).toEqual([]);
  });

  it("refuses an unwritable parent at exit 2 (EACCES), not 1, on a drifting mirror", async () => {
    const fx = await generated();
    const locked = join(fx.root, "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o555);
    // Skipped where the permission bit is not enforced (root, or a filesystem
    // that ignores it) rather than asserted into a platform-dependent failure --
    // the same guard ../changelog/command.test.ts uses for its EACCES case.
    let enforced = true;
    try {
      writeFileSync(join(locked, "probe"), "");
      enforced = false;
    } catch {
      // still locked, as expected
    }
    try {
      if (enforced) {
        const result = await capture(drifting(fx, ["--markdown-out", "locked/drift.md"]), fx.root);
        expect(result.code).toBe(2);
        expect(result.err.join("\n")).toMatch(/locked\/drift\.md', which could not be written \((EACCES|EPERM): permission denied\)/);
        expect(result.err.join("\n")).toContain("The check itself ran (drift: yes)");
      }
    } finally {
      chmodSync(locked, 0o755); // restore so the temp-dir cleanup can traverse it
    }
  });

  it("describes every write failure it can meet, and carries an errno-less one by its own message", () => {
    const errno = (code: string): Error => Object.assign(new Error(`${code}: raw`), { code });
    expect(describeWriteFailure(errno("EEXIST"))).toBe("EEXIST: a component of its parent path exists and is not a directory");
    expect(describeWriteFailure(errno("ENOTDIR"))).toBe("ENOTDIR: a component of its parent path exists and is not a directory");
    expect(describeWriteFailure(errno("EISDIR"))).toBe("EISDIR: that path is a directory");
    expect(describeWriteFailure(errno("EACCES"))).toBe("EACCES: permission denied");
    expect(describeWriteFailure(errno("EPERM"))).toBe("EPERM: permission denied");
    expect(describeWriteFailure(errno("ENOSPC"))).toBe("ENOSPC: the file system refused the write");
    expect(describeWriteFailure(new Error("no errno here"))).toBe("no errno here");
    expect(describeWriteFailure("a thrown string")).toBe("a thrown string");
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

describe("nen canon checkout + mirror's checkout form -- the refusals that come before any git call (zheref/nen#294)", () => {
  it("refuses --rules-dir beside the checkout form, and neither form, at exit 2 by name", async () => {
    const fx = fixture();
    const both = await capture(mirrorArgs("check", fx, ["--stack-dir", "handbooks/stacks", "--leaf", "rules"]), fx.root);
    expect(both.code).toBe(2);
    expect(both.err.join("\n")).toMatch(/give one or the other, never both/);
    const withCheckout = await capture(mirrorArgs("check", fx, ["--canon-checkout", "/x"]), fx.root);
    expect(withCheckout.code).toBe(2);
    const neither = mirrorArgs("check", fx).filter((arg, index, all): boolean => arg !== "--rules-dir" && all[index - 1] !== "--rules-dir");
    const none = await capture(neither, fx.root);
    expect(none.code).toBe(2);
    expect(none.err.join("\n")).toMatch(/--rules-dir is required, or --stack-dir <dir> and --leaf <name> together/);
    const half = await capture([...neither, "--stack-dir", "handbooks/stacks"], fx.root);
    expect(half.code).toBe(2);
    expect(half.err.join("\n")).toMatch(/Missing: --leaf\./);
  });

  it("refuses an unresolvable checkout at exit 2 on check -- never drift's 1 -- naming the code and the verb that shows every step", async () => {
    const fx = fixture();
    writeRegistry(fx.root, { "owner/handbooks": "v1.2.0" });
    const argv = unpinnedArgs("check", fx).filter((arg, index, all): boolean => arg !== "--rules-dir" && all[index - 1] !== "--rules-dir");
    const result = await capture([...argv, "--stack-dir", "handbooks/stacks", "--leaf", "rules"], fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/the canon checkout did not resolve \(unresolvable\): no canon checkout for owner\/handbooks@v1\.2\.0.*Run 'nen canon checkout --repo /);
  });

  it("canon checkout: exit 1 with a JSON failure document when nothing resolves; exit 2 on a missing --repo, a foreign flag or an empty --canon-checkout", async () => {
    const fx = fixture();
    writeRegistry(fx.root, { "owner/handbooks": "v1.2.0" });
    const result = await capture(["canon", "checkout", "--json"], fx.root);
    expect(result.code).toBe(1);
    expect(json(result)).toMatchObject({ contract: "nen.canon.checkout/v0.1", ok: false, source: "owner/handbooks", ref: "v1.2.0", path: null, resolvedFrom: null, verified: null, failure: { code: "unresolvable" } });
    expect(result.err.join("\n")).toMatch(/^nen: unresolvable: /);
    const text = await capture(["canon", "checkout"], fx.root);
    expect(text.out).toEqual(expect.arrayContaining(["source: owner/handbooks@v1.2.0", "checkout: (unresolved)", "  passed over: flag --canon-checkout (not given)"]));
    expect((await capture(["canon", "checkout"], null)).code).toBe(2);
    const foreign = await capture(["canon", "checkout", "--rules-dir", "x"], fx.root);
    expect(foreign.code).toBe(2);
    expect(foreign.err.join("\n")).toMatch(/--rules-dir is not read by 'canon checkout'/);
    expect((await capture(["canon", "checkout", "--canon-checkout", ""], fx.root)).code).toBe(2);
  });

  it("canon checkout: exit 2 when there is no pin to resolve a source and ref from", async () => {
    const fx = fixture();
    const result = await capture(["canon", "checkout"], fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--source not given/);
  });
});

describe("Nobunaga round 1 -- the registry and flag findings (zheref/nen#294)", () => {
  /** The mirror args in the checkout form, --source/--ref and --rules-dir dropped. */
  function checkoutFormArgs(sub: "generate" | "check", fx: Fixture, extra: readonly string[] = []): string[] {
    const argv = unpinnedArgs(sub, fx).filter((arg, index, all): boolean => arg !== "--rules-dir" && all[index - 1] !== "--rules-dir");
    return [...argv, "--stack-dir", "handbooks/stacks", "--leaf", "rules", ...extra];
  }
  function writeRaw(root: string, registry: unknown): void {
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "repos.json"), JSON.stringify(registry));
  }

  it("N5: a malformed registry is exit 2 on generate and check -- never drift's 1 -- through the pin and through the checkout declaration", async () => {
    const fx = fixture();
    writeRaw(fx.root, { consumers: [], maintained_tools: [{ repo: "owner/handbooks", pinned: 3 }] });
    for (const sub of ["generate", "check"] as const) {
      const viaPin = await capture(checkoutFormArgs(sub, fx), fx.root);
      expect(viaPin.code, viaPin.err.join("\n")).toBe(2);
      expect(viaPin.err.join("\n")).toMatch(/maintained_tools\[0\]\.pinned/);
    }
    writeRaw(fx.root, { consumers: [], maintained_tools: [{ repo: "owner/handbooks", checkout_env: "/not/a/name" }] });
    for (const sub of ["generate", "check"] as const) {
      const viaDeclaration = await capture(checkoutFormArgs(sub, fx, ["--source", "owner/handbooks", "--ref", "v1.2.0"]), fx.root);
      expect(viaDeclaration.code, viaDeclaration.err.join("\n")).toBe(2);
      expect(viaDeclaration.err.join("\n")).toMatch(/maintained_tools\[0\]\.checkout_env/);
    }
  });

  it("N6: --canon-checkout is refused on 'canon pin' and 'canon resolve'", async () => {
    const fx = fixture();
    writeRegistry(fx.root, { "owner/handbooks": "v1.2.0" });
    const pin = await capture(["canon", "pin", "--canon-checkout", "/x"], fx.root);
    expect(pin.code).toBe(2);
    expect(pin.err.join("\n")).toMatch(/--canon-checkout is not read by 'canon pin'/);
    const resolved = await capture([...resolveArgs({ target: "zheref/KroApple", "always-load": "a.md", "stack-dir": "s" }), "--canon-checkout", "/x"]);
    expect(resolved.code).toBe(2);
    expect(resolved.err.join("\n")).toMatch(/--canon-checkout is not read by 'canon resolve'/);
  });

  it("N11: an absolute --stack-dir is refused before any git call (this harness throws on one)", async () => {
    const fx = fixture();
    writeRaw(fx.root, { consumers: [], maintained_tools: [{ repo: "owner/handbooks", pinned: "v1.2.0", checkout: fx.root }] });
    const argv = unpinnedArgs("check", fx).filter((arg, index, all): boolean => arg !== "--rules-dir" && all[index - 1] !== "--rules-dir");
    const result = await capture([...argv, "--stack-dir", "/etc", "--leaf", "rules"], fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/neither may be absolute/);
  });

  it("N11: --source in another case still finds the declaration recorded for the slug", async () => {
    const fx = fixture();
    writeRaw(fx.root, { consumers: [], maintained_tools: [{ repo: "owner/handbooks", pinned: "v1.2.0", checkout: "${NEN_TEST_UNSET_VARIABLE}/x" }] });
    const result = await capture(["canon", "checkout", "--source", "Owner/Handbooks", "--ref", "v1.2.0", "--json"], fx.root);
    expect(result.code).toBe(1);
    expect(json(result)).toMatchObject({ failure: { code: "bad-template" } });
  });
});

describe("Nobunaga round 2 -- canon checkout on a malformed registry (R5)", () => {
  it("exits 2 with the loader's pointer and no --json document", async () => {
    const fx = fixture();
    mkdirSync(join(fx.root, "nen"), { recursive: true });
    writeFileSync(join(fx.root, "nen", "repos.json"), JSON.stringify({ consumers: [], maintained_tools: [{ repo: "owner/handbooks", pinned: "v1.2.0", checkout_env: "/bad" }] }));
    const result = await capture(["canon", "checkout", "--json"], fx.root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/maintained_tools\[0\]\.checkout_env/);
    expect(result.out).toEqual([]);
  });
});
