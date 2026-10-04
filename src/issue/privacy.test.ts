import { describe, expect, it } from "vitest";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import {
  blockingExit,
  checkPrivateNames,
  compileMatcher,
  findPrivateNames,
  normalise,
  parseIgnoreList,
  privateNameLines,
  readPrivateList,
  readTargetVisibility,
  PrivateListUnavailableError,
  PRIVATE_NAME_EXIT,
} from "./privacy.js";

const TARGET: Target = { owner: "o", repo: "pub", slug: "o/pub" };

/** The list page `readPrivateList` asks for. */
function page(n: number, names: readonly string[]): ScriptedCall {
  return {
    match: `gh api user/repos?visibility=private&per_page=100&page=${n}`,
    result: { stdout: JSON.stringify(names.map((full_name): { full_name: string } => ({ full_name }))) },
  };
}

function visibility(value: unknown): ScriptedCall {
  return { match: "gh api repos/o/pub", result: { stdout: JSON.stringify(value) } };
}

/** Hits for one body against one list, as `field:line:#index[n]`. */
function hits(list: readonly string[], body: string): readonly string[] {
  return findPrivateNames(compileMatcher(list), [{ field: "body", text: body }]).map(
    (hit): string => `${hit.field}:${hit.line}:#${hit.index}${hit.normalised ? "n" : ""}`,
  );
}

describe("private-name matching (zheref/nen#329)", () => {
  const LIST = ["acme/secret-sauce", "acme/vault", "other/zeta"];

  it("finds a bare name, whole-word", () => {
    expect(hits(LIST, "see vault for details")).toEqual(["body:1:#2"]);
  });

  it("finds an owner/name slug and a URL through the name", () => {
    expect(hits(LIST, "acme/vault")).toEqual(["body:1:#2"]);
    expect(hits(LIST, "line one\nhttps://github.com/acme/secret-sauce/pull/3")).toEqual(["body:2:#1"]);
  });

  it("is case-insensitive", () => {
    expect(hits(LIST, "VAULT and Secret-Sauce")).toEqual(["body:1:#2", "body:1:#1"]);
  });

  it("treats `_` and `.` as word bounds -- markdown emphasis, snake_case, a file suffix, a sentence's end", () => {
    expect(hits(LIST, "_vault_")).toEqual(["body:1:#2"]);
    expect(hits(LIST, "__vault__")).toEqual(["body:1:#2"]);
    expect(hits(LIST, "my_vault")).toEqual(["body:1:#2"]);
    expect(hits(LIST, "vault.git")).toEqual(["body:1:#2"]);
    expect(hits(LIST, "it lives in vault.")).toEqual(["body:1:#2"]);
  });

  it("finds a name inside `**bold**` emphasis", () => {
    expect(hits(LIST, "**vault**")).toEqual(["body:1:#2"]);
  });

  it("does not match a name inside a longer word, where `-` and letters continue it", () => {
    expect(hits(LIST, "vaults vault-tools secret-sauces myvault")).toEqual([]);
  });

  it("finds a name only the normalised readings expose, and says so", () => {
    expect(hits(LIST, "va**ul**t")).toEqual(["body:1:#2n"]);
    expect(hits(LIST, "va`u`lt")).toEqual(["body:1:#2n"]);
    expect(hits(LIST, "va<!-- x -->ult")).toEqual(["body:1:#2n"]);
    expect(hits(LIST, "v&#97;ult")).toEqual(["body:1:#2n"]);
    expect(hits(LIST, "v%61ult")).toEqual(["body:1:#2n"]);
    expect(hits(LIST, "va​ult")).toEqual(["body:1:#2n"]);
    expect(hits(LIST, "secret–sauce")).toEqual(["body:1:#1n"]);
    expect(hits(LIST, "\\_vault\\_")).toEqual(["body:1:#2"]);
  });

  it("reports one name once per line, raw or normalised", () => {
    expect(hits(LIST, "vault, vault and v&#97;ult")).toEqual(["body:1:#2"]);
  });

  it("indexes the sorted list and lets the first of two case-twin names own the index", () => {
    const matcher = compileMatcher(["a/Thing", "b/thing", "c/zeta"]);
    expect(matcher.indexOf.get("thing")).toBe(1);
    expect(matcher.indexOf.get("zeta")).toBe(3);
  });

  it("takes a name with a dot literally, never as a regex wildcard", () => {
    expect(hits(["o/my.app"], "my.app and myXapp")).toEqual(["body:1:#1"]);
  });

  it("normalise() folds dashes and drops format characters", () => {
    expect(normalise("a—b­c")).toBe("a-bc");
  });
});

describe("the ignore list", () => {
  it("parses names and slugs, lowercase, skipping comments, blanks and whitespace", () => {
    const list = parseIgnoreList("# header\n\n  Vault  # generic\nAcme/Thing\r\n");
    expect([...list.names]).toEqual(["vault"]);
    expect([...list.slugs]).toEqual(["acme/thing"]);
  });

  it("exempts a case twin only when every owner carrying the name is ignored", () => {
    const both = compileMatcher(["a/Thing", "b/thing"], parseIgnoreList("thing\n"));
    expect(both.ignored.has("thing")).toBe(true);
    const one = compileMatcher(["a/Thing", "b/thing"], parseIgnoreList("a/thing\n"));
    expect(one.ignored.has("thing")).toBe(false);
  });

  it("marks an ignored hit, and a check with only ignored hits is clean but reports them", () => {
    const seams = new ScriptedSeams([visibility({ visibility: "public" }), page(1, ["acme/vault"])]);
    const check = checkPrivateNames(seams, TARGET, [{ field: "body", text: "vault" }], false, parseIgnoreList("vault"));
    expect(check.result).toBe("clean");
    expect(check.hits).toEqual([{ field: "body", line: 1, index: 1, normalised: false, ignored: true }]);
    expect(privateNameLines(check, TARGET)).toEqual(["nen issue: ignored: body:1: private repository #1 (ignore file)"]);
  });
});

describe("the private-name reads, fail closed", () => {
  it("reads the target's visibility, falling back to the `private` boolean", () => {
    expect(readTargetVisibility(new ScriptedSeams([visibility({ visibility: "PUBLIC" })]), TARGET)).toBe("public");
    expect(readTargetVisibility(new ScriptedSeams([visibility({ visibility: "internal" })]), TARGET)).toBe("internal");
    expect(readTargetVisibility(new ScriptedSeams([visibility({ private: true })]), TARGET)).toBe("private");
    expect(readTargetVisibility(new ScriptedSeams([visibility({ private: false })]), TARGET)).toBe("public");
  });

  it("refuses an unreadable, unparseable or unknown visibility", () => {
    const failing: ScriptedCall = { match: "gh api repos/o/pub", result: { code: 1, stderr: "HTTP 404" } };
    expect(() => readTargetVisibility(new ScriptedSeams([failing]), TARGET)).toThrow(PrivateListUnavailableError);
    const garbage: ScriptedCall = { match: "gh api repos/o/pub", result: { stdout: "not json" } };
    expect(() => readTargetVisibility(new ScriptedSeams([garbage]), TARGET)).toThrow(/did not parse/);
    expect(() => readTargetVisibility(new ScriptedSeams([visibility({ visibility: "secret" })]), TARGET)).toThrow(
      /not public, private or internal/,
    );
    expect(() => readTargetVisibility(new ScriptedSeams([visibility({})]), TARGET)).toThrow(/carried no visibility/);
    const unstartable: ScriptedCall = { match: "gh api repos/o/pub", result: { spawnFailed: true, code: 127 } };
    expect(() => readTargetVisibility(new ScriptedSeams([unstartable]), TARGET)).toThrow(/could not be started/);
  });

  it("reads every page and sorts the list bytewise", () => {
    const first = Array.from({ length: 100 }, (_v, i): string => `o/r${String(i).padStart(3, "0")}`);
    const seams = new ScriptedSeams([page(1, first), page(2, ["Z/last", "o/r000"])]);
    const list = readPrivateList(seams);
    expect(list).toHaveLength(101);
    expect(list[0]).toBe("Z/last");
    expect(seams.calls).toHaveLength(2);
  });

  it("refuses a list that reads EMPTY, never a pass", () => {
    expect(() => readPrivateList(new ScriptedSeams([page(1, [])]))).toThrow(/read EMPTY/);
  });

  it("refuses a failing or malformed list", () => {
    const failing: ScriptedCall = {
      match: "gh api user/repos?visibility=private&per_page=100&page=1",
      result: { code: 1, stderr: "HTTP 401: Bad credentials" },
    };
    expect(() => readPrivateList(new ScriptedSeams([failing]))).toThrow(/HTTP 401/);
    const object: ScriptedCall = {
      match: "gh api user/repos?visibility=private&per_page=100&page=1",
      result: { stdout: "{}" },
    };
    expect(() => readPrivateList(new ScriptedSeams([object]))).toThrow(/not an array/);
    const nameless: ScriptedCall = {
      match: "gh api user/repos?visibility=private&per_page=100&page=1",
      result: { stdout: "[{}]" },
    };
    expect(() => readPrivateList(new ScriptedSeams([nameless]))).toThrow(/no full_name/);
  });

  it("refuses a list that fills every page it will read, as possibly truncated", () => {
    const full = Array.from({ length: 100 }, (_v, i): string => `o/r${i}`);
    const script = Array.from({ length: 100 }, (_v, i): ScriptedCall => page(i + 1, full));
    expect(() => readPrivateList(new ScriptedSeams(script))).toThrow(/may be truncated/);
  });
});

describe("checkPrivateNames -- the verdict a verb acts on", () => {
  const body = [{ field: "body", text: "ships with the vault adapter" }];

  it("skips by flag without reading anything", () => {
    const seams = new ScriptedSeams([]);
    expect(checkPrivateNames(seams, TARGET, body, true).result).toBe("skipped-by-flag");
    expect(seams.calls).toHaveLength(0);
  });

  it("skips a private or internal target without reading the list", () => {
    for (const value of ["private", "internal"]) {
      const seams = new ScriptedSeams([visibility({ visibility: value })]);
      const check = checkPrivateNames(seams, TARGET, body, false);
      expect(check.result).toBe("skipped-private-target");
      expect(check.targetVisibility).toBe(value);
      expect(seams.calls).toHaveLength(1);
    }
  });

  it("refuses a hit on a public target with exit 4, and its lines never carry the name", () => {
    const seams = new ScriptedSeams([visibility({ visibility: "public" }), page(1, ["acme/vault"])]);
    const check = checkPrivateNames(seams, TARGET, body, false);
    expect(check.result).toBe("refused");
    expect(blockingExit(check)).toBe(PRIVATE_NAME_EXIT);
    const lines = privateNameLines(check, TARGET).join("\n");
    expect(lines).toContain("body:1: private repository #1");
    expect(lines).not.toMatch(/vault/i);
  });

  it("is clean on a public target with no hit, and prints nothing", () => {
    const seams = new ScriptedSeams([visibility({ visibility: "public" }), page(1, ["acme/other"])]);
    const check = checkPrivateNames(seams, TARGET, body, false);
    expect(check.result).toBe("clean");
    expect(privateNameLines(check, TARGET)).toEqual([]);
  });

  it("is unavailable (exit 1) when the visibility or the list cannot be read", () => {
    const noVisibility = checkPrivateNames(
      new ScriptedSeams([{ match: "gh api repos/o/pub", result: { code: 1 } }]),
      TARGET,
      body,
      false,
    );
    expect(noVisibility.result).toBe("unavailable");
    expect(blockingExit(noVisibility)).toBe(1);
    const emptyList = checkPrivateNames(new ScriptedSeams([visibility({ visibility: "public" }), page(1, [])]), TARGET, body, false);
    expect(emptyList.result).toBe("unavailable");
    expect(emptyList.error).toMatch(/EMPTY/);
    expect(privateNameLines(emptyList, TARGET).join("\n")).toMatch(/never a pass/);
  });
});
