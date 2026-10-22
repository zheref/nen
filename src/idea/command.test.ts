import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { ideaCommand } from "./command.js";
import { FULL_REACH_ROW, SCOPES_CALL } from "../issue/privacy.testkit.js";

/**
 * THE DEFAULT PRIVATE-NAME GUARD ANSWER (zheref/nen#363), for every test that
 * is not about the guard: the target's visibility read answers "private", so
 * the guard skips and reads no list. The guard's own describe block passes
 * `guard: "scripted"` and scripts every read itself.
 */
function privateTargetRow(argv: readonly string[]): ScriptedCall | null {
  const at = argv.indexOf("--target");
  const slug = at >= 0 ? argv[at + 1] : undefined;
  if (slug === undefined) return null;
  return { match: `gh api repos/${slug}`, result: { stdout: JSON.stringify({ visibility: "private" }) } };
}

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  // `null` is a real case: the invocation that never typed --repo (zheref/nen#28).
  repoFlag: string | null = BANKAI_REPO,
  guard: "private-target" | "scripted" = "private-target",
): Promise<{ code: number; out: string[]; err: string[]; calls: readonly string[] }> {
  const guardRow = guard === "scripted" ? null : privateTargetRow(argv);
  if (guardRow !== null) script = [guardRow, ...script];
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
  const scripted = new ScriptedSeams(script);
  const seams: Seams = scripted;
  const code = await runFamily(ideaCommand, argv, repoFlag, false, io, seams);
  return {
    code,
    out,
    err,
    calls: scripted.calls
      .map((call): string => [call.command, ...call.args].join(" "))
      .filter((line): boolean => guardRow === null || line !== guardRow.match),
  };
}

describe("nen idea file -- CLI wiring", () => {
  it("requires --target", async () => {
    const result = await capture(["idea", "file"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--target/);
  });

  it("requires --body-file", async () => {
    expect((await capture(["idea", "file", "--target", "o/n"])).code).toBe(2);
  });

  // zheref/nen#28: the usage line lists --repo unbracketed, so omitting it is
  // refused by name, before any file is read.
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["idea", "file", "--target", "o/n"], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("exits 0 and reports OK on a clean read-back round trip", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-idea-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "the body");
    const result = await capture(
      [
        "idea",
        "file",
        "--target",
        "zheref/nen",
        "--title",
        "t",
        "--body-file",
        bodyFile,
        "--label",
        "bankai:severity/high",
        "--assignee",
        "me",
      ],
      [
        {
          match: `gh issue create --repo zheref/nen --title t --body-file - --assignee me --label bankai:severity/high`,
          result: { stdout: "https://github.com/zheref/nen/issues/5\n" },
        },
        {
          match: "gh api repos/zheref/nen/issues/5",
          result: { stdout: JSON.stringify({ title: "t", body: "the body", labels: [{ name: "bankai:severity/high" }] }) },
        },
      ],
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/read-back OK/);
  });

  // zheref/nen#77: the read-back now says WHICH CLASS of object answered. A
  // pull request here means the verification fetch reached a different object
  // than the one just filed, so the verdict is refused rather than rendered.
  it("exits 1 and names the issue when the read-back answers with a pull request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-idea-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "the body");
    const result = await capture(
      [
        "idea",
        "file",
        "--target",
        "zheref/nen",
        "--title",
        "t",
        "--body-file",
        bodyFile,
        "--label",
        "bankai:severity/high",
        "--assignee",
        "me",
      ],
      [
        {
          match: `gh issue create --repo zheref/nen --title t --body-file - --assignee me --label bankai:severity/high`,
          result: { stdout: "https://github.com/zheref/nen/issues/5\n" },
        },
        {
          match: "gh api repos/zheref/nen/issues/5",
          result: {
            stdout: JSON.stringify({
              number: 5,
              title: "t",
              body: "the body",
              labels: [{ name: "bankai:severity/high" }],
              pull_request: { url: "https://api.github.com/repos/zheref/nen/pulls/5" },
            }),
          },
        },
      ],
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/idea filed as #5, but the read-back answered with a PULL REQUEST/);
    // NEVER the confident verdict: every compared field matched above, so a
    // verb without the class check would have printed exactly this line.
    expect(result.out.join("\n")).not.toMatch(/read-back OK/);
  });

  // THE --json SHAPE OF THIS FAILURE, PINNED. It is deliberately NOT the
  // `refused: true` object the 'issue' family's object-class refusals emit:
  // "refused" means "I declined to act on your input", and here the verb has
  // already acted -- the issue is filed. This is a read-back that could not
  // confirm what it read, which is the failure `idea file` has always
  // surfaced as an error line and exit 1, with no result object because there
  // is no verdict to report. The test exists so that contract is a decision on
  // the record rather than an accident of where the throw lands.
  it("--json emits no verdict object for that failure -- exit 1 and the refusal envelope on stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-idea-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "the body");
    const result = await capture(
      [
        "idea",
        "file",
        "--target",
        "zheref/nen",
        "--title",
        "t",
        "--body-file",
        bodyFile,
        "--label",
        "bankai:severity/high",
        "--assignee",
        "me",
        "--json",
      ],
      [
        {
          match: `gh issue create --repo zheref/nen --title t --body-file - --assignee me --label bankai:severity/high`,
          result: { stdout: "https://github.com/zheref/nen/issues/5\n" },
        },
        {
          match: "gh api repos/zheref/nen/issues/5",
          result: {
            stdout: JSON.stringify({
              number: 5,
              title: "t",
              body: "the body",
              labels: [{ name: "bankai:severity/high" }],
              pull_request: { url: "https://api.github.com/repos/zheref/nen/pulls/5" },
            }),
          },
        },
      ],
    );
    // Since Hatsu SDD plan N5 the failure is the nen.refusal/v0.1 envelope on
    // stdout under --json -- still no verdict object: no readBack, no
    // mismatches, nothing a caller could read as a match.
    expect(result.code).toBe(1);
    expect(result.err).toEqual([]);
    const envelope = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(envelope).toMatchObject({ contract: "nen.refusal/v0.1", ok: false, verb: "idea file", code: 1 });
    expect(envelope).not.toHaveProperty("readBack");
    expect(envelope).not.toHaveProperty("mismatches");
    expect(String((envelope["refused"] as string[])[0])).toMatch(/PULL REQUEST, not an issue/);
  });

  it("idea --help documents the read-back's object-class check", async () => {
    const result = await capture(["idea", "--help"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/The read-back also checks WHICH CLASS OF OBJECT answered/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["idea", "bogus"])).code).toBe(2);
  });
});

// zheref/nen#94. `--forbid-family` was declared in the flag spec and forwarded
// into `fileIdea`'s FileRequest exactly as `issue file`'s is -- so it worked,
// and nothing outside the source tree said it existed.
describe("nen idea --help -- every flag the spec accepts is documented", () => {
  it("documents --forbid-family, with what it does", () => {
    expect(ideaCommand.usage).toContain("--forbid-family ns:family");
    expect(ideaCommand.usage).toContain("declares off-limits");
  });

  it("documents every value flag the spec accepts", () => {
    // The rule rather than the one instance: a flag the parser takes and the
    // help never names is a flag only the source tells a caller about, which is
    // how this one went unmentioned in the first place.
    for (const flag of ideaCommand.flags.values ?? []) {
      expect(ideaCommand.usage, `--${flag}`).toContain(`--${flag}`);
    }
  });
});

// zheref/nen#93's rule, applied to this family's fifth copy of the same check.
describe("nen idea file -- --target refuses the way every other family does", () => {
  it("refuses a MALFORMED --target at exit 2, not 1", async () => {
    const result = await capture([
      "idea", "file", "--target", "not-a-slug", "--title", "t",
      "--body-file", "x", "--label", "a", "--assignee", "u",
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/owner\/name/);
  });

  it("refuses a MISSING --target at exit 2, naming the flag", async () => {
    const result = await capture([
      "idea", "file", "--title", "t", "--body-file", "x", "--label", "a", "--assignee", "u",
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--target owner\/name is required/);
  });
});

describe("nen idea file -- the private-name guard (zheref/nen#363)", () => {
  const PUBLIC: ScriptedCall = { match: "gh api repos/zheref/nen", result: { stdout: JSON.stringify({ visibility: "public" }) } };
  const PRIVATE: ScriptedCall = { match: "gh api repos/zheref/nen", result: { stdout: JSON.stringify({ visibility: "private" }) } };
  const LIST_PAGE = "gh api user/repos?visibility=private&per_page=100&page=1";
  const LIST: ScriptedCall = {
    match: LIST_PAGE,
    result: { stdout: JSON.stringify([{ full_name: "acme/hidden-thing" }, { full_name: "acme/vault" }]) },
  };
  const CREATE = "gh issue create --repo zheref/nen --title t --body-file - --assignee me --label bankai:severity/high";
  const filing = (body: string, ...extra: string[]): string[] => {
    const dir = mkdtempSync(join(tmpdir(), "nen-idea-guard-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, body);
    return [
      "idea", "file", "--target", "zheref/nen", "--title", "t", "--body-file", bodyFile,
      "--label", "bankai:severity/high", "--assignee", "me", ...extra,
    ];
  };
  const created: ScriptedCall[] = [
    { match: CREATE, result: { stdout: "https://github.com/zheref/nen/issues/5\n" } },
    {
      match: "gh api repos/zheref/nen/issues/5",
      result: { stdout: JSON.stringify({ title: "t", body: "nothing private", labels: [{ name: "bankai:severity/high" }] }) },
    },
  ];

  it("a private name in the body on a PUBLIC target refuses with exit 4 before any write, and never prints the name", async () => {
    const result = await capture(filing("ported from the vault"), [PUBLIC, FULL_REACH_ROW, LIST], BANKAI_REPO, "scripted");
    expect(result.code).toBe(4);
    expect(result.calls).toEqual(["gh api repos/zheref/nen", SCOPES_CALL, LIST_PAGE]);
    const all = [...result.out, ...result.err].join("\n");
    expect(all).toContain("nen idea file: body:1: private repository #2");
    expect(all).not.toMatch(/vault/i);
  });

  it("a private name in the TITLE refuses too", async () => {
    const argv = filing("nothing private");
    argv[argv.indexOf("--title") + 1] = "about Hidden-Thing";
    const result = await capture(argv, [PUBLIC, FULL_REACH_ROW, LIST], BANKAI_REPO, "scripted");
    expect(result.code).toBe(4);
    expect(result.err.join("\n")).toContain("title:1: private repository #1");
    expect(result.calls.some((line): boolean => line.startsWith("gh issue create"))).toBe(false);
  });

  it("--json: the refusal is { filed: false, privateNameCheck }", async () => {
    const result = await capture(filing("the vault", "--json"), [PUBLIC, FULL_REACH_ROW, LIST], BANKAI_REPO, "scripted");
    expect(result.code).toBe(4);
    const report = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(report["filed"]).toBe(false);
    expect((report["privateNameCheck"] as { result: string }).result).toBe("refused");
    expect(result.out.join("\n")).not.toMatch(/vault/i);
  });

  it("a PRIVATE target is not checked -- the list is never read, and the idea is filed", async () => {
    const result = await capture(filing("nothing private"), [PRIVATE, ...created], BANKAI_REPO, "scripted");
    expect(result.code).toBe(0);
    expect(result.calls).not.toContain(LIST_PAGE);
    expect(result.calls).toContain(CREATE);
  });

  it("an unreadable private list fails closed (exit 1) and files nothing", async () => {
    const result = await capture(
      filing("nothing private"),
      [PUBLIC, FULL_REACH_ROW, { match: LIST_PAGE, result: { code: 1, stderr: "HTTP 401" } }],
      BANKAI_REPO,
      "scripted",
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/nen idea file: private-name check could not run/);
    expect(result.calls.some((line): boolean => line.startsWith("gh issue create"))).toBe(false);
  });

  it("a clean filing on a PUBLIC target files, and --json carries the clean verdict", async () => {
    const result = await capture(filing("nothing private", "--json"), [PUBLIC, FULL_REACH_ROW, LIST, ...created], BANKAI_REPO, "scripted");
    expect(result.code).toBe(0);
    expect((JSON.parse(result.out.join("\n")) as { privateNameCheck: { result: string } }).privateNameCheck.result).toBe("clean");
  });

  it("--skip-private-name-check reads nothing, files, and is named on stderr", async () => {
    const result = await capture(filing("nothing private", "--skip-private-name-check"), created, BANKAI_REPO, "scripted");
    expect(result.code).toBe(0);
    expect(result.calls).not.toContain("gh api repos/zheref/nen");
    expect(result.err.join("\n")).toMatch(/SKIPPED by --skip-private-name-check/);
  });

  it("a missing --private-names-ignore-file is exit 2 before any gh call", async () => {
    const result = await capture(filing("x", "--private-names-ignore-file", "no-such-ignore-file"), [], BANKAI_REPO, "scripted");
    expect(result.code).toBe(2);
    expect(result.calls).toEqual([]);
  });
});
