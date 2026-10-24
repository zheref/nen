import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { defaultSeams, type Seams } from "../seam/exec.js";
import { runCommand } from "./command.js";
import { recordSchema, runIdMatches, validateRecord, type RecordSchema } from "./record.js";

const ID = "dowsing-chain-fixture-family-capture-20261022";
const RECORD = {
  schema: "hatsu.spec.run/v0.1",
  caller: "dowsing-chain",
  runId: ID,
  mode: "capture",
  family: "fixture-family",
  specRepo: "fixture-owner/fixture-spec",
  members: [{ code: "FA", platform: "android", sha: "0".repeat(40) }],
  scope: ["fixture-capability"],
  constitutionPr: "FS-PR-#1",
  wavePrs: [],
  folders: [],
  targets: [],
  clarify: { round: 0, asked: 0, answered: 0 },
  preAnswered: [],
  next: "constitution",
  at: "2026-10-22T00:00:00Z",
};

async function run(argv: readonly string[], env: Record<string, string | undefined>, repo: string | null = null): Promise<{ code: number; out: string[]; err: string[]; json: () => Record<string, unknown> }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); } };
  const seams: Seams = { ...defaultSeams(), env };
  const code = await runFamily(runCommand, ["run", ...argv], repo, true, io, seams);
  return { code, out, err, json: (): Record<string, unknown> => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

function input(value: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), "nen-record-in-")), "record.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

const schema = recordSchema("hatsu.spec.run/v0.1") as RecordSchema;

describe("nen run record", () => {
  it("writes the record whole at 0600 in a 0700 directory under XDG_STATE_HOME, and reads it back valid", async () => {
    const state = mkdtempSync(join(tmpdir(), "nen-record-state-"));
    const written = await run(["record", "write", "--schema", "hatsu.spec.run/v0.1", "--id", ID, "--from", input(RECORD)], { XDG_STATE_HOME: state });
    expect(written.code, written.err.join("\n")).toBe(0);
    const report = written.json();
    expect(Object.keys(report)).toEqual(["contract", "verdict", "schema", "id", "path", "problems", "record", "reason"]);
    const path = join(state, "hatsu", "specs", `${ID}.json`);
    expect(report).toMatchObject({ contract: "nen.run.record/v0.1", verdict: "written", path });
    // POSIX modes only: Windows reports 0o666/0o777 whatever was asked (src/canon/pin-write.test.ts's rule).
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(state, "hatsu", "specs")).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(join(state, "hatsu", "specs"))).toEqual([`${ID}.json`]);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(RECORD);
    const read = await run(["record", "read", "--schema", "hatsu.spec.run/v0.1", "--id", ID], { XDG_STATE_HOME: state });
    expect(read.code).toBe(0);
    expect(read.json()).toMatchObject({ verdict: "valid", record: RECORD });
  });

  it("falls back to $HOME/.local/state, and writes nothing on --dry-run", async () => {
    const home = mkdtempSync(join(tmpdir(), "nen-record-home-"));
    const dry = await run(["record", "write", "--schema", "hatsu.spec.run/v0.1", "--id", ID, "--from", input(RECORD), "--dry-run"], { HOME: home });
    expect(dry.json()).toMatchObject({ verdict: "would-write", path: join(home, ".local", "state", "hatsu", "specs", `${ID}.json`) });
    expect(() => statSync(join(home, ".local"))).toThrow();
  });

  it("says absent for a run never recorded, and could-not-read for a file that is not JSON or no state directory", async () => {
    const state = mkdtempSync(join(tmpdir(), "nen-record-state-"));
    const absent = await run(["record", "read", "--schema", "hatsu.spec.run/v0.1", "--id", ID], { XDG_STATE_HOME: state });
    expect(absent.code).toBe(1);
    expect(absent.json()["verdict"]).toBe("absent");
    mkdirSync(join(state, "hatsu", "specs"), { recursive: true });
    writeFileSync(join(state, "hatsu", "specs", `${ID}.json`), "{");
    expect((await run(["record", "read", "--schema", "hatsu.spec.run/v0.1", "--id", ID], { XDG_STATE_HOME: state })).json()["verdict"]).toBe("could-not-read");
    const nowhere = await run(["record", "read", "--schema", "hatsu.spec.run/v0.1", "--id", ID], { XDG_STATE_HOME: "relative/dir" });
    expect(nowhere.json()).toMatchObject({ verdict: "could-not-read", path: null });
    // A relative XDG_STATE_HOME is ignored, as the XDG spec says, and HOME's default applies (Nobunaga F10).
    const home = mkdtempSync(join(tmpdir(), "nen-record-home-"));
    const fallback = await run(["record", "read", "--schema", "hatsu.spec.run/v0.1", "--id", ID], { XDG_STATE_HOME: "relative/dir", HOME: home });
    expect(fallback.json()).toMatchObject({ verdict: "absent", path: join(home, ".local", "state", "hatsu", "specs", `${ID}.json`) });
    const garbled = join(mkdtempSync(join(tmpdir(), "nen-record-in-")), "record.json");
    writeFileSync(garbled, "{");
    const unread = await run(["record", "write", "--schema", "hatsu.spec.run/v0.1", "--id", ID, "--from", garbled], { XDG_STATE_HOME: state });
    expect(unread.code).toBe(1);
    expect(unread.json()).toMatchObject({ verdict: "could-not-read" });
  });

  it("refuses another schema, another caller, a runId that is not the file's and a field off its type, writing nothing", async () => {
    const state = mkdtempSync(join(tmpdir(), "nen-record-state-"));
    for (const [change, why] of [
      [{ schema: "hatsu.spec.run/v0.2" }, "not hatsu.spec.run/v0.1"],
      [{ caller: "kamui" }, "resume it with its own caller"],
      [{ runId: `${ID}-2` }, "not the file's"],
      [{ next: "build" }, "next is \"build\", not one of"],
      [{ members: [{ code: "FA" }] }, "members[0].platform is missing"],
      [{ targets: [{ code: "FA", folder: "x", story: "US1", issue: null, pr: null, state: "merged" }] }, "targets[0].state"],
      [{ at: "yesterday" }, "at \"yesterday\" does not match"],
      [{ members: [{ code: 1, platform: "android", sha: "0".repeat(40) }] }, "members[0].code is not a string"],
      [{ folders: [{ nnn: "001", slug: "list", status: "bogus", markers: { clarification: 0, ruling: 0, unverified: 0 } }] }, "folders[0].status is \"bogus\""],
      [{ folders: [{ nnn: "001", slug: "list", status: "captured", markers: "x" }] }, "folders[0].markers is not an object"],
      [{ clarify: { round: "a", asked: 0, answered: 0 } }, "clarify.round is not a whole number"],
      [{ members: [{ code: "FA", platform: "android", sha: "0".repeat(40), shaa: "x" }] }, "members[0].shaa is not a key of this row"],
    ] as const) {
      const result = await run(["record", "write", "--schema", "hatsu.spec.run/v0.1", "--id", ID, "--from", input({ ...RECORD, ...change })], { XDG_STATE_HOME: state });
      expect(result.code, why).toBe(1);
      expect(result.json()["verdict"]).toBe("invalid");
      expect((result.json()["problems"] as string[]).join("; ")).toContain(why);
    }
    expect(() => statSync(join(state, "hatsu"))).toThrow();
  });

  it("validates the run id whole before any path is built, and refuses the usage errors at exit 2", async () => {
    expect(runIdMatches(schema, ID)).toBe(true);
    expect(runIdMatches(schema, `${ID}\n`)).toBe(false);
    expect(runIdMatches(schema, `x${ID}`)).toBe(false);
    expect(runIdMatches(schema, "dowsing-chain-../../etc-capture-20261022")).toBe(false);
    const env = { XDG_STATE_HOME: mkdtempSync(join(tmpdir(), "nen-record-state-")) };
    for (const argv of [
      ["record", "read", "--schema", "hatsu.spec.run/v0.1", "--id", "../escape"],
      ["record", "read", "--schema", "other/v1", "--id", ID],
      ["record", "list", "--schema", "hatsu.spec.run/v0.1", "--id", ID],
      ["record", "write", "--schema", "hatsu.spec.run/v0.1", "--id", ID],
      ["record", "read", "--schema", "hatsu.spec.run/v0.1", "--id", ID, "--dry-run"],
      ["start", "--id", "x", "--target", "o/r", "--schema", "hatsu.spec.run/v0.1"],
    ]) {
      expect((await run(argv, env)).code, argv.join(" ")).toBe(2);
    }
    expect((await run(["record", "read", "--schema", "hatsu.spec.run/v0.1", "--id", ID], env, ".")).code).toBe(2);
  });

  it.skipIf(process.platform === "win32")("refuses a record directory that is a link, and writes nothing through it (Feitan F2)", async () => {
    const state = mkdtempSync(join(tmpdir(), "nen-record-state-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "nen-record-elsewhere-"));
    mkdirSync(join(state, "hatsu"));
    symlinkSync(elsewhere, join(state, "hatsu", "specs"));
    const result = await run(["record", "write", "--schema", "hatsu.spec.run/v0.1", "--id", ID, "--from", input(RECORD)], { XDG_STATE_HOME: state });
    expect(result.code).toBe(1);
    expect(result.json()).toMatchObject({ verdict: "could-not-read" });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("accepts Hatsu's own fixture record shape", () => {
    expect(validateRecord(schema, ID, RECORD)).toEqual([]);
  });
});
