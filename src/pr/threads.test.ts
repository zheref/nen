// src/pr/threads.test.ts -- `nen pr threads`: the walk, the two mutations, and
// the five exit codes that make this verb worth having.
//
// NO NETWORK. Every `gh` call is a ScriptedSeams entry, and the seam THROWS on
// a call nobody scripted -- so "the dry run writes nothing" is proved by the
// absence of a scripted mutation rather than asserted in a comment: a mutation
// leaking into a `--dry-run` path is an unscripted call and a red test.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { parseTarget } from "../github/target.js";
import { prCommand } from "./command.js";
import { listArgv, listPageArgv, looksLikeAuthFailure, printableArgv, replyArgv, resolveArgv } from "./threads.js";

const TARGET = parseTarget("zheref/nen");
const NOW = new Date("2026-09-20T12:00:00.000Z");

function node(id: string, isResolved: boolean, path = "src/report/data.ts", line: number | null = 212): unknown {
  return {
    id,
    isResolved,
    path,
    line,
    comments: {
      nodes: [
        {
          author: { login: "copilot-pull-request-reviewer" },
          body: `a finding about ${path}`,
          url: `https://github.com/zheref/nen/pull/217#discussion_${id}`,
        },
      ],
    },
  };
}

function pageBody(nodes: readonly unknown[], hasNextPage: unknown, endCursor: string | null = null): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: { headRefOid: "1f4bb2c0deadbeef", reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } } },
      },
    },
  });
}

function listCall(body: string): ScriptedCall {
  return { match: `gh ${listArgv(TARGET, 217).join(" ")}`, result: { code: 0, stdout: body } };
}

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly seams: ScriptedSeams;
}

async function capture(argv: readonly string[], calls: readonly ScriptedCall[]): Promise<Captured> {
  return captureIn(argv, calls, null);
}

/** The same, with a `--repo` root -- what `--body-file` resolves against. */
async function captureIn(
  argv: readonly string[],
  calls: readonly ScriptedCall[],
  repoFlag: string | null,
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  const seams = new ScriptedSeams(calls, { now: (): Date => NOW, platform: "linux" });
  const code = await runFamily(prCommand, argv, repoFlag, false, io, seams);
  return { code, out, err, seams };
}

function bodyFile(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "nen-threads-")), "reply.md");
  writeFileSync(path, text, "utf8");
  return path;
}

const BASE = ["pr", "threads", "list", "--target", "zheref/nen", "--pr", "217"];

describe("the argv builders", () => {
  it("name --method explicitly on every call, the way ./fetch.ts's rule requires", () => {
    for (const argv of [listArgv(TARGET, 217), listPageArgv(TARGET, 217, "c1"), replyArgv("T1", "hi"), resolveArgv("T1")]) {
      const at = argv.findIndex((arg): boolean => arg === "--method");
      expect(at).toBeGreaterThanOrEqual(0);
      expect(argv[at + 1]).toBe("POST");
    }
  });

  it("asks for the display fields the gate's own query deliberately does not", () => {
    const query = listArgv(TARGET, 217).join(" ");
    expect(query).toContain("path line comments(first:1){nodes{author{login} body url}}");
    expect(query).toContain("id isResolved");
    // And the LIST query is a pure read -- no mutation operation in it.
    expect(query).not.toContain("mutation");
  });

  it("spells the two mutations GitHub actually has", () => {
    expect(replyArgv("T1", "hi").join(" ")).toContain("addPullRequestReviewThreadReply");
    expect(resolveArgv("T1").join(" ")).toContain("resolveReviewThread");
  });
});

describe("looksLikeAuthFailure", () => {
  it("claims a credential problem only on the phrases gh actually prints", () => {
    expect(looksLikeAuthFailure("gh auth login to authenticate")).toBe(true);
    expect(looksLikeAuthFailure("HTTP 401: Bad credentials")).toBe(true);
    // An outage is exit 1, not exit 5: over-claiming "auth" sends a caller to
    // re-login over something a retry would have fixed.
    expect(looksLikeAuthFailure("HTTP 502: Bad gateway")).toBe(false);
  });
});

describe("nen pr threads list", () => {
  it("walks to completion across pages and reports every thread", async () => {
    const captured = await capture([...BASE, "--json"], [
      listCall(pageBody([node("T1", true)], true, "cursor-1")),
      {
        match: `gh ${listPageArgv(TARGET, 217, "cursor-1").join(" ")}`,
        result: { code: 0, stdout: pageBody([node("T2", false, "src/pr/threads.ts", null)], false) },
      },
    ]);
    expect(captured.code).toBe(0);
    const document = JSON.parse(captured.out.join("\n")) as {
      contract: string;
      head: string;
      thread: null;
      threads: { id: string; line: number | null; author: string; firstComment: string }[];
    };
    expect(document.contract).toBe("nen.pr.threads/v0.1");
    expect(document.head).toBe("1f4bb2c0deadbeef");
    expect(document.thread).toBeNull();
    expect(document.threads.map((thread): string => thread.id)).toEqual(["T1", "T2"]);
    expect(document.threads[1]?.line).toBeNull();
    expect(document.threads[1]?.author).toBe("copilot-pull-request-reviewer");
  });

  it("FAILS CLOSED on a page that neither ends the walk nor carries a cursor", async () => {
    const captured = await capture(BASE, [listCall(pageBody([node("T1", true)], "yes", null))]);
    expect(captured.code).toBe(1);
    expect(captured.err.join("\n")).toMatch(/did not answer hasNextPage:false but carried no usable cursor/);
  });

  it("never reads an unreadable isResolved as resolved", async () => {
    const captured = await capture([...BASE, "--json"], [
      listCall(pageBody([{ id: "T1", path: "a.ts", line: 1, comments: { nodes: [] } }], false)),
    ]);
    expect(captured.code).toBe(0);
    const threads = (JSON.parse(captured.out.join("\n")) as { threads: { isResolved: boolean }[] }).threads;
    expect(threads[0]?.isResolved).toBe(false);
  });

  it("cuts the first comment at 200 characters", async () => {
    const long = "x".repeat(500);
    const captured = await capture([...BASE, "--json"], [
      listCall(pageBody([{ id: "T1", isResolved: false, path: "a.ts", line: 1, comments: { nodes: [{ author: { login: "a" }, body: long, url: "u" }] } }], false)),
    ]);
    const threads = (JSON.parse(captured.out.join("\n")) as { threads: { firstComment: string }[] }).threads;
    expect(threads[0]?.firstComment).toHaveLength(201);
    expect(threads[0]?.firstComment.endsWith("…")).toBe(true);
  });

  it("prints a resolution mark, the id and the anchor in the human rendering", async () => {
    const captured = await capture(BASE, [listCall(pageBody([node("T1", true), node("T2", false)], false))]);
    expect(captured.code).toBe(0);
    expect(captured.out[0]).toBe("zheref/nen#217 @ 1f4bb2c0: 2 review thread(s), 1 unresolved");
    expect(captured.out.join("\n")).toContain("UNRESOLVED  T2  src/report/data.ts:212  @copilot-pull-request-reviewer");
  });

  it("reports a GraphQL 200 carrying `errors` as a failure, not as an empty list", async () => {
    const captured = await capture(BASE, [
      { match: `gh ${listArgv(TARGET, 217).join(" ")}`, result: { code: 0, stdout: JSON.stringify({ errors: [{ message: "Something went wrong" }] }) } },
    ]);
    expect(captured.code).toBe(1);
    expect(captured.err.join("\n")).toMatch(/Something went wrong/);
  });

  it("exits 5 when the credential could not authenticate", async () => {
    const captured = await capture(BASE, [
      { match: `gh ${listArgv(TARGET, 217).join(" ")}`, result: { code: 1, stderr: "gh: To get started with GitHub CLI, please run: gh auth login\n" } },
    ]);
    expect(captured.code).toBe(5);
  });

  it("exits 4 when the pull request itself is not visible", async () => {
    const captured = await capture(BASE, [
      { match: `gh ${listArgv(TARGET, 217).join(" ")}`, result: { code: 0, stdout: JSON.stringify({ data: { repository: null } }) } },
    ]);
    expect(captured.code).toBe(4);
  });
});

describe("nen pr threads reply", () => {
  const args = (extra: readonly string[]): readonly string[] => [
    "pr",
    "threads",
    "reply",
    "--target",
    "zheref/nen",
    "--pr",
    "217",
    "--thread",
    "T2",
    ...extra,
  ];

  it("posts the reply and reports it", async () => {
    const file = bodyFile("Fixed in 2a6539c.");
    const captured = await capture(args(["--body-file", file, "--json"]), [
      listCall(pageBody([node("T2", false)], false)),
      { match: `gh ${replyArgv("T2", "Fixed in 2a6539c.").join(" ")}`, result: { code: 0, stdout: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: "C1", url: "u" } } } }) } },
    ]);
    expect(captured.code).toBe(0);
    const document = JSON.parse(captured.out.join("\n")) as { replied: boolean; resolved: boolean; thread: string; dryRun: boolean };
    expect(document).toMatchObject({ replied: true, resolved: false, thread: "T2", dryRun: false });
  });

  it("--dry-run prints the exact argv and sends NOTHING (no mutation is scripted)", async () => {
    const file = bodyFile("Fixed in 2a6539c.");
    const captured = await capture(args(["--body-file", file, "--dry-run"]), [
      listCall(pageBody([node("T2", false)], false)),
    ]);
    expect(captured.code).toBe(0);
    expect(captured.out.join("\n")).toContain("would run: gh api --method POST graphql");
    expect(captured.out.join("\n")).toContain("nothing written (dry run)");
    // One call only -- the listing. A mutation would have thrown, unscripted.
    expect(captured.seams.calls).toHaveLength(1);
  });

  it("exits 4 on a thread this pull request has not got, NAMING it and the count", async () => {
    const captured = await capture(
      ["pr", "threads", "reply", "--target", "zheref/nen", "--pr", "217", "--thread", "NOPE", "--body-file", bodyFile("hi")],
      [listCall(pageBody([node("T2", false)], false))],
    );
    expect(captured.code).toBe(4);
    expect(captured.err.join("\n")).toMatch(/carries no review thread with id 'NOPE'/);
    expect(captured.err.join("\n")).toMatch(/has 1 thread\(s\)/);
  });

  it("refuses a missing or empty --body-file at exit 2, before any call", async () => {
    const missing = await capture(args([]), []);
    expect(missing.code).toBe(2);
    expect(missing.err.join("\n")).toMatch(/takes --body-file <path>/);
    const empty = await capture(args(["--body-file", bodyFile("   \n")]), []);
    expect(empty.code).toBe(2);
    expect(empty.err.join("\n")).toMatch(/is empty \(or holds only whitespace\)/);
  });

  it("refuses a missing --thread at exit 2", async () => {
    const captured = await capture(
      ["pr", "threads", "reply", "--target", "zheref/nen", "--pr", "217", "--body-file", bodyFile("hi")],
      [],
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/takes --thread <id>/);
  });
});

describe("nen pr threads resolve", () => {
  const args = (extra: readonly string[] = []): readonly string[] => [
    "pr",
    "threads",
    "resolve",
    "--target",
    "zheref/nen",
    "--pr",
    "217",
    "--thread",
    "T2",
    ...extra,
  ];

  it("resolves an unresolved thread", async () => {
    const captured = await capture(args(["--json"]), [
      listCall(pageBody([node("T2", false)], false)),
      { match: `gh ${resolveArgv("T2").join(" ")}`, result: { code: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: "T2", isResolved: true } } } }) } },
    ]);
    expect(captured.code).toBe(0);
    expect(JSON.parse(captured.out.join("\n"))).toMatchObject({ resolved: true, replied: false });
  });

  it("exits 3 on an ALREADY-RESOLVED thread, named, with nothing sent", async () => {
    const captured = await capture(args(), [listCall(pageBody([node("T2", true)], false))]);
    expect(captured.code).toBe(3);
    expect(captured.err.join("\n")).toMatch(/is already resolved; nothing was sent/);
    expect(captured.seams.calls).toHaveLength(1);
  });

  it("--dry-run still fires exit 3, because a dry run whose refusals differ proves nothing", async () => {
    const captured = await capture(args(["--dry-run"]), [listCall(pageBody([node("T2", true)], false))]);
    expect(captured.code).toBe(3);
  });
});

describe("the ACTION's own flag guards (Copilot #221)", () => {
  // The family guard admits --thread/--body-file/--dry-run because they belong
  // to 'threads'; each ACTION then has to refuse the ones it does not read, or
  // a caller gets a successful listing while an instruction they typed had no
  // effect.
  const cases: ReadonlyArray<readonly [string, readonly string[], string]> = [
    ["list", ["--thread", "T1"], "--thread"],
    ["list", ["--body-file", "x.md"], "--body-file"],
    ["list", ["--dry-run"], "--dry-run"],
    ["resolve", ["--thread", "T1", "--body-file", "x.md"], "--body-file"],
  ];

  for (const [action, extra, flag] of cases) {
    it(`refuses ${flag} on 'threads ${action}', rather than ignoring it`, async () => {
      const captured = await capture(
        ["pr", "threads", action, "--target", "zheref/nen", "--pr", "217", ...extra],
        [],
      );
      expect(captured.code).toBe(2);
      expect(captured.err.join("\n")).toMatch(
        new RegExp(`\\${flag} is not read by 'pr threads ${action}'`),
      );
      // Refused BEFORE any call: nothing is scripted, and an unscripted call
      // would have thrown.
      expect(captured.seams.calls).toEqual([]);
    });
  }

  it("still accepts every flag the action DOES read", async () => {
    const file = bodyFile("hi");
    const reply = await capture(
      ["pr", "threads", "reply", "--target", "zheref/nen", "--pr", "217", "--thread", "T2", "--body-file", file, "--dry-run"],
      [listCall(pageBody([node("T2", false)], false))],
    );
    expect(reply.code, reply.err.join("\n")).toBe(0);
    const resolve = await capture(
      ["pr", "threads", "resolve", "--target", "zheref/nen", "--pr", "217", "--thread", "T2", "--dry-run"],
      [listCall(pageBody([node("T2", false)], false))],
    );
    expect(resolve.code, resolve.err.join("\n")).toBe(0);
  });
});

describe("--pr is read strictly on every threads action (Copilot #221 round 2)", () => {
  // `requirePr`'s `Number(raw)` reads `1e3` as 1000 and `0x0c` as 12. On a
  // verb that WRITES -- a reply is a public comment under the caller's
  // identity -- a typo addressing a different pull request is not survivable,
  // so all three actions take the digits-only reader `edit-body` already had.
  for (const action of ["list", "reply", "resolve"]) {
    it(`refuses a coercible --pr on 'threads ${action}', naming the verb and the value`, async () => {
      for (const raw of ["1e3", "0x0c", "217.0", " 217", "+217", "217abc", "0"]) {
        const captured = await capture(
          ["pr", "threads", action, "--target", "zheref/nen", "--pr", raw],
          [],
        );
        expect(captured.code, `--pr '${raw}' was accepted by ${action}`).toBe(2);
        expect(captured.err.join("\n")).toMatch(
          new RegExp(`threads ${action} takes --pr <n>: a positive whole number, digits only -- got '${raw.replace(/[+\-.]/g, "\\$&")}'`),
        );
        // Refused before any call: nothing is scripted, and an unscripted
        // call would have thrown.
        expect(captured.seams.calls).toEqual([]);
      }
    });
  }

  it("leaves a flag-shaped value to the argv parser, which refuses it first at the same exit", async () => {
    // `--pr -217` never reaches this reader: ../cli/args.ts refuses a value
    // that looks like a flag. Same exit 2, a different (and better) sentence.
    const captured = await capture(["pr", "threads", "list", "--target", "zheref/nen", "--pr", "-217"], []);
    expect(captured.code).toBe(2);
  });

  it("still accepts an ordinary number, and still names the flag when it is absent", async () => {
    const ok = await capture(BASE, [listCall(pageBody([node("T1", true)], false))]);
    expect(ok.code, ok.err.join("\n")).toBe(0);
    const absent = await capture(["pr", "threads", "list", "--target", "zheref/nen"], []);
    expect(absent.code).toBe(2);
    expect(absent.err.join("\n")).toMatch(/threads list takes --pr <n>\./);
  });

  it("leaves `edit-body`'s own refusal naming edit-body, not another verb", async () => {
    const captured = await capture(
      ["pr", "edit-body", "--target", "zheref/nen", "--pr", "1e3", "--body-file", bodyFile("x")],
      [],
    );
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/edit-body takes --pr <n>/);
  });
});

describe("the family's flag guards", () => {
  it("refuses --thread on a subcommand that does not read it", async () => {
    const captured = await capture(["pr", "fetch", "--target", "zheref/nen", "--pr", "217", "--thread", "T1"], []);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/--thread is only read by 'pr threads'/);
  });

  it("refuses a threads action it has not got, naming the three it has", async () => {
    const captured = await capture(["pr", "threads", "close", "--target", "zheref/nen", "--pr", "217"], []);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/needs an action: list, reply, resolve/);
  });
});

// ── the hardening round (Nobunaga N4/N9, Feitan F4/F6/F7) ──────────────────

describe("the GraphQL variable flags (Feitan F6)", () => {
  it("sends the String! variables with -f and only the Int! with -F", () => {
    // `-F` is gh's TYPED form: it coerces a digits-only value to a number and
    // reads a leading `@` as a FILE to slurp. `owner`, `name` and `cursor`
    // are `String!`, and a cursor is an opaque token nen never inspects.
    for (const argv of [listArgv(TARGET, 217), listPageArgv(TARGET, 217, "@cursor")]) {
      for (const variable of ["owner=", "name=", "cursor="]) {
        const at = argv.findIndex((arg): boolean => arg.startsWith(variable));
        if (at === -1) continue;
        expect(argv[at - 1], `${variable} must be sent with -f, not gh's typed -F`).toBe("-f");
      }
      const numberAt = argv.findIndex((arg): boolean => arg.startsWith("number="));
      expect(argv[numberAt - 1], "number= is the one genuine Int! and keeps -F").toBe("-F");
    }
  });

  it("sends a reply body and a thread id with -f, so an @ or digits cannot be re-read", () => {
    const argv = replyArgv("1234567", "@not-a-file");
    for (const field of ["threadId=", "body="]) {
      const at = argv.findIndex((arg): boolean => arg.startsWith(field));
      expect(argv[at - 1]).toBe("-f");
    }
  });
});

describe("printableArgv (Nobunaga N4)", () => {
  it("summarises the body instead of printing it, and keeps the line one line", () => {
    const body = "Fixed in 2a6539c.\nSee $(whoami) and `id` for the rest.\nthird line";
    const printed = printableArgv([...replyArgv("T1", body)]);
    expect(printed.split("\n")).toHaveLength(1);
    // The body's own bytes never reach the line a reader is invited to copy.
    expect(printed).not.toContain("$(whoami)");
    expect(printed).not.toContain("third line");
    expect(printed).toContain("body=<");
    expect(printed).toContain("byte(s); first line: Fixed in 2a6539c.");
  });

  it("quotes every other element the way this repository's `would run:` lines do", () => {
    const printed = printableArgv([...replyArgv("T1", "hi")]);
    // The mutation carries spaces, so it is quoted as ONE element: a reader
    // who re-splits the printed line on spaces gets the same command back.
    expect(printed).toMatch(/^gh api --method POST graphql -f 'query=mutation/);
  });

  it("strips a control character out of the first line it shows", () => {
    const printed = printableArgv([...replyArgv("T1", `${String.fromCharCode(27)}[2Kerased`)]);
    expect(printed).not.toContain(String.fromCharCode(27));
    expect(printed).toContain("erased");
  });
});

describe("the --json argv (Nobunaga N9)", () => {
  it("carries the full, unsummarised argv on a dry run, and null for list", async () => {
    const file = bodyFile("Fixed in 2a6539c.");
    const dry = await capture(
      ["pr", "threads", "reply", "--target", "zheref/nen", "--pr", "217", "--thread", "T2", "--body-file", file, "--dry-run", "--json"],
      [listCall(pageBody([node("T2", false)], false))],
    );
    expect(dry.code).toBe(0);
    const document = JSON.parse(dry.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(document)).toEqual([
      "contract",
      "target",
      "pr",
      "head",
      "thread",
      "replied",
      "resolved",
      "dryRun",
      "threads",
      "argv",
    ]);
    // The full argv, body and all -- the summary is for the human line only.
    expect(document["argv"]).toEqual([...replyArgv("T2", "Fixed in 2a6539c.")]);

    const listed = await capture([...BASE, "--json"], [listCall(pageBody([node("T1", true)], false))]);
    expect((JSON.parse(listed.out.join("\n")) as Record<string, unknown>)["argv"]).toBeNull();
  });
});

describe("--body-file resolves against --repo (Feitan F7)", () => {
  it("reads the file from the repository named, not from the process cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-threads-repo-"));
    writeFileSync(join(root, "reply.md"), "from the repo root", "utf8");
    const captured = await captureIn(
      ["pr", "threads", "reply", "--target", "zheref/nen", "--pr", "217", "--thread", "T2", "--body-file", "reply.md", "--dry-run", "--json"],
      [listCall(pageBody([node("T2", false)], false))],
      root,
    );
    expect(captured.code, captured.err.join("\n")).toBe(0);
    expect((JSON.parse(captured.out.join("\n")) as { argv: string[] }).argv).toContain("body=from the repo root");
  });
});

describe("the human rendering strips control characters (Feitan F4)", () => {
  it("never lets a path, an author or a comment move the cursor", async () => {
    const hostile = `${String.fromCharCode(27)}[2Kerased`;
    const captured = await capture(BASE, [
      listCall(
        pageBody(
          [
            {
              id: "T1",
              isResolved: false,
              path: `src/${hostile}.ts`,
              line: 1,
              comments: { nodes: [{ author: { login: hostile }, body: `a finding ${hostile}`, url: "u" }] },
            },
          ],
          false,
        ),
      ),
    ]);
    expect(captured.code).toBe(0);
    const text = captured.out.join("\n");
    expect(text).not.toContain(String.fromCharCode(27));
    expect(text).toContain("erased");
  });

  it("keeps the real bytes under --json, for the consumer that needs the field", async () => {
    const hostile = `${String.fromCharCode(27)}[2Kerased`;
    const captured = await capture([...BASE, "--json"], [
      listCall(
        pageBody(
          [{ id: "T1", isResolved: false, path: hostile, line: 1, comments: { nodes: [{ author: { login: "a" }, body: "b", url: "u" }] } }],
          false,
        ),
      ),
    ]);
    const threads = (JSON.parse(captured.out.join("\n")) as { threads: { path: string }[] }).threads;
    expect(threads[0]?.path).toBe(hostile);
  });
});
