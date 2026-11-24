import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { releaseCommand } from "./command.js";

const asset = { id: "A1", name: "tool.zip", size: 42, downloadUrl: "https://github.com/o/r/releases/download/v1/tool.zip" };
const release = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id: "R1", tagName: "v1", isDraft: false, updatedAt: "2026-01-01T00:00:00Z", releaseAssets: { totalCount: 1, nodes: [asset], pageInfo: { hasNextPage: false, endCursor: "a1" } }, ...extra });
const response = (value: unknown = release(), permission: unknown = "WRITE"): string => JSON.stringify({ data: { repository: { viewerPermission: permission, release: value } } });
async function capture(results: readonly {stdout?: string; stderr?: string; code?: number; spawnFailed?: boolean}[], flags: string[] = []): Promise<{ code: number; out: string; err: string; seams: ScriptedSeams }> {
  const seams = new ScriptedSeams(results.map(result => ({ match: "gh api graphql --hostname github.com --input -", result })));
  const out: string[] = [], err: string[] = [];
  const io: Io = { out: line => out.push(line), err: line => err.push(line) };
  const code = await runFamily(releaseCommand, ["release", "state", "--kind", flags[0] === "--kind" ? flags[1]! : "github", "--repo-slug", "o/r", "--tag", "v1", "--json", ...(flags[0] === "--kind" ? flags.slice(2) : flags)], null, false, io, seams);
  return { code, out: out.join("\n"), err: err.join("\n"), seams };
}
describe("release state (NN#652)", () => {
  for (const state of ["absent", "draft", "published"] as const) it(`AC-1: reads ${state} without a mutation`, async () => {
    const r = await capture([{ stdout: response(state === "absent" ? null : release({isDraft: state === "draft"})) }]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ state, assets: state === "absent" ? [] : [asset] });
    expect(r.seams.calls).toHaveLength(1);
  });
  for (const result of [{code: 4, stderr: "no credential"}, {code: 1, stderr: "network failure"}, {code: 1, stderr: "timeout"}, {code: 1, spawnFailed: true}, {stdout: "not json"}, {stdout: JSON.stringify({errors:[{message:"permission"}],data:{repository:{release:null}}})}]) it("AC-2: cannot look is never absence", async () => {
    const r = await capture([result]); expect(r.code).toBe(1); expect(JSON.parse(r.out)).toMatchObject({state:null, assets:null}); expect(r.out).toContain("could not look"); expect(r.out).not.toContain('"absent"');
  });
  for (const permission of ["READ", "TRIAGE", null, "unknown"]) it("AC-2: hidden drafts cannot become absent", async () => {
    const r = await capture([{stdout: response(null, permission)}]); expect(r.code).toBe(1); expect(r.out).toContain("could not look");
  });
  it("AC-3: names an unsupported destination before any read", async () => {
    const r = await capture([], ["--kind", "store"]); expect(r.code).toBe(2); expect(r.err).toContain("store"); expect(r.seams.calls).toHaveLength(0);
  });
  it("AC-1: reads all asset pages using a query and exact tag variables", async () => {
    const first = release({releaseAssets:{totalCount:2,nodes:[asset],pageInfo:{hasNextPage:true,endCursor:"cursor1"}}});
    const second = release({releaseAssets:{totalCount:2,nodes:[{...asset,id:"A2",name:"other.zip"}],pageInfo:{hasNextPage:false,endCursor:"cursor2"}}});
    const r=await capture([{stdout:response(first)},{stdout:response(second)}]); expect(r.code).toBe(0); expect(JSON.parse(r.out).assets).toHaveLength(2);
    for(const call of r.seams.calls) { const body=JSON.parse(call.stdin ?? "{}"); expect(body.query).toMatch(/^query /); expect(body.query).not.toContain("mutation"); expect(body.variables.tag).toBe("v1"); }
    expect(JSON.parse(r.seams.calls[1]!.stdin ?? "{}").variables.cursor).toBe("cursor1");
  });
  it("AC-2: an incomplete asset page is not a complete state", async () => {
    const r=await capture([{stdout:response(release({releaseAssets:{totalCount:2,nodes:[asset],pageInfo:{hasNextPage:false,endCursor:null}}}))}]); expect(r.code).toBe(1);
  });
  it("AC-2: changed release evidence during pagination is unknown", async () => {
    const first=release({releaseAssets:{totalCount:2,nodes:[asset],pageInfo:{hasNextPage:true,endCursor:"x"}}});
    const r=await capture([{stdout:response(first)},{stdout:response(release({id:"R2"}))}]); expect(r.code).toBe(1); expect(JSON.parse(r.out).assets).toBeNull();
  });
  for (const change of [
    {tagName:"other"}, {isDraft:null}, {id:""}, {releaseAssets:null},
    {releaseAssets:{totalCount:-1,nodes:[],pageInfo:{hasNextPage:false}}},
    {releaseAssets:{totalCount:1,nodes:[{...asset,size:-1}],pageInfo:{hasNextPage:false}}},
    {releaseAssets:{totalCount:1,nodes:[{...asset,downloadUrl:"javascript:bad"}],pageInfo:{hasNextPage:false}}},
    {releaseAssets:{totalCount:2,nodes:[asset,asset],pageInfo:{hasNextPage:false}}},
    {releaseAssets:{totalCount:0,nodes:[asset],pageInfo:{hasNextPage:false}}},
    {releaseAssets:{totalCount:1,nodes:[],pageInfo:{hasNextPage:true,endCursor:"x"}}},
  ]) it("AC-2: malformed release or asset evidence stays unknown", async () => {
    const r=await capture([{stdout:response(release(change))}]); expect(r.code).toBe(1); expect(JSON.parse(r.out).state).toBeNull();
  });
  it("AC-2: disappearance during pagination stays unknown", async () => {
    const first=release({releaseAssets:{totalCount:2,nodes:[asset],pageInfo:{hasNextPage:true,endCursor:"x"}}});
    const r=await capture([{stdout:response(first)},{stdout:response(null)}]); expect(r.code).toBe(1);
  });
  it("AC-2: repeated cursor refuses instead of looping", async () => {
    const first=release({releaseAssets:{totalCount:3,nodes:[asset],pageInfo:{hasNextPage:true,endCursor:"x"}}});
    const second=release({releaseAssets:{totalCount:3,nodes:[{...asset,id:"A2"}],pageInfo:{hasNextPage:true,endCursor:"x"}}});
    const r=await capture([{stdout:response(first)},{stdout:response(second)}]); expect(r.code).toBe(1); expect(r.seams.calls).toHaveLength(2);
  });
  it("AC-2: tool diagnostics cannot leak credentials into the report", async () => {
    const r=await capture([{code:1,stderr:"sensitive-value"}]); expect(r.out+r.err).not.toContain("sensitive-value");
  });
  it("rejects unrelated flags and surplus arguments before tools", async () => {
    for(const flags of [["--range","a..b"],["extra"],["--","extra"]]) {const r=await capture([],flags);expect(r.code).toBe(2);expect(r.seams.calls).toHaveLength(0);}
  });

});
