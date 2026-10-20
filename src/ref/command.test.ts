import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { Seams } from "../seam/exec.js";
import { refCommand } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";

// NEVER `defaultSeams()` HERE (see ../warmup/command.test.ts's own note on the
// same fix) -- a `run` that throws converts a future regression (this family
// growing a real subprocess call) into an immediate red test.
const STUB_SEAMS: Seams = {
  run: (): never => {
    throw new Error("must not be called");
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

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding applied consistently across
// this family's siblings).
async function capture(argv: readonly string[], repoFlag: string = BANKAI_REPO): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const code = await runFamily(refCommand, argv, repoFlag, false, io, STUB_SEAMS);
  return { code, out, err };
}

describe("nen ref format", () => {
  it("formats a known code", async () => {
    const result = await capture(["ref", "format", "--code", "KP", "--kind", "IS", "--number", "460"]);
    expect(result.code).toBe(0);
  });

  // zheref/nen#17 (review minor): the bankai fixture's product_codes nests a
  // `$comment`, the same shape the live bankai-core file carries. `declared`
  // is built from `Object.keys(registry.productCodes)` PLUS every consumer's
  // `code` -- an unknown code's refusal renders that whole set under
  // "Declared:", and this roster was never tested against a real loaded
  // registry until now.
  it("an unknown code's refusal lists the Declared roster, never a nested $comment (zheref/nen#17)", async () => {
    const result = await capture(["ref", "format", "--code", "ZZ", "--kind", "IS", "--number", "1"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/Declared: BC, BS, KC, KN, KP, KW\./);
    expect(result.err.join("\n")).not.toContain("$comment");
  });
});

describe("nen ref parse", () => {
  it("parses a token", async () => {
    const result = await capture(["ref", "parse", "KP-IS-#460"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("code:   KP");
  });

  it("parses a well-formed token, exit 0", async () => {
    const result = await capture(["ref", "parse", "KP-PR-#42"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/ref:\s+KP-PR-#42/);
    expect(result.out.join("\n")).toMatch(/number: 42/);
  });

  it("refuses a token with no positional argument", async () => {
    const result = await capture(["ref", "parse"]);
    expect(result.code).toBe(2);
  });

  it("still refuses a MISSING token at exit 2, as it always did", async () => {
    const result = await capture(["ref", "parse"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/needs a token/);
  });

  it("refuses a malformed token at exit 2, the SAME code as 'label apply' (zheref/nen#10 item 3)", async () => {
    // The two verbs both take a caller-typed object ref as a positional, so a
    // typo must cost the same in both -- exit 2, "you typed it wrong". They
    // used to disagree: this one and `label apply` both let RefError escape to
    // exit 1, the code a retry wrapper reads as "worth retrying".
    const result = await capture(["ref", "parse", "not-a-ref"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is not object notation/);
    expect(result.err.join("\n")).toMatch(/Run 'nen ref --help'/);
  });
});

describe("GitHub object subjects (#427)", () => {
  it.each([
    ["https://github.com/zheref/KroApple/issues/460", "IS"],
    ["https://github.com/zheref/KroApple/pull/460", "PR"],
    ["zheref/KroApple#460", null],
  ])("parses %s without GitHub calls", async (token, kind) => {
    const result = await capture(["ref", "parse", token!, "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({ slug: "zheref/KroApple", code: "KP", kind, number: 460 });
  });
  it("accepts an unregistered slug without inventing a code", async () => {
    const result = await capture(["ref", "parse", "outside/repository#12", "--json"]);
    expect(JSON.parse(result.out.join("\n"))).toEqual({ slug: "outside/repository", kind: null, number: 12 });
  });
  it.each([
    "https://other.example/o/r/issues/1", "https://github.com.evil.example/o/r/pull/1",
    "https://github.com@evil.example/o/r/issues/1", "https://user@github.com/o/r/issues/1",
    "http://github.com/o/r/issues/1", "https://github.com:443/o/r/issues/1",
    "https://github.com/o/r/issues/1/extra", "https://github.com/o/r/issues/1?x=1",
    "https://github.com/o/r/issues/1#fragment", "https://github.com/o/r/pulls/1",
    "https://github.com/o/r/../r/issues/1", "https://github.com/o/r/issues/%31",
    "https://github.com/o/r/issues/0", "o/r#0", "o/r#9007199254740992", "o/r/extra#1", "o/r#1\n", "https://github.com/o/r/issues/1\n",
  ])("refuses other authorities and path shapes: %s", async (token) => {
    const result = await capture(["ref", "parse", token]);
    expect(result.code).toBe(2); expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/refused|safe positive/);
  });
  it("names an unsupported host", async () => {
    const result = await capture(["ref", "parse", "https://elsewhere.example/o/r/pull/1"]);
    expect(result.err.join("\n")).toContain("elsewhere.example");
  });
});

it("parses a GitHub subject with no local registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "nen-ref-no-registry-"));
  const result = await capture(["ref", "parse", "o/r#1", "--json"], root);
  expect(result.code).toBe(0); expect(JSON.parse(result.out.join("\n"))).toEqual({ slug: "o/r", kind: null, number: 1 });
});
it("refuses an invalid URL without guessing", async () => {
  const result = await capture(["ref", "parse", "https://["]);
  expect(result.code).toBe(2); expect(result.err.join("\n")).toContain("not a valid GitHub object URL");
});

describe("review regressions on exact GitHub subjects", () => {
  it.each([
    "https://user:PLACEHOLDER@[invalid",
    "https:/user:PLACEHOLDER@github.com/o/r/issues/1",
  ])("refuses malformed authorities without echoing userinfo", async (token) => {
    const result = await capture(["ref", "parse", token]);
    expect(result.code).toBe(2); expect(result.out).toEqual([]);
    expect(result.err.join("\n")).not.toContain("PLACEHOLDER");
    expect(result.err.join("\n")).not.toContain("user:");
  });
  it.each(["github。com", "github．com"])("requires the literal ASCII host rather than URL-normalized %s", async (host) => {
    const result = await capture(["ref", "parse", `https://${host}/o/r/issues/1`]);
    expect(result.code).toBe(2); expect(result.out).toEqual([]);
  });
  it("does not borrow a registered code from a different owner with the same basename", async () => {
    const result = await capture(["ref", "parse", "attacker/KroApple#460", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({ slug: "attacker/KroApple", kind: null, number: 460 });
  });
  it("finds a registered consumer code with case-insensitive exact slug identity", async () => {
    const result = await capture(["ref", "parse", "ZHEREF/kroapple#460", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({ slug: "ZHEREF/kroapple", code: "KP", kind: null, number: 460 });
  });
  it("includes consumer-only and fully recorded product codes without guessing bare-name owners", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-ref-exact-code-")); mkdirSync(join(root, "nen"));
    writeFileSync(join(root, "nen/repos.json"), JSON.stringify({
      consumers: [{ repo: "o/r", code: "RR", consumes: [] }],
      product_codes: { TT: "known/tools", BB: "Bare", OO: "OnlyBare" },
      maintained_tools: [{ repo: "owner/Bare" }],
    }));
    for (const [slug, code] of [["O/R", "RR"], ["KNOWN/Tools", "TT"], ["owner/Bare", "BB"], ["attacker/Bare", undefined], ["unknown/OnlyBare", undefined], ["unknown/unknown", undefined]]) {
      const result = await capture(["ref", "parse", `${slug}#1`, "--json"], root);
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.out.join("\n"));
      expect(parsed.slug).toBe(slug);
      if (code === undefined) expect(parsed).not.toHaveProperty("code");
      else expect(parsed.code).toBe(code);
    }
  });
});

it("does not lend a bare product code to a second recorded owner with the same name", async () => {
  const root = mkdtempSync(join(tmpdir(), "nen-ref-two-owners-")); mkdirSync(join(root, "nen"));
  writeFileSync(join(root, "nen/repos.json"), JSON.stringify({
    consumers: [{ repo: "trusted/r", code: "RR", consumes: [] }],
    product_codes: { RR: "r" },
    maintained_tools: [{ repo: "other/r" }],
  }));
  const trusted = await capture(["ref", "parse", "TRUSTED/R#12", "--json"], root);
  expect(trusted.code).toBe(0);
  expect(JSON.parse(trusted.out.join("\n"))).toEqual({ slug: "TRUSTED/R", code: "RR", kind: null, number: 12 });
  for (const slug of ["other/r", "OTHER/R"]) {
    const other = await capture(["ref", "parse", `${slug}#12`, "--json"], root);
    expect(other.code).toBe(0);
    expect(JSON.parse(other.out.join("\n"))).toEqual({ slug, kind: null, number: 12 });
  }
});
