import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { VerbContext } from "../cli/verb.js";
import { canonVerb } from "./verb.js";

function makeContext(overrides: Partial<VerbContext> = {}): { context: VerbContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const context: VerbContext = {
    args: [],
    values: {},
    booleans: new Set(),
    passthrough: [],
    repoFlag: BANKAI_REPO,
    json: false,
    io: { out: (l): void => void out.push(l), err: (l): void => void err.push(l) },
    ...overrides,
  };
  return { context, out, err };
}

describe("nen canon resolve -- CLI wiring", () => {
  it("resolves the scenario recorded for the target and derives the stack path", () => {
    const { context, out } = canonContext({
      target: "zheref/KroApple",
      "always-load": "handbooks/uzf-core.md,handbooks/security-baseline.md",
      "stack-dir": "handbooks/stacks",
    });
    expect(canonVerb.run(context)).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/scenario: swiftui-tca-uzf-v2/);
    expect(text).toMatch(/always load: handbooks\/uzf-core\.md, handbooks\/security-baseline\.md/);
    expect(text).toMatch(/stack handbook: handbooks\/stacks\/swiftui-tca-uzf-v2\/architecture\.md/);
  });

  it("exits 1 when the target repo has no recorded scenario", () => {
    const { context, err } = canonContext({
      target: "zheref/nonexistent",
      "always-load": "handbooks/uzf-core.md",
      "stack-dir": "handbooks/stacks",
    });
    expect(canonVerb.run(context)).toBe(1);
    expect(err.join("\n")).toMatch(/is not a consumer/);
  });

  it("requires --target and --stack-dir", () => {
    expect(canonVerb.run(canonContext({}).context)).toBe(2);
    expect(canonVerb.run(canonContext({ target: "o/n" }).context)).toBe(2);
  });

  // Review finding #19: --always-load used to be optional and silently
  // resolved to "(none)" -- indistinguishable from "this repo truly loads
  // nothing unconditionally".
  it("requires --always-load", () => {
    const { context, err } = canonContext({ target: "zheref/KroApple", "stack-dir": "handbooks/stacks" });
    expect(canonVerb.run(context)).toBe(2);
    expect(err.join("\n")).toMatch(/--always-load/);
  });

  it("refuses an empty --always-load rather than silently resolving to '(none)'", () => {
    const { context, err } = canonContext({
      target: "zheref/KroApple",
      "always-load": "",
      "stack-dir": "handbooks/stacks",
    });
    expect(canonVerb.run(context)).toBe(2);
    expect(err.join("\n")).toMatch(/named no paths/);
  });

  it("refuses an unknown subcommand", () => {
    expect(canonVerb.run(makeContext({ args: ["bogus"] }).context)).toBe(2);
  });
});

function canonContext(values: Record<string, string>): { context: VerbContext; out: string[]; err: string[] } {
  return makeContext({ args: ["resolve"], values });
}

describe("nen canon mirror generate|check -- CLI wiring", () => {
  const HEADER_TEMPLATE = "<!-- GENERATED from {ref}/{scenario}/{file} -- DO NOT EDIT. -->\n";
  const HEADER_PATTERN = "^<!-- GENERATED from (?<ref>\\S+)\\/(?<scenario>[^/]+)\\/(?<file>\\S+) -- DO NOT EDIT\\. -->\\n";

  function fixture(): { rulesDir: string; canonValues: string; outDir: string } {
    const base = mkdtempSync(join(tmpdir(), "nen-canon-verb-"));
    const rulesDir = join(base, "rules");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(join(rulesDir, "01-a.md"), "Hello {{NAME}}.\n");
    const canonValues = join(base, "canon-values.yml");
    writeFileSync(canonValues, "scenario: scenario-x\nvalues:\n  NAME: World\n");
    return { rulesDir, canonValues, outDir: join(base, "out") };
  }

  it("generate writes the mirror and exits 0", () => {
    const { rulesDir, canonValues, outDir } = fixture();
    const { context, out } = makeContext({
      args: ["mirror", "generate"],
      values: { "rules-dir": rulesDir, "canon-values": canonValues, "out-dir": outDir, ref: "v1.0.0", "header-template": HEADER_TEMPLATE },
    });
    expect(canonVerb.run(context)).toBe(0);
    expect(out.join("\n")).toMatch(/written: 01-a\.md/);
  });

  it("check reports OK (exit 0) right after a generate, and drift (exit 1) once the source changes", () => {
    const { rulesDir, canonValues, outDir } = fixture();
    canonVerb.run(
      makeContext({
        args: ["mirror", "generate"],
        values: { "rules-dir": rulesDir, "canon-values": canonValues, "out-dir": outDir, ref: "v1.0.0", "header-template": HEADER_TEMPLATE },
      }).context,
    );
    const clean = makeContext({
      args: ["mirror", "check"],
      values: { "rules-dir": rulesDir, "canon-values": canonValues, "mirror-dir": outDir, ref: "v1.0.0", "header-template": HEADER_TEMPLATE, "header-pattern": HEADER_PATTERN },
    });
    expect(canonVerb.run(clean.context)).toBe(0);

    writeFileSync(join(rulesDir, "01-a.md"), "Hello {{NAME}}, changed.\n");
    const dirty = makeContext({
      args: ["mirror", "check"],
      values: { "rules-dir": rulesDir, "canon-values": canonValues, "mirror-dir": outDir, ref: "v1.0.0", "header-template": HEADER_TEMPLATE, "header-pattern": HEADER_PATTERN },
    });
    expect(canonVerb.run(dirty.context)).toBe(1);
    expect(dirty.out.join("\n")).toMatch(/hand-edited: 01-a\.md/);
  });

  it("refuses an unknown 'canon mirror' subcommand", () => {
    expect(canonVerb.run(makeContext({ args: ["mirror", "bogus"] }).context)).toBe(2);
  });
});
