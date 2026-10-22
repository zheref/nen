import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { classifyCommand } from "../parse/izanami.js";
import { effortDirectory, formatId, parseOptionSpec, recordDefect, STOP_ANSWER_CONTRACT } from "./answer.js";
import { stopCommand } from "./command.js";

// THE ONLY SUBPROCESS THIS VERB RUNS is `git rev-parse --git-common-dir`; the
// seam answers it with a RELATIVE `.git`, as git does from a core checkout, so
// the relative-to-root resolution is exercised. Anything else throws.
function seams(gitAnswer: CommandResult | null = null, now = "2026-10-22T10:00:00Z"): Seams {
  return {
    run: (command, args, options): CommandResult => {
      if (command === "git" && args.includes("--git-common-dir")) {
        // An inherited GIT_DIR must never steer the lookup to another repository.
        expect(options?.env).toMatchObject({ GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined, LC_ALL: "C" });
        expect(Object.hasOwn(options?.env ?? {}, "GIT_DIR")).toBe(true);
        return gitAnswer ?? { code: 0, stdout: ".git\n", stderr: "", spawnFailed: false };
      }
      throw new Error(`unexpected subprocess: ${command} ${args.join(" ")}`);
    },
    now: (): Date => new Date(now),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("no watched form");
    },
    platform: "linux",
  };
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "nen-stop-answer-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "q.md"), "Which door at breath?\n");
  writeFileSync(join(root, "typed.txt"), "Take the  second door, but  keep the tree.\n");
  writeFileSync(join(root, "label.txt"), "Open a fresh worktree\n");
  return root;
}

async function run(argv: readonly string[], root: string, s: Seams = seams(), json = false): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(stopCommand, json ? [...argv, "--json"] : argv, root, false, io, s);
  return { code, out, err };
}

const BASE = [
  "stop", "answer", "--record", "HA-IS-#401", "--gate", "G5", "--who", "kurapika", "--question-file", "q.md",
  "--option", "A=Open a fresh worktree::the dirty tree stays untouched",
  "--option", "B=Discard the tree::uncommitted work is lost",
];

describe("nen stop answer --record", () => {
  it("records a pick as kind 'picked' with no typed text, under the git common dir", async () => {
    const root = repo();
    const result = await run([...BASE, "--pick", "A"], root, seams(), true);
    expect(result.err).toEqual([]);
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n"));
    expect(doc.dryRun).toBe(false);
    expect(doc.path).toBe(join(root, ".git", ".nen", "stops", "HA-IS-%23401", "1.json"));
    const record = JSON.parse(readFileSync(doc.path, "utf8"));
    expect(record).toEqual({
      contract: STOP_ANSWER_CONTRACT,
      id: "R-2026-10-22-01",
      effortId: "HA-IS-#401",
      n: 1,
      gate: "G5",
      who: "kurapika",
      question: "Which door at breath?\n",
      options: [
        { key: "A", label: "Open a fresh worktree", consequence: "the dirty tree stays untouched" },
        { key: "B", label: "Discard the tree", consequence: "uncommitted work is lost" },
      ],
      kind: "picked",
      pick: "A",
      typed: null,
      answeredAt: "2026-10-22T10:00:00.000Z",
    });
    expect(existsSync(join(root, ".git", ".nen", "stop-ids", "R-2026-10-22-01"))).toBe(true);
  });

  it("keeps a typed reply verbatim as kind 'typed'", async () => {
    const root = repo();
    const result = await run([...BASE, "--typed-file", "typed.txt"], root);
    expect(result.code).toBe(0);
    expect(result.out[0]).toMatch(/^recorded R-2026-10-22-01 -> /);
    const record = JSON.parse(readFileSync(join(root, ".git", ".nen", "stops", "HA-IS-%23401", "1.json"), "utf8"));
    expect(record.kind).toBe("typed");
    expect(record.pick).toBeNull();
    expect(record.typed).toBe("Take the  second door, but  keep the tree.\n");
  });

  it("records typed text that is word for word an option label as that pick, text kept", async () => {
    const root = repo();
    expect((await run([...BASE, "--typed-file", "label.txt"], root)).code).toBe(0);
    const record = JSON.parse(readFileSync(join(root, ".git", ".nen", "stops", "HA-IS-%23401", "1.json"), "utf8"));
    expect(record).toMatchObject({ kind: "picked", pick: "A", typed: "Open a fresh worktree\n" });
  });

  it("never reuses an id: counts per day across efforts and survives a deleted record", async () => {
    const root = repo();
    expect((await run([...BASE, "--pick", "A"], root)).code).toBe(0);
    const other = BASE.map((token): string => (token === "HA-IS-#401" ? "NN-IS-#9" : token));
    expect((await run([...other, "--pick", "B"], root)).code).toBe(0);
    expect((await run([...BASE, "--pick", "B"], root)).code).toBe(0);
    const ids = readdirSync(join(root, ".git", ".nen", "stop-ids")).sort();
    expect(ids).toEqual(["R-2026-10-22-01", "R-2026-10-22-02", "R-2026-10-22-03"]);
    const second = JSON.parse(readFileSync(join(root, ".git", ".nen", "stops", "HA-IS-%23401", "2.json"), "utf8"));
    expect(second).toMatchObject({ id: "R-2026-10-22-03", n: 2 });
    // A new day starts at 01 again; the date is part of the id.
    expect((await run([...BASE, "--pick", "A"], root, seams(null, "2026-10-23T00:00:01Z"))).code).toBe(0);
    expect(readdirSync(join(root, ".git", ".nen", "stop-ids"))).toContain("R-2026-10-23-01");
  });

  it("takes the next number when a racing writer already reserved it", async () => {
    const root = repo();
    mkdirSync(join(root, ".git", ".nen", "stop-ids"), { recursive: true });
    // A reservation with no record: an id burned by a writer that failed after reserving.
    writeFileSync(join(root, ".git", ".nen", "stop-ids", "R-2026-10-22-01"), "");
    const result = await run([...BASE, "--pick", "A"], root, seams(), true);
    expect(JSON.parse(result.out.join("\n")).record.id).toBe("R-2026-10-22-02");
  });

  it("--dry-run writes nothing and names the next free id", async () => {
    const root = repo();
    const result = await run([...BASE, "--pick", "A", "--dry-run"], root);
    expect(result.code).toBe(0);
    expect(result.out[0]).toMatch(/^\(dry run\) would record R-2026-10-22-01 -> /);
    expect(existsSync(join(root, ".git", ".nen"))).toBe(false);
  });

  it("refuses (exit 2) what the caller typed wrong, writing nothing", async () => {
    const root = repo();
    const cases: (readonly string[])[] = [
      [...BASE],
      [...BASE, "--pick", "A", "--typed-file", "typed.txt"],
      [...BASE, "--pick", "Z"],
      [...BASE.filter((token, i, all): boolean => token !== "--gate" && all[i - 1] !== "--gate"), "--pick", "A"],
      [...BASE.map((token): string => (token === "G5" ? "G9" : token)), "--pick", "A"],
      [...BASE.slice(0, 10), "--pick", "A"],
      [...BASE, "--option", "A=dup::again", "--pick", "A"],
      [...BASE, "--option", "C=no consequence", "--pick", "A"],
      [...BASE, "--option", "C=Discard the tree::same label as B", "--pick", "A"],
      [...BASE, "--pick", "A", "--mark"],
      [...BASE, "--pick", "A", "--title", "t"],
      [...BASE.map((token): string => (token === "HA-IS-#401" ? "../escape" : token)), "--pick", "A"],
      [...BASE.map((token): string => (token === "q.md" ? "missing.md" : token)), "--pick", "A"],
      ["stop", "answer", "bogus"],
    ];
    for (const argv of cases) {
      const result = await run(argv, root);
      expect(result.code, argv.join(" ")).toBe(2);
    }
    expect(existsSync(join(root, ".git", ".nen"))).toBe(false);
  });

  it("is exit 1, writing nothing, when git cannot name the common directory", async () => {
    const root = repo();
    const result = await run([...BASE, "--pick", "A"], root, seams({ code: 128, stdout: "", stderr: "fatal: not a git repository\n", spawnFailed: false }));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not read the git common directory/);
  });

  it("refuses the answer flags on the banner form", async () => {
    const root = repo();
    for (const argv of [["stop", "--pick", "A"], ["stop", "--option", "A=a::b"], ["stop", "--dry-run"], ["stop", "--record", "x"]]) {
      expect((await run(argv, root)).code, argv.join(" ")).toBe(2);
    }
  });
  it("refuses a .nen that links out of the common directory, creating nothing through it", async () => {
    const root = repo();
    const outside = mkdtempSync(join(tmpdir(), "nen-stop-outside-"));
    symlinkSync(outside, join(root, ".git", ".nen"));
    const result = await run([...BASE, "--pick", "A"], root);
    expect(result.code).toBe(2);
    expect(readdirSync(outside)).toEqual([]);
    // The dry run refuses exactly what the real run would, and no id is burned.
    expect((await run([...BASE, "--pick", "A", "--dry-run"], root)).code).toBe(2);
  });
});

describe("nen stop answer show", () => {
  it("lists every record in order, and an absent ledger is empty at exit 0", async () => {
    const root = repo();
    const empty = await run(["stop", "answer", "show", "HA-IS-#401"], root);
    expect(empty.code).toBe(0);
    expect(empty.out[0]).toMatch(/^no stop answers recorded for 'HA-IS-#401'/);
    await run([...BASE, "--pick", "A"], root);
    await run([...BASE, "--typed-file", "typed.txt"], root);
    const listed = await run(["stop", "answer", "show", "HA-IS-#401"], root, seams(), true);
    expect(listed.code).toBe(0);
    const doc = JSON.parse(listed.out.join("\n"));
    expect(doc.records.map((r: { id: string; kind: string }): string => `${r.id}:${r.kind}`)).toEqual(["R-2026-10-22-01:picked", "R-2026-10-22-02:typed"]);
    const text = await run(["stop", "answer", "show", "HA-IS-#401"], root);
    expect(text.out[1]).toMatch(/^R-2026-10-22-02  G5  kurapika  typed: Take the/);
  });

  it("is exit 1 on a record it cannot read, never a shorter ledger", async () => {
    const root = repo();
    await run([...BASE, "--pick", "A"], root);
    writeFileSync(join(root, ".git", ".nen", "stops", "HA-IS-%23401", "2.json"), "{ not json");
    const result = await run(["stop", "answer", "show", "HA-IS-#401"], root);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/2\.json' could not be read as JSON/);
  });

  it("refuses a record that is a symbolic link", async () => {
    const root = repo();
    await run([...BASE, "--pick", "A"], root);
    const elsewhere = join(root, "elsewhere.json");
    writeFileSync(elsewhere, "{}");
    symlinkSync(elsewhere, join(root, ".git", ".nen", "stops", "HA-IS-%23401", "2.json"));
    expect((await run(["stop", "answer", "show", "HA-IS-#401"], root)).code).toBe(2);
  });

  it("refuses a missing effort id and write-only flags", async () => {
    const root = repo();
    expect((await run(["stop", "answer", "show"], root)).code).toBe(2);
    expect((await run(["stop", "answer", "show", "x", "--dry-run"], root)).code).toBe(2);
    expect((await run(["stop", "answer", "show", "x", "--pick", "A"], root)).code).toBe(2);
  });
});

describe("stop answer helpers", () => {
  it("parses <key>=<label>::<consequence>, keeping '=' and ':' inside the label and consequence", () => {
    expect(parseOptionSpec("b=Use x=y::costs: one rerun")).toEqual({ key: "b", label: "Use x=y", consequence: "costs: one rerun" });
    expect((): unknown => parseOptionSpec("=label::c")).toThrow(/key/);
    expect((): unknown => parseOptionSpec("a=::c")).toThrow(/label is empty/);
    expect((): unknown => parseOptionSpec("a=l::")).toThrow(/consequence is empty/);
  });

  it("formats ids with at least two digits", () => {
    expect(formatId("2026-10-22", 3)).toBe("R-2026-10-22-03");
    expect(formatId("2026-10-22", 104)).toBe("R-2026-10-22-104");
  });

  it("refuses effort ids that could leave the stops directory", () => {
    for (const id of ["", "/abs", "a/../b", ".", "..", "a\\b", "C:x"]) {
      expect((): unknown => effortDirectory("/c", id), id).toThrow();
    }
    expect(effortDirectory("/c", "a/b")).toBe(resolve("/c", ".nen", "stops", "a%2Fb"));
  });

  it("names a record's first defect", () => {
    expect(recordDefect([], "e", 1)).toMatch(/not a JSON object/);
    expect(recordDefect({ contract: "x" }, "e", 1)).toMatch(/is not a nen.stop.answer/);
    expect(recordDefect({ contract: STOP_ANSWER_CONTRACT, effortId: "f" }, "e", 1)).toMatch(/records the effort/);
    expect(recordDefect({ contract: STOP_ANSWER_CONTRACT, effortId: "e", n: 2 }, "e", 1)).toMatch(/named 1.json/);
    const good = {
      contract: STOP_ANSWER_CONTRACT, id: "R-2026-10-22-01", effortId: "e", n: 1, gate: "G5", who: "w", question: "q",
      options: [{ key: "A", label: "a", consequence: "c" }], kind: "picked", pick: "A", typed: null, answeredAt: "t",
    };
    expect(recordDefect(good, "e", 1)).toBeNull();
    expect(recordDefect({ ...good, pick: "Z" }, "e", 1)).toMatch(/none of its options' keys/);
    expect(recordDefect({ ...good, options: [1] }, "e", 1)).toMatch(/not an object/);
    expect(recordDefect({ ...good, options: [{ key: "A" }] }, "e", 1)).toMatch(/string key, label and consequence/);
  });
});

describe("izanami classifies stop answer", () => {
  it("is mutating unless --dry-run, show is read-only, and a subcommand behind a flag is unknown", () => {
    expect(classifyCommand("nen stop answer --record e --gate G5 --pick A").classification).toBe("mutating");
    expect(classifyCommand("nen stop answer --record e --dry-run").classification).toBe("read-only");
    expect(classifyCommand("nen stop answer show e --json").classification).toBe("read-only");
    expect(classifyCommand("nen stop --gate G5 answer --record e").classification).toBe("unknown");
    expect(classifyCommand("nen stop --repo . clear").classification).toBe("unknown");
    expect(classifyCommand("nen stop --gate G4").classification).toBe("read-only");
  });
});
