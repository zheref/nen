// src/pr/settle.test.ts -- `nen pr threads settle` (zheref/nen#230): one walk,
// 2N mutations, every refusal before the first write, and a partial failure
// that says exactly what was done.
//
// NO NETWORK. Every `gh` call is a ScriptedSeams entry and an unscripted one
// throws -- so "sent nothing" is proved by the recorded calls, not asserted.

import { describe, expect, it } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { parseTarget } from "../github/target.js";
import { prCommand } from "./command.js";
import { MAX_BATCH_FILE_BYTES, MAX_BODY_CHARS, readSettleFile, SETTLE_CONTRACT } from "./settle.js";
import { listArgv, listPageArgv, replyArgv, resolveArgv } from "./threads.js";

const TARGET = parseTarget("zheref/nen");
const HEAD_SHA = "1f4bb2c0a1b2c3d4e5f60718293a4b5c6d7e8f90";

function node(id: string, isResolved: boolean): unknown {
  return { id, isResolved, path: "src/a.ts", line: 1, comments: { nodes: [{ author: { login: "copilot" }, body: "finding", url: `u-${id}` }] } };
}

function pageBody(nodes: readonly unknown[], hasNextPage: unknown = false, endCursor: string | null = null): string {
  return JSON.stringify({
    data: { repository: { pullRequest: { headRefOid: HEAD_SHA, reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } } } } },
  });
}

const listCall = (body: string): ScriptedCall => ({ match: `gh ${listArgv(TARGET, 217).join(" ")}`, result: { code: 0, stdout: body } });
const replyOk = (thread: string, body: string): ScriptedCall => ({
  match: `gh ${replyArgv(thread, body).join(" ")}`,
  result: { code: 0, stdout: JSON.stringify({ data: { addPullRequestReviewThreadReply: { comment: { id: `C-${thread}`, url: "u" } } } }) },
});
const resolveOk = (thread: string): ScriptedCall => ({
  match: `gh ${resolveArgv(thread).join(" ")}`,
  result: { code: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: thread, isResolved: true } } } }) },
});

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly seams: ScriptedSeams;
}

async function capture(argv: readonly string[], calls: readonly ScriptedCall[], repoFlag: string | null = null): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const seams = new ScriptedSeams(calls);
  const code = await runFamily(prCommand, argv, repoFlag, false, io, seams);
  return { code, out, err, seams };
}

/** A temp dir holding `batch.json` (and any extra files), returning the batch's absolute path. */
function batch(content: unknown, extra: Readonly<Record<string, string>> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-settle-"));
  for (const [name, text] of Object.entries(extra)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text, "utf8");
  }
  const path = join(dir, "batch.json");
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  return path;
}

const args = (from: string, extra: readonly string[] = []): readonly string[] => [
  "pr", "threads", "settle", "--target", "zheref/nen", "--pr", "217", "--from", from, ...extra,
];
const ghCalls = (seams: ScriptedSeams): readonly string[] => seams.calls.map((call): string => [call.command, ...call.args].join(" "));
const mutations = (seams: ScriptedSeams): number => ghCalls(seams).filter((call): boolean => call.includes("mutation(")).length;

describe("nen pr threads settle -- the batch", () => {
  it("walks ONCE, then one reply and one resolve per entry: 2N + 1 calls", async () => {
    const from = batch([{ thread: "T1", body: "Fixed in abc." }, { thread: "T2", bodyFile: "replies/t2.md" }], { "replies/t2.md": "Declined:\nout of scope.\n" });
    const captured = await capture([...args(from), "--json"], [
      listCall(pageBody([node("T1", false), node("T2", false), node("T3", false)])),
      replyOk("T1", "Fixed in abc."),
      resolveOk("T1"),
      replyOk("T2", "Declined:\nout of scope.\n"),
      resolveOk("T2"),
    ]);
    expect(captured.code).toBe(0);
    expect(captured.seams.calls).toHaveLength(5);
    expect(ghCalls(captured.seams).filter((call): boolean => call.includes("reviewThreads"))).toHaveLength(1);
    const doc = JSON.parse(captured.out.join("\n")) as Record<string, unknown> & { entries: Record<string, unknown>[] };
    expect(Object.keys(doc)).toEqual(["contract", "target", "pr", "head", "from", "dryRun", "ok", "stoppedAt", "entries"]);
    expect(doc).toMatchObject({ contract: SETTLE_CONTRACT, target: "zheref/nen", pr: 217, head: HEAD_SHA, from, dryRun: false, ok: true, stoppedAt: null });
    expect(Object.keys(doc.entries[0] ?? {})).toEqual(["thread", "disposition", "replied", "resolved", "bodyBytes", "bodyFrom", "replyArgv", "resolveArgv", "error"]);
    expect(doc.entries.map((entry): unknown => [entry["thread"], entry["disposition"], entry["replied"], entry["resolved"]])).toEqual([
      ["T1", "resolved", true, true],
      ["T2", "resolved", true, true],
    ]);
    expect(doc.entries[0]?.["bodyFrom"]).toBe("inline");
    expect(doc.entries[1]?.["bodyFrom"]).toBe(join(realpathSync(join(from, "..")), "replies", "t2.md"));
  });

  it("follows the walk across pages before any mutation", async () => {
    const from = batch([{ thread: "T9", body: "ok" }]);
    const captured = await capture(args(from), [
      listCall(pageBody([node("T1", false)], true, "c1")),
      { match: `gh ${listPageArgv(TARGET, 217, "c1").join(" ")}`, result: { code: 0, stdout: pageBody([node("T9", false)]) } },
      replyOk("T9", "ok"),
      resolveOk("T9"),
    ]);
    expect(captured.code).toBe(0);
    expect(captured.out[0]).toBe(`zheref/nen#217 @ 1f4bb2c0: settled 1 of 1 thread(s) from ${from}`);
    expect(captured.out).toContain("  T9  replied, resolved");
  });

  it("reports an ALREADY-RESOLVED thread per entry, sends it nothing, settles the rest, exits 3", async () => {
    const from = batch([{ thread: "T1", body: "a" }, { thread: "T2", body: "b" }]);
    const captured = await capture([...args(from), "--json"], [
      listCall(pageBody([node("T1", true), node("T2", false)])),
      replyOk("T2", "b"),
      resolveOk("T2"),
    ]);
    expect(captured.code).toBe(3);
    const doc = JSON.parse(captured.out.join("\n")) as { ok: boolean; entries: { thread: string; disposition: string; replyArgv: unknown }[] };
    expect(doc.ok).toBe(false);
    expect(doc.entries.map((entry): string => entry.disposition)).toEqual(["already-resolved", "resolved"]);
    expect(doc.entries[0]?.replyArgv).toBeNull();
    expect(ghCalls(captured.seams).some((call): boolean => call.includes("threadId=T1"))).toBe(false);
  });
});

describe("nen pr threads settle -- refused before any write (exit 2)", () => {
  it("names an unknown thread id, after the one walk, with nothing sent", async () => {
    const from = batch([{ thread: "T1", body: "a" }, { thread: "NOPE", body: "b" }, { thread: "GONE", body: "c" }]);
    const captured = await capture(args(from), [listCall(pageBody([node("T1", false)]))]);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/carries no review thread with id 'NOPE', 'GONE'; nothing was sent/);
    expect(captured.seams.calls).toHaveLength(1);
  });

  it("names a duplicated thread id, an empty body and a bad entry together, before any call", async () => {
    const from = batch(
      [
        { thread: "T1", body: "a" },
        { thread: "T1", body: "again" },
        { thread: "T2", body: "   \n" },
        { thread: "T3", bodyFile: "empty.md" },
        { thread: "T4" },
        { thread: "T5", body: "x", bodyFile: "y.md" },
        { thread: "T6", body: "x", extra: 1 },
        { thread: "", body: "x" },
        "not an object",
        { thread: "T7", bodyFile: "missing.md" },
      ],
      { "empty.md": "\n" },
    );
    const captured = await capture(args(from), []);
    expect(captured.code).toBe(2);
    const err = captured.err.join("\n");
    expect(err).toMatch(/entry 1: thread 'T1' is already named by entry 0/);
    expect(err).toMatch(/entry 2: the body is empty/);
    expect(err).toMatch(/entry 3: the body in '.*empty\.md' is empty/);
    expect(err).toMatch(/entry 4: carries neither 'body' nor 'bodyFile'/);
    expect(err).toMatch(/entry 5: carries both 'body' and 'bodyFile'/);
    expect(err).toMatch(/entry 6: unknown key\(s\) 'extra'/);
    expect(err).toMatch(/entry 7: 'thread' must be a non-empty string/);
    expect(err).toMatch(/entry 8: not an object/);
    expect(err).toMatch(/entry 9: could not read bodyFile/);
    expect(err).toMatch(/nothing was sent/);
    expect(captured.seams.calls).toEqual([]);
  });

  it("refuses an unreadable, non-JSON, non-array or empty file before any call", async () => {
    for (const from of [join(tmpdir(), "nen-settle-does-not-exist.json"), batch("{not json"), batch({ thread: "T1", body: "a" }), batch([])]) {
      const captured = await capture(args(from), []);
      expect(captured.code, from).toBe(2);
      expect(captured.seams.calls, from).toEqual([]);
    }
  });

  it("refuses a missing --from, and the single-thread flags, at exit 2", async () => {
    const missing = await capture(["pr", "threads", "settle", "--target", "zheref/nen", "--pr", "217"], []);
    expect(missing.code).toBe(2);
    expect(missing.err.join("\n")).toMatch(/takes --from <file.json>/);
    const from = batch([{ thread: "T1", body: "a" }]);
    for (const extra of [["--thread", "T1"], ["--body-file", from]]) {
      const captured = await capture(args(from, extra), []);
      expect(captured.code, extra.join(" ")).toBe(2);
      expect(captured.err.join("\n")).toMatch(/not read by 'pr threads settle'/);
    }
  });

  it("refuses --from on the other threads actions and on other pr subcommands", async () => {
    const from = batch([{ thread: "T1", body: "a" }]);
    const reply = await capture(["pr", "threads", "resolve", "--target", "zheref/nen", "--pr", "217", "--thread", "T1", "--from", from], []);
    expect(reply.code).toBe(2);
    expect(reply.err.join("\n")).toMatch(/--from is not read by 'pr threads resolve'/);
    const fetch = await capture(["pr", "fetch", "--target", "zheref/nen", "--pr", "217", "--from", from], []);
    expect(fetch.code).toBe(2);
    expect(fetch.err.join("\n")).toMatch(/--from is only read by 'pr threads settle'/);
  });

  it("resolves a relative --from against --repo, not the process directory", async () => {
    const from = batch([{ thread: "T1", body: "a" }]);
    const captured = await capture(args("batch.json", ["--dry-run"]), [listCall(pageBody([node("T1", false)]))], join(from, ".."));
    expect(captured.code).toBe(0);
  });
});

describe("nen pr threads settle -- a failure partway through", () => {
  it("stops at the first refused mutation, names what was done, retries nothing, exits 1", async () => {
    const from = batch([{ thread: "T1", body: "a" }, { thread: "T2", body: "b" }, { thread: "T3", body: "c" }]);
    const script = [
      listCall(pageBody([node("T1", false), node("T2", false), node("T3", false)])),
      replyOk("T1", "a"),
      resolveOk("T1"),
      replyOk("T2", "b"),
      { match: `gh ${resolveArgv("T2").join(" ")}`, result: { code: 0, stdout: JSON.stringify({ errors: [{ message: "Something went wrong" }] }) } },
    ];
    const captured = await capture([...args(from), "--json"], script);
    expect(captured.code).toBe(1);
    const doc = JSON.parse(captured.out.join("\n")) as { ok: boolean; stoppedAt: string; entries: { disposition: string; error: string | null }[] };
    expect(doc.ok).toBe(false);
    expect(doc.stoppedAt).toBe("T2");
    expect(doc.entries.map((entry): string => entry.disposition)).toEqual(["resolved", "replied", "not-attempted"]);
    expect(doc.entries[1]?.error).toMatch(/Something went wrong/);
    expect(captured.err.join("\n")).toMatch(
      /stopped at thread 'T2'; nothing was retried\. Replied to and resolved: T1\. Replied to, NOT resolved: T2\. Reply failed \(nothing confirmed sent\): none\. Already resolved, nothing sent: none\. Not attempted: T3\./,
    );
    // Exactly one resolve per thread attempted -- no retry of T2, nothing for T3.
    expect(ghCalls(captured.seams).filter((call): boolean => call.includes("resolveReviewThread"))).toHaveLength(2);
    expect(ghCalls(captured.seams).some((call): boolean => call.includes("threadId=T3"))).toBe(false);
  });

  it("a reply that cannot be confirmed is 'failed', and an auth failure keeps the single verbs' exit 5", async () => {
    const from = batch([{ thread: "T1", body: "a" }, { thread: "T2", body: "b" }]);
    const captured = await capture(args(from), [
      listCall(pageBody([node("T1", false), node("T2", false)])),
      { match: `gh ${replyArgv("T1", "a").join(" ")}`, result: { code: 1, stderr: "HTTP 401: Bad credentials" } },
    ]);
    expect(captured.code).toBe(5);
    expect(captured.out).toContain("  T2  not attempted (the batch stopped at T1)");
    expect(captured.out.some((line): boolean => line.startsWith("  T1  FAILED, nothing confirmed sent:"))).toBe(true);
    expect(mutations(captured.seams)).toBe(1);
  });

  it("a walk that fails is the single verbs' code, with nothing sent", async () => {
    const from = batch([{ thread: "T1", body: "a" }]);
    const captured = await capture(args(from), [
      { match: `gh ${listArgv(TARGET, 217).join(" ")}`, result: { code: 0, stdout: JSON.stringify({ data: { repository: null } }) } },
    ]);
    expect(captured.code).toBe(4);
    expect(captured.seams.calls).toHaveLength(1);
  });
});

describe("nen pr threads settle --dry-run", () => {
  it("prints both mutations and every reply body per entry, and sends NOTHING", async () => {
    const from = batch([{ thread: "T1", body: "Fixed in abc.\nSee the test." }, { thread: "T2", body: "b" }]);
    const captured = await capture(args(from, ["--dry-run"]), [listCall(pageBody([node("T1", false), node("T2", true)]))]);
    expect(captured.code).toBe(3);
    expect(captured.seams.calls).toHaveLength(1);
    const text = captured.out.join("\n");
    expect(captured.out[0]).toBe(`zheref/nen#217 @ 1f4bb2c0: would settle 1 of 2 thread(s) from ${from} -- dry run, nothing written`);
    expect(text).toContain("  T1  would reply (27 byte(s)) and resolve");
    expect(text).toMatch(/would run: gh api --method POST graphql .*addPullRequestReviewThreadReply/);
    expect(text).toMatch(/would run: gh api --method POST graphql .*resolveReviewThread/);
    expect(text).toContain("      | Fixed in abc.\n      | See the test.");
    expect(text).toContain("  T2  already resolved -- nothing would be sent to it");
  });

  it("--json carries the full argv, body bytes included", async () => {
    const from = batch([{ thread: "T1", body: "x\ny" }]);
    const captured = await capture(args(from, ["--dry-run", "--json"]), [listCall(pageBody([node("T1", false)]))]);
    expect(captured.code).toBe(0);
    const doc = JSON.parse(captured.out.join("\n")) as { ok: boolean; dryRun: boolean; entries: { disposition: string; replyArgv: string[]; resolveArgv: string[] }[] };
    expect(doc).toMatchObject({ ok: true, dryRun: true });
    expect(doc.entries[0]?.disposition).toBe("planned");
    expect(doc.entries[0]?.replyArgv).toEqual([...replyArgv("T1", "x\ny")]);
    expect(doc.entries[0]?.resolveArgv).toEqual([...resolveArgv("T1")]);
  });

  it("strips control characters from human output, keeps them in --json", async () => {
    const from = batch([{ thread: "T1", body: "a\u001b[2Kb" }]);
    const human = await capture(args(from, ["--dry-run"]), [listCall(pageBody([node("T1", false)]))]);
    expect(human.out.join("\n")).not.toContain("\u001b");
    expect(human.out.join("\n")).toContain("      | a[2Kb");
  });
});

describe("nen pr threads settle -- a bodyFile is confined to the batch's directory (Feitan F1)", () => {
  /** Refused at exit 2 with nothing called, the refusal matching `pattern`. */
  async function refused(entry: Record<string, unknown>, pattern: RegExp, setup?: (dir: string) => void): Promise<void> {
    const from = batch([entry]);
    setup?.(join(from, ".."));
    const captured = await capture(args(from), []);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(pattern);
    expect(captured.seams.calls).toEqual([]);
  }

  it("refuses an absolute bodyFile, even one that exists", async () => {
    const outside = join(mkdtempSync(join(tmpdir(), "nen-settle-outside-")), "secret.txt");
    writeFileSync(outside, "a secret", "utf8");
    await refused({ thread: "T1", bodyFile: outside }, /entry 0: 'bodyFile' '.*secret\.txt' is absolute/);
  });

  it("refuses a '..' segment, even one that lands back inside", async () => {
    await refused({ thread: "T1", bodyFile: "sub/../reply.md" }, /entry 0: 'bodyFile' 'sub\/\.\.\/reply\.md' carries a '\.\.' segment/, (dir) => {
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "reply.md"), "hi", "utf8");
    });
  });

  it.skipIf(process.platform === "win32")("refuses a symlink that escapes the directory, by where it lands", async () => {
    const outside = join(mkdtempSync(join(tmpdir(), "nen-settle-outside-")), "secret.txt");
    writeFileSync(outside, "a secret", "utf8");
    await refused({ thread: "T1", bodyFile: "link.md" }, /'bodyFile' 'link\.md' resolves to '.*secret\.txt', outside the batch file's directory/, (dir) => {
      symlinkSync(outside, join(dir, "link.md"));
    });
  });

  it.skipIf(process.platform === "win32")("refuses a device path, named directly or through a link", async () => {
    await refused({ thread: "T1", bodyFile: "/dev/stdin" }, /is absolute/);
    await refused({ thread: "T1", bodyFile: "zero" }, /'bodyFile' 'zero' resolves to '\/dev\/zero', outside/, (dir) => {
      symlinkSync("/dev/zero", join(dir, "zero"));
    });
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO inside the directory without blocking on it", async () => {
    await refused({ thread: "T1", bodyFile: "pipe" }, /'bodyFile' 'pipe' is not a regular file/, (dir) => {
      execFileSync("mkfifo", [join(dir, "pipe")]);
    });
  });

  it("refuses a directory inside the directory", async () => {
    await refused({ thread: "T1", bodyFile: "sub" }, /'bodyFile' 'sub' is not a regular file/, (dir) => {
      mkdirSync(join(dir, "sub"));
    });
  });

  it.skipIf(process.platform === "win32")("reports the REAL path of an in-directory symlink in bodyFrom and on the live line, relative to the batch", async () => {
    const from = batch([{ thread: "T1", bodyFile: "alias.md" }], { "replies/real.md": "ok" });
    const dir = join(from, "..");
    symlinkSync(join(dir, "replies", "real.md"), join(dir, "alias.md"));
    const script = [listCall(pageBody([node("T1", false)])), replyOk("T1", "ok"), resolveOk("T1")];
    const human = await capture(args(from), script);
    expect(human.code).toBe(0);
    expect(human.out).toContain(`  T1  [body: ${join("replies", "real.md")}]  replied, resolved`);
    const json = await capture([...args(from), "--json"], script);
    const doc = JSON.parse(json.out.join("\n")) as { entries: { bodyFrom: string }[] };
    expect(doc.entries[0]?.bodyFrom).toBe(join(realpathSync(dir), "replies", "real.md"));
  });
});

describe("nen pr threads settle -- body size and file-controlled text (Feitan F2, F3)", () => {
  it(`refuses a body over ${MAX_BODY_CHARS} characters, inline or from a file, in the all-problems pass`, async () => {
    const big = "x".repeat(MAX_BODY_CHARS + 1);
    const from = batch([{ thread: "T1", body: big }, { thread: "T2", bodyFile: "big.md" }, { thread: "T3", body: "x".repeat(MAX_BODY_CHARS) }], { "big.md": big });
    const captured = await capture(args(from), []);
    expect(captured.code).toBe(2);
    const err = captured.err.join("\n");
    expect(err).toMatch(/entry 0: the body is 65537 characters, over the 65536-character limit/);
    expect(err).toMatch(/entry 1: the body in 'big\.md' is 65537 characters/);
    expect(err).not.toMatch(/entry 2/);
    expect(captured.seams.calls).toEqual([]);
  });

  it("refuses a bodyFile too large to be a body without reading it", async () => {
    const from = batch([{ thread: "T1", bodyFile: "huge.md" }], { "huge.md": "x".repeat(MAX_BODY_CHARS * 4 + 1) });
    const captured = await capture(args(from), []);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/'huge\.md' is 262145 bytes, more than a 65536-character body can be; it was not read/);
  });

  it("refuses a thread id carrying a control character, and strips control characters from every echoed fragment", async () => {
    const from = batch([{ thread: "T\u001b[2K1", body: "a" }, { thread: "T2", body: "b", "k\u001b[1A": 1 }, { thread: "T3", bodyFile: "x\u001b[2K.md" }]);
    const captured = await capture(args(from), []);
    expect(captured.code).toBe(2);
    const err = captured.err.join("\n");
    expect(err).not.toContain("\u001b");
    expect(err).toMatch(/entry 0: 'thread' 'T\[2K1' carries a control character/);
    expect(err).toMatch(/entry 1: unknown key\(s\) 'k\[1A'/);
    expect(err).toMatch(/entry 2: could not read bodyFile 'x\[2K\.md'/);
  });

  it("strips control characters from an unknown thread id echoed after the walk", async () => {
    const from = batch([{ thread: "NO\u200bPE", body: "a" }]);
    const captured = await capture(args(from), [listCall(pageBody([node("T1", false)]))]);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/carries no review thread with id 'NOPE'/);
  });
});

describe("nen pr threads settle -- --from is read with bodyFile's discipline", () => {
  async function refusedFrom(from: string, pattern: RegExp): Promise<void> {
    const captured = await capture(args(from), []);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(pattern);
    expect(captured.seams.calls).toEqual([]);
  }

  it.skipIf(process.platform === "win32")("refuses a FIFO without blocking on it", async () => {
    const fifo = join(mkdtempSync(join(tmpdir(), "nen-settle-")), "batch.fifo");
    execFileSync("mkfifo", [fifo]);
    await refusedFrom(fifo, /could not read --from '.*batch\.fifo': it is not a regular file/);
  });

  it.skipIf(process.platform === "win32")("refuses a device", async () => {
    await refusedFrom("/dev/zero", /could not read --from '\/dev\/zero': it is not a regular file/);
  });

  it("refuses a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-settle-"));
    await refusedFrom(dir, /could not read --from '.*': it is not a regular file/);
  });

  it("refuses an oversize file without reading it", async () => {
    const from = batch(" ".repeat(MAX_BATCH_FILE_BYTES + 1));
    await refusedFrom(from, new RegExp(`it is ${MAX_BATCH_FILE_BYTES + 1} bytes, over the ${MAX_BATCH_FILE_BYTES}-byte limit`));
  });

  it("strips control characters from the path it names", async () => {
    const captured = await capture(args(join(tmpdir(), "nope\u001b[2K.json")), []);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).not.toContain("\u001b");
    expect(captured.err.join("\n")).toMatch(/nope\[2K\.json': it could not be opened \(ENOENT\)/);
  });
});

describe("nen pr threads settle -- files in the directory nobody meant to name (Feitan F4)", () => {
  async function refused(entries: readonly Record<string, unknown>[], extra: Readonly<Record<string, string>>, patterns: readonly RegExp[], setup?: (dir: string) => void): Promise<string> {
    const from = batch(entries, extra);
    setup?.(join(from, ".."));
    const captured = await capture(args(from), []);
    expect(captured.code).toBe(2);
    const err = captured.err.join("\n");
    for (const pattern of patterns) expect(err).toMatch(pattern);
    expect(captured.seams.calls).toEqual([]);
    return err;
  }

  it("refuses a dot-file or dot-directory segment, all in the one refusal", async () => {
    await refused(
      [{ thread: "T1", bodyFile: ".env" }, { thread: "T2", bodyFile: ".git/config" }, { thread: "T3", bodyFile: "sub/.npmrc" }],
      { ".env": "TOKEN=x", ".git/config": "[core]", "sub/.npmrc": "//registry:_authToken=x" },
      [/entry 0: 'bodyFile' '\.env' names a dot-file/, /entry 1: 'bodyFile' '\.git\/config' names a dot-file/, /entry 2: 'bodyFile' 'sub\/\.npmrc' names a dot-file/],
    );
  });

  it("lets a lone '.' segment through", async () => {
    const from = batch([{ thread: "T1", bodyFile: "./reply.md" }], { "reply.md": "ok" });
    const captured = await capture(args(from, ["--dry-run"]), [listCall(pageBody([node("T1", false)]))]);
    expect(captured.code).toBe(0);
  });

  it.skipIf(process.platform === "win32")("refuses a plain-named symlink that lands on a dot-file", async () => {
    await refused([{ thread: "T1", bodyFile: "alias.md" }], { ".env": "TOKEN=x" }, [/'alias\.md' resolves to a dot-file or dot-directory \('\.env'\)/], (dir) => {
      symlinkSync(join(dir, ".env"), join(dir, "alias.md"));
    });
  });

  it("refuses a file with more than one hard link", async () => {
    const outside = join(mkdtempSync(join(tmpdir(), "nen-settle-outside-")), "secret.txt");
    writeFileSync(outside, "a secret", "utf8");
    await refused([{ thread: "T1", bodyFile: "reply.md" }], {}, [/'reply\.md' has 2 hard links/], (dir) => {
      linkSync(outside, join(dir, "reply.md"));
    });
  });

  it("refuses cloud keys, private-key headers and entropy inline AND from files before any call (#404)", async () => {
    for (const [shape, secret] of [
      ["AWS access key", "AKIA" + "A".repeat(16)],
      ["Google API key", "AIza" + "b".repeat(35)],
      ["Azure account key", "AccountKey=" + "C".repeat(86) + "=="],
      ["private-key block", "-----BEGIN RSA PRIVATE KEY-----"],
      ["high-entropy token", "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL"],
    ]) {
      const err = await refused(
        [{ thread: "T1", body: "found: " + secret }, { thread: "T2", bodyFile: "reply.md" }],
        { "reply.md": "found: " + secret },
        [/entry 0:/, /entry 1:/, new RegExp(shape ?? ""), /value redacted/],
      );
      expect(err).not.toContain(secret);
    }
  });

  it("does not mistake a port and a later @ for a body credential (#404)", async () => {
    const from = batch([{ thread: "T1", body: "See https://host:8443/repo@main" }]);
    const captured = await capture(args(from, ["--dry-run"]), [listCall(pageBody([node("T1", false)]))]);
    expect(captured.code, captured.err.join("\n")).toBe(0);
  });

  it("refuses a body carrying a credential's shape, inline or from a file, without echoing it", async () => {
    const token = `ghp_${"A".repeat(36)}`;
    const err = await refused(
      [{ thread: "T1", body: `here: ${token}` }, { thread: "T2", bodyFile: "r.md" }, { thread: "T3", body: "see https://user:hunter2@example.com/x" }],
      { "r.md": `github_pat_${"b".repeat(40)}` },
      [/entry 0: the body carries a credential's shape/, /entry 1: the body in 'r\.md' carries a credential's shape/, /entry 2: the body carries a credential's shape/],
    );
    expect(err).not.toContain(token);
    expect(err).not.toContain("hunter2");
  });
});

describe("nen pr threads settle -- the realpath/open race (Feitan F5)", () => {
  it.skipIf(process.platform === "win32")("refuses a bodyFile swapped for a symlink between its realpath and its open", () => {
    const outside = join(mkdtempSync(join(tmpdir(), "nen-settle-outside-")), "secret.txt");
    writeFileSync(outside, "a secret", "utf8");
    const from = batch([{ thread: "T1", bodyFile: "reply.md" }], { "reply.md": "ok" });
    const target = join(realpathSync(join(from, "..")), "reply.md");
    let swapped = false;
    // The seam answers the check truthfully, then swaps the file for a symlink
    // to a file outside before the open -- the window an attacker would use.
    const racing = (path: string): string => {
      const real = realpathSync(path);
      if (!swapped && real === target) {
        swapped = true;
        rmSync(target);
        symlinkSync(outside, target);
      }
      return real;
    };
    expect(() => readSettleFile(from, racing)).toThrow(/entry 0: could not open bodyFile 'reply\.md' \((ELOOP|EMLINK)\)|changed between its check and its open/);
    expect(swapped).toBe(true);
  });

  it("refuses a bodyFile whose real path moved between the check and the read", () => {
    const from = batch([{ thread: "T1", bodyFile: "reply.md" }], { "reply.md": "ok" });
    const target = join(realpathSync(join(from, "..")), "reply.md");
    let calls = 0;
    // The second resolution of the same real path answers differently: the
    // re-check after fstat must notice.
    const drifting = (path: string): string => {
      const real = realpathSync(path);
      if (real === target) calls += 1;
      return real === target && calls > 1 ? `${target}.moved` : real;
    };
    expect(() => readSettleFile(from, drifting)).toThrow(/changed between its check and its open/);
  });

  it("names a --from directory that cannot be resolved, at exit 2", () => {
    const from = batch([{ thread: "T1", body: "a" }]);
    const failing = (path: string): string => {
      if (path === join(from, "..")) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      return realpathSync(path);
    };
    expect(() => readSettleFile(from, failing)).toThrow(/could not resolve the directory of --from '.*batch\.json' \(ENOENT\)/);
  });
});
