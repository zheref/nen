import { describe, expect, it } from "vitest";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { checkTagPreconditions } from "./preconditions.js";
const sha = "a".repeat(40); const previous = "b".repeat(40);
const git = (args: string, result: ScriptedCall["result"] = {}): ScriptedCall => ({ match: `git --no-replace-objects --no-lazy-fetch ${args}`, result });
function script(options: {hold?:string; previousCode?:number; fetchCode?:number; ancestorCode?:number; fragments?:string} = {}): ScriptedCall[] {
  const calls = [git("remote get-url origin", { stdout:"https://github.com/zheref/example.git\n" }), {match:"gh variable get RELEASE_HOLD --repo zheref/example",result:{stdout:options.hold ?? "false\n"}}];
  if (options.hold === "true") return calls;
  calls.push(git("rev-parse --verify --quiet refs/tags/v0.9.0^{commit}", {code:options.previousCode ?? 0,stdout:previous}));
  if (options.previousCode) return calls;
  calls.push(git("rev-parse --verify --end-of-options HEAD^{commit}", {stdout:sha}),git("fetch origin main", {code:options.fetchCode ?? 0}));
  if (options.fetchCode) return calls;
  calls.push(git(`merge-base --is-ancestor ${sha} origin/main`, {code:options.ancestorCode ?? 0}));
  if (options.ancestorCode) return calls;
  calls.push(git(`ls-tree -r --name-only -z ${sha} -- :(literal)changelog.d`, {stdout:options.fragments ?? ""}));
  return calls;
}
const base = {previousTag:"v0.9.0", mode:"marker" as const};
describe("CON-41 immutable mode preconditions", () => {
  it("resolves a moving symbolic input once before refreshing trunk, then uses only its immutable SHA", () => {
    const seams = new ScriptedSeams(script({fragments:"changelog.d/123.md\0"}));
    expect(checkTagPreconditions(seams,"/repo","HEAD","v1.0.0",base)).toEqual({ok:true,sha,mode:"marker",fragmentCount:1});
    expect(seams.calls.filter(c=>c.args.includes("HEAD^{commit}"))).toHaveLength(1);
  });
  for (const [label,options,exit] of [["HOLD",{hold:"true"},1],["missing previous",{previousCode:1},1],["unreadable previous",{previousCode:128},2],["fetch failure",{fetchCode:128},2],["off trunk",{ancestorCode:1},1],["unreadable ancestry",{ancestorCode:128},2]] as const) {
    it(`refuses ${label} with exit ${exit}`,()=>{ const seams=new ScriptedSeams(script(options)); expect(checkTagPreconditions(seams,"/repo","HEAD","v1.0.0",base)).toMatchObject({ok:false,exit}); expect(seams.calls.some(c=>c.args.includes("-a"))).toBe(false); });
  }
  it("release mode refuses uncollated immutable fragments",()=>{const seams=new ScriptedSeams(script({fragments:"changelog.d/1.md\0"}));expect(checkTagPreconditions(seams,"/repo","HEAD","v1.0.0",{...base,mode:"release"})).toMatchObject({ok:false,exit:1});});
  it("refuses option-shaped trunk before any process",()=>{const seams=new ScriptedSeams([]);expect(checkTagPreconditions(seams,"/repo","HEAD","v1.0.0",{...base,trunk:"--upload-pack=evil"})).toMatchObject({ok:false,exit:2});expect(seams.calls).toHaveLength(0);});
});

describe("release section reconciliation",()=>{
  const text = (body:string):string=>`# Changelog\n\n## Unreleased\n_(nothing awaiting release.)_\n\n## v1.0.0 — 2026-11-03\n${body}\n## v0.9.0 — 2026-10-01\n- Old ([#42](https://github.com/zheref/example/pull/42))\n`;
  function release(content:string, terminal?:ScriptedCall["result"]):ScriptedSeams {
    return new ScriptedSeams([...script(),git(`show ${sha}:CHANGELOG.md`,{stdout:content}),git(`log --merges --format=%s --end-of-options ${previous}..${sha}`,{stdout:"Merge pull request #42 from fix\n"}),...(terminal ? [git(`log -1 --no-show-signature --format=%H%x09%P%x09%s --end-of-options ${sha}^{commit} --`,terminal)] : [])]);
  }
  it("counts citations in deeper change subsections",()=>{const result=checkTagPreconditions(release(text("### Added\n- Feature ([#42](https://github.com/zheref/example/pull/42))")),"/repo","HEAD","v1.0.0",{...base,mode:"release"});expect(result,JSON.stringify(result)).toMatchObject({ok:true,mode:"release"});});
  it("old section citations cannot satisfy the new section",()=>{const seams=release(text("### Added\n- Feature"),{stdout:`${sha}\t${previous}\tordinary commit\n`});expect(checkTagPreconditions(seams,"/repo","HEAD","v1.0.0",{...base,mode:"release"})).toMatchObject({ok:false,exit:1,reason:expect.stringContaining("42")});});
  it("terminal allowance read failure is unreadable, not unmet",()=>{const seams=release(text("- Feature"),{code:128,stderr:"missing history"});expect(checkTagPreconditions(seams,"/repo","HEAD","v1.0.0",{...base,mode:"release"})).toMatchObject({ok:false,exit:2});});
  it("uncollated Unreleased refuses before history reads",()=>{const seams=new ScriptedSeams([...script(),git(`show ${sha}:CHANGELOG.md`,{stdout:text("- Feature ([#42](https://github.com/zheref/example/pull/42))").replace("_(nothing awaiting release.)_","- Pending")})]);expect(checkTagPreconditions(seams,"/repo","HEAD","v1.0.0",{...base,mode:"release"})).toMatchObject({ok:false,exit:1});});
});
