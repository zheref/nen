// src/schema/set.test.ts -- `nen schema set` through ../index.ts's real
// `run()`: the pre-registry dispatch, its own flag spec, and its exit codes.

import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, schemaSubcommand, type Io } from "../index.js";
import { GATE_EXCEPTIONS, GATE_SCOPES, gateChange, parseSetPointer, parseSetValue, readFromRaw, SchemaSetUsageError, SETTABLE_FILES, touchedPointers, touchesCanonPin } from "./set.js";

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
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "85", "--gate-change"));
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
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/monitor/pollSeconds", "--value", "600", "--json"));
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n")) as Record<string, unknown>;
    expect(doc).toMatchObject({ file: "nen/workflow.json", pointer: "/monitor/pollSeconds", before: 300, after: 600, written: true, op: "replace", read: true, gateChange: false });
    expect(typeof doc["line"]).toBe("number");
  });

  it("--dry-run shows before -> after and writes nothing", async () => {
    const root = site();
    const mtime = statSync(join(root, "nen", "workflow.json")).mtimeMs;
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "85", "--dry-run", "--gate-change"));
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("change: 80 -> 85");
    expect(result.out.join("\n")).toContain("written: nothing (--dry-run)");
    expect(read(root)).toBe(WORKFLOW);
    expect(statSync(join(root, "nen", "workflow.json")).mtimeMs).toBe(mtime);
    const json = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "85", "--dry-run", "--json", "--gate-change"));
    expect(JSON.parse(json.out.join("\n"))).toMatchObject({ before: 80, after: 85, dryRun: true, written: false, changed: true });
  });

  it("a value already set writes nothing and says so", async () => {
    const root = site();
    const mtime = statSync(join(root, "nen", "workflow.json")).mtimeMs;
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "80", "--gate-change"));
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("written: nothing (/coverage/minimum is already 80)");
    expect(statSync(join(root, "nen", "workflow.json")).mtimeMs).toBe(mtime);
  });

  it("keeps the file's permission bits", async () => {
    const root = site();
    chmodSync(join(root, "nen", "workflow.json"), 0o640);
    expect((await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "85", "--gate-change"))).code).toBe(0);
    if (process.platform !== "win32") expect(statSync(join(root, "nen", "workflow.json")).mode & 0o777).toBe(0o640);
  });

  it("leaves every $ note untouched in a file dense with them, in every settable file", async () => {
    const root = site(METADATA_REPO);
    const before = read(root, "nen/gates.json");
    const result = await capture(set(root, "--file", "nen/gates.json", "--pointer", "/reviewers/0/delivery_holistic_pass", "--value", "false", "--gate-change"));
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
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", '"high"', "--gate-change"));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("at coverage.minimum, expected a number");
    expect(result.err.join("\n")).toContain("nothing was written");
    expect(read(root)).toBe(WORKFLOW);
  });

  it("refuses a cross-field violation the loader catches (a ladder that does not ascend)", async () => {
    const root = site();
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "95", "--json", "--gate-change"));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: false, written: false, failure: { code: "invalid" } });
    expect(read(root)).toBe(WORKFLOW);
  });

  it("refuses an unknown gates.json key the loader refuses", async () => {
    const root = site(METADATA_REPO);
    const before = read(root, "nen/gates.json");
    const result = await capture(set(root, "--file", "nen/gates.json", "--pointer", "/not_a_gate", "--value", "1", "--gate-change"));
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
    const result = await capture(set(root, "--file", "nen/gates.json", "--pointer", "/version", "--value", "1", "--gate-change", "--json"));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: false, failure: { code: "no-file" } });
  });

  it("exit 1: a path the file does not have, a structure, a repeated member", async () => {
    const root = site();
    for (const [pointer, code] of [
      ["/nothing/here", "refused-edit"],
      ["/monitor", "refused-edit"],
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

  it.skipIf(process.platform === "win32")("exit 1 (symlink): a declaration that links out of the repository is refused, and the target is untouched", async () => {
    const root = site();
    const outside = mkdtempSync(join(tmpdir(), "nen-set-outside-"));
    temps.push(outside);
    writeFileSync(join(outside, "workflow.json"), WORKFLOW);
    rmSync(join(root, "nen", "workflow.json"));
    symlinkSync(join(outside, "workflow.json"), join(root, "nen", "workflow.json"));
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/monitor/maxCycles", "--value", "25", "--json"));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: false, written: false, failure: { code: "symlink" } });
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

describe("nen schema set -- gate changes fail closed (Feitan F1, Nobunaga R1)", () => {
  const gated = async (root: string, file: string, pointer: string, value: string): Promise<void> => {
    const before = read(root, file);
    const bare = await capture(set(root, "--file", file, "--pointer", pointer, "--value", value));
    expect(bare.code, `${file} ${pointer}`).toBe(2);
    expect(bare.err.join("\n"), pointer).toContain("is a gate change");
    expect(bare.err.join("\n"), pointer).toContain("--gate-change");
    expect(read(root, file)).toBe(before);
  };

  it("one regression per family: refused without the flag, the file untouched", async () => {
    const root = site(METADATA_REPO);
    // gates.json: a reviewer's flags, and the dependabot carve-out.
    await gated(root, "nen/gates.json", "/reviewers/0/delivery_holistic_pass", "false");
    await gated(root, "nen/gates.json", "/reviewers/2/bounded_policy_exempt", "false");
    await gated(root, "nen/gates.json", "/dependabot_carve_out/satisfied_by_context/0", '"anything / green"');
    // contract.json: the dependency's probe and the bootstrap's sha256, a lane's cwd.
    await gated(root, "nen/contract.json", "/dependency/version_probe/0", '"sh"');
    await gated(root, "nen/contract.json", "/dependency/bootstrap/sha256", '"0000"');
    await gated(root, "nen/contract.json", "/project/lanes/web/cwd", '"elsewhere"');
    // workflow.json: review scopes.
    await gated(root, "nen/workflow.json", "/review/scopes/security/paths/0", '"nothing/**"');
    // decisions.json: a row's class, both steps of ask-once -> autonomous.
    await gated(root, "nen/decisions.json", "/rows/1/default", '"nen label apply <ref> --label canon --run"');
    await gated(root, "nen/decisions.json", "/rows/1/class", '"autonomous"');
  });

  it("with the flag, writes and says so: a security-relevant line, and gateChange: true", async () => {
    const root = site();
    const human = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/branch/base", "--value", '"trunk"', "--gate-change", "--dry-run"));
    expect(human.code).toBe(0);
    expect(human.out.join("\n")).toContain("security-relevant: /branch/base is a gate change -- branch is the trunk");
    const json = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/branch/base", "--value", '"trunk"', "--gate-change", "--json"));
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out.join("\n"))).toMatchObject({ gateChange: true, written: true, after: "trunk" });
  });

  it("an added object is matched key path by key path: no gated key rides in under its parent", () => {
    expect(gateChange("nen/contract.json", ["project", "verbs", "release-guard", "build"], { exe: "sh", args: ["-c", "true"] })).not.toBeNull();
    expect(gateChange("nen/gates.json", ["dependabot_carve_out"], { author_pattern: { pattern: "^.+$" }, satisfied_by_context: [] })).not.toBeNull();
    // An ungated parent, a gated key inside: the segment rule finds it.
    const hit = gateChange("nen/contract.json", ["mechanical", "mirrors", "0", "regen"], { args: ["x"] });
    expect(hit?.segments).toEqual(["mechanical", "mirrors", "0", "regen", "args"]);
    expect(touchedPointers(["a"], { b: [1, { c: 2 }] })).toEqual([["a"], ["a", "b"], ["a", "b", "0"], ["a", "b", "1"], ["a", "b", "1", "c"]]);
  });

  it("the added-object bypass is refused through the verb, naming the inner pointer", async () => {
    const root = site(METADATA_REPO);
    const result = await capture(set(root, "--file", "nen/contract.json", "--pointer", "/project/verbs/web/guard", "--value", '{"exe":"sh","args":["-c","true"]}'));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("is a gate change");
  });

  it("each named exception is no gate: why in a decision row, and a note", async () => {
    expect(GATE_EXCEPTIONS.map((exception): string => `${exception.file}:${exception.key}`)).toEqual(["nen/decisions.json:why", "*:note"]);
    const root = site(METADATA_REPO);
    const why = await capture(set(root, "--file", "nen/decisions.json", "--pointer", "/rows/0/why", "--value", '"nothing is discarded"', "--json"));
    expect(why.code, why.err.join("\n")).toBe(0);
    expect(JSON.parse(why.out.join("\n"))).toMatchObject({ gateChange: false, written: true });
    expect(gateChange("nen/contract.json", ["project", "verbs", "web", "build", "note"], "prose")).toBeNull();
    expect(gateChange("nen/gates.json", ["reviewers", "0", "note"], "prose")).toBeNull();
    // An exception covers the key itself, never a structure under it.
    expect(gateChange("nen/contract.json", ["project", "verbs", "web", "note"], { exe: "sh" })).not.toBeNull();
    expect(gateChange("nen/decisions.json", ["rows", "0", "why", "x"], "y")).not.toBeNull();
  });

  it("--gate-change on an edit that is no gate change is exit 2", async () => {
    const root = site();
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/monitor/maxCycles", "--value", "25", "--gate-change"));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain("--gate-change was given, but /monitor/maxCycles is not a gate change; drop the flag, or report the missing rule");
    expect(read(root)).toBe(WORKFLOW);
  });

  it("the canon pin is refused at exit 2 with or without the flag, naming canon pin --write", async () => {
    const root = site(METADATA_REPO);
    writeFileSync(join(root, "nen", "repos.json"), '{ "maintained_tools": [ { "repo": "owner/handbooks", "pinned": "v1.0.0" } ], "consumers": [], "product_codes": {} }\n');
    for (const extra of [[], ["--gate-change"]]) {
      const result = await capture(set(root, "--file", "nen/repos.json", "--pointer", "/maintained_tools/0/pinned", "--value", '"v9.9.9"', ...extra));
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toContain("nen canon pin --write");
    }
    expect(touchesCanonPin("nen/repos.json", ["consumers", "0", "pinned"], "v1")).toBe(false);
  });

  it("every scope names a settable file", () => {
    for (const scope of GATE_SCOPES) expect(SETTABLE_FILES).toContain(scope.file);
    expect(gateChange("nen/workflow.json", ["monitor", "maxCycles"], 1)).toBeNull();
    expect(gateChange("nen/workflow.json", ["coverage", "ideal"], 95)).not.toBeNull();
    expect(gateChange("nen/labels.json", ["labels", "0", "color"], "ffffff")).toBeNull();
  });
});

describe("nen schema set -- the file must be a real declaration in a real nen/ (Feitan F2, Nobunaga R3)", () => {
  it.skipIf(process.platform === "win32")("exit 1 (symlink): a declaration linked to another file inside the repository", async () => {
    const root = site();
    writeFileSync(join(root, "elsewhere.json"), WORKFLOW);
    rmSync(join(root, "nen", "workflow.json"));
    symlinkSync(join(root, "elsewhere.json"), join(root, "nen", "workflow.json"));
    const result = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/monitor/maxCycles", "--value", "25", "--json"));
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ ok: false, written: false, failure: { code: "symlink" } });
    expect(readFileSync(join(root, "elsewhere.json"), "utf8")).toBe(WORKFLOW);
  });

  it.skipIf(process.platform === "win32")("exit 1 (symlink): a declaration linked into .git, and a nen/ that is itself a link into .git", async () => {
    const root = site();
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, ".git", "config"), '{ "monitor": { "maxCycles": 20 } }\n');
    rmSync(join(root, "nen", "workflow.json"));
    symlinkSync(join(root, ".git", "config"), join(root, "nen", "workflow.json"));
    const file = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/monitor/maxCycles", "--value", "25", "--json"));
    expect(file.code).toBe(1);
    expect(JSON.parse(file.out.join("\n"))).toMatchObject({ failure: { code: "symlink" } });
    expect(readFileSync(join(root, ".git", "config"), "utf8")).toContain('"maxCycles": 20');

    const dir = site();
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "workflow.json"), WORKFLOW);
    rmSync(join(dir, "nen"), { recursive: true });
    symlinkSync(join(dir, ".git"), join(dir, "nen"));
    const linked = await capture(set(dir, "--file", "nen/workflow.json", "--pointer", "/monitor/maxCycles", "--value", "25", "--json"));
    expect(linked.code).toBe(1);
    expect(JSON.parse(linked.out.join("\n"))).toMatchObject({ failure: { code: "symlink", message: expect.stringContaining("is a symbolic link") as unknown } });
    expect(readFileSync(join(dir, ".git", "workflow.json"), "utf8")).toBe(WORKFLOW);
  });
});

describe("nen schema set -- what the loader reads (N2, R2) and what was already broken (N7)", () => {
  it("a key the typed model does not carry is written and reported so, read: false", async () => {
    const root = site();
    const human = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/monitor/note", "--value", '"kept"', "--dry-run"));
    expect(human.code).toBe(0);
    expect(human.out.join("\n")).toContain("the loader's typed model is unchanged -- /monitor/note is kept verbatim");
    expect(human.out.join("\n")).not.toContain("validated: ");
    const json = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/monitor/note", "--value", '"kept"', "--json"));
    expect(JSON.parse(json.out.join("\n"))).toMatchObject({ read: false, written: true });
    const readKey = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/monitor/maxCycles", "--value", "25", "--json"));
    expect(JSON.parse(readKey.out.join("\n"))).toMatchObject({ read: true });
  });

  it("a key a command reads from the raw form counts as read: an invocation's artifacts", async () => {
    const root = site(METADATA_REPO);
    const result = await capture(set(root, "--file", "nen/contract.json", "--pointer", "/project/verbs/web/build/artifacts", "--value", '["out/report.xml"]', "--gate-change", "--json"));
    expect(result.code, result.err.join("\n")).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ op: "add", read: true, gateChange: true });
    expect(readFromRaw("nen/contract.json", ["project", "verbs", "web", "build", "artifacts"], [])).toBe(true);
  });

  it("a key a command reads from the raw form counts as read: the bootstrap's sha256", async () => {
    const root = site(METADATA_REPO);
    const result = await capture(set(root, "--file", "nen/contract.json", "--pointer", "/dependency/bootstrap/sha256", "--value", '"abc"', "--gate-change", "--json"));
    expect(result.code, result.err.join("\n")).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ read: true, gateChange: true });
    expect(readFromRaw("nen/contract.json", ["dependency", "minimum_semantics"], "x")).toBe(true);
  });

  it("names a failure that was already there, and allows the edit that repairs it", async () => {
    const root = site();
    writeFileSync(join(root, "nen", "workflow.json"), WORKFLOW.replace('"minimum": 80', '"minimum": 95'));
    const still = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/monitor/maxCycles", "--value", "25"));
    expect(still.code).toBe(1);
    expect(still.err.join("\n")).toContain("the file already fails its loader:");
    expect(still.err.join("\n")).toContain("does not ascend");
    const repair = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "80", "--json", "--gate-change"));
    expect(repair.code).toBe(0);
    expect(JSON.parse(repair.out.join("\n"))).toMatchObject({ repaired: true, written: true, read: true });
    expect(read(root)).toBe(WORKFLOW);
  });

  it("exit 2: an empty pointer segment, and replacing a scalar with an object (N1)", async () => {
    const root = site();
    expect((await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage/", "--value", "1"))).code).toBe(2);
    expect((await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/coverage//minimum", "--value", "1"))).code).toBe(2);
    const object = await capture(set(root, "--file", "nen/workflow.json", "--pointer", "/monitor/maxCycles", "--value", '{"a":1}', "--json"));
    expect(object.code).toBe(1);
    expect(JSON.parse(object.out.join("\n"))).toMatchObject({ failure: { code: "refused-edit", message: expect.stringContaining("not supported in v1") as unknown } });
    expect(read(root)).toBe(WORKFLOW);
  });
});

describe("nen schema set -- the subcommand after flags (N4)", () => {
  it("finds set past --repo and --json before it", async () => {
    const root = site();
    const repoFirst = await capture(["schema", "--repo", root, "set", "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "85", "--dry-run", "--gate-change"]);
    expect(repoFirst.code).toBe(0);
    const jsonFirst = await capture(["schema", "--json", "set", "--repo", root, "--file", "nen/workflow.json", "--pointer", "/coverage/minimum", "--value", "85", "--dry-run", "--gate-change"]);
    expect(jsonFirst.code).toBe(0);
    expect(JSON.parse(jsonFirst.out.join("\n"))).toMatchObject({ dryRun: true });
    expect(schemaSubcommand(["schema", "--repo=x", "set"])).toBe("set");
    expect(schemaSubcommand(["schema", "--file", "set", "check"])).toBe("check");
    expect((await capture(["schema", "--json", "check", "--repo", root])).code).toBe(1);
  });

  it("strips control characters from the usage-error lines", async () => {
    const result = await capture(["schema", "set", "--bogus\u001b[2J"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).not.toContain("\u001b");
  });
});

describe("schema set -- families (#453)", () => {
  const family = { name: "sample-product", spec: { repo: "owner/product-spec", role: "spec", gate: "G2" }, members: [{ code: "RA", platform: "ios" }] };
  it("requires --gate-change for nested and whole family declarations", async () => {
    const root = site();
    const text = JSON.stringify({ consumers: [], product_codes: { RA: "owner/product-ios" }, families: [family] });
    writeFileSync(join(root, "nen/repos.json"), text);
    for (const [pointer, value] of [["/families/0/spec/repo", '"owner/other-spec"'], ["/families", JSON.stringify([{ ...family, name: "other" }])]]) {
      const refused = await capture(set(root, "--file", "nen/repos.json", "--pointer", pointer as string, "--value", value as string, "--dry-run"));
      expect(refused.code).toBe(2);
      expect(refused.err.join("\n")).toContain("--gate-change");
      const allowed = await capture(set(root, "--file", "nen/repos.json", "--pointer", pointer as string, "--value", value as string, "--dry-run", "--gate-change", "--json"));
      if (pointer === "/families") {
        // Gate acknowledgement does not widen schema set's scalar-only replacement contract.
        expect(allowed.code).toBe(1);
        expect(JSON.parse(allowed.out.join("\n"))).toMatchObject({ written: false, failure: { code: "refused-edit" } });
      } else {
        expect(allowed.code).toBe(0);
        expect(JSON.parse(allowed.out.join("\n"))).toMatchObject({ read: true, gateChange: true, written: false });
      }
      expect(read(root, "nen/repos.json")).toBe(text);
    }
  });
  it("gates adding a previously absent whole family block, then validates it", async () => {
    const root = site();
    const text = JSON.stringify({ consumers: [], product_codes: { RA: "owner/product-ios" } });
    writeFileSync(join(root, "nen/repos.json"), text);
    const args = ["--file", "nen/repos.json", "--pointer", "/families", "--value", JSON.stringify([family]), "--dry-run", "--json"];
    expect((await capture(set(root, ...args))).code).toBe(2);
    const allowed = await capture(set(root, ...args, "--gate-change"));
    expect(allowed.code).toBe(0);
    expect(JSON.parse(allowed.out.join("\n"))).toMatchObject({ read: true, gateChange: true, written: false });
    expect(read(root, "nen/repos.json")).toBe(text);
  });
  it("refuses invalid member codes in a dry run through the shared loader, with no write", async () => {
    const root = site();
    const text = JSON.stringify({ consumers: [], product_codes: { RA: "owner/product-ios" }, families: [family] });
    writeFileSync(join(root, "nen/repos.json"), text);
    const result = await capture(set(root, "--file", "nen/repos.json", "--pointer", "/families/0/members/0/code", "--value", '"missing"', "--dry-run", "--gate-change"));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toContain("families[0].members[0].code");
    expect(read(root, "nen/repos.json")).toBe(text);
  });
});
