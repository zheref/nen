import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { repoCommand } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";

async function capture(
  argv: readonly string[],
  run: Seams["run"] = (): CommandResult => {
    throw new Error("this test's invocation should make no subprocess call");
  },
  // `null` is a real case here, not a default-filler: it is the invocation
  // that never typed --repo at all (zheref/nen#28's subject).
  repoFlag: string | null = BANKAI_REPO,
  json = false,
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
    run,
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
  const code = await runFamily(repoCommand, argv, repoFlag, json, io, seams);
  return { code, out, err };
}

describe("nen repo resolve -- dispatches through the union registry", () => {
  it("resolves a known token without a subprocess call (main's own family)", async () => {
    const result = await capture(["repo", "resolve", "KP"]);
    expect(result.code).toBe(0);
  });

  it("resolves a code to the pending_onboarding slug the registry records (zheref/nen#27)", async () => {
    // The bankai fixture's KC names 'KroCloud', a bare value whose owner is
    // recorded only under pending_onboarding -- the exact case the issue's
    // live reproduction hit.
    const result = await capture(["repo", "resolve", "KC"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["zheref/KroCloud  (KC)  via code"]);
  });

  it("no-token form resolves the registry's OWN origin via product_codes (zheref/nen#27)", async () => {
    const result = await capture(["repo", "resolve"], (): CommandResult => ({
      code: 0,
      stdout: "https://github.com/zheref/bankai-core.git\n",
      stderr: "",
      spawnFailed: false,
    }));
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "origin: https://github.com/zheref/bankai-core.git",
      "zheref/bankai-core  (BC)  via origin",
    ]);
  });

  // zheref/nen#17: the bankai fixture's product_codes nests a `$comment`, the
  // same shape the live bankai-core file carries. Before the loader fix, this
  // sweep printed a SEVENTH row -- "Object-reference notation (...)  ($comment)
  // via all" -- inside an otherwise successful result, for a registry that
  // names exactly six repositories.
  it("'all' prints one row per real repository, never one for a nested $comment (zheref/nen#17)", async () => {
    const result = await capture(["repo", "resolve", "all"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "zheref/KroApple  (KP)  via all",
      "zheref/KroAndroid  (KN)  via all",
      "zheref/bankai-scaffold  (BS)  via all",
      "bankai-core  (BC)  via all",
      "KroWeb  (KW)  via all",
      "zheref/KroCloud  (KC)  via all",
    ]);
    expect(result.out.join("\n")).not.toContain("$comment");
  });

  it("an unknown token's refusal lists the registry's codes, never a nested $comment (zheref/nen#17)", async () => {
    const result = await capture(["repo", "resolve", "notarealtoken"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/Codes: BC \(bankai-core\), BS \(bankai-scaffold\), KP \(KroApple\), KN \(KroAndroid\), KW \(KroWeb\), KC \(KroCloud\)\./);
    expect(result.err.join("\n")).not.toContain("$comment");
  });

  it("refuses --from next to a token, naming --repo, instead of silently ignoring it (zheref/nen#27)", async () => {
    const result = await capture(["repo", "resolve", "KP", "--from", "/somewhere"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--from applies only to the no-token form/);
    expect(result.err.join("\n")).toMatch(/--repo <path>/);
  });

  // A --repo with no nen/repos.json (and no legacy schemas/repos.json) is a
  // PRECONDITION this verb cannot proceed without at all -- there is no
  // registry to resolve a token against, which is a different failure from
  // "the token did not match", and must not be reported the same way an
  // unresolved token is (exit 1, above): a caller pointed at a repo that has
  // not adopted the registry gets exit 2, matching this family's other
  // "cannot proceed as given" refusals (an omitted --from-token conflict, an
  // omitted --repo on 'scenario').
  it("refuses a --repo with no nen/repos.json at exit 2, naming the file, not a token failure", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-no-registry-"));
    const result = await capture(["repo", "resolve", "KP"], undefined, empty);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/nen[/\\]repos\.json: no such file/);
  });

  // Same defect, no-token (origin) form: the registry is opened before the
  // origin is ever read, so the missing-file refusal fires first and the
  // same way.
  it("refuses a --repo with no nen/repos.json at exit 2 on the no-token form too", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-no-registry-"));
    const result = await capture(["repo", "resolve"], undefined, empty);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/nen[/\\]repos\.json: no such file/);
  });
});

describe("nen repo inventory|scenario -- CLI wiring (verbs/4-remainders, merged into this family)", () => {
  // zheref/nen#93: EXIT 2, not 1. Four families each kept a private
  // `requireTarget` that threw a plain Error, so sixteen verbs answered a
  // forgotten flag with "the thing you asked for did not work" instead of "you
  // typed it wrong" -- and a retry wrapper honouring that distinction retries a
  // 1 forever. One shared `requireTargetFlag` now answers for all of them, the
  // way every OTHER required flag in these same families already did.
  it("requires --target, as a USAGE error like every other required flag here", async () => {
    const result = await capture(["repo", "inventory"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--target owner\/name is required/);
  });

  it("inventory requires --epic-label once --target is given", async () => {
    expect((await capture(["repo", "inventory", "--target", "o/n"])).code).toBe(2);
  });

  it("inventory requires --integration-prefix once --epic-label is given too -- no default naming convention", async () => {
    const result = await capture(["repo", "inventory", "--target", "o/n", "--epic-label", "type:epic"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--integration-prefix <prefix> is required/);
  });

  it("scenario reads the target repo's registry entry and exits 0", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/KroApple"]);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(["swiftui-tca-uzf-v2"]);
  });

  // zheref/nen#28: the usage line lists --repo unbracketed, and honoring that
  // at the parser is the fix -- omission used to default silently to the cwd
  // and surface as that directory's missing-or-unrelated registry.
  it("scenario refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/KroApple"], undefined, null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  // An EMPTY/whitespace --repo is the same mistake as omission, and must hit
  // the same refusal -- not fall through to resolveRepoRoot(), whose
  // empty-value message advises omitting the flag this verb just refused to
  // let the caller omit (review thread on zheref/nen#73).
  it("scenario refuses an EMPTY --repo the same way as an omitted one (exit 2)", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/KroApple"], undefined, "   ");
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
    expect(result.err.join("\n")).not.toMatch(/omit it entirely/);
  });

  // The three downstream causes the one old refusal conflated (zheref/nen#28),
  // one test each. Cause 1: the --repo path carries no nen/repos.json --
  // a PRECONDITION this verb cannot proceed past at all, so it is exit 2
  // (usage/precondition), the same code 'repo resolve' refuses with for the
  // identical absent-registry defect, not exit 1 (that is reserved for a
  // registry that IS present and simply does not record what was asked).
  it("scenario names a --repo path with no nen/repos.json as exactly that (exit 2)", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-no-registry-"));
    const result = await capture(["repo", "scenario", "--target", "zheref/KroApple"], undefined, empty);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/nen[/\\]repos\.json: no such file/);
  });

  // Cause 2: the registry knows nothing about the target, anywhere.
  it("scenario exits 1 with a 'not recorded anywhere' reason when the repo is unrecorded", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/nonexistent"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/is not recorded anywhere/);
  });

  // Cause 3: the registry plainly records the repo (here under
  // pending_onboarding -- #27's widened resolution), just not with a scenario.
  // Since zheref/nen#219 that row can carry one, so the remedy is that row.
  it("scenario tells a recorded non-consumer apart from an unknown repo (exit 1)", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/KroCloud"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/is recorded in .*under 'pending_onboarding'/);
    expect(result.err.join("\n")).toMatch(/Add one to its pending_onboarding\[\] row/);
  });

  // zheref/nen#28's second finding: this is a NAME-HALF match against a bare
  // product-code value (no owner recorded anywhere), not a registry hit on
  // the full 'zheref/bankai-core' slug -- so the refusal must not claim the
  // slug itself "is recorded".
  it("scenario names the product code recording the registry's OWN repo, not 'unknown' -- and does not overclaim the slug is recorded", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/bankai-core"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/bare product code 'BC' \('bankai-core'\), which names no owner/);
    expect(result.err.join("\n")).toMatch(/is not itself recorded in/);
    expect(result.err.join("\n")).not.toMatch(/'zheref\/bankai-core' is recorded in/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["repo", "bogus"])).code).toBe(2);
  });
});

describe("nen repo inventory|scenario -- rendering and the registry that will not load", () => {
  it("inventory renders epics with children, integration branches and open PRs in plain text", async () => {
    const replies: Record<string, string> = {
      "issue list": JSON.stringify([{ number: 1, title: "epic", state: "OPEN", labels: [] }]),
      "api repos/o/n/issues/1/sub_issues": JSON.stringify([
        { number: 2, title: "child", state: "open", html_url: "https://x/2", labels: [{ name: "stage/building" }] },
      ]),
      "api repos/o/n/branches": "main\nintegration/epic-1\n",
      "api repos/o/n/compare/main...integration/epic-1": JSON.stringify({ ahead_by: 3, behind_by: 1 }),
      "pr list": JSON.stringify([{ number: 9, title: "wip", baseRefName: "main", url: "https://x/9", isDraft: true }]),
    };
    const run: Seams["run"] = (_bin, args): CommandResult => {
      const joined = args.join(" ");
      const key = Object.keys(replies).find((prefix): boolean => joined.startsWith(prefix));
      if (key === undefined) throw new Error(`unexpected gh call: ${joined}`);
      return { code: 0, stdout: replies[key] ?? "", stderr: "", spawnFailed: false };
    };
    const result = await capture(
      ["repo", "inventory", "--target", "o/n", "--epic-label", "type:epic", "--integration-prefix", "integration/"],
      run,
    );
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "epics: 1",
      "  #1 epic -- 1 child(ren)",
      "    #2 open  stage/building  child",
      "integration branches: 1",
      "  integration/epic-1  +3/-1 vs trunk",
      "open PRs: 1",
      "  #9 (draft) -> main  wip",
    ]);
  });

  it("scenario --json carries an unrecorded repo's refusal and exits 1", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/nonexistent"], undefined, BANKAI_REPO, true);
    expect(result.code).toBe(1);
    expect((JSON.parse(result.out.join("\n")) as { ok: boolean }).ok).toBe(false);
  });

  it("a PRESENT but malformed registry is the verb's own failure, not a usage error", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-repo-malformed-"));
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "repos.json"), "{ not json");
    const result = await capture(["repo", "scenario", "--target", "zheref/KroApple"], undefined, root);
    expect(result.code).toBe(1);
  });
});

// A checkout carrying exactly `registry` as its nen/repos.json.
function checkoutWith(registry: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "nen-repo-scenario-"));
  mkdirSync(join(root, "nen"), { recursive: true });
  writeFileSync(join(root, "nen", "repos.json"), JSON.stringify(registry));
  return root;
}

// The registry zheref/nen#219 was verified against -- the two tool
// repositories' own, `"consumers": []` -- with each tool now stating the
// scenario its maintained_tools[] row may carry.
const TOOL_REGISTRY = {
  consumers: [],
  maintained_tools: [
    { repo: "zheref/hatsu", role: "Hatsu workflow and skill prose", scenario: "hatsu-plugin" },
    { repo: "zheref/nen", role: "Shared deterministic machinery", scenario: "bun-cli" },
  ],
  pending_onboarding: [{ repo: "zheref/KroCloud", scenario: "cloud-functions" }],
  product_codes: { HA: "zheref/hatsu", NN: "zheref/nen" },
};

describe("nen repo scenario -- maintained_tools[] and pending_onboarding[] carry a scenario (zheref/nen#219)", () => {
  // Criterion 1, in the exact invocation the issue quotes as refusing.
  it("returns a maintained tool's scenario at exit 0", async () => {
    const root = checkoutWith(TOOL_REGISTRY);
    const hatsu = await capture(["repo", "scenario", "--target", "zheref/hatsu"], undefined, root);
    expect(hatsu).toEqual({ code: 0, out: ["hatsu-plugin"], err: [] });
    const nen = await capture(["repo", "scenario", "--target", "zheref/nen"], undefined, root);
    expect(nen).toEqual({ code: 0, out: ["bun-cli"], err: [] });
  });

  it("carries a maintained tool's scenario under --json in the unchanged { ok, scenario } shape", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/nen"], undefined, checkoutWith(TOOL_REGISTRY), true);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({ ok: true, scenario: "bun-cli" });
  });

  // Criterion 2.
  it("returns a pending onboarding's scenario at exit 0", async () => {
    const result = await capture(["repo", "scenario", "--target", "zheref/KroCloud"], undefined, checkoutWith(TOOL_REGISTRY));
    expect(result).toEqual({ code: 0, out: ["cloud-functions"], err: [] });
  });

  // Criterion 3, against the registry exactly as the issue found it: both
  // tools listed, neither stating a scenario.
  it("refuses a maintained tool with no scenario at exit 1, naming the section it is in -- never sending it to consumers[]", async () => {
    const root = checkoutWith({
      consumers: [],
      maintained_tools: [{ repo: "zheref/hatsu", role: "Hatsu workflow and skill prose" }],
      product_codes: { HA: "zheref/hatsu" },
    });
    const result = await capture(["repo", "scenario", "--target", "zheref/hatsu"], undefined, root);
    expect(result.code).toBe(1);
    const err = result.err.join("\n");
    expect(err).toMatch(/'zheref\/hatsu' is recorded in .*\(under 'maintained_tools'\)/);
    expect(err).toMatch(/Add one to its maintained_tools\[\] row/);
    expect(err).not.toMatch(/record it under consumers/);
    expect(err).not.toMatch(/only a consumers\[\] entry carries/);
  });

  it("refuses rows that state different scenarios at exit 1, naming both", async () => {
    const root = checkoutWith({
      consumers: [{ repo: "zheref/bankai-scaffold", consumes: [], scenario: "scaffold" }],
      maintained_tools: [{ repo: "zheref/bankai-scaffold", scenario: "tooling" }],
    });
    const result = await capture(["repo", "scenario", "--target", "zheref/bankai-scaffold"], undefined, root);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/with more than one scenario -- 'scaffold' \(its consumers\[\] entry\), 'tooling' \(its maintained_tools\[\] row\)/);
  });

  // Criterion 4's refusal half: validated as a consumer's is, so a
  // non-string is the registry's own defect -- exit 1, by pointer -- rather
  // than read as "no scenario".
  it("a maintained_tools[] row whose scenario is not a string is the registry's defect (exit 1), named by pointer", async () => {
    const root = checkoutWith({ consumers: [], maintained_tools: [{ repo: "zheref/nen", scenario: 7 }] });
    const result = await capture(["repo", "scenario", "--target", "zheref/nen"], undefined, root);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/maintained_tools\[0\]\.scenario/);
  });

  // Criterion 6: the consumer path and the absent-registry refusal are the
  // ones above, unchanged; this pins the consumer half against a registry
  // that now ALSO carries listed scenarios.
  it("a consumer's own scenario reads exactly as before beside listed rows that carry theirs", async () => {
    const root = checkoutWith({
      ...TOOL_REGISTRY,
      consumers: [{ repo: "zheref/KroApple", consumes: [], scenario: "swiftui-tca-uzf-v2" }],
    });
    const result = await capture(["repo", "scenario", "--target", "zheref/KroApple"], undefined, root);
    expect(result).toEqual({ code: 0, out: ["swiftui-tca-uzf-v2"], err: [] });
  });

  // Criteria 2 and 5: the help says which sections carry the field.
  it("'nen repo --help' names every section that carries a scenario, and the one that cannot", async () => {
    const result = await capture(["repo", "--help"]);
    expect(result.code).toBe(0);
    const help = result.out.join("\n");
    expect(help).toMatch(/WHICH SECTIONS CARRY IT: a 'scenario' field on a consumers\[\],\s+maintained_tools\[\] or pending_onboarding\[\] row, validated alike/);
    expect(help).toMatch(/A product_codes value is a name, not a row, and\s+carries none/);
  });
});
