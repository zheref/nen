// src/schema/set.test.ts -- `nen schema set` through ../index.ts's real
// `run()`: the pre-registry dispatch, its own flag spec, and its exit codes.

import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Io } from "../index.js";
import { parseSetPointer, parseSetValue, SchemaSetUsageError, SETTABLE_FILES } from "./set.js";

const METADATA_REPO = join(process.cwd(), "src", "schema", "fixtures", "metadata-repo");
const WORKFLOW = readFileSync(join(process.cwd(), "nen", "workflow.json"), "utf8");

const temps: string[] = [];
afterEach((): void => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A repository root carrying nen's own nen/workflow.json, or a copy of `from`. */
function site(from?: string): string {
  const root = mkdtempSync(join(tmpdir(), "nen-set-"));
  temps.push(root);
  if (from === undefined) {
    mkdirSync(join(root, "nen"));
    writeFileSync(join(root, "nen", "workflow.json"), WORKFLOW);
  } else {
    cpSync(from, root, { recursive: true });
  }
  return root;
}

async function capture(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
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
  return { code: await run(argv, io), out, err };
}

const set = (root: string, ...rest: string[]): string[] => ["schema", "set", "--repo", root, ...rest];
const read = (root: string, file = "nen/workflow.json"): string => readFileSync(join(root, ...file.split("/")), "utf8");

describe("nen schema set -- the write", () => {
  it("replaces one scalar, touches no other line, and reads it back", async () => {
    const root = site();
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "85"));
    expect(result.code).toBe(0);
    const after = read(root);
    expect(after).toBe(WORKFLOW.replace('"minimum": 80,', '"minimum": 85,'));
    const text = result.out.join("\n");
    expect(text).toContain("change: 80 -> 85");
    expect(text).toContain("validated: nen/workflow.json's loader accepts the result");
    expect(text).toContain("read back: /coverage/minimum is 85");
  });

  it("adds a member to an existing object, in its own style", async () => {
    const root = site();
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/monitor/note", "--value", '"kept"', "--json"));
    expect(result.code).toBe(0);
    expect(read(root)).toBe(WORKFLOW.replace('"monitor": { "maxCycles": 20, "pollSeconds": 300 }', '"monitor": { "maxCycles": 20, "pollSeconds": 300, "note": "kept" }'));
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc).toMatchObject({ contract: "nen.schema.set/v0.1", ok: true, file: "nen/workflow.json", pointer: "/monitor/note", op: "add", before: null, after: "kept", changed: true, dryRun: false, written: true, failure: null });
  });

  it("--json carries { file, pointer, before, after, written } on a replace", async () => {
    const root = site();
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/branch/base", "--value", '"trunk"', "--json"));
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc).toMatchObject({ file: "nen/workflow.json", pointer: "/branch/base", before: "main", after: "trunk", written: true, op: "replace" });
    expect(typeof doc["line"]).toBe("number");
  });

  it("--dry-run shows before -> after and writes nothing", async () => {
    const root = site();
    const mtime = statSync(join(root, "nen", "workflow.json")).mtimeMs;
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "85", "--dry-run"));
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("change: 80 -> 85");
    expect(result.out.join("\n")).toContain("written: nothing (--dry-run)");
    expect(read(root)).toBe(WORKFLOW);
    expect(statSync(join(root, "nen", "workflow.json")).mtimeMs).toBe(mtime);
    const json = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "85", "--dry-run", "--json"));
    expect(JSON.parse(json.out.join("\n"))).toMatchObject({ before: 80, after: 85, dryRun: true, written: false, changed: true });
  });

  it("a value already set writes nothing and says so", async () => {
    const root = site();
    const mtime = statSync(join(root, "nen", "workflow.json")).mtimeMs;
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "80"));
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("written: nothing (/coverage/minimum is already 80)");
    expect(statSync(join(root, "nen", "workflow.json")).mtimeMs).toBe(mtime);
  });

  it("keeps the file's permission bits", async () => {
    const root = site();
    chmodSync(join(root, "nen", "workflow.json"), 0o640);
    expect((await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "85"))).code).toBe(0);
    if (process.platform !== "win32") expect(statSync(join(root, "nen", "workflow.json")).mode & 0o777).toBe(0o640);
  });

  it("leaves every $ note untouched in a file dense with them, in every settable file", async () => {
    const root = site(METADATA_REPO);
    const before = read(root, "nen/gates.json");
    const result = await capture(set(root, "--file", "nen/gates.json", "--pointer", "/reviewers/0/delivery_holistic_pass", "--value", "false"));
    expect(result.code).toBe(0);
    const after = read(root, "nen/gates.json");
    const changed = after.split("\n").filter((line, index): boolean => line !== before.split("\n")[index]);
    expect(changed).toEqual(['      "delivery_holistic_pass": false,']);
    expect((await capture(["schema", "check", "--repo", root])).code).toBe(0);
  });

  it("offers exactly the JSON declarations", () => {
    expect(SETTABLE_FILES).toEqual(["nen/labels.json", "nen/repos.json", "nen/gates.json", "nen/contract.json", "nen/workflow.json", "nen/decisions.json"]);
  });
});

describe("nen schema set -- validated by the loader before the write", () => {
  it("refuses a value the loader refuses, exit 1, the file byte-identical", async () => {
    const root = site();
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", '"high"'));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("at coverage.minimum, expected a number");
    expect(result.err.join("\n")).toContain("nothing was written");
    expect(read(root)).toBe(WORKFLOW);
  });

  it("refuses a cross-field violation the loader catches (a ladder that does not ascend)", async () => {
    const root = site();
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "95", "--json"));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: false, written: false, failure: { code: "invalid" } });
    expect(read(root)).toBe(WORKFLOW);
  });

  it("refuses an unknown gates.json key the loader refuses", async () => {
    const root = site(METADATA_REPO);
    const before = read(root, "nen/gates.json");
    const result = await capture(set(root, "--file", "nen/gates.json", "--pointer", "/not_a_gate", "--value", "1"));
    expect(result.code).toBe(1);
    expect(read(root, "nen/gates.json")).toBe(before);
  });
});

describe("nen schema set -- refusals", () => {
  it("exit 2: a $ segment, colors.yml, an unknown file, a missing flag, a value that is not JSON, a stray argument", async () => {
    const root = site();
    const cases: string[][] = [
      ["--file", "nen/workflow.json", "--pointer", "/$comment", "--value", "1"],
      ["--file", "nen/workflow.json", "--pointer", "/models/$note/x", "--value", "1"],
      ["--file", "nen/colors.yml", "--pointer", "/version", "--value", "1"],
      ["--file", "nen/other.json", "--pointer", "/a", "--value", "1"],
      ["--file", "./nen/workflow.json", "--pointer", "/a", "--value", "1"],
      ["--file", "nen/workflow.json", "--pointer", "/coverage/minimum"],
      ["--file", "nen/workflow.json", "--pointer", "coverage/minimum", "--value", "1"],
      ["--file", "nen/workflow.json", "--pointer", "", "--value", "1"],
      ["--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "eighty"],
      ["--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "1", "extra"],
      ["--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "1", "--target", "x"],
    ];
    for (const rest of cases) {
      const result = await capture(set(root, ...rest));
      expect(result.code, rest.join(" ")).toBe(2);
      expect(result.out, rest.join(" ")).toEqual([]);
    }
    expect(read(root)).toBe(WORKFLOW);
  });

  it("exit 1: an absent file is never created", async () => {
    const root = site();
    const result = await capture(set(root, "--file", "nen/gates.json", "--pointer", "/version", "--value", "1", "--json"));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: false, failure: { code: "no-file" } });
  });

  it("exit 1: a path the file does not have, a structure, a repeated member", async () => {
    const root = site();
    for (const [pointer, code] of [
      ["/nothing/here", "refused-edit"],
      ["/coverage", "refused-edit"],
    ] as const) {
      const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", pointer, "--value", "1", "--json"));
      expect(result.code, pointer).toBe(1);
      expect(JSON.parse(result.out.join("\n"))).toMatchObject({ failure: { code } });
    }
    writeFileSync(join(root, "nen", "workflow.json"), '{ "monitor": { "maxCycles": 20 }, "monitor": { "maxCycles": 30 } }\n');
    const repeated = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/monitor/maxCycles", "--value", "5"));
    expect(repeated.code).toBe(1);
    expect(repeated.err.join("\n")).toContain("more than once");
  });

  it("exit 1: a file that is not JSON", async () => {
    const root = site();
    writeFileSync(join(root, "nen", "workflow.json"), "{ nope");
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/a", "--value", "1"));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("is not valid JSON");
  });

  it.skipIf(process.platform === "win32")("exit 1: a declaration that links out of the repository is refused, and the target is untouched", async () => {
    const root = site();
    const outside = mkdtempSync(join(tmpdir(), "nen-set-outside-"));
    temps.push(outside);
    writeFileSync(join(outside, "workflow.json"), WORKFLOW);
    rmSync(join(root, "nen", "workflow.json"));
    symlinkSync(join(outside, "workflow.json"), join(root, "nen", "workflow.json"));
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "85", "--json"));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ failure: { code: "outside-repo" } });
    expect(readFileSync(join(outside, "workflow.json"), "utf8")).toBe(WORKFLOW);
  });

  it("exit 2: --repo that does not exist", async () => {
    const result = await capture(["schema", "set", "--repo", "/definitely/not/a/repo", "--file", "nen/workflow.json", "--pointer", "/a", "--value", "1"]);
    expect(result.code).toBe(2);
  });

  it("schema check still refuses set's flags, and --help documents both verbs and the $ contract", async () => {
    expect((await capture(["schema", "check", "--file", "nen/workflow.json"])).code).toBe(2);
    const help = await capture(["schema", "set", "--help"]);
    expect(help.code).toBe(0);
    const text = help.out.join("\n");
    expect(text).toContain("schema set --repo <path> --file <nen/...json> --pointer <JSON pointer> --value <JSON>");
    expect(text).toContain("'$'-PREFIXED KEYS ARE METADATA");
    expect((await capture(["schema", "--help"])).out.join("\n")).toBe(text);
  });
});

describe("parseSetValue / parseSetPointer", () => {
  it("reads JSON and refuses what it could not write back as typed", () => {
    expect(parseSetValue("85")).toBe(85);
    expect(parseSetValue('"main"')).toBe("main");
    expect(parseSetValue("null")).toBeNull();
    expect(parseSetValue("[1, 2]")).toEqual([1, 2]);
    expect((): unknown => parseSetValue("main")).toThrow(SchemaSetUsageError);
    expect((): unknown => parseSetValue("1e400")).toThrow(/cannot write back/);
    expect((): unknown => parseSetValue("12345678901234567890")).toThrow(/past 2\^53/);
    expect((): unknown => parseSetValue('{"a": 1e999}')).toThrow(/cannot write back/);
  });

  it("refuses the whole document, a $ segment anywhere, and __proto__", () => {
    expect(parseSetPointer("/a/b")).toEqual(["a", "b"]);
    expect((): unknown => parseSetPointer("")).toThrow(/whole document/);
    expect((): unknown => parseSetPointer("/a/$b/c")).toThrow(/metadata/);
    expect((): unknown => parseSetPointer("/__proto__/x")).toThrow(/__proto__/);
    expect((): unknown => parseSetPointer("a")).toThrow(SchemaSetUsageError);
  });
});
