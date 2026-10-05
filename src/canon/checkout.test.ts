// src/canon/checkout.test.ts -- the canon checkout's resolution order and its
// five verification facts, against a scripted git (zheref/nen#294). The same
// facts against a REAL git are ./checkout.integration.test.ts.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { ToolCheckout } from "../schema/repos.js";
import { checkoutLines, expandCheckoutTemplate, resolveCanonCheckout, verifyCanonCheckout } from "./checkout.js";

const SOURCE = "owner/handbooks";
const REF = "v1.2.0";
const TAG_SHA = "a".repeat(40);

function dir(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "nen-canon-checkout-")));
}

/** A git that answers for `path` as a clean checkout of SOURCE at REF, with `over` replacing any one answer. */
function gitFor(path: string, over: Readonly<Record<string, ScriptedCall["result"]>> = {}): ScriptedCall[] {
  const answers: Record<string, ScriptedCall["result"]> = {
    "rev-parse --show-toplevel": { stdout: `${path}\n` },
    "remote get-url origin": { stdout: "https://github.com/owner/handbooks.git\n" },
    [`rev-parse --verify --quiet refs/tags/${REF}^{commit}`]: { stdout: `${TAG_SHA}\n` },
    "rev-parse --verify --quiet HEAD^{commit}": { stdout: `${TAG_SHA}\n` },
    "status --porcelain": { stdout: "" },
    ...over,
  };
  return Object.entries(answers).map(([args, result]): ScriptedCall => ({ match: `git -C ${path} ${args}`, result }));
}

const declared = (fields: Partial<ToolCheckout>): ToolCheckout => ({ index: 2, checkoutEnv: null, checkout: null, ...fields });

describe("expandCheckoutTemplate -- the smallest shell subset that can spell a cache slot", () => {
  const env = { HOME: "/home/u", XDG_CACHE_HOME: "", EMPTY: "", SET: "/s" };

  it("expands $NAME, ${NAME} and ${NAME:-default}, a default itself expanded", () => {
    expect(expandCheckoutTemplate("$SET/a", env)).toEqual({ ok: true, value: "/s/a" });
    expect(expandCheckoutTemplate("${SET}/a", env)).toEqual({ ok: true, value: "/s/a" });
    expect(expandCheckoutTemplate("${XDG_CACHE_HOME:-${HOME}/.cache}/h/c", env)).toEqual({ ok: true, value: "/home/u/.cache/h/c" });
    expect(expandCheckoutTemplate("${SET:-/unused}/x", env)).toEqual({ ok: true, value: "/s/x" });
    expect(expandCheckoutTemplate("../sibling/handbooks", env)).toEqual({ ok: true, value: "../sibling/handbooks" });
  });

  it("refuses an unset or empty variable with no default by name, rather than splicing in nothing", () => {
    expect(expandCheckoutTemplate("${UNSET}/x", env)).toEqual({ ok: false, reason: expect.stringMatching(/\$\{UNSET\}, which is not set .*no ':-' default/) as unknown });
    expect(expandCheckoutTemplate("$EMPTY/x", env)).toEqual({ ok: false, reason: expect.stringMatching(/\$EMPTY, which is not set/) as unknown });
  });

  it("refuses a leading '~', an unclosed brace, a bad name and a stray '$'", () => {
    expect(expandCheckoutTemplate("~/handbooks", env)).toMatchObject({ ok: false, reason: expect.stringMatching(/write \$\{HOME\} instead/) as unknown });
    expect(expandCheckoutTemplate("${HOME/x", env)).toMatchObject({ ok: false, reason: expect.stringMatching(/never closed/) as unknown });
    expect(expandCheckoutTemplate("${1BAD}/x", env)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not name a variable/) as unknown });
    expect(expandCheckoutTemplate("/a/$/b", env)).toMatchObject({ ok: false, reason: expect.stringMatching(/not followed by a variable name/) as unknown });
  });
});

describe("resolveCanonCheckout -- the fixed order, each step reported, no fall-through on failure", () => {
  it("uses --canon-checkout first (relative against the consumer root) and reports the later steps as never consulted", () => {
    const root = dir();
    mkdirSync(join(root, "canon"));
    const path = join(root, "canon");
    const seams = new ScriptedSeams(gitFor(path), { env: { CANON: "/elsewhere" } });
    const result = resolveCanonCheckout({ root, source: SOURCE, ref: REF, flag: "canon", declaration: declared({ checkoutEnv: "CANON" }), seams });
    expect(result.failure).toBeNull();
    expect(result.path).toBe(path);
    expect(result.resolvedFrom).toEqual({ kind: "flag", status: "used", from: "--canon-checkout" });
    expect(result.steps).toHaveLength(1);
    expect(result.verified).toEqual({ origin: "https://github.com/owner/handbooks.git", originSlug: SOURCE, head: TAG_SHA, tag: REF, tagCommit: TAG_SHA, clean: true });
  });

  it("uses the variable the declaration NAMES, citing the registry field, when no flag is given", () => {
    const root = dir();
    const path = dir();
    const seams = new ScriptedSeams(gitFor(path), { env: { MY_CANON: path } });
    const result = resolveCanonCheckout({ root, source: SOURCE, ref: REF, flag: null, declaration: declared({ checkoutEnv: "MY_CANON", checkout: "/never/read" }), seams });
    expect(result.failure).toBeNull();
    expect(result.resolvedFrom).toEqual({ kind: "env", status: "used", from: "$MY_CANON (nen/repos.json maintained_tools[2].checkout_env)" });
    expect(result.steps.map((step): string => `${step.kind}:${step.status}`)).toEqual(["flag:absent", "env:used"]);
  });

  it("passes over an unset variable to the declared template, and says why", () => {
    const root = dir();
    const cache = dir();
    const path = join(cache, "canon", "owner", "handbooks");
    mkdirSync(path, { recursive: true });
    const seams = new ScriptedSeams(gitFor(path), { env: { HOME: "/nope", XDG_CACHE_HOME: cache } });
    const result = resolveCanonCheckout({
      root, source: SOURCE, ref: REF, flag: null,
      declaration: declared({ checkoutEnv: "MY_CANON", checkout: "${XDG_CACHE_HOME:-${HOME}/.cache}/canon/owner/handbooks" }),
      seams,
    });
    expect(result.failure).toBeNull();
    expect(result.path).toBe(path);
    expect(result.steps[1]).toEqual({ kind: "env", status: "absent", from: "$MY_CANON (nen/repos.json maintained_tools[2].checkout_env)", note: "not set in this environment" });
    expect(result.resolvedFrom?.kind).toBe("declared-path");
    expect(checkoutLines(result)).toEqual(expect.arrayContaining([
      `checkout: ${path}`,
      "resolved from: declared-path '${XDG_CACHE_HOME:-${HOME}/.cache}/canon/owner/handbooks' (nen/repos.json maintained_tools[2].checkout)",
      "  passed over: env $MY_CANON (nen/repos.json maintained_tools[2].checkout_env) (not set in this environment)",
    ]));
  });

  it("resolves a relative declared path against the consumer root", () => {
    const base = dir();
    const root = join(base, "consumer");
    const path = join(base, "handbooks");
    mkdirSync(root);
    mkdirSync(path);
    const result = resolveCanonCheckout({ root, source: SOURCE, ref: REF, flag: null, declaration: declared({ checkout: "../handbooks" }), seams: new ScriptedSeams(gitFor(path)) });
    expect(result.failure).toBeNull();
    expect(result.path).toBe(path);
  });

  it("fails 'unresolvable' when nothing is given or declared, naming both fields and the flag", () => {
    const result = resolveCanonCheckout({ root: dir(), source: SOURCE, ref: REF, flag: null, declaration: null, seams: new ScriptedSeams([]) });
    expect(result.failure?.code).toBe("unresolvable");
    expect(result.failure?.message).toMatch(/declares no checkout for owner\/handbooks.*'checkout_env'.*'checkout'.*--canon-checkout/);
    expect(result.path).toBeNull();
    expect(result.steps.every((step): boolean => step.status === "absent")).toBe(true);
  });

  it("does NOT fall through when a present step fails: an invalid env path ends the run though a valid template is declared", () => {
    const root = dir();
    const good = dir();
    const seams = new ScriptedSeams(gitFor(good), { env: { MY_CANON: join(root, "missing") } });
    const result = resolveCanonCheckout({ root, source: SOURCE, ref: REF, flag: null, declaration: declared({ checkoutEnv: "MY_CANON", checkout: good }), seams });
    expect(result.failure?.code).toBe("not-found");
    expect(result.resolvedFrom?.kind).toBe("env");
    expect(seams.calls).toEqual([]);
  });

  it("refuses a relative variable value and an unexpandable template, each by its own code", () => {
    const root = dir();
    const relative = resolveCanonCheckout({ root, source: SOURCE, ref: REF, flag: null, declaration: declared({ checkoutEnv: "MY_CANON" }), seams: new ScriptedSeams([], { env: { MY_CANON: "rel/path" } }) });
    expect(relative.failure?.code).toBe("env-not-absolute");
    const template = resolveCanonCheckout({ root, source: SOURCE, ref: REF, flag: null, declaration: declared({ checkout: "${NOPE}/x" }), seams: new ScriptedSeams([]) });
    expect(template.failure?.code).toBe("bad-template");
    expect(template.failure?.message).toMatch(/maintained_tools\[2\]\.checkout\) cannot be expanded: it names \$\{NOPE\}/);
  });
});

describe("verifyCanonCheckout -- five facts, each its own named failure", () => {
  const cases: ReadonlyArray<readonly [string, Readonly<Record<string, ScriptedCall["result"]>>, string, RegExp]> = [
    ["no work tree", { "rev-parse --show-toplevel": { code: 128, stdout: "" } }, "not-a-checkout", /not inside a git work tree/],
    ["no origin", { "remote get-url origin": { code: 2, stdout: "" } }, "no-origin", /has no 'origin' remote/],
    ["another repository", { "remote get-url origin": { stdout: "git@github.com:someone/else.git\n" } }, "wrong-source", /names someone\/else, not owner\/handbooks/],
    ["an unparseable origin", { "remote get-url origin": { stdout: "/local/path\n" } }, "wrong-source", /does not read as an owner\/name repository/],
    ["no such tag", { [`rev-parse --verify --quiet refs/tags/${REF}^{commit}`]: { code: 1, stdout: "" } }, "tag-missing", /has no tag v1\.2\.0.*fetch --tags/],
    ["HEAD elsewhere", { "rev-parse --verify --quiet HEAD^{commit}": { stdout: `${"b".repeat(40)}\n` } }, "off-pin", /is at bbbbbbbbbbbb, not at v1\.2\.0 \(aaaaaaaaaaaa\)/],
    ["no HEAD", { "rev-parse --verify --quiet HEAD^{commit}": { code: 1, stdout: "" } }, "off-pin", /has no HEAD commit/],
    ["a dirty tree", { "status --porcelain": { stdout: " M handbooks/x.md\n?? y\n" } }, "dirty", /has 2 uncommitted changes \(first: 'M handbooks\/x\.md'\)/],
    ["a failing status", { "status --porcelain": { code: 128 } }, "not-a-checkout", /git status failed/],
    ["no git", { "rev-parse --show-toplevel": { spawnFailed: true, code: 127 } }, "git-unavailable", /git could not be started/],
  ];
  for (const [what, over, code, message] of cases) {
    it(`fails '${code}' on ${what}`, () => {
      const path = dir();
      const result = verifyCanonCheckout(new ScriptedSeams(gitFor(path, over)), path, SOURCE, REF);
      expect("failure" in result && result.failure.code).toBe(code);
      expect("failure" in result && result.failure.message).toMatch(message);
    });
  }

  it("refuses a subdirectory of a checkout rather than walking up from it", () => {
    const top = dir();
    const sub = join(top, "handbooks");
    mkdirSync(sub);
    const result = verifyCanonCheckout(new ScriptedSeams(gitFor(sub, { "rev-parse --show-toplevel": { stdout: `${top}\n` } })), sub, SOURCE, REF);
    expect("failure" in result && result.failure.code).toBe("not-checkout-root");
  });

  it("refuses a path that is not a directory, and one that does not exist, before any git call", () => {
    const base = dir();
    writeFileSync(join(base, "file"), "x");
    const seams = new ScriptedSeams([]);
    expect(verifyCanonCheckout(seams, join(base, "file"), SOURCE, REF)).toMatchObject({ failure: { code: "not-found", message: expect.stringMatching(/is not a directory/) as unknown } });
    expect(verifyCanonCheckout(seams, join(base, "nope"), SOURCE, REF)).toMatchObject({ failure: { code: "not-found", message: expect.stringMatching(/does not exist/) as unknown } });
    expect(seams.calls).toEqual([]);
  });

  it("matches the source case-insensitively and redacts credentials in the reported origin", () => {
    const path = dir();
    const result = verifyCanonCheckout(new ScriptedSeams(gitFor(path, { "remote get-url origin": { stdout: "https://me:s3cret@github.com/Owner/Handbooks\n" } })), path, SOURCE, REF);
    expect("verified" in result && result.verified.origin).toBe("https://me:***@github.com/Owner/Handbooks");
    expect(JSON.stringify(result)).not.toMatch(/s3cret/);
  });
});
