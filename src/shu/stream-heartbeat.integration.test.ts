// src/shu/stream-heartbeat.integration.test.ts -- `--stream` and the heartbeat
// against a REAL child on the REAL clock (zheref/nen#244).
//
// WHY THIS EXISTS BESIDE THE SCRIPTED SUITE. ./run.test.ts proves the order of
// lines on a timeline the test owns. It cannot prove that a real child's line
// reaches the caller BEFORE that child exits, which is the whole of what a
// log-growth watchdog needs and the one thing a buffered seam can never do --
// and it cannot prove the heartbeat's timer really fires while a real process
// sleeps. Only a real process and a real clock answer either.
//
// THE CHILD IS THIS TEST RUNNER'S OWN EXECUTABLE (`process.execPath -e`), so
// there is no toolchain to install and nothing on PATH to depend on, and it
// runs identically on all three CI lanes. The intervals are short and the
// assertions are floors ("at least two"), never exact counts: a loaded CI host
// can be late, and a late heartbeat is still a heartbeat.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../index.js";
import { runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { shuCommand } from "./command.js";

/** Prints, sleeps past several heartbeats, prints on stderr, exits with a code. */
const PRINT_SLEEP_PRINT = [
  "process.stdout.write('first\\n');",
  "setTimeout(() => { process.stderr.write('last\\n'); process.exit(3); }, 1500);",
].join(" ");

/** Says nothing at all for past two intervals. */
const SILENT = "setTimeout(() => process.exit(0), 1200);";

const HEARTBEAT = "nen shu: step 1 of 1";

interface Run {
  readonly code: number;
  readonly out: readonly string[];
  /** stderr, each line with the millisecond (since the verb started) it arrived. */
  readonly err: readonly { readonly line: string; readonly atMs: number }[];
  readonly totalMs: number;
}

let repo = "";

function declare(script: string): void {
  writeFileSync(
    join(repo, "nen", "contract.json"),
    JSON.stringify({
      $schema: "nen.contract/v0.1",
      project: {
        lanes: { only: { stack: "placeholder-stack", cwd: "." } },
        defaultLane: "only",
        // `lint`, not `build`: a green build writes a proof through git, and
        // this temporary directory is not a repository.
        verbs: { only: { lint: { exe: process.execPath, argv: ["-e", script] } } },
      },
    }),
  );
}

async function lint(flags: readonly string[]): Promise<Run> {
  const started = Date.now();
  const out: string[] = [];
  const err: { line: string; atMs: number }[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push({ line, atMs: Date.now() - started }),
  };
  const code = await runFamily(shuCommand, ["shu", "lint", ...flags], repo, false, io, defaultSeams());
  return { code, out, err, totalMs: Date.now() - started };
}

beforeAll((): void => {
  repo = mkdtempSync(join(tmpdir(), "nen-shu-live-"));
  mkdirSync(join(repo, "nen"));
});

afterAll((): void => {
  rmSync(repo, { recursive: true, force: true });
});

describe("--stream and the heartbeat, on a real child (zheref/nen#244)", () => {
  it("relays the child's first line BEFORE it exits under --stream, heartbeats between", async () => {
    declare(PRINT_SLEEP_PRINT);
    const run = await lint(["--json", "--stream", "--heartbeat", "0.4"]);
    expect(run.code).toBe(1);
    const lines = run.err.map((entry): string => entry.line);
    const first = run.err.find((entry): boolean => entry.line === "first");
    const last = run.err.find((entry): boolean => entry.line === "last");
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    // LIVE: the first line landed long before the child's 1.5s sleep was over.
    expect(first?.atMs ?? Infinity).toBeLessThan((last?.atMs ?? 0) - 700);
    const beats = lines.filter((line): boolean => line.startsWith(HEARTBEAT));
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(lines.indexOf("first")).toBeLessThan(lines.indexOf(beats[0] ?? ""));
    expect(lines.indexOf("last")).toBeGreaterThan(lines.indexOf(beats[1] ?? ""));
    // The tool's own code, unchanged, in the one JSON document on stdout.
    const report = JSON.parse(run.out.join("\n")) as { exitCode: number; steps: { exitCode: number }[] };
    expect(report.exitCode).toBe(1);
    expect(report.steps[0]?.exitCode).toBe(3);
  }, 20_000);

  it("holds the child's lines until it exits by default, with the heartbeat ahead of them", async () => {
    declare(PRINT_SLEEP_PRINT);
    const run = await lint(["--json", "--heartbeat", "0.4"]);
    expect(run.code).toBe(1);
    const lines = run.err.map((entry): string => entry.line);
    const beats = lines.filter((line): boolean => line.startsWith(HEARTBEAT));
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(lines.indexOf("first")).toBeGreaterThan(lines.lastIndexOf(beats[beats.length - 1] ?? ""));
    const report = JSON.parse(run.out.join("\n")) as { steps: { exitCode: number }[] };
    expect(report.steps[0]?.exitCode).toBe(3);
  }, 20_000);

  it("beats at least twice on stderr for a child that prints nothing for past two intervals", async () => {
    declare(SILENT);
    const run = await lint(["--heartbeat", "0.4"]);
    expect(run.code).toBe(0);
    const beats = run.err.filter((entry): boolean => entry.line.startsWith(HEARTBEAT));
    expect(beats.length).toBeGreaterThanOrEqual(2);
    // EACH WHILE THE CHILD WAS STILL RUNNING, not flushed at the end.
    expect(beats[0]?.atMs ?? Infinity).toBeLessThan(run.totalMs - 300);
  }, 20_000);

  it("says nothing while the child runs with --heartbeat 0 and no --stream: the case a watchdog misreads", async () => {
    declare(SILENT);
    const run = await lint(["--heartbeat", "0"]);
    expect(run.code).toBe(0);
    expect(run.err.filter((entry): boolean => entry.line.startsWith(HEARTBEAT))).toEqual([]);
  }, 20_000);
});
