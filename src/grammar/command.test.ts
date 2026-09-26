import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { parseCommand } from "./command.js";

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  options: { repoFlag?: string | null; json?: boolean } = {},
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
  const seams: Seams = new ScriptedSeams(script);
  const code = await runFamily(
    parseCommand,
    argv,
    // `=== undefined`, not `??`: `repoFlag: null` is a REAL case (the
    // invocation that never typed --repo, zheref/nen#28) and must not be
    // coalesced back into the fixture default.
    options.repoFlag === undefined ? BANKAI_REPO : options.repoFlag,
    options.json ?? false,
    io,
    seams,
  );
  return { code, out, err };
}

describe("nen parse <skill> -- the generic --grammar/--line engine (main's own family)", () => {
  it("parses and echoes a matching line", async () => {
    const result = await capture([
      "parse",
      "my-skill",
      "--grammar",
      "do <thing>",
      "--line",
      "do the dishes",
    ]);
    expect(result.code).toBe(0);
  });

  it("requires --grammar and --line for a skill that is not futon/izanagi/izanami", async () => {
    expect((await capture(["parse", "my-skill"])).code).toBe(2);
  });

  // zheref/nen#170: `--line ""` used to be refused ("the line must open with
  // the literal 'at'") on a grammar whose only clause is optional, while
  // `--line "at"` exited 0 with the clause absent -- so the ORDINARY
  // invocation of such a skill was the one spelling a caller had to know.
  it("accepts an EMPTY --line when every clause of the grammar is optional", async () => {
    const empty = await capture(["parse", "jutaisho", "--grammar", "at [<gate:G2|G4>]", "--line", ""]);
    expect(empty.code).toBe(0);
    expect(empty.out).toEqual(["gate: (clause absent)"]);
    expect(empty.err).toEqual([]);

    // Identical to the bare-literal spelling, which is the point.
    const bare = await capture(["parse", "jutaisho", "--grammar", "at [<gate:G2|G4>]", "--line", "at"]);
    expect(bare.code).toBe(0);
    expect(bare.out).toEqual(empty.out);
  });

  it("still refuses an empty --line at exit 2 when the grammar requires a clause", async () => {
    const result = await capture(["parse", "backlog-state", "--grammar", "<repo>[@<gate:G1|G2>]", "--line", ""]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/<repo> is required and the line does not supply it/);
    expect(result.err.join("\n")).toContain("backlog-state <repo>");
  });

  // zheref/nen#30: a single-slot template's `[ ... ]` clause used to collapse
  // into the first slot and exit 0 -- 'BC@G9' came back as repo='BC@G9', ok:true.
  it("splits a bracketed clause after the template's only leading slot (zheref/nen#30)", async () => {
    const result = await capture(
      ["parse", "backlog-state", "--grammar", "<repo>[@<gate:G1|G2|all>]", "--line", "BC@G2"],
      [],
      { json: true },
    );
    expect(result.code).toBe(0);
    // The asserted type carries `suffix` because the --json contract does: every
    // slot reports whether its `[+]` suffix was present, even when false.
    const parsed = JSON.parse(result.out.join("\n")) as {
      slots: { name: string; value: string; suffix: boolean }[];
    };
    expect(parsed.slots).toEqual([
      { name: "repo", value: "BC", suffix: false },
      { name: "gate", value: "G2", suffix: false },
    ]);
  });

  it("exits 2 on an out-of-set bracketed enum instead of swallowing it (zheref/nen#30)", async () => {
    const result = await capture([
      "parse",
      "backlog-state",
      "--grammar",
      "<repo>[@<gate:G1|G2|all>]",
      "--line",
      "BC@G9",
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/G1 \| G2 \| all/);
    expect(result.err.join("\n")).toMatch(/BC@<gate:/);
  });

  it("exits 2 on an unsupported template shape instead of mis-parsing the line (zheref/nen#30)", async () => {
    const result = await capture(["parse", "my-skill", "--grammar", "[<repo>]", "--line", "BC"]);
    expect(result.code).toBe(2);
  });
});

describe("nen parse futon -- CLI wiring (verbs/4-remainders, merged into this family)", () => {
  it("resolves a known consumer code, build-only", async () => {
    const result = await capture(["parse", "futon", "KP@high", "--self", "zheref/bankai-core"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/repo: zheref\/KroApple \(KP\)/);
    expect(result.out.join("\n")).toMatch(/terminal: \(none -- build-only\)/);
  });

  it("emits the stable --json contract", async () => {
    const result = await capture(
      ["parse", "futon", "KP@high+", "--self", "zheref/bankai-core"],
      [],
      { json: true },
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as { band: { severities: string[] } };
    expect(parsed.band.severities).toEqual(["critical", "high"]);
  });

  it("emits a label selector with band null", async () => {
    const result = await capture(["parse", "futon", "KP@bug", "--self", "zheref/bankai-core"], [], { json: true });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as { band: unknown; label: string };
    expect(parsed).toMatchObject({ band: null, label: "bug" });
  });

  it("never refuses a skill or prose step against a non-self consumer -- the caller authorizes", async () => {
    const result = await capture(["parse", "futon", "KP@bug then notify the channel", "--self", "zheref/bankai-core"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/then: prose "notify the channel"/);
  });

  it("refuses a 'then tag' clause against a non-self consumer, with a corrected line", async () => {
    const result = await capture(["parse", "futon", "KP@high then tag", "--self", "zheref/bankai-core"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is refused against 'zheref\/KroApple'/);
    expect(result.err.join("\n")).toMatch(/try: KP@high/);
  });

  it("refuses an unparseable invocation before ever touching the registry", async () => {
    const result = await capture(["parse", "futon", "not an invocation"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/no '@<severity>'/);
  });

  // zheref/nen#28: the futon usage line lists --repo unbracketed, so omitting
  // it is refused by name -- never silently resolved against the cwd's registry.
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["parse", "futon", "KP@high"], [], { repoFlag: null });
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("requires an invocation string", async () => {
    expect((await capture(["parse", "futon"])).code).toBe(2);
  });

  it("resolves 'the repo you are standing in' from origin when the token is omitted", async () => {
    const result = await capture(["parse", "futon", "@critical"], [
      { match: "git remote get-url origin", result: { stdout: "git@github.com:zheref/bankai-core.git\n" } },
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/repo: zheref\/bankai-core/);
  });
});

// ── the advance-go gate (maintainer's ruling, 2026-09-26) ───────────────────
//
// A checkout carrying nen/repos.json (BANKAI_REPO's own, so 'BC' resolves to
// 'bankai-core' and the bare '@severity' form -- repoToken null -- resolves to
// the checkout's own origin), nen/contract.json (a declared project.kind, so
// ../repo/classify.ts's kindOf() does not have to derive one from stacks) and
// nen/workflow.json's futon.advanceGo. The origin is scripted to
// 'zheref/bankai-core' so the resolved repo (via the bare '@severity' form) IS
// the checkout -- ../repo/classify.ts derives a kind only then, which is
// exactly the condition this gate is proving.
function gateRepo(kind: "product" | "process" | "library", advanceGo: Readonly<Record<string, readonly string[]>>): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-futon-gate-"));
  mkdirSync(join(dir, "nen"), { recursive: true });
  copyFileSync(join(BANKAI_REPO, "nen", "repos.json"), join(dir, "nen", "repos.json"));
  writeFileSync(
    join(dir, "nen", "contract.json"),
    JSON.stringify({ project: { kind, lanes: { default: { stack: "generic", cwd: "." } }, verbs: { default: { build: { unsupported: "test fixture" } } } } }),
  );
  writeFileSync(join(dir, "nen", "workflow.json"), JSON.stringify({ futon: { advanceGo } }));
  return dir;
}

const ORIGIN_IS_SELF: readonly ScriptedCall[] = [
  { match: "git remote get-url origin", result: { stdout: "git@github.com:zheref/bankai-core.git\n" } },
];

describe("nen parse futon -- the advance-go gate on a skill chain", () => {
  it("annotates an ALLOWED step with gate.allowed true and the classified kind", async () => {
    const root = gateRepo("process", { mugetsu: ["process", "library"] });
    const result = await capture(["parse", "futon", "@high then mugetsu", "--repo", root], ORIGIN_IS_SELF, { repoFlag: root, json: true });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as {
      then: { kind: string; steps: { skill: string; gate?: { allowed: boolean; kind: string } }[] };
    };
    expect(parsed.then.kind).toBe("skills");
    expect(parsed.then.steps).toEqual([{ skill: "mugetsu", target: null, gate: { allowed: true, kind: "process", reason: expect.any(String) } }]);
  });

  it("annotates a REFUSED step (repo kind is a declared product, skill allows only process/library) and still exits 0", async () => {
    const root = gateRepo("product", { mugetsu: ["process", "library"] });
    const result = await capture(["parse", "futon", "@high then mugetsu", "--repo", root], ORIGIN_IS_SELF, { repoFlag: root, json: true });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as {
      then: { steps: { skill: string; gate?: { allowed: boolean; kind: string; reason: string } }[] };
    };
    expect(parsed.then.steps[0]?.gate).toEqual({ allowed: false, kind: "product", reason: expect.any(String) });

    // The plain rendering prints a 'refused: <skill> (<reason>)' line, and the
    // exit code stays 0 -- a refused step does NOT fail the parse.
    const plain = await capture(["parse", "futon", "@high then mugetsu", "--repo", root], ORIGIN_IS_SELF, { repoFlag: root });
    expect(plain.code).toBe(0);
    expect(plain.out.join("\n")).toMatch(/refused: mugetsu \(/);
  });

  it("fails CLOSED (refused) when the target repo's kind is unknown -- not this checkout", async () => {
    // No --self and no scripted origin match for THIS call: the token 'BC'
    // resolves through the registry's product_codes to 'bankai-core', which is
    // NOT the checkout at --repo (origin answers something else entirely), so
    // classifyRepo() can never read that OTHER repo's contract and reports
    // kind 'unknown'.
    const root = gateRepo("product", { mugetsu: ["process", "library", "product"] });
    const script: readonly ScriptedCall[] = [
      { match: "git remote get-url origin", result: { stdout: "git@github.com:someone/unrelated.git\n" } },
    ];
    const result = await capture(["parse", "futon", "KP@high then mugetsu", "--repo", root], script, { repoFlag: root, json: true });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as {
      then: { steps: { skill: string; gate?: { allowed: boolean; kind: string; reason: string } }[] };
    };
    expect(parsed.then.steps[0]?.gate).toEqual({ allowed: false, kind: "unknown", reason: expect.any(String) });
    // item 10: a proper possessive ("zheref/KroApple's"), never the doubled
    // apostrophe a literal-quoted slug used to produce ("...''s").
    expect(parsed.then.steps[0]?.gate?.reason).toMatch(/^zheref\/KroApple's repo kind is unknown/);
    expect(parsed.then.steps[0]?.gate?.reason).not.toContain("''s");
  });

  it("leaves an UNLISTED skill unannotated -- no 'gate' field at all", async () => {
    const root = gateRepo("process", { mugetsu: ["process", "library"] });
    const result = await capture(["parse", "futon", "@high then kagutsuchi", "--repo", root], ORIGIN_IS_SELF, { repoFlag: root, json: true });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as { then: { steps: { skill: string; gate?: unknown }[] } };
    expect(parsed.then.steps[0]?.gate).toBeUndefined();
  });

  it("matches a 'plugin:'-prefixed step against the same unprefixed key", async () => {
    const root = gateRepo("process", { mugetsu: ["process", "library"] });
    const result = await capture(["parse", "futon", "@high then plugin:mugetsu", "--repo", root], ORIGIN_IS_SELF, { repoFlag: root, json: true });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as { then: { steps: { skill: string; gate?: { allowed: boolean } }[] } };
    expect(parsed.then.steps[0]?.gate?.allowed).toBe(true);
  });

  // F1: the lookup once stripped ONLY 'plugin:', so a chain step from any
  // other namespace ('hatsu:mugetsu') fell through as an unlisted skill and
  // the gate fell open (unannotated) instead of judging it against the same
  // 'mugetsu' policy key. A refusing kind must still refuse it.
  it("matches a 'hatsu:'-prefixed step against the same unprefixed key, and still refuses a disallowed kind (F1)", async () => {
    const root = gateRepo("product", { mugetsu: ["process", "library"] });
    const result = await capture(["parse", "futon", "@high then hatsu:mugetsu", "--repo", root], ORIGIN_IS_SELF, { repoFlag: root, json: true });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as { then: { steps: { skill: string; gate?: { allowed: boolean; kind: string } }[] } };
    expect(parsed.then.steps[0]?.gate).toEqual({ allowed: false, kind: "product", reason: expect.any(String) });
  });
});

describe("nen parse izanagi/izanami -- dispatch through the merged family", () => {
  it("izanagi parses a valid invocation", async () => {
    const result = await capture(["parse", "izanagi", "retry the build until it is green up to 3"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/cap: 3/);
  });

  it("izanami classifies a read-only command", async () => {
    const result = await capture(["parse", "izanami", "gh pr checks 42 until it is green"]);
    expect(result.code).toBe(0);
  });

  // zheref/nen#31's exact transcripts: a plain file read and a read-only nen
  // verb came back [unknown] and refused the whole run; both must accept now,
  // and a genuinely mutating nen verb must STILL refuse whole.
  it("izanami accepts a plain file read (#31)", async () => {
    const result = await capture(["parse", "izanami", "until it says ok\ncat somefile.txt"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/\[read-only\] cat somefile\.txt/);
  });

  it("izanami accepts a read-only nen verb invocation (#31)", async () => {
    const result = await capture(["parse", "izanami", "until it says ready\nnen pr ready 925 --gh-repo owner/repo"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/\[read-only\] nen pr ready 925/);
  });

  it("izanami still refuses a mutating nen verb, whole (#31)", async () => {
    const result = await capture([
      "parse",
      "izanami",
      "until applied\nnen label apply XX-PR-#1 --label wake --repo-slug o/r --run",
    ]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/\[mutating\] nen label apply/);
    expect(result.err.join("\n")).toMatch(/WHOLE run is refused/);
  });
});

describe("nen parse -- refuses an invocation with no skill named", () => {
  it("exits 2", async () => {
    expect((await capture(["parse"])).code).toBe(2);
  });
});
