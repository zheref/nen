import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { wakeCommand } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding).
//
// `guard`: by default the private-name guard's visibility read
// (zheref/nen#363) -- `gh api repos/<--repo-slug>` exactly -- answers
// "private" before `run` sees it, so a test about something else neither
// scripts nor counts it. The guard's own tests pass "scripted".
async function capture(
  argv: readonly string[],
  given: Seams["run"],
  guard: "private-target" | "scripted" = "private-target",
): Promise<{ code: number; out: string[]; err: string[] }> {
  const at = argv.indexOf("--repo-slug");
  const slug = at >= 0 ? argv[at + 1] : undefined;
  const run: Seams["run"] =
    guard === "scripted" || slug === undefined
      ? given
      : (command, args, options): CommandResult =>
          command === "gh" && args.length === 2 && args[0] === "api" && args[1] === `repos/${slug}`
            ? ok(JSON.stringify({ visibility: "private" }))
            : given(command, args, options);
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
  const code = await runFamily(wakeCommand, argv, null, false, io, seams);
  return { code, out, err };
}

function ok(stdout: string): CommandResult {
  return { code: 0, stdout, stderr: "", spawnFailed: false };
}

describe("nen wake fire", () => {
  it("is a dry run by default and mutates nothing", async () => {
    let calls = 0;
    const result = await capture(
      ["wake", "fire", "--repo-slug", "o/r", "--ref", "XX-PR-#12", "--label", "wake"],
      (): CommandResult => {
        calls += 1;
        return ok("");
      },
    );
    expect(result.code).toBe(0);
    expect(calls).toBe(0);
    expect(result.out.join("\n")).toMatch(/dry run/);
  });

  it("removes then re-applies the label when --run is given", async () => {
    const seen: string[][] = [];
    await capture(["wake", "fire", "--repo-slug", "o/r", "--ref", "XX-PR-#12", "--label", "wake", "--run"], (command, args): CommandResult => {
      seen.push([command, ...args]);
      return ok("");
    });
    expect(seen).toEqual([
      ["gh", "issue", "edit", "12", "--repo", "o/r", "--remove-label", "wake"],
      ["gh", "issue", "edit", "12", "--repo", "o/r", "--add-label", "wake"],
    ]);
  });

  it("refuses a ref carrying no #<N>", async () => {
    const result = await capture(["wake", "fire", "--repo-slug", "o/r", "--ref", "not-a-ref", "--label", "wake"], (): CommandResult => ok(""));
    expect(result.code).toBe(2);
  });
});

describe("nen wake verify", () => {
  const openPr = JSON.stringify([
    {
      number: 7,
      draft: false,
      user: { login: "kisuke-bankai[bot]" },
      head: { ref: "feature/x", repo: { id: 1 } },
      base: { repo: { id: 1 } },
    },
  ]);
  const runsWithSwallow = JSON.stringify({
    workflow_runs: [
      {
        id: 100,
        conclusion: "action_required",
        html_url: "https://example.invalid/100",
        event: "pull_request",
        created_at: "2025-12-31T00:00:00Z",
        workflow_id: 5,
        status: "completed",
      },
    ],
  });

  it("is a dry run by default and mutates nothing (review finding: was write-by-default)", async () => {
    const mutations: string[][] = [];
    const result = await capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "bankai\\[bot\\]$"],
      (command, args): CommandResult => {
        const joined = args.join(" ");
        if (joined.includes("/pulls?")) return ok(openPr);
        if (joined.includes("/actions/runs")) return ok(runsWithSwallow);
        if (joined.includes("/comments")) return ok("[]");
        if (command === "gh" && (args[0] === "run" || joined.includes("/comments"))) mutations.push([command, ...args]);
        return ok("");
      },
    );
    expect(result.code).toBe(0);
    expect(mutations).toEqual([]);
    expect(result.out.join("\n")).toMatch(/redrive/);
  });

  it("redrives a swallowed run and posts the FULL, conclusion-selected body when --run is given", async () => {
    const calls: string[][] = [];
    const result = await capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "bankai\\[bot\\]$", "--run"],
      (command, args): CommandResult => {
        calls.push([command, ...args]);
        const joined = args.join(" ");
        if (joined.includes("/pulls?")) return ok(openPr);
        if (joined.includes("/actions/runs")) return ok(runsWithSwallow);
        if (joined.includes("/comments")) return ok("[]");
        if (command === "gh" && args[0] === "run") return ok("");
        return ok("");
      },
    );
    expect(result.code).toBe(0);
    expect(calls.some((call): boolean => call[0] === "gh" && call[1] === "run" && call[2] === "rerun" && call[3] === "100")).toBe(true);
    const commentCall = calls.find((call): boolean => call.join(" ").includes("/issues/7/comments") && call.includes("-f"));
    expect(commentCall).toBeDefined();
    const body = commentCall?.find((arg): boolean => arg.startsWith("body="))?.slice("body=".length) ?? "";
    // The full conclusion-selected message, not only the idempotency stamp
    // (review finding: the port had dropped bankai-core#273/#398's prose and
    // posted an empty-reading HTML-comment-only body).
    expect(body).toContain("Swallowed wake auto-redriven");
    expect(body).toContain("gh run rerun 100");
    expect(body).toContain("<!-- nen-wake-redrive run_id=100");
  });

  it("falls back to a human flag, and warns, rather than aborting the sweep, when the rerun fails", async () => {
    const calls: string[][] = [];
    const result = await capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "bankai\\[bot\\]$", "--run"],
      (command, args): CommandResult => {
        calls.push([command, ...args]);
        const joined = args.join(" ");
        if (joined.includes("/pulls?")) return ok(openPr);
        if (joined.includes("/actions/runs")) return ok(runsWithSwallow);
        if (joined.includes("/comments")) return ok("[]");
        if (command === "gh" && args[0] === "run") return { code: 1, stdout: "", stderr: "HTTP 403: rerun refused", spawnFailed: false };
        return ok("");
      },
    );
    // The sweep completes (exit 0), not a thrown ToolError -- a failed rerun
    // must not strand every PR after this one unscanned (bankai-core#398/PR
    // #411, review finding).
    expect(result.code).toBe(0);
    const commentCall = calls.find((call): boolean => call.join(" ").includes("/issues/7/comments") && call.includes("-f"));
    const body = commentCall?.find((arg): boolean => arg.startsWith("body="))?.slice("body=".length) ?? "";
    expect(body).toContain("gh run rerun 100");
    expect(body).toContain("<!-- nen-wake-guard run_id=100");
    expect(result.out.join("\n")).toMatch(/warning:.*gh run rerun 100 failed/);
  });

  it("warns rather than aborting when the follow-up comment POST fails", async () => {
    const result = await capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "bankai\\[bot\\]$", "--run"],
      (command, args): CommandResult => {
        const joined = args.join(" ");
        if (joined.includes("/pulls?")) return ok(openPr);
        if (joined.includes("/actions/runs")) return ok(runsWithSwallow);
        if (joined.includes("/issues/7/comments") && args.includes("-f")) {
          return { code: 1, stdout: "", stderr: "HTTP 500", spawnFailed: false };
        }
        if (joined.includes("/comments")) return ok("[]");
        return ok("");
      },
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/warning:.*posting its follow-up comment failed/);
  });

  it("refuses an unparseable --author-pattern as a usage error", async () => {
    const result = await capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "("],
      (): CommandResult => ok("[]"),
    );
    expect(result.code).toBe(2);
  });

  // zheref/nen#8 item 3, second exposed site: this pattern is compiled from a
  // flag and then run against `pr.user.login` -- a string GitHub supplies -- so
  // it carries the identical ReDoS exposure ../schema/gates.ts's five pattern
  // fields do, and goes through the same guard. Refused AT THE FLAG, before a
  // single gh call: the alternative is a sweep that risks hanging partway
  // through with workflows already redriven.
  it("refuses a catastrophic --author-pattern before any gh call", async () => {
    const result = await capture(
      [
        "wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z",
        "--author-pattern", "(a+)+$",
      ],
      // Throws if reached: the refusal must precede the first fetch.
      (): CommandResult => {
        throw new Error("must not be called");
      },
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/exponential-backtracking/);
    expect(result.err.join("\n")).toContain("'(a+)+'");
  });

  it("still accepts an ordinary anchored bot-login pattern", async () => {
    const result = await capture(
      [
        "wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z",
        "--author-pattern", "(^|/)some-bot(\\[bot\\])?$",
      ],
      (): CommandResult => ok("[]"),
    );
    expect(result.code).toBe(0);
  });
});

describe("nen wake -- the private-name guard (zheref/nen#363)", () => {
  const LIST_PAGE = "api user/repos?visibility=private&per_page=100&page=1";
  const LIST = JSON.stringify([{ full_name: "acme/hidden-thing" }, { full_name: "acme/vault" }]);
  /** A gh answering the guard's two reads, recording every call, and nothing else. */
  const guardOnly = (visibility: string, list: CommandResult | null, seen: string[]) =>
    (command: string, args: readonly string[]): CommandResult => {
      seen.push([command, ...args].join(" "));
      const joined = args.join(" ");
      if (joined === "api repos/o/r") return ok(JSON.stringify({ visibility }));
      if (joined === "api -i user") return ok("HTTP/2.0 200 OK\nX-Oauth-Scopes: repo\n\n{}");
      if (joined === LIST_PAGE && list !== null) return list;
      return ok("[]");
    };
  const FIRE = ["wake", "fire", "--repo-slug", "o/r", "--ref", "XX-PR-#12", "--label", "wake"];
  const VERIFY = ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "bankai\\[bot\\]$"];

  it("fire: a private name in --comment on a PUBLIC target refuses with exit 4 -- no label touched, nothing posted, the name never printed", async () => {
    const seen: string[] = [];
    const result = await capture([...FIRE, "--comment", "re-fired after the vault move", "--run"], guardOnly("public", ok(LIST), seen), "scripted");
    expect(result.code).toBe(4);
    expect(seen).toEqual(["gh api repos/o/r", "gh api -i user", `gh ${LIST_PAGE}`]);
    const all = [...result.out, ...result.err].join("\n");
    expect(all).toContain("nen wake fire: comment:1: private repository #2");
    expect(all).not.toMatch(/vault/i);
  });

  it("fire: the dry run refuses the same way", async () => {
    const result = await capture([...FIRE, "--comment", "Hidden-Thing"], guardOnly("public", ok(LIST), []), "scripted");
    expect(result.code).toBe(4);
  });

  it("fire: a PRIVATE target is not checked -- the list is never read, and the wake fires", async () => {
    const seen: string[] = [];
    const result = await capture([...FIRE, "--comment", "the vault", "--run"], guardOnly("private", null, seen), "scripted");
    expect(result.code).toBe(0);
    expect(seen).not.toContain(`gh ${LIST_PAGE}`);
    expect(seen.some((call): boolean => call.includes("/issues/12/comments"))).toBe(true);
  });

  it("fire: an unreadable private list fails closed (exit 1), nothing written", async () => {
    const seen: string[] = [];
    const result = await capture(
      [...FIRE, "--comment", "anything", "--run"],
      guardOnly("public", { code: 1, stdout: "", stderr: "HTTP 401", spawnFailed: false }, seen),
      "scripted",
    );
    expect(result.code).toBe(1);
    expect(seen).toEqual(["gh api repos/o/r", "gh api -i user", `gh ${LIST_PAGE}`]);
  });

  it("fire: with no --comment there is no text, no check -- and the guard's flags are refused rather than ignored", async () => {
    const seen: string[] = [];
    expect((await capture(FIRE, guardOnly("public", ok(LIST), seen), "scripted")).code).toBe(0);
    expect(seen).toEqual([]);
    const refused = await capture([...FIRE, "--skip-private-name-check"], guardOnly("public", ok(LIST), []), "scripted");
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toMatch(/only with --comment/);
  });

  it("fire --json: the refusal is { fired: false, privateNameCheck }", async () => {
    const result = await capture([...FIRE, "--comment", "the vault", "--json"], guardOnly("public", ok(LIST), []), "scripted");
    expect(result.code).toBe(4);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["fired"]).toBe(false);
    expect((doc["privateNameCheck"] as { result: string }).result).toBe("refused");
  });

  it("verify: a private name in a marker refuses with exit 4 before the first PR read", async () => {
    const seen: string[] = [];
    const result = await capture([...VERIFY, "--flag-marker", "vault_guard", "--run"], guardOnly("public", ok(LIST), seen), "scripted");
    expect(result.code).toBe(4);
    expect(seen).toEqual(["gh api repos/o/r", "gh api -i user", `gh ${LIST_PAGE}`]);
    expect(result.err.join("\n")).toContain("nen wake verify: flag-marker:1: private repository #2");
  });

  it("verify: a hit in --now is never echoed under --json (N1)", async () => {
    const result = await capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "a", "--flag-marker", "acme/vault", "--json"],
      guardOnly("public", ok(LIST), []),
      "scripted",
    );
    expect(result.code).toBe(4);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc["now"]).toBeUndefined();
    expect(result.out.join("\n")).not.toMatch(/vault/i);
  });

  it("verify: --now that is not an ISO-8601 instant is exit 2 before any call -- free text never reaches a comment", async () => {
    const seen: string[] = [];
    const result = await capture(["wake", "verify", "--repo-slug", "o/r", "--now", "acme/vault 2026", "--author-pattern", "a", "--json"], guardOnly("public", ok(LIST), seen), "scripted");
    expect(result.code).toBe(2);
    expect(seen).toEqual([]);
    expect(result.out.join("\n")).not.toMatch(/vault/i);
  });

  it("verify: a PRIVATE target is not checked, and the sweep runs", async () => {
    const seen: string[] = [];
    const result = await capture([...VERIFY, "--flag-marker", "vault-guard"], guardOnly("private", null, seen), "scripted");
    expect(result.code).toBe(0);
    expect(seen).not.toContain(`gh ${LIST_PAGE}`);
  });

  it("verify: an unreadable private list fails closed (exit 1) before the sweep", async () => {
    const seen: string[] = [];
    const result = await capture(VERIFY, guardOnly("public", { code: 1, stdout: "", stderr: "HTTP 401", spawnFailed: false }, seen), "scripted");
    expect(result.code).toBe(1);
    expect(seen.some((call): boolean => call.includes("/pulls?"))).toBe(false);
  });

  it("verify: a --repo-slug that is not owner/name is a usage error (exit 2) before any call", async () => {
    const seen: string[] = [];
    const result = await capture(["wake", "verify", "--repo-slug", "not-a-slug", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "a"], guardOnly("public", ok(LIST), seen), "scripted");
    expect(result.code).toBe(2);
    expect(seen).toEqual([]);
  });
});
