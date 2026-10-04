// src/pr/markready.test.ts -- `nen pr mark-ready` (zheref/nen#345), behind the
// seam only. NO NETWORK: every `gh` call is a ScriptedSeams entry, and an
// unscripted call throws -- so a test that passes also proves no extra call
// (a second mutation, a stray read) was made.

import { describe, expect, it } from "vitest";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { VerbUsageError } from "../cli/command.js";
import {
  EXIT_HEAD_MISMATCH,
  EXIT_NOT_OPEN,
  MARK_READY_CONTRACT,
  exitCodeFor,
  markReady,
  markReadyArgv,
  readDraftState,
  readDraftStateArgv,
} from "./markready.js";

const TARGET: Target = { owner: "acme", repo: "widgets", slug: "acme/widgets" };
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OTHER_HEAD = "fedcba9876543210fedcba9876543210fedcba98";
const NODE = "PR_kwSYNTHETIC";

const READ_KEY = `gh ${readDraftStateArgv(TARGET, 42).join(" ")}`;
const WRITE_KEY = `gh ${markReadyArgv(NODE).join(" ")}`;

function prJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          id: NODE,
          number: 42,
          state: "OPEN",
          isDraft: true,
          headRefOid: HEAD,
          url: "https://github.com/acme/widgets/pull/42",
          ...overrides,
        },
      },
    },
  });
}

function read(overrides: Record<string, unknown> = {}): ScriptedCall {
  return { match: READ_KEY, result: { code: 0, stdout: prJson(overrides) } };
}

const WRITE_OK: ScriptedCall = {
  match: WRITE_KEY,
  result: { code: 0, stdout: JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { id: NODE, isDraft: false } } } }) },
};

function seams(calls: readonly ScriptedCall[]): ScriptedSeams {
  return new ScriptedSeams(calls, { platform: "linux" });
}

const INPUT = { target: TARGET, number: 42, requiredHead: null, dryRun: false } as const;

describe("argv -- the mutation a dry run prints is the mutation that runs", () => {
  it("addresses markPullRequestReadyForReview by node id, over POST graphql", () => {
    const argv = markReadyArgv(NODE);
    expect(argv.slice(0, 4)).toEqual(["api", "--method", "POST", "graphql"]);
    expect(argv.join(" ")).toContain("markPullRequestReadyForReview(input:{pullRequestId:$id})");
    expect(argv[argv.length - 1]).toBe(`id=${NODE}`);
  });

  it("reads the number as a typed Int and the owner/name as strings", () => {
    const argv = readDraftStateArgv(TARGET, 42);
    expect(argv).toContain("-F");
    expect(argv[argv.indexOf("-F") + 1]).toBe("number=42");
    expect(argv).toContain("owner=acme");
    expect(argv).toContain("name=widgets");
  });
});

describe("markReady -- dry run", () => {
  it("reads, prints the mutation argv, and sends nothing", () => {
    const s = seams([read()]);
    const report = markReady(s, { ...INPUT, dryRun: true });
    expect(report.status).toBe("dry-run");
    expect(report.contract).toBe(MARK_READY_CONTRACT);
    expect(report.sent).toBe(false);
    expect(report.isDraft).toBe(true);
    expect(report.mutationArgv).toEqual(["gh", ...markReadyArgv(NODE)]);
    expect(exitCodeFor(report.status)).toBe(0);
    expect(s.calls.length).toBe(1);
  });

  it("still refuses a head mismatch under --dry-run, exactly as the real run would", () => {
    const s = seams([read()]);
    const report = markReady(s, { ...INPUT, dryRun: true, requiredHead: OTHER_HEAD.slice(0, 7) });
    expect(report.status).toBe("head-mismatch");
    expect(s.calls.length).toBe(1);
  });
});

describe("markReady -- the transition", () => {
  it("sends the mutation and reports success only after the read back says not-a-draft", () => {
    const s = seams([read(), WRITE_OK, read({ isDraft: false })]);
    const report = markReady(s, INPUT);
    expect(report.status).toBe("marked-ready");
    expect(report.ok).toBe(true);
    expect(report.wasDraft).toBe(true);
    expect(report.isDraft).toBe(false);
    expect(report.sent).toBe(true);
    expect(report.headAfter).toBe(HEAD);
    expect(report.headMoved).toBe(false);
    expect(exitCodeFor(report.status)).toBe(0);
    expect(s.calls.map((call) => call.args[5]?.slice(0, 8))).toEqual(["query=qu", "query=mu", "query=qu"]);
  });

  it("accepts a matching --require-head prefix in any case, then transitions", () => {
    const s = seams([read(), WRITE_OK, read({ isDraft: false })]);
    const report = markReady(s, { ...INPUT, requiredHead: HEAD.slice(0, 10).toUpperCase() });
    expect(report.status).toBe("marked-ready");
  });

  it("with --require-head, a head that moved by the read back is marked-ready-head-moved: not ok, exit 8", () => {
    const s = seams([read(), WRITE_OK, read({ isDraft: false, headRefOid: OTHER_HEAD })]);
    const report = markReady(s, { ...INPUT, requiredHead: HEAD });
    expect(report.status).toBe("marked-ready-head-moved");
    expect(report.ok).toBe(false);
    expect(report.isDraft).toBe(false);
    expect(report.headMoved).toBe(true);
    expect(report.headAfter).toBe(OTHER_HEAD);
    expect(report.message).toMatch(/no longer holds/);
    expect(exitCodeFor(report.status)).toBe(EXIT_HEAD_MISMATCH);
  });

  it("without --require-head, a moved head is informational: marked-ready at exit 0", () => {
    const s = seams([read(), WRITE_OK, read({ isDraft: false, headRefOid: OTHER_HEAD })]);
    const report = markReady(s, INPUT);
    expect(report.status).toBe("marked-ready");
    expect(report.ok).toBe(true);
    expect(report.headMoved).toBe(true);
    expect(report.message).toMatch(/head moved/);
    expect(exitCodeFor(report.status)).toBe(0);
  });
});

describe("markReady -- already ready", () => {
  it("is exit 0, status already-ready, and sends nothing", () => {
    const s = seams([read({ isDraft: false })]);
    const report = markReady(s, INPUT);
    expect(report.status).toBe("already-ready");
    expect(report.ok).toBe(true);
    expect(report.sent).toBe(false);
    expect(report.mutationArgv).toBeNull();
    expect(exitCodeFor(report.status)).toBe(0);
    expect(s.calls.length).toBe(1);
  });

  it("is the same answer under --dry-run", () => {
    const report = markReady(seams([read({ isDraft: false })]), { ...INPUT, dryRun: true });
    expect(report.status).toBe("already-ready");
  });
});

describe("markReady -- refusals before any write", () => {
  it("refuses a head mismatch at exit 8 with both SHAs, sending nothing", () => {
    const s = seams([read()]);
    const report = markReady(s, { ...INPUT, requiredHead: OTHER_HEAD });
    expect(report.status).toBe("head-mismatch");
    expect(report.ok).toBe(false);
    expect(report.message).toContain(OTHER_HEAD);
    expect(report.message).toContain(HEAD);
    expect(exitCodeFor(report.status)).toBe(EXIT_HEAD_MISMATCH);
    expect(s.calls.length).toBe(1);
  });

  it.each(["", "0123456", `${HEAD}0`, "z".repeat(40)])("fails (exit 1, not a mismatch) on a GitHub head that is not a full SHA: '%s'", (head) => {
    let thrown: unknown;
    try {
      markReady(seams([read({ headRefOid: head })]), { ...INPUT, requiredHead: HEAD });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(VerbUsageError);
    expect(String(thrown)).toMatch(/headRefOid/);
  });

  it.each(["CLOSED", "MERGED"])("refuses a %s pull request at exit 3, sending nothing", (state) => {
    const s = seams([read({ state })]);
    const report = markReady(s, INPUT);
    expect(report.status).toBe("not-open");
    expect(report.message).toContain(state);
    expect(exitCodeFor(report.status)).toBe(EXIT_NOT_OPEN);
    expect(s.calls.length).toBe(1);
  });

  it("checks OPEN before the head pin, so a merged PR is not reported as a mismatch", () => {
    const report = markReady(seams([read({ state: "MERGED" })]), { ...INPUT, requiredHead: OTHER_HEAD });
    expect(report.status).toBe("not-open");
  });

  it("refuses a number that is not a pull request as a usage error (exit 2), from gh's stderr", () => {
    const s = seams([
      {
        match: READ_KEY,
        result: { code: 1, stderr: "GraphQL: Could not resolve to a PullRequest with the number of 42. (repository.pullRequest)" },
      },
    ]);
    expect(() => markReady(s, INPUT)).toThrow(VerbUsageError);
    expect(() => markReady(s, INPUT)).toThrow(/does not read as a pull request/);
  });

  it("refuses the same way from a 200 carrying errors, and from a null pullRequest", () => {
    const viaErrors = seams([
      { match: READ_KEY, result: { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: null } }, errors: [{ message: "Could not resolve to a PullRequest with the number of 42." }] }) } },
    ]);
    expect(() => markReady(viaErrors, INPUT)).toThrow(VerbUsageError);
    const viaNull = seams([{ match: READ_KEY, result: { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: null } } }) } }]);
    expect(() => markReady(viaNull, INPUT)).toThrow(/does not read as a pull request/);
  });

  it("refuses an unresolvable repository as a usage error naming --target", () => {
    const s = seams([
      { match: READ_KEY, result: { code: 1, stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/widgets'. (repository)" } },
    ]);
    expect(() => markReady(s, INPUT)).toThrow(/--target acme\/widgets does not resolve/);
    const viaNull = seams([{ match: READ_KEY, result: { code: 0, stdout: JSON.stringify({ data: { repository: null } }) } }]);
    expect(() => markReady(viaNull, INPUT)).toThrow(VerbUsageError);
  });

  it("fails (not usage) when the first read fails for any other reason, sending nothing", () => {
    const s = seams([{ match: READ_KEY, result: { code: 1, stderr: "HTTP 502: Bad Gateway" } }]);
    let thrown: unknown;
    try {
      markReady(s, INPUT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(VerbUsageError);
    expect(String(thrown)).toMatch(/502/);
    expect(s.calls.length).toBe(1);
  });

  it("fails when gh could not be started, rather than reading it as not-a-PR", () => {
    const s = seams([{ match: READ_KEY, result: { code: -1, stderr: "spawn gh ENOENT", spawnFailed: true } }]);
    expect(() => readDraftState(s, TARGET, 42)).toThrow(/ENOENT/);
  });

  it("fails on an answer missing a field, never reading it as 'not a draft'", () => {
    const s = seams([read({ isDraft: "false" })]);
    expect(() => readDraftState(s, TARGET, 42)).toThrow(/isDraft/);
  });

  it.each([
    ["{}", "{}"],
    ["no repository key", JSON.stringify({ data: {} })],
    ["no pullRequest key", JSON.stringify({ data: { repository: {} } })],
    ["data not an object", JSON.stringify({ data: [] })],
    ["pullRequest not an object", JSON.stringify({ data: { repository: { pullRequest: 7 } } })],
  ])("reads a malformed 200 (%s) as an unreadable answer (exit 1), never as 'does not resolve'", (_label, stdout) => {
    let thrown: unknown;
    try {
      readDraftState(seams([{ match: READ_KEY, result: { code: 0, stdout } }]), TARGET, 42);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(VerbUsageError);
    expect(String(thrown)).toMatch(/no readable/);
  });

  it("fails on non-JSON and on an answer about a different number", () => {
    expect(() => readDraftState(seams([{ match: READ_KEY, result: { code: 0, stdout: "<html>" } }]), TARGET, 42)).toThrow(/JSON/);
    expect(() => readDraftState(seams([read({ number: 43 })]), TARGET, 42)).toThrow(/#43/);
  });
});

describe("markReady -- API rejection and failed read back stay non-success", () => {
  it("reports refused (exit 1) when GitHub answers 200 with an errors array, and does not read back", () => {
    const s = seams([read(), { match: WRITE_KEY, result: { code: 0, stdout: JSON.stringify({ data: null, errors: [{ message: "Resource not accessible by integration" }] }) } }]);
    const report = markReady(s, INPUT);
    expect(report.status).toBe("refused");
    expect(report.ok).toBe(false);
    expect(report.sent).toBe(true);
    expect(report.message).toMatch(/Resource not accessible/);
    expect(exitCodeFor(report.status)).toBe(1);
    expect(s.calls.length).toBe(2);
  });

  it("reads back after a non-zero gh exit, and reports unconfirmed when it still reads draft", () => {
    const s = seams([read(), { match: WRITE_KEY, result: { code: 1, stderr: "HTTP 502: Bad Gateway" } }, read()]);
    const report = markReady(s, INPUT);
    expect(report.status).toBe("unconfirmed");
    expect(report.ok).toBe(false);
    expect(report.message).toMatch(/502/);
    expect(exitCodeFor(report.status)).toBe(1);
    expect(s.calls.length).toBe(3);
  });

  it("reads back after a non-zero gh exit, and reports marked-ready when GitHub did apply it -- naming gh's failure", () => {
    const s = seams([read(), { match: WRITE_KEY, result: { code: 1, stderr: "connection reset" } }, read({ isDraft: false })]);
    const report = markReady(s, INPUT);
    expect(report.status).toBe("marked-ready");
    expect(report.ok).toBe(true);
    expect(report.message).toMatch(/did not answer cleanly.*connection reset/);
  });

  it("reads back after a non-JSON mutation answer, and after a spawn failure", () => {
    expect(markReady(seams([read(), { match: WRITE_KEY, result: { code: 0, stdout: "nope" } }, read({ isDraft: false })]), INPUT).status).toBe(
      "marked-ready",
    );
    const spawn = seams([read(), { match: WRITE_KEY, result: { code: -1, stderr: "spawn gh ENOENT", spawnFailed: true } }, read()]);
    const report = markReady(spawn, INPUT);
    expect(report.status).toBe("unconfirmed");
    expect(report.message).toMatch(/ENOENT/);
  });

  it("reports unconfirmed (exit 1) when the read back still says draft", () => {
    const report = markReady(seams([read(), WRITE_OK, read()]), INPUT);
    expect(report.status).toBe("unconfirmed");
    expect(report.ok).toBe(false);
    expect(report.isDraft).toBe(true);
    expect(exitCodeFor(report.status)).toBe(1);
  });

  it("reports unconfirmed when the read back itself fails", () => {
    const s = seams([read(), WRITE_OK, { match: READ_KEY, result: { code: 1, stderr: "HTTP 500" } }]);
    const report = markReady(s, INPUT);
    expect(report.status).toBe("unconfirmed");
    expect(report.isDraft).toBeNull();
    expect(report.message).toMatch(/NOT confirmed/);
  });

  it("reports unconfirmed when the read back answers a different object", () => {
    const report = markReady(seams([read(), WRITE_OK, read({ isDraft: false, id: "PR_other" })]), INPUT);
    expect(report.status).toBe("unconfirmed");
    expect(report.message).toMatch(/different object/);
  });
});
