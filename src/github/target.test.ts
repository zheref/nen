import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import { parseRemoteUrl, parseTarget, targetFromRemote, TargetError } from "./target.js";

describe("parseTarget -- --target owner/name, the GitHub side of the pair", () => {
  it("splits a valid slug", () => {
    expect(parseTarget("zheref/nen")).toEqual({ owner: "zheref", repo: "nen", slug: "zheref/nen" });
  });

  it("refuses a value that is not an owner/name slug", () => {
    expect(() => parseTarget("../checkout")).toThrow(TargetError);
    expect(() => parseTarget("../checkout")).toThrow(/--repo names a checkout on disk/);
  });
});

describe("parseRemoteUrl -- both spellings git writes", () => {
  it("parses an ssh remote", () => {
    expect(parseRemoteUrl("git@github.com:zheref/nen.git")).toEqual({
      owner: "zheref",
      repo: "nen",
      slug: "zheref/nen",
    });
  });

  it("parses an https remote, with or without .git", () => {
    expect(parseRemoteUrl("https://github.com/zheref/nen.git")).toEqual({
      owner: "zheref",
      repo: "nen",
      slug: "zheref/nen",
    });
    expect(parseRemoteUrl("https://github.com/zheref/nen")).toEqual({
      owner: "zheref",
      repo: "nen",
      slug: "zheref/nen",
    });
  });

  it("does not check the host -- an enterprise install is legitimate", () => {
    expect(parseRemoteUrl("git@git.example.com:owner/name.git")).toEqual({
      owner: "owner",
      repo: "name",
      slug: "owner/name",
    });
  });

  it("returns null for a URL that does not read as a repository", () => {
    expect(parseRemoteUrl("not a url at all")).toBeNull();
  });
});

describe("targetFromRemote", () => {
  it("resolves origin's URL into a Target", () => {
    const seams = new ScriptedSeams([
      { match: "git remote get-url origin", result: { stdout: "git@github.com:zheref/nen.git\n" } },
    ]);
    expect(targetFromRemote(seams, "/repo")).toEqual({
      owner: "zheref",
      repo: "nen",
      slug: "zheref/nen",
    });
  });

  it("refuses when there is no such remote", () => {
    const seams = new ScriptedSeams([
      { match: "git remote get-url origin", result: { code: 1, stderr: "error: No such remote" } },
    ]);
    expect(() => targetFromRemote(seams, "/repo")).toThrow(TargetError);
  });

  it("refuses when the remote does not read as GitHub", () => {
    const seams = new ScriptedSeams([
      { match: "git remote get-url origin", result: { stdout: "/local/bare/repo.git\n" } },
    ]);
    expect(() => targetFromRemote(seams, "/repo")).toThrow(/does not read as a GitHub repository/);
  });

  it("echoes an unparseable origin without its userinfo -- the token never reaches the message (SEC-5, zheref/nen#373)", () => {
    for (const url of ["https://ghp_FAKE0000@github.com/owner/name/extra", "https://user:ghp_FAKE0000@github.com/owner/name/extra"]) {
      const seams = new ScriptedSeams([{ match: "git remote get-url origin", result: { stdout: `${url}\n` } }]);
      let message = "";
      try {
        targetFromRemote(seams, "/repo");
      } catch (error) {
        expect(error).toBeInstanceOf(TargetError);
        message = (error as Error).message;
      }
      expect(message).toContain("'https://***@github.com/owner/name/extra'");
      expect(message).not.toMatch(/fake0000/i);
      expect(message).not.toContain("user:");
    }
  });

  it("takes a named remote, not just origin", () => {
    const seams = new ScriptedSeams([
      { match: "git remote get-url upstream", result: { stdout: "https://github.com/a/b\n" } },
    ]);
    expect(targetFromRemote(seams, "/repo", "upstream").slug).toBe("a/b");
  });
});
