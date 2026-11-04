import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runFamily } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { toolCommand, runTool, downloadHttps } from "./command.js";
import type { Seams, CommandResult } from "../seam/exec.js";
import { installTool, type Download } from "./install.js";
import { tar } from "./fixtures.js";
const roots:string[]=[];afterEach(()=>{vi.unstubAllGlobals();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture():{root:string;contract:string;archive:Buffer;download:Download;seams:Seams}{const root=mkdtempSync(join(tmpdir(),"nen-tool-command-"));roots.push(root);const contract=join(root,"scans.json");writeFileSync(contract,JSON.stringify({secretScan:{tool:"scanner",version:"v1.2.3",assets:{"linux-x64":"scanner.tar.gz"},checksumsUrl:"https://example.com/sums",assetUrlTemplate:"https://example.com/<asset>"}}));const archive=tar([{name:"scanner"}]);const download=async(url:URL):Promise<Buffer>=>url.pathname==="/sums"?Buffer.from(createHash("sha256").update(archive).digest("hex")+"  scanner.tar.gz\n"):archive;const seams={...new ScriptedSeams([]),platform:"linux" as const,env:{PATH:root},run:():CommandResult=>({code:0,stdout:"1.2.3",stderr:"",spawnFailed:false})};return{root,contract,archive,download,seams};}
describe("public tool install",()=>{
  it("runs one command from the declaring contract and emits version",async()=>{const f=fixture();const out:string[]=[];const code=await runFamily({...toolCommand,run:c=>runTool(c,f.download,"x64")},["tool","install","--contract",f.contract,"--row","secretScan","--bin-dir",f.root],null,false,{out:line=>{out.push(line);},err:()=>{}},f.seams);expect(code).toBe(0);expect(out.join(" ")).toContain("v1.2.3");expect(readFileSync(join(f.root,"scanner"),"utf8")).toBe("verified executable");});
  it("cleanup failure retains the truthful installed outcome/path",async()=>{const f=fixture();const result=await installTool({contract:f.contract,row:"secretScan",binDir:f.root,seams:f.seams,arch:"x64",download:f.download,cleanup:()=>{throw new Error("cleanup denied");}});expect(result).toMatchObject({exit:0,verdict:"installed",path:join(realpathSync(f.root),"scanner"),cleanupWarning:expect.stringContaining("could not be removed")});expect(readFileSync(join(f.root,"scanner"),"utf8")).toBe("verified executable");});
});
describe("bounded credential-free HTTPS transport",()=>{
  for(const location of ["http://example.com/archive","https://user:password@example.com/archive"]){it("refuses unsafe redirect without following it",async()=>{const fetcher=vi.fn().mockResolvedValue(new Response(null,{status:302,headers:{location}}));vi.stubGlobal("fetch",fetcher);await expect(downloadHttps(new URL("https://example.com/start"),10)).rejects.toThrow(/redirect destination/);expect(fetcher).toHaveBeenCalledTimes(1);});}
  it("enforces byte budget before concatenation and forces TLS verification",async()=>{const fetcher=vi.fn().mockResolvedValue(new Response("123456"));vi.stubGlobal("fetch",fetcher);await expect(downloadHttps(new URL("https://example.com/start"),5)).rejects.toThrow(/byte budget/);expect(fetcher.mock.calls[0]?.[1]).toMatchObject({credentials:"omit",redirect:"manual",tls:{rejectUnauthorized:true}});});
  it("follows bounded HTTPS release asset redirects without retry",async()=>{const fetcher=vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:"https://assets.example.com/archive"}})).mockResolvedValueOnce(new Response("ok"));vi.stubGlobal("fetch",fetcher);expect((await downloadHttps(new URL("https://example.com/start"),10)).toString()).toBe("ok");expect(fetcher).toHaveBeenCalledTimes(2);});
});
