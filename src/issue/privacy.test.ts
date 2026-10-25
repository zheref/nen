import { describe, expect, it } from "vitest";
import { FULL_REACH_ROW } from "./privacy.testkit.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import {
  blockingExit,
  checkPrivateNames,
  compileMatcher,
  findPrivateNameOccurrences,
  findPrivateNames,
  NamedListError,
  normalise,
  parseIgnoreList,
  objectKindAtRef,
  parseNamedList,
  privateNameLines,
  readCommittedNamedList,
  readPrivateList,
  resolveRemoteDefaultRef,
  showAtRef,
  readTargetVisibility,
  PrivateListUnavailableError,
  PRIVATE_NAME_EXIT,
  type NamedList,
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
    // Within a line, hits come in list order (one pattern per name), not text order.
    expect(hits(LIST, "VAULT and Secret-Sauce")).toEqual(["body:1:#1", "body:1:#2"]);
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
    const matcher = compileMatcher(["a/Gizmo", "b/gizmo", "c/zeta"]);
    expect(matcher.indexOf.get("gizmo")).toBe(1);
    expect(matcher.indexOf.get("zeta")).toBe(3);
  });

  it("takes a name with a dot literally, never as a regex wildcard", () => {
    expect(hits(["o/my.app"], "my.app and myXapp")).toEqual(["body:1:#1"]);
  });

  it("reads strikethrough, U+2212 and default-ignorable characters through the normalised pass (N6)", () => {
    expect(hits(["o/secretproj"], "secret~~proj~~")).toEqual(["body:1:#1n"]);
    expect(hits(["o/secret-proj"], "secret\u2212proj")).toEqual(["body:1:#1n"]);
    expect(hits(["o/secretproj"], "secret\u034Fproj")).toEqual(["body:1:#1n"]);
    expect(hits(["o/secretproj"], "secret\uFE0Fproj")).toEqual(["body:1:#1n"]);
  });

  it("never resolves an entity name through Object.prototype (N11)", () => {
    expect(normalise("&constructor;&toString;&__proto__;")).toBe("&constructor;&toString;&__proto__;");
  });

  it("finds a policed name inside an IGNORED longer one -- prefix and suffix overlaps (Copilot round 1)", () => {
    // Prefix: `vault` is policed, `vault.tools` ignored; `.` bounds a word, so `vault` occurs.
    const prefix = compileMatcher(["a/vault", "b/vault.tools"], parseIgnoreList("vault.tools\n"));
    expect(findPrivateNames(prefix, [{ field: "body", text: "see vault.tools" }])).toEqual([
      { field: "body", line: 1, index: 1, normalised: false, ignored: false, ignoredBy: null, form: "bare", class: null },
      { field: "body", line: 1, index: 2, normalised: false, ignored: true, ignoredBy: "ignore-file", form: "bare", class: null },
    ]);
    // Suffix: `vault` is policed, `my_vault` ignored; `_` bounds a word.
    const suffix = compileMatcher(["a/my_vault", "b/vault"], parseIgnoreList("my_vault\n"));
    expect(findPrivateNames(suffix, [{ field: "body", text: "in my_vault today" }])).toEqual([
      { field: "body", line: 1, index: 1, normalised: false, ignored: true, ignoredBy: "ignore-file", form: "bare", class: null },
      { field: "body", line: 1, index: 2, normalised: false, ignored: false, ignoredBy: null, form: "bare", class: null },
    ]);
  });

  it("reads a name inside a link destination before tags are stripped -- autolink and href (Copilot round 1)", () => {
    expect(hits(LIST, "<https://github.com/acme/v%61ult>")).toEqual(["body:1:#2n"]);
    expect(hits(LIST, '<a href="https://github.com/acme/v%61ult">the adapter</a>')).toEqual(["body:1:#2n"]);
    expect(hits(LIST, '<a href="https://github.com/acme/v&#97;ult">x</a>')).toEqual(["body:1:#2n"]);
  });

  it("normalise() folds dashes and drops format characters", () => {
    expect(normalise("a—b­c")).toBe("a-bc");
  });
});

describe("the ignore list", () => {
  it("parses names and slugs, lowercase, skipping comments, blanks and whitespace", () => {
    const list = parseIgnoreList("# header\n\n  Vault  # generic\nAcme/Gizmo\r\n");
    expect([...list.names]).toEqual(["vault"]);
    expect([...list.slugs]).toEqual(["acme/gizmo"]);
  });

  it("exempts a case twin only when every owner carrying the name is ignored", () => {
    const both = compileMatcher(["a/Gizmo", "b/gizmo"], parseIgnoreList("gizmo\n"));
    expect(both.ignored.has("gizmo")).toBe(true);
    const one = compileMatcher(["a/Gizmo", "b/gizmo"], parseIgnoreList("a/gizmo\n"));
    expect(one.ignored.has("gizmo")).toBe(false);
  });

  it("a blocking hit reports the first STILL-POLICED entry's index, never an exempt twin's (N7)", () => {
    const matcher = compileMatcher(["a/gizmo", "b/gizmo"], parseIgnoreList("a/gizmo\n"));
    expect(findPrivateNames(matcher, [{ field: "body", text: "gizmo" }])).toEqual([
      { field: "body", line: 1, index: 2, normalised: false, ignored: false, ignoredBy: null, form: "bare", class: null },
    ]);
  });

  it("refuses as unavailable when EVERY private name is ignored, unless --allow-all-ignored (N4)", () => {
    const script = (): ScriptedSeams =>
      new ScriptedSeams([visibility({ visibility: "public" }), FULL_REACH_ROW, page(1, ["acme/vault", "b/zeta"])]);
    const ignoreAll = parseIgnoreList("vault\nzeta\n");
    const refused = checkPrivateNames(script(), TARGET, [{ field: "body", text: "vault" }], false, ignoreAll);
    expect(refused.result).toBe("unavailable");
    expect(refused.error).toMatch(/every private name is ignored/);
    expect(blockingExit(refused)).toBe(1);
    const allowed = checkPrivateNames(script(), TARGET, [{ field: "body", text: "vault" }], false, ignoreAll, true);
    expect(allowed.result).toBe("clean");
    expect(allowed.hits).toEqual([{ field: "body", line: 1, index: 1, normalised: false, ignored: true, ignoredBy: "ignore-file", form: "bare", class: null }]);
  });

  it("reports the list's size and owner count, and never a name (N13)", () => {
    const seams = new ScriptedSeams([visibility({ visibility: "public" }), FULL_REACH_ROW, page(1, ["acme/vault", "Acme/other", "b/zeta"])]);
    const check = checkPrivateNames(seams, TARGET, [{ field: "body", text: "clean" }], false);
    expect(check.listSize).toBe(3);
    expect(check.owners).toBe(2);
    expect(JSON.stringify(check)).not.toMatch(/vault|other|zeta|acme/i);
    const skipped = checkPrivateNames(new ScriptedSeams([]), TARGET, [], true);
    expect(skipped.listSize).toBeNull();
    expect(skipped.owners).toBeNull();
  });

  it("marks an ignored hit, and a check with only ignored hits is clean but reports them", () => {
    const seams = new ScriptedSeams([visibility({ visibility: "public" }), FULL_REACH_ROW, page(1, ["acme/other", "acme/vault"])]);
    const check = checkPrivateNames(seams, TARGET, [{ field: "body", text: "vault" }], false, parseIgnoreList("vault"));
    expect(check.result).toBe("clean");
    expect(check.hits).toEqual([{ field: "body", line: 1, index: 2, normalised: false, ignored: true, ignoredBy: "ignore-file", form: "bare", class: null }]);
    expect(privateNameLines(check, TARGET)).toEqual(["nen issue: ignored: body:1: private repository #2 (ignore file)"]);
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

  it("refuses a list with ANY malformed full_name, mixed with valid ones, never checking past it (Copilot round 1)", () => {
    for (const bad of ["owner/", "/name", "a/b/c", "bare", "own er/name", "owner/na me"]) {
      const seams = new ScriptedSeams([page(1, ["acme/vault", bad, "other/zeta"])]);
      expect(() => readPrivateList(seams), bad).toThrow(/malformed full_name \(entry 2; not exactly owner\/name\)/);
    }
    // And through the verdict: unavailable, never a clean read of unrelated text.
    const check = checkPrivateNames(
      new ScriptedSeams([visibility({ visibility: "public" }), FULL_REACH_ROW, page(1, ["acme/vault", "secretco/"])]),
      TARGET,
      [{ field: "body", text: "unrelated text" }],
      false,
    );
    expect(check.result).toBe("unavailable");
    expect(check.error).not.toMatch(/secretco/);
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

  it("skips a private target without reading the list", () => {
    const seams = new ScriptedSeams([visibility({ visibility: "private" })]);
    const check = checkPrivateNames(seams, TARGET, body, false);
    expect(check.result).toBe("skipped-private-target");
    expect(check.targetVisibility).toBe("private");
    expect(seams.calls).toHaveLength(1);
  });

  // zheref/nen#363, Feitan F9: an internal repository is readable by the
  // whole enterprise, so it is checked like a public one.
  it("checks an INTERNAL target like a public one", () => {
    const seams = new ScriptedSeams([visibility({ visibility: "internal" }), FULL_REACH_ROW, page(1, ["acme/vault"])]);
    const check = checkPrivateNames(seams, TARGET, body, false);
    expect(check.result).toBe("refused");
    expect(check.targetVisibility).toBe("internal");
  });

  // zheref/nen#363, Feitan F7: a list the credential cannot be shown to have
  // in full is a refusal, never a pass against the names it happened to get.
  describe("the credential's reach -- X-OAuth-Scopes", () => {
    const scopes = (headers: string): ScriptedCall => ({ match: "gh api -i user", result: { stdout: `HTTP/2.0 200 OK\n${headers}\n{"login":"me"}` } });
    it("a classic token with 'repo' reads the list", () => {
      const seams = new ScriptedSeams([visibility({ visibility: "public" }), scopes("X-OAuth-Scopes: read:org, repo, workflow\n"), page(1, ["acme/other"])]);
      expect(checkPrivateNames(seams, TARGET, body, false).result).toBe("clean");
    });
    it("a scopes header WITHOUT 'repo' is unavailable, and the list is never read", () => {
      const seams = new ScriptedSeams([visibility({ visibility: "public" }), scopes("X-OAuth-Scopes: public_repo, read:org\n")]);
      const check = checkPrivateNames(seams, TARGET, body, false);
      expect(check.result).toBe("unavailable");
      expect(check.error).toMatch(/may be partial/);
      expect(seams.calls).toHaveLength(2);
    });
    it("NO scopes header (a fine-grained, app or CI token) is unavailable", () => {
      const seams = new ScriptedSeams([visibility({ visibility: "public" }), scopes("Content-Type: application/json\n")]);
      const check = checkPrivateNames(seams, TARGET, body, false);
      expect(check.result).toBe("unavailable");
      expect(check.error).toMatch(/no X-OAuth-Scopes header/);
      expect(blockingExit(check)).toBe(1);
    });
    it("a header-looking line in the BODY is not read as the header", () => {
      const seams = new ScriptedSeams([visibility({ visibility: "public" }), scopes("Content-Type: application/json\n\nX-OAuth-Scopes: repo")]);
      expect(checkPrivateNames(seams, TARGET, body, false).result).toBe("unavailable");
    });
    it("a scopes read that fails is unavailable", () => {
      const seams = new ScriptedSeams([visibility({ visibility: "public" }), { match: "gh api -i user", result: { code: 1, stderr: "HTTP 401" } }]);
      expect(checkPrivateNames(seams, TARGET, body, false).result).toBe("unavailable");
    });
  });

  it("refuses a hit on a public target with exit 4, and its lines never carry the name", () => {
    const seams = new ScriptedSeams([visibility({ visibility: "public" }), FULL_REACH_ROW, page(1, ["acme/vault"])]);
    const check = checkPrivateNames(seams, TARGET, body, false);
    expect(check.result).toBe("refused");
    expect(blockingExit(check)).toBe(PRIVATE_NAME_EXIT);
    const lines = privateNameLines(check, TARGET).join("\n");
    expect(lines).toContain("body:1: private repository #1");
    expect(lines).not.toMatch(/vault/i);
  });

  it("is clean on a public target with no hit, and prints nothing", () => {
    const seams = new ScriptedSeams([visibility({ visibility: "public" }), FULL_REACH_ROW, page(1, ["acme/other"])]);
    const check = checkPrivateNames(seams, TARGET, body, false);
    expect(check.result).toBe("clean");
    expect(privateNameLines(check, TARGET)).toEqual([]);
  });

  it("strips terminal controls from gh's stderr in the human lines, and keeps the bytes in the verdict (Copilot round 1)", () => {
    const failing: ScriptedCall = {
      match: "gh api user/repos?visibility=private&per_page=100&page=1",
      result: { code: 1, stderr: "HTTP 401\u001b[2K\u001b[1Aforged\r" },
    };
    const check = checkPrivateNames(new ScriptedSeams([visibility({ visibility: "public" }), FULL_REACH_ROW, failing]), TARGET, [], false);
    expect(check.error).toContain("\u001b[2K");
    const human = privateNameLines(check, TARGET).join("\n");
    expect(human).not.toMatch(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/);
    expect(human).toContain("HTTP 401[2K[1Aforged");
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
    const emptyList = checkPrivateNames(new ScriptedSeams([visibility({ visibility: "public" }), FULL_REACH_ROW, page(1, [])]), TARGET, body, false);
    expect(emptyList.result).toBe("unavailable");
    expect(emptyList.error).toMatch(/EMPTY/);
    expect(privateNameLines(emptyList, TARGET).join("\n")).toMatch(/never a pass/);
  });
});

describe("the named list (zheref/nen#441)", () => {
  it("parses exact owner/name slugs, lowercase, skipping comments, blanks and whitespace", () => {
    const list = parseNamedList("# ruled public\n\n  Acme/Gizmo  # the ruling\r\nb/other\n");
    expect([...list.slugs]).toEqual(["acme/gizmo", "b/other"]);
  });

  it("refuses a bare name, naming the line and never the entry", () => {
    let thrown: unknown;
    try {
      parseNamedList("# header\nacme/gizmo\nvault\n");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NamedListError);
    expect((thrown as NamedListError).line).toBe(3);
    expect((thrown as NamedListError).message).toMatch(/line 3 is not an exact owner\/name/);
    expect((thrown as NamedListError).message).not.toContain("vault");
    expect(() => parseNamedList("a/b/c\n")).toThrow(NamedListError);
    expect(() => parseNamedList("acme/\n")).toThrow(NamedListError);
  });

  it("exempts exactly that repository: a same-named private repository under another owner is still a hit", () => {
    const named = parseNamedList("a/gizmo\n");
    const matcher = compileMatcher(["a/gizmo", "b/gizmo"], null, named);
    expect(matcher.ignored.has("gizmo")).toBe(false);
    expect(findPrivateNames(matcher, [{ field: "body", text: "gizmo" }])).toEqual([
      { field: "body", line: 1, index: 2, normalised: false, ignored: false, ignoredBy: null, form: "bare", class: null },
    ]);
  });

  it("honours both lists in one call, and each ignored hit says which list exempted it", () => {
    const seams = new ScriptedSeams([visibility({ visibility: "public" }), FULL_REACH_ROW, page(1, ["acme/gizmo", "acme/vault", "b/zeta"])]);
    const check = checkPrivateNames(
      seams,
      TARGET,
      [{ field: "body", text: "gizmo, vault and zeta" }],
      false,
      parseIgnoreList("vault\n"),
      false,
      parseNamedList("acme/gizmo\n"),
    );
    expect(check.result).toBe("refused");
    expect(check.hits).toEqual([
      { field: "body", line: 1, index: 1, normalised: false, ignored: true, ignoredBy: "named-list", form: "bare", class: null },
      { field: "body", line: 1, index: 2, normalised: false, ignored: true, ignoredBy: "ignore-file", form: "bare", class: null },
      { field: "body", line: 1, index: 3, normalised: false, ignored: false, ignoredBy: null, form: "bare", class: null },
    ]);
    expect(privateNameLines(check, TARGET).slice(0, 3)).toEqual([
      "nen issue: ignored: body:1: private repository #1 (named list)",
      "nen issue: ignored: body:1: private repository #2 (ignore file)",
      "nen issue: body:1: private repository #3",
    ]);
  });

  it("names the named list when both lists exempt one entry", () => {
    const matcher = compileMatcher(["acme/gizmo"], parseIgnoreList("gizmo\n"), parseNamedList("acme/gizmo\n"));
    expect(matcher.exemptedBy.get("gizmo")).toBe("named-list");
  });

  it("counts both lists in the every-name-exempted refusal", () => {
    const script = (): ScriptedSeams =>
      new ScriptedSeams([visibility({ visibility: "public" }), FULL_REACH_ROW, page(1, ["acme/gizmo", "acme/vault"])]);
    const both = checkPrivateNames(script(), TARGET, [{ field: "body", text: "x" }], false, parseIgnoreList("vault\n"), false, parseNamedList("acme/gizmo\n"));
    expect(both.result).toBe("unavailable");
    expect(both.error).toMatch(/every private name is ignored \(the ignore file and the named list exempt all 2\)/);
    const namedOnly = checkPrivateNames(script(), TARGET, [{ field: "body", text: "x" }], false, null, false, parseNamedList("acme/gizmo\nacme/vault\n"));
    expect(namedOnly.error).toMatch(/\(the named list exempts all 2\)/);
    const allowed = checkPrivateNames(script(), TARGET, [{ field: "body", text: "gizmo" }], false, null, true, parseNamedList("acme/gizmo\nacme/vault\n"));
    expect(allowed.result).toBe("clean");
    expect(allowed.hits).toEqual([{ field: "body", line: 1, index: 1, normalised: false, ignored: true, ignoredBy: "named-list", form: "bare", class: null }]);
  });

  const HEAD_REF = "git -C /r symbolic-ref -q refs/remotes/origin/HEAD";
  const main = (path: string): string => `git -C /r show refs/remotes/origin/main:${path}`;
  const tree = (path: string): string => `git -C /r ls-tree refs/remotes/origin/main -- ${path}`;
  const file = (path: string, text: string): ScriptedCall => ({ match: main(path), result: { stdout: text } });
  const blob = (path: string): ScriptedCall => ({ match: tree(path), result: { stdout: `100644 blob 0123456789abcdef0123456789abcdef01234567\t${path}\n` } });
  const headRef: ScriptedCall = { match: HEAD_REF, result: { stdout: "refs/remotes/origin/main\n" } };

  it("resolves the remote's default branch from refs/remotes/origin/HEAD, and null when it is unset or not origin's", () => {
    expect(resolveRemoteDefaultRef(new ScriptedSeams([headRef]), "/r")).toBe("refs/remotes/origin/main");
    expect(resolveRemoteDefaultRef(new ScriptedSeams([{ match: HEAD_REF, result: { code: 1 } }]), "/r")).toBeNull();
    expect(resolveRemoteDefaultRef(new ScriptedSeams([{ match: HEAD_REF, result: { stdout: "refs/remotes/upstream/main\n" } }]), "/r")).toBeNull();
    expect(resolveRemoteDefaultRef(new ScriptedSeams([{ match: HEAD_REF, result: { code: 1, spawnFailed: true } }]), "/r")).toBeNull();
  });

  it("shows a committed file at a ref, tells a file from a tree or symlink, and answers null or absent when git cannot", () => {
    expect(showAtRef(new ScriptedSeams([file("scripts/named.txt", "acme/gizmo\n")]), "/r", "refs/remotes/origin/main", "scripts/named.txt")).toBe("acme/gizmo\n");
    expect(showAtRef(new ScriptedSeams([{ match: main("scripts/named.txt"), result: { code: 128, stderr: "fatal: path does not exist" } }]), "/r", "refs/remotes/origin/main", "scripts/named.txt")).toBeNull();
    expect(objectKindAtRef(new ScriptedSeams([blob("scripts/named.txt")]), "/r", "refs/remotes/origin/main", "scripts/named.txt")).toBe("file");
    expect(objectKindAtRef(new ScriptedSeams([{ match: tree("changelog.d"), result: { stdout: "040000 tree 0123456789abcdef0123456789abcdef01234567\tchangelog.d\n" } }]), "/r", "refs/remotes/origin/main", "changelog.d")).toBe("tree");
    expect(objectKindAtRef(new ScriptedSeams([{ match: tree("link"), result: { stdout: "120000 blob 0123456789abcdef0123456789abcdef01234567\tlink\n" } }]), "/r", "refs/remotes/origin/main", "link")).toBe("symlink");
    expect(objectKindAtRef(new ScriptedSeams([{ match: tree("gone"), result: { stdout: "" } }]), "/r", "refs/remotes/origin/main", "gone")).toBe("absent");
  });

  it("reads the policy, the path and the list at the remote's default branch, and never the checkout's values", () => {
    const seams = new ScriptedSeams([
      headRef,
      file("nen/workflow.json", '{"privateNames":{"namedFile":"scripts/ruled.txt"}}'),
      blob("scripts/ruled.txt"),
      file("scripts/ruled.txt", "# ruled\nAcme/Gizmo\n"),
    ]);
    // The checkout declares another path: compared, never read.
    const read = readCommittedNamedList(seams, "/r", "scripts/mine.txt");
    expect(read.ref).toBe("refs/remotes/origin/main");
    expect(read.path).toBe("scripts/ruled.txt");
    expect([...(read.named?.slugs ?? [])]).toEqual(["acme/gizmo"]);
    expect(seams.calls.map((call): string => [call.command, ...call.args].join(" "))).toEqual([
      HEAD_REF,
      main("nen/workflow.json"),
      tree("scripts/ruled.txt"),
      main("scripts/ruled.txt"),
    ]);
  });

  it("a branch that declares its own list, or retargets branch.base at itself, exempts nothing: the default branch's policy decides (Feitan, Nobunaga)", () => {
    // main's policy declares no named list; the checkout's does, and names a
    // base of its own. Neither checkout value is read.
    const seams = new ScriptedSeams([headRef, file("nen/workflow.json", '{"branch":{"base":"feature"}}')]);
    const read = readCommittedNamedList(seams, "/r", "scripts/mine.txt");
    expect(read.named).toBeNull();
    expect(read.reason).toMatch(/declares no privateNames\.namedFile; the checkout's own declaration \('scripts\/mine.txt'\) is head content and decides nothing/);
    expect(seams.calls.map((call): string => call.args.join(" ")).join("\n")).not.toContain("feature");
    expect(seams.calls.map((call): string => call.args.join(" ")).join("\n")).not.toContain("mine.txt");
  });

  it.each([
    ["the ref unset", [{ match: HEAD_REF, result: { code: 1 } }], /refs\/remotes\/origin\/HEAD is not set/],
    ["no policy at the ref", [headRef, { match: main("nen/workflow.json"), result: { code: 128 } }], /nen\/workflow.json is not at refs\/remotes\/origin\/main/],
    ["a policy this build cannot parse", [headRef, file("nen/workflow.json", '{"coverage":{"minimun":1}}')], /could not be read -- .*coverage\.minimun/],
    ["a policy that is not JSON", [headRef, file("nen/workflow.json", "not json")], /is not valid JSON/],
    ["a directory at the path", [headRef, file("nen/workflow.json", '{"privateNames":{"namedFile":"changelog.d"}}'), { match: tree("changelog.d"), result: { stdout: "040000 tree 0123456789abcdef0123456789abcdef01234567\tchangelog.d\n" } }], /'changelog.d' at refs\/remotes\/origin\/main is a tree, not a regular file/],
    ["a symlink at the path", [headRef, file("nen/workflow.json", '{"privateNames":{"namedFile":"link"}}'), { match: tree("link"), result: { stdout: "120000 blob 0123456789abcdef0123456789abcdef01234567\tlink\n" } }], /is a symlink, not a regular file/],
    ["no such file at the ref", [headRef, file("nen/workflow.json", '{"privateNames":{"namedFile":"scripts/x.txt"}}'), { match: tree("scripts/x.txt"), result: { stdout: "" } }], /'scripts\/x.txt' is not at refs\/remotes\/origin\/main/],
  ])("names nothing, with the reason, on %s", (_case, script, reason) => {
    const read = readCommittedNamedList(new ScriptedSeams(script as ScriptedCall[]), "/r", "scripts/x.txt");
    expect(read.named).toBeNull();
    expect(read.reason).toMatch(reason);
  });

  it("a bare name on the committed list throws NamedListError naming the line", () => {
    const seams = new ScriptedSeams([headRef, file("nen/workflow.json", '{"privateNames":{"namedFile":"scripts/x.txt"}}'), blob("scripts/x.txt"), file("scripts/x.txt", "acme/gizmo\nvault\n")]);
    expect(() => readCommittedNamedList(seams, "/r", "scripts/x.txt")).toThrow(NamedListError);
  });

  it("reads a lazily given named list only after the visibility row: never under the opt-out, never for a private target", () => {
    let calls = 0;
    const named = (): NamedList => {
      calls += 1;
      return parseNamedList("acme/gizmo\n");
    };
    expect(checkPrivateNames(new ScriptedSeams([]), TARGET, [{ field: "body", text: "gizmo" }], true, null, false, named).result).toBe("skipped-by-flag");
    expect(checkPrivateNames(new ScriptedSeams([visibility({ visibility: "private" })]), TARGET, [{ field: "body", text: "gizmo" }], false, null, false, named).result).toBe("skipped-private-target");
    expect(calls).toBe(0);
    const check = checkPrivateNames(new ScriptedSeams([visibility({ visibility: "public" }), FULL_REACH_ROW, page(1, ["acme/gizmo", "b/zeta"])]), TARGET, [{ field: "body", text: "gizmo" }], false, null, false, named);
    expect(calls).toBe(1);
    expect(check.hits).toEqual([{ field: "body", line: 1, index: 1, normalised: false, ignored: true, ignoredBy: "named-list", form: "bare", class: null }]);
  });
});

describe("ordinary-word names (zheref/nen#535)", () => {
  // The maintainer's ruling of 2026-10-25: a private repository named after a
  // common word is matched only where the text names a REPOSITORY. `mark`,
  // `landed` are ordinary words; `kro-pwa`, `mark2`, `marktool`,
  // `mark-tool` are not, and keep the bare-word match.
  const LIST = ["acme/Landed", "acme/Mark", "acme/kro-pwa"];
  const occurrences = (list: readonly string[], body: string): ReturnType<typeof findPrivateNameOccurrences> =>
    findPrivateNameOccurrences(compileMatcher(list), [{ field: "body", text: body }]);
  const forms = (list: readonly string[], body: string): readonly string[] =>
    occurrences(list, body).hits.map((hit): string => `${hit.line}:#${hit.index}:${hit.form}:${hit.class ?? "-"}`);

  it("classifies the names: whole name, case-insensitive, nothing stripped", async () => {
    const { isOrdinaryWord, ORDINARY_WORD_COUNT, ORDINARY_WORDS_SOURCE } = await import("./ordinary-words.js");
    for (const word of ["Mark", "mark", "MARK", "Landed", "LANDED"]) expect(isOrdinaryWord(word), word).toBe(true);
    for (const name of ["kro-pwa", "Mark2", "MarkTool", "mark-tool", "mark.tools", "my_mark", " mark", "mark ", "", "MarKk"]) {
      expect(isOrdinaryWord(name), name).toBe(false);
    }
    expect(ORDINARY_WORD_COUNT).toBeGreaterThan(5000);
    expect(ORDINARY_WORDS_SOURCE).toMatch(/^SCOWL 2020\.12\.07/);
  });

  it("never matches an ordinary-word name used BARE: prose, a flag, a dotted identifier", () => {
    // `--mark` was never a hit: `-` is a word character, so the word there is `--mark`.
    expect(occurrences(LIST, "nen stop --mark")).toEqual({ hits: [], ruled: [] });
    for (const body of ["Mark the gate", "`nen.stop.mark/v0.3`", "it landed.", "LANDED", "mark_it", "**Mark**"]) {
      const found = occurrences(LIST, body);
      expect(found.hits, body).toEqual([]);
      expect(found.ruled.length, body).toBe(1);
      expect(found.ruled[0], body).toMatchObject({ field: "body", line: 1, form: "bare", class: "ordinary-word" });
    }
  });

  it("matches it in every repository-shaped form, owner/name, name#N, owner/name#N and a URL", () => {
    expect(forms(LIST, "zheref/Mark")).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    expect(forms(LIST, "fixed in Mark#12")).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    expect(forms(LIST, "acme/mark#12")).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    expect(forms(LIST, "https://github.com/zheref/Mark")).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    expect(forms(LIST, "https://github.com/zheref/Mark.git and /pull/3")).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    expect(forms(LIST, "the Landed board lives at acme/landed")).toEqual(["1:#1:repository-shaped:ordinary-word"]);
    // Spelt through an encoding, it is still the repository.
    expect(occurrences(LIST, "zheref%2FMark").hits).toMatchObject([{ index: 2, normalised: true, form: "repository-shaped" }]);
  });

  it("reports a line that names the repository as a hit only, never also as ruled", () => {
    const found = occurrences(LIST, "Mark the gate, then see zheref/Mark");
    expect(found.hits).toHaveLength(1);
    expect(found.ruled).toEqual([]);
  });

  it("keeps the bare match for a name that is not an ordinary word", () => {
    expect(forms(LIST, "the kro-pwa build")).toEqual(["1:#3:bare:-"]);
    expect(forms(LIST, "acme/kro-pwa")).toEqual(["1:#3:repository-shaped:-"]);
    for (const name of ["Mark2", "MarkTool", "mark-tool"]) {
      expect(forms([`acme/${name}`], `the ${name} repo`), name).toEqual(["1:#1:bare:-"]);
    }
  });

  it("a `#` not followed by a digit, and a name before a slash, are not repository-shaped", () => {
    for (const body of ["Mark# is a heading", "mark/v0.3", "Mark #12"]) {
      expect(occurrences(LIST, body).hits, body).toEqual([]);
    }
  });

  it("checkPrivateNames: a bare ordinary word is clean and reported; the shaped form refuses (exit 4)", () => {
    const script = (): ScriptedSeams => new ScriptedSeams([visibility({ visibility: "public" }), FULL_REACH_ROW, page(1, ["acme/Mark", "b/zeta"])]);
    const clean = checkPrivateNames(script(), TARGET, [{ field: "notes", text: "- `nen.stop.mark/v0.3` keeps one marker per gate" }], false);
    expect(clean.result).toBe("clean");
    expect(clean.ruled).toEqual([{ field: "notes", line: 1, index: 1, normalised: false, form: "bare", class: "ordinary-word" }]);
    expect(privateNameLines(clean, TARGET, "release-publish")).toEqual([
      "release-publish: not matched: notes:1: private repository #1 (ordinary word: matched only as owner/name, name#N, name.git, a URL, or its owner's slug spaced or split across lines)",
    ]);
    const refused = checkPrivateNames(script(), TARGET, [{ field: "body", text: "moved to acme/Mark#4" }], false);
    expect(refused.result).toBe("refused");
    expect(blockingExit(refused)).toBe(PRIVATE_NAME_EXIT);
    expect(refused.hits).toEqual([
      { field: "body", line: 1, index: 1, normalised: false, ignored: false, ignoredBy: null, form: "repository-shaped", class: "ordinary-word" },
    ]);
    expect(privateNameLines(refused, TARGET).join("\n")).not.toMatch(/mark/i);
  });

  it("matches through a markup or quote run after the slash (Feitan F1)", () => {
    for (const body of ["acme/_Mark_", "acme/__Mark__", "acme/[Mark]", "acme/(Mark)", "acme/'Mark'", 'acme/"Mark"', "acme/{Mark}", "acme/`Mark`", "acme/**Mark**", "acme/~~Mark~~"]) {
      expect(forms(LIST, body), body).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    }
  });

  it("a bracket wrapper counts only when its closer is not followed by an extension or a slash (round 2 F8)", () => {
    for (const body of ["pages/[mark].tsx", "app/(mark)/page.tsx", "src/{mark}/index.ts", "see pages/[Mark].tsx and app/(Mark)/page.tsx"]) {
      const found = occurrences(LIST, body);
      expect(found.hits, body).toEqual([]);
      expect(found.ruled, body).toHaveLength(1);
    }
    for (const body of ["acme/[Mark]", "acme/(Mark)", "acme/{Mark}", "acme/`Mark`", "acme/[Mark](https://example.com)", "acme/(**Mark**)", "acme / [Mark]"]) {
      expect(forms(LIST, body), body).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    }
    // The remaining cost: a backticked path segment reads, markup stripped, as the plain dir/name.
    expect(forms(LIST, "x/`mark`.ts")).toEqual(["1:#2:repository-shaped:ordinary-word"]);
  });

  it("a [name]: link reference definition anywhere in the text makes [name] a wrapper whatever follows (round 3)", () => {
    const definition = "\n\n[mark]: https://example.com";
    for (const body of ["acme/[Mark]/issues/1", "acme/[Mark].git"]) {
      expect(forms(LIST, body + definition), body).toEqual(["1:#2:repository-shaped:ordinary-word"]);
      expect(forms(LIST, body + "\n\n[MARK]: <https://example.com>"), body).toEqual(["1:#2:repository-shaped:ordinary-word"]);
      const without = occurrences(LIST, body);
      expect(without.hits, body).toEqual([]);
      expect(without.ruled, body).toHaveLength(1);
    }
    // The cost: with the definition, a code path's brackets are a wrapper too.
    expect(forms(LIST, "pages/[mark].tsx" + definition)).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    // ( { and the backtick keep round 2's rule.
    expect(occurrences(LIST, "app/(mark)/page.tsx" + definition).hits).toEqual([]);
    expect(occurrences(LIST, "src/{mark}/index.ts" + definition).hits).toEqual([]);
  });

  it("a slug split across a line break is ONE hit, never also ruled on the second line (Nobunaga N7)", () => {
    expect(occurrences(LIST, "see acme/\nMark today")).toEqual({
      hits: [{ field: "body", line: 1, index: 2, normalised: false, ignored: false, ignoredBy: null, form: "repository-shaped", class: "ordinary-word" }],
      ruled: [],
    });
  });

  it("the rule line names every repository-shaped form (round 2 N8)", async () => {
    const { ORDINARY_WORD_RULE } = await import("./ordinary-words.js");
    for (const form of ["owner/name", "name#N", "name.git", "a URL", "its owner's slug spaced or split across lines"]) expect(ORDINARY_WORD_RULE).toContain(form);
  });

  it("reads a look-alike slash as a slash (Feitan F2)", () => {
    for (const slash of ["\u2215", "\u2044", "\u29F8", "\u2571", "\uFF0F"]) {
      expect(occurrences(LIST, `zheref${slash}Mark`).hits, slash).toMatchObject([{ index: 2, normalised: true, form: "repository-shaped" }]);
    }
  });

  it("matches the list's own owner with spaces around the slash, and across a line break (Feitan F3)", () => {
    expect(forms(LIST, "acme / Mark")).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    expect(forms(LIST, "acme/ Mark")).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    expect(forms(LIST, "acme /Mark")).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    expect(forms(LIST, "it moved to acme/\nMark last year")).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    expect(forms(LIST, "it moved to acme /\n  _Mark_ last year")).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    // A form complete on one line is reported there, once -- never also on the line above.
    expect(forms(LIST, "first line\nacme/Mark")).toEqual(["2:#2:repository-shaped:ordinary-word"]);
    // An owner the list does not carry, spaced, is prose: "this / Mark" passes, reported.
    const prose = occurrences(LIST, "read this / Mark the gate");
    expect(prose.hits).toEqual([]);
    expect(prose.ruled).toHaveLength(1);
  });

  it("matches name.git, and accepts the bare forms the ruling allows (Feitan F4)", () => {
    expect(forms(LIST, "clone Mark.git")).toEqual(["1:#2:repository-shaped:ordinary-word"]);
    for (const body of ["the Mark repo", "repo: Mark", "owner:Mark", "Mark/issues/3", "Mark #12", "gh repo clone Mark", "a sentence ends in Mark."]) {
      const found = occurrences(LIST, body);
      expect(found.hits, body).toEqual([]);
      expect(found.ruled, body).toHaveLength(1);
    }
  });

  it("an EXEMPT ordinary-word name used bare reports as an ignored hit, exactly as before the rule (Nobunaga N1)", () => {
    const viaIgnore = findPrivateNameOccurrences(compileMatcher(["acme/Mark"], parseIgnoreList("mark\n")), [{ field: "body", text: "Mark the gate" }]);
    expect(viaIgnore.hits).toEqual([{ field: "body", line: 1, index: 1, normalised: false, ignored: true, ignoredBy: "ignore-file", form: "bare", class: "ordinary-word" }]);
    expect(viaIgnore.ruled).toEqual([]);
    const viaNamed = findPrivateNameOccurrences(compileMatcher(["acme/Mark"], null, parseNamedList("acme/Mark\n")), [{ field: "body", text: "Mark the gate" }]);
    expect(viaNamed.hits).toMatchObject([{ ignored: true, ignoredBy: "named-list", form: "bare" }]);
    expect(viaNamed.ruled).toEqual([]);
    const lines = privateNameLines(
      { result: "clean", targetVisibility: "public", listSize: 1, owners: 1, hits: viaIgnore.hits, ruled: viaIgnore.ruled, error: null },
      TARGET,
    );
    expect(lines).toEqual(["nen issue: ignored: body:1: private repository #1 (ignore file)"]);
    // Not exempt: the same text is ruled, never a hit.
    const policed = findPrivateNameOccurrences(compileMatcher(["acme/Mark"]), [{ field: "body", text: "Mark the gate" }]);
    expect(policed.hits).toEqual([]);
    expect(policed.ruled).toEqual([{ field: "body", line: 1, index: 1, normalised: false, form: "bare", class: "ordinary-word" }]);
  });

  it("the ignore file and the named list still exempt an ordinary-word name's shaped hit, unchanged", () => {
    const ignored = findPrivateNames(compileMatcher(["acme/Mark"], parseIgnoreList("mark\n")), [{ field: "body", text: "acme/Mark" }]);
    expect(ignored).toEqual([{ field: "body", line: 1, index: 1, normalised: false, ignored: true, ignoredBy: "ignore-file", form: "repository-shaped", class: "ordinary-word" }]);
    const named = findPrivateNames(compileMatcher(["acme/Mark"], null, parseNamedList("acme/Mark\n")), [{ field: "body", text: "acme/Mark" }]);
    expect(named[0]?.ignoredBy).toBe("named-list");
  });

  it("the v0.28.0 notes read no blocking hit for an ordinary-word name, where the bare match refused them", async () => {
    const { readFileSync } = await import("node:fs");
    const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
    const start = changelog.indexOf("## v0.28.0");
    const end = changelog.indexOf("\n## v0.27.0", start);
    expect(start).toBeGreaterThan(-1);
    const notes = changelog.slice(start, end);
    const script = (): ScriptedSeams => new ScriptedSeams([visibility({ visibility: "public" }), FULL_REACH_ROW, page(1, ["acme/Mark"])]);
    const check = checkPrivateNames(script(), TARGET, [{ field: "notes", text: notes }], false);
    expect(check.result).toBe("clean");
    expect(check.hits).toEqual([]);
    expect(check.ruled.length).toBeGreaterThan(0);
  });
});
