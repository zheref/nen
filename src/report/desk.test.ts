import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { makeTempDir } from "../testing/tempdir.js";
import { reportCommand } from "./command.js";
import { assembleRegister, parseDesk } from "./register.js";

async function capture(args: string[], repo: string | null = null): Promise<{code: number; out: string; err: string}> {
  const out: string[] = [], err: string[] = [];
  const code = await runFamily(reportCommand, ["report", ...args], repo, false,
    { out: (s) => void out.push(s), err: (s) => void err.push(s) }, new ScriptedSeams([]));
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const baseDesk = { variant: "register", title: "Desk", scope: "local", gate: "G4", generatedAtLocal: "", footerNote: "", architectureCaption: "",
  gates: [{ gate: "G4", label: "Review", cleared: "", asks: [{ kind: "DO", rank: 1, title: "Prepare", why: "Example", pr: null,
    options: [{ letter: "A", label: "Prepare", command: "", consequence: "", star: true }], objects: [{ label: "Here", url: "#desk" }] }] }],
  rows: {}, legendRows: [{ mark: "", meaning: "" }], efforts: [], spendNotes: {} };
function desk(): typeof baseDesk { return structuredClone(baseDesk); }

describe("report desk starter (#638)", () => {
  it("emits a valid, typed starter without a repo or external reads (AC-1)", async () => {
    const result = await capture(["desk"]);
    expect(result.code, result.err).toBe(0);
    const document = JSON.parse(result.out);
    expect(Object.keys(document).sort()).toEqual(Object.keys(desk()).sort());
    expect(document.gates[0].asks[0].pr).toBeNull();
    expect(typeof document.gates[0].asks[0].options[0].star).toBe("boolean");
    expect(document.gates[0].asks[0].objects[0]).toEqual(expect.objectContaining({label: expect.any(String), url: expect.any(String)}));
    expect(() => parseDesk(document, "starter")).not.toThrow();
    expect((await capture(["desk", "--json"])).out).toBe(result.out);
  });
  it("assembles and renders the unmodified starter with no invented objects (AC-2)", async () => {
    const result = await capture(["desk"]);
    expect(result.code, result.err).toBe(0);
    const document = assembleRegister(parseDesk(JSON.parse(result.out), "starter"), {
      generatedAt: "2026-11-24T00:00:00Z", objects: [], phases: [], usage: [], target: null, verdictFile: null,
      codes: { codeFor: () => null, slugFor: () => null, unavailable: null },
    });
    const root = makeTempDir("nen-desk-starter-");
    mkdirSync(join(root, "nen"));
    writeFileSync(join(root, "nen/workflow.json"), readFileSync(join(process.cwd(), "nen/workflow.json")));
    writeFileSync(join(root, "data.json"), JSON.stringify({ generatedAt: "2026-11-24T00:00:00Z", ...document }));
    const rendered = await capture(["render", "--variant", "register", "--template", join(process.cwd(), "src/report/fixtures/rikugan.html"), "--data", "data.json", "--out", "page.html"], root);
    expect(rendered.code, rendered.err).toBe(0);
    expect(readFileSync(join(root, "page.html"), "utf8")).toContain(document.title);
  });
  it("includes every row-note field for an explicitly named object (AC-1)", async () => {
    const result = await capture(["desk", "--row", "pr#1"]);
    expect(result.code, result.err).toBe(0);
    const document = JSON.parse(result.out);
    expect(document.rows["pr#1"]).toEqual({marks: "", gate: "", gateClass: "", needs: "", session: "", lane: "", thought: ""});
    expect(() => parseDesk(document, "starter")).not.toThrow();
    expect((await capture(["desk", "--row", "bad reference"])).code).toBe(2);
  });
  it("names the starter in family help (AC-4)", () => expect(reportCommand.usage).toContain("nen report desk"));
  it.each([["desk", "extra"], ["desk", "--out", "x"], ["desk", "--base", "main"]])("refuses unused input %j", async (...args) => {
    expect((await capture(args)).code).toBe(2);
  });
});

describe("complete desk refusal (#638 AC-3)", () => {
  it("reports the original three field mistakes and independent sibling errors together", () => {
    const document = desk();
    Object.assign(document, {title: false, legendRows: [{mark: false, meaning: 8}], rows: {"pr#1": {needs: false, thought: 7}}, spendNotes: {one: false, two: 8}});
    Object.assign(document.gates[0]!, {cleared: true});
    Object.assign(document.gates[0]!.asks[0]!, {objects: ["HA-PR-#87", {label: 9, url: "javascript:alert(1)"}], why: null});
    Object.assign(document.gates[0]!.asks[0]!.options[0]!, {star: "★"});
    let message = "";
    try { parseDesk(document, "desk.json"); } catch (error) { message = String(error); }
    for (const part of ["'title'", "'cleared'", "objects[0]", "objects[1]", "'star'", "'why'", "'mark'", "'meaning'", "'needs'", "'thought'", "spendNotes['one']", "spendNotes['two']"])
      expect(message, part).toContain(part);
    expect(() => parseDesk(desk(), "next.json")).not.toThrow();
  });
  it("collects invalid containers and unknown keys without throwing a runtime error", () => {
    const document = { ...desk(), gates: [null, { gate: "", label: false, asks: [null], verdict: "ready" }], rows: [], legendRows: [null], efforts: 3, spendNotes: false, verdict: "ready", typo: true };
    let message = "";
    try { parseDesk(document, "bad.json"); } catch (error) { message = String(error); }
    for (const part of ["gates[0]", "gates[1]", "legendRows[0]", "'rows'", "'efforts'", "'spendNotes'", "QUOTED", "typo"])
      expect(message, part).toContain(part);
    expect(message).not.toMatch(/TypeError/);
  });
});

it("reports every repeated letter group, effort index and malformed reference together (#638 AC-3)", () => {
  const document = desk();
  const option = document.gates[0]!.asks[0]!.options[0]!;
  Object.assign(document.gates[0]!.asks[0]!, {pr: "bad reference", options: [option, {...option, star: false}, {...option, letter: "B", star: false}, {...option, letter: "B", star: false}]});
  Object.assign(document, {efforts: [false, "", 3]});
  let message = "";
  try { parseDesk(document, "bad.json"); } catch (error) { message = String(error); }
  for (const part of ["options[1].letter", "options[3].letter", "efforts[0]", "efforts[1]", "efforts[2]", "'pr'"])
    expect(message, part).toContain(part);
});

it("refuses control-bearing row references before stdout", async () => {
  for (const character of ["\u009b", "\u202e", "\u200b"])
    expect((await capture(["desk", "--row", `owner/re${character}po#1`])).code).toBe(2);
});
it("withholds rejected string values and avoids errors inferred from invalid containers", () => {
  const document = desk();
  const marker = "private-example-value";
  Object.assign(document.gates[0]!, {asks: 3});
  Object.assign(document, {title: false, generatedAtLocal: 3});
  let message = "";
  try { parseDesk(document, "bad.json"); } catch (error) { message = String(error); }
  expect(message).toContain("not a list");
  expect(message).not.toContain("no asks and no 'cleared'");
  const other = desk();
  Object.assign(other.gates[0]!.asks[0]!, {kind: marker, rank: marker, options: [null, false], objects: [{label: "x", url: marker}]});
  try { parseDesk(other, "bad.json"); } catch (error) { message = String(error); }
  expect(message).not.toContain(marker);
  expect(message).not.toContain("letters two options");
  expect(message).toContain("options[0]");
  expect(message).toContain("options[1]");
});

it("reports invalid reference numbers and a definite excess of stars despite a malformed peer", () => {
  for (const pr of ["NN-PR-#0", "pr#9007199254740993", 9007199254740992]) {
    const document = desk();
    const option = document.gates[0]!.asks[0]!.options[0]!;
    Object.assign(document.gates[0]!.asks[0]!, {pr, options: [option, {...option, letter: "B"}, null]});
    let message = "";
    try { parseDesk(document, "bad.json"); } catch (error) { message = String(error); }
    expect(message).toContain("invalid 'pr'");
    expect(message).toContain("stars 2 options");
    expect(message).toContain("options[2]");
  }
});
