import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { parseArgs } from "../cli/args.js";
import { mergeFlags } from "../cli/command.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { evaluate, freeze, hash, parseFrozen, parseItem, parseSpec, type Item, type Tracker } from "./model.js";
import { goalCommand, hookInput, hookOutput, runGoal } from "./command.js";
import { githubTracker } from "./tracker.js";

const dirs: string[] = [];
function temp(): string { const d = mkdtempSync(join(tmpdir(), "nen-goal-")); dirs.push(d); return d; }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const at = "2026-11-11T12:00:00Z";
const item = (number: number, state: Item["state"] = "OPEN", kind: Item["kind"] = "issue"): Item => ({ number, state, kind, url: `https://github.com/o/r/issues/${number}`, closedAt: state === "OPEN" ? null : at });
const definition = (conditions: unknown[] = [{ kind: "issues-closed", numbers: [1, 2] }]): unknown => ({ contract: "nen.goal/v1", target: "o/r", conditions, all: true });
const spec = parseSpec(definition());
function tracker(items: Item[], query: Item[] = items): Tracker { return { items: (ns) => items.filter((i) => ns.includes(i.number)), query: vi.fn(() => query) }; }
const rawItem = (i: Item): unknown => ({ ...i, __typename: i.kind === "issue" ? "Issue" : "PullRequest" });
function seams(data: unknown): ScriptedSeams { return new ScriptedSeams([{ match: "gh api graphql --hostname github.com --input -", result: { code: 0, stdout: JSON.stringify({ data }), stderr: "" } }]); }

describe("goal evidence", () => {
  it("names every open fixed item and ignores later matching issues", () => {
    expect(evaluate(spec, tracker([item(1), item(2)]), at).conditions[0]?.unmet).toEqual([1, 2]);
    expect(evaluate(spec, tracker([item(1,"CLOSED"),item(2,"CLOSED"),item(3)]),at).verdict).toBe("met");
  });
  it.each(["==", "<=", "<"])("checks live counts with %s and names the matching items", (op) => {
    const s = parseSpec(definition([{ kind:"query-count",query:"is:open",op,value:0 }]));
    const v = evaluate(s,tracker([], [item(1),item(2)]),at);
    expect(v.verdict).toBe("not-met"); expect(v.conditions[0]?.unmet).toEqual([1,2]); expect(v.conditions[0]?.count).toBe(2);
  });
  it("freezes once, never reruns the query, validates definition identity", () => {
    const s = parseSpec(definition([{kind:"query-count",query:"is:open",op:"==",value:0}]));
    const frozen = freeze(s,tracker([item(1)]),at,"session");
    const t = tracker([item(1,"CLOSED"),item(2)]);
    expect(evaluate(s,t,at,parseFrozen(frozen,s)).verdict).toBe("met"); expect(t.query).not.toHaveBeenCalled();
    expect(() => parseFrozen({...frozen,specHash:"wrong"},s)).toThrow();
    expect(() => parseFrozen({...frozen,conditions:[]},s)).toThrow();
    expect(() => parseFrozen({...frozen,conditions:[[item(1),item(1)]]},s)).toThrow();
    expect(() => freeze(s,t,at,"")).toThrow();
  });
  it("distinguishes closed and merged PRs, refuses missing/wrong-type items", () => {
    const s = parseSpec(definition([{kind:"prs-merged",numbers:[1]}]));
    expect(evaluate(s,tracker([item(1,"CLOSED","pr")]),at).verdict).toBe("not-met");
    expect(evaluate(s,tracker([item(1,"MERGED","pr")]),at).verdict).toBe("met");
    expect(evaluate(parseSpec(definition([{kind:"prs-closed",numbers:[1]}])),tracker([item(1,"MERGED","pr")]),at).verdict).toBe("met");
    expect(() => evaluate(s,tracker([item(1)]),at)).toThrow("Wrong item type");
    expect(() => evaluate(spec,tracker([]),at)).toThrow("did not return");
  });
  it.each([["=="], ["<="], ["<"], {toString: (): string => "=="}].map((op) => ({op})))("rejects non-string query operators %#", ({op}) => {
    expect(() => parseSpec(definition([{kind:"query-count",query:"is:open",op,value:1}]))).toThrow("Invalid query-count");
  });
  it.each([{state:["OPEN"]}, {state:["CLOSED"]}, {__typename:["Issue"]}, {__typename:["PullRequest"]}])("rejects coerced tracker fields %#", (fields) => {
    expect(() => parseItem({...rawItem(item(1)) as object,...fields})).toThrow("unreadable item");
    const result = invoke(["check","--spec","goal.json"],{repository:{n1:{...rawItem(item(1)) as object,...fields},n2:rawItem(item(2,"CLOSED"))}});
    expect(result.code).toBe(2); expect(JSON.parse(result.out[0]!).verdict).toBe("error");
  });
  it("fingerprints evidence independently of check time and input order", () => {
    expect(evaluate(spec,tracker([item(1),item(2)]),at).fingerprint).toBe(evaluate(spec,tracker([item(2),item(1)]),"2026-11-12T12:00:00Z").fingerprint);
  });
  it.each([null, {}, {...spec,all:false}, {...spec,extra:true}, definition([]), definition([{kind:"bad"}]), definition([{kind:"issues-closed",numbers:[0]}]), definition([{kind:"issues-closed",numbers:[1,1]}]), definition([{kind:"query-count",query:"repo:elsewhere/repo",op:"==",value:0}]), definition([{kind:"query-count",query:"is:open OR is:closed",op:"==",value:0}])])("refuses malformed definitions %#", (raw) => { expect(() => parseSpec(raw)).toThrow(); });
  it.each([null, {}, {number:1,__typename:"Issue",state:"MERGED",url:"x",closedAt:null}])("refuses unreadable items %#", (raw) => { expect(() => parseItem(raw)).toThrow(); });
});

describe("hook continuation guard", () => {
  it.each(["claude-code", "codex", "cursor"] as const)("continues then stops on unchanged evidence for %s", (hook) => {
    const path = join(temp(),"state.json"); const v = evaluate(spec,tracker([item(1),item(2)]),at);
    const first = hookOutput(v,hook,{session:"s",active:false},path,3);
    expect(first[hook === "cursor" ? "followup_message" : "reason"]).toContain("#1, #2");
    expect(hookOutput(v,hook,{session:"s",active:true},path,3).systemMessage).toBeUndefined();
    expect(hookOutput(v,hook,{session:"s",active:true},path,3).systemMessage).toContain("remains not met");
    expect(hookOutput(v,hook,{session:"new",active:true},path,3).systemMessage).toBeUndefined();
    expect(hookOutput(evaluate(spec,tracker([item(1,"CLOSED"),item(2,"CLOSED")]),at),hook,{session:"new",active:true},path,3)).toEqual({});
  });
  it("resets on changed evidence and refuses corrupt state", () => {
    const path = join(temp(),"s");
    const v = evaluate(spec,tracker([item(1),item(2)]),at);
    hookOutput(v,"codex",{session:"s",active:true},path,2);
    expect(hookOutput(evaluate(spec,tracker([item(1,"CLOSED"),item(2)]),at),"codex",{session:"s",active:true},path,2).decision).toBe("block");
    writeFileSync(path,'{}'); expect(() => hookOutput(v,"codex",{session:"s",active:true},path,2)).toThrow();
  });
  it("validates each host input", () => {
    expect(hookInput({conversation_id:"c",loop_count:1},"cursor")).toEqual({session:"c",active:true});
    expect(hookInput({session_id:"c",stop_hook_active:false},"codex").active).toBe(false);
    for (const raw of [{}, {session_id:"c"}]) expect(() => hookInput(raw,"claude-code")).toThrow();
    expect(() => hookInput({conversation_id:"c",loop_count:-1},"cursor")).toThrow();
  });
});

describe("GitHub reads", () => {
  it("batches fifty fixed items into one read", () => {
    const all = Array.from({length:50},(_,i) => item(i+1));
    const s = seams({repository:Object.fromEntries(all.map((i) => [`n${i.number}`,rawItem(i)]))});
    expect(githubTracker(s,"o/r",".").items(all.map((i) => i.number))).toHaveLength(50);
    expect(s.calls).toHaveLength(1);
  });
  it("checks complete search results and rejects count truncation", () => {
    const data = {repository:{nameWithOwner:"o/r"},search:{issueCount:1,nodes:[rawItem(item(1))],pageInfo:{hasNextPage:false,endCursor:null}}};
    expect(githubTracker(seams(data),"o/r",".").query("is:open")).toHaveLength(1);
    expect(() => githubTracker(seams({repository:data.repository,search:{...data.search,issueCount:2}}),"o/r",".").query("is:open")).toThrow("incomplete");
    expect(() => githubTracker(seams({repository:data.repository,search:{...data.search,issueCount:1001}}),"o/r",".").query("is:open")).toThrow("limit");
  });
  it("accepts empty search only after verifying the repository exists and is accessible", () => {
    const search = {issueCount:0,nodes:[],pageInfo:{hasNextPage:false,endCursor:null}};
    const querySpec = parseSpec(definition([{kind:"query-count",query:"is:open",op:"==",value:0}]));
    expect(evaluate(querySpec,githubTracker(seams({repository:{nameWithOwner:"o/r"},search}),"o/r","."),at).verdict).toBe("met");
    for (const repository of [null, undefined, {}, {nameWithOwner:"other/repo"}]) {
      expect(() => evaluate(querySpec,githubTracker(seams({repository,search}),"o/r","."),at)).toThrow();
    }
  });
  it("pins github.com and rejects same-slug evidence from another host", () => {
    const s = seams({repository:{n1:rawItem(item(1))}});
    githubTracker(s,"o/r",".").items([1]);
    expect(JSON.stringify(s.calls)).toContain("--hostname");
    const foreign = {...rawItem(item(1,"CLOSED")) as object,url:"https://enterprise.example/o/r/issues/1"};
    expect(() => githubTracker(seams({repository:{n1:foreign}}),"o/r",".").items([1])).toThrow("outside");
  });
  it("rejects partial GraphQL data and missing fixed nodes", () => {
    const s = new ScriptedSeams([{match:"gh api graphql --hostname github.com --input -",result:{code:0,stdout:JSON.stringify({errors:[{}],data:{}}),stderr:""}}]);
    expect(() => githubTracker(s,"o/r",".").items([1])).toThrow("GraphQL");
    expect(() => githubTracker(seams({repository:{n1:null}}),"o/r",".").items([1])).toThrow();
  });
});

function invoke(argv: string[], data: unknown = {repository:{n1:rawItem(item(1)),n2:rawItem(item(2))}}, input: unknown = {session_id:"s",stop_hook_active:false}): {code:number;out:string[];err:string[];root:string} {
  const root = temp(); writeFileSync(join(root,"goal.json"),JSON.stringify(spec));
  const out:string[]=[]; const err:string[]=[];
  const code = runGoal({ args:parseArgs(["goal",...argv],mergeFlags(goalCommand.flags)),repoFlag:root,json:true,io:{out:(s)=>{out.push(s);},err:(s)=>{err.push(s);}},seams:seams(data) },()=>input);
  return {code,out,err,root};
}
describe("command outcomes", () => {
  it("returns not-met JSON and error JSON distinctly", () => {
    expect(invoke(["check","--spec","goal.json"]).code).toBe(1);
    const error = invoke(["check","--spec","missing"]); expect(error.code).toBe(2); expect(JSON.parse(error.out[0]!).verdict).toBe("error");
    expect(invoke(["check","--spec","goal.json"],{repository:{}}).code).toBe(2);
  });
  it("refuses ignored passthrough flags instead of checking a different scope", () => {
    const r = invoke(["check","--spec","goal.json","--","--frozen","missing.json"]);
    expect(r.code).toBe(2); expect(JSON.parse(r.out[0]!).verdict).toBe("error");
    const hook = invoke(["check","--spec","goal.json","--hook","codex","--","--frozen","missing.json"]);
    expect(hook.code).toBe(0); expect(JSON.parse(hook.out[0]!).systemMessage).toContain("could not evaluate");
  });
  it("creates a frozen record and requires its session identity", () => {
    const r=invoke(["freeze","--spec","goal.json","--session-id","s"]); expect(r.code).toBe(0);
    const frozen=JSON.parse(readFileSync(join(r.root,"goal.frozen.json"),"utf8")); expect(frozen.specHash).toBe(hash(spec));
    expect(invoke(["freeze","--spec","goal.json"]).code).toBe(2);
    expect(invoke(["freeze","--spec","goal.json","--session-id","s","--out","goal.json"]).code).toBe(2);
  });
  it.each(["claude-code","codex","cursor"])("always allows stopping on evaluation errors in %s", (hook) => {
    const r=invoke(["check","--spec","missing","--hook",hook]); expect(r.code).toBe(0); if (hook !== "cursor") expect(JSON.parse(r.out[0]!).systemMessage).toContain("could not evaluate"); else expect(JSON.parse(r.out[0]!)).toEqual({}); expect(r.err[0]).toContain("could not evaluate");
  });
  it("does not publish new evidence when hook state is corrupt", () => {
    const root = temp(); const path = join(root,"state.json");
    writeFileSync(join(root,"goal.json"),JSON.stringify(spec)); writeFileSync(path,"{}");
    const out: string[] = [];
    const code = runGoal({args:parseArgs(["goal","check","--spec","goal.json","--hook","codex","--state","state.json"],mergeFlags(goalCommand.flags)),repoFlag:root,json:true,io:{out:(s)=>{out.push(s);},err:()=>{}},seams:seams({repository:{n1:rawItem(item(1,"CLOSED")),n2:rawItem(item(2,"CLOSED"))}})},()=>({session_id:"s",stop_hook_active:false}));
    expect(code).toBe(0); expect(JSON.parse(out[0]!).systemMessage).toContain("could not evaluate");
    expect(existsSync(`${path}.evidence.json`)).toBe(false);
  });
  it("writes evidence and blocks only on evaluated not-met conditions", () => {
    const r=invoke(["check","--spec","goal.json","--hook","codex","--state","s.json"]); expect(r.code).toBe(0); expect(JSON.parse(r.out[0]!).decision).toBe("block");
    expect(JSON.parse(readFileSync(join(r.root,"s.json.evidence.json"),"utf8")).verdict).toBe("not-met");
    if (process.platform !== "win32") {
      expect(statSync(join(r.root,"s.json")).mode & 0o777).toBe(0o600);
      expect(statSync(join(r.root,"s.json.evidence.json")).mode & 0o777).toBe(0o600);
    }
    expect(invoke(["check","--spec","goal.json","--hook","codex"],{},{}).code).toBe(0);
  });
  it.each([["check"],["unknown"],["check","--spec","goal.json","--hook","bad"],["check","--spec","goal.json","--state","x"],["check","--spec","goal.json","--out","x"],["freeze","--spec","goal.json","--frozen","x"]].map((args) => ({args})))("refuses invalid combinations $args", ({args}) => { expect(invoke(args).code).toBe(2); });
});


describe("hook parser boundary", () => {
  it.each(["--hook=codex", "--hook=claude-code", "--hook=cursor"])("allows stopping on malformed argv with %s", async (hook) => {
    const out: string[] = [];
    const code = await runFamily(goalCommand, ["goal","check",hook,"--typo"], null, false, {out:(s)=>{out.push(s);},err:()=>{}},new ScriptedSeams([]));
    expect(code).toBe(0); expect(() => JSON.parse(out[0]!)).not.toThrow();
  });
  it.each([["-hook","codex"], ["-hook=cursor"], ["--hook","bad","--hook","codex"]].map((args) => ({args})))("translates malformed argv for recognized hook spellings $args", async ({args}) => {
    const out: string[] = [];
    const code = await runFamily(goalCommand,["goal","check",...args,"--typo"],null,false,{out:(s)=>{out.push(s);},err:()=>{}},new ScriptedSeams([]));
    expect(code).toBe(0); expect(() => JSON.parse(out[0]!)).not.toThrow();
  });
  it("does not discover a hook flag after the passthrough boundary", async () => {
    const out: string[] = [];
    const code = await runFamily(goalCommand,["goal","check","--typo","--","--hook","codex"],null,false,{out:(s)=>{out.push(s);},err:()=>{}},new ScriptedSeams([]));
    expect(code).toBe(2); expect(out).toEqual([]);
  });
  it("retains ordinary parser errors outside hook mode", async () => {
    expect(await runFamily(goalCommand,["goal","check","--typo"],null,false,{out:()=>{},err:()=>{}},new ScriptedSeams([]))).toBe(2);
  });
});
