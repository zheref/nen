import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { makeTempDir } from "../testing/tempdir.js";
import { delimiter, join } from "node:path";
import { tar, zip } from "./fixtures.js";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Seams, CommandResult } from "../seam/exec.js";
import { installTool, type Download, type ToolInstallResult } from "./install.js";
import { archiveBinary } from "./archive.js";
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});

function fixture(options:{manifest?:Buffer;archive?:Buffer;version?:string;assets?:Record<string,string>;downloadFailure?:boolean;platform?:"linux"|"win32"}={}): {root:string;path:string;run:()=>Promise<ToolInstallResult>;calls:string[];downloads:string[];seams:Seams;download:Download}{
  const root=makeTempDir("nen-tool-test-");roots.push(root);const path=join(root,"scans.json");const archive=options.archive ?? tar([{name:"scanner"},{name:"LICENSE"}]);const asset=options.assets?.[`${options.platform ?? "linux"}-x64`] ?? "scanner_1.2.3_linux_x64.tar.gz";
  writeFileSync(path,JSON.stringify({secretScan:{tool:"scanner",version:"v1.2.3",assets:options.assets ?? {"linux-x64":asset},checksumsUrl:"https://downloads.example/checksums.txt",assetUrlTemplate:"https://downloads.example/<asset>"}}));
  const calls:string[]=[];const seams={...new ScriptedSeams([]),platform:options.platform ?? "linux" as const,env:{PATH:root},run:(exe:string,args:readonly string[]):CommandResult=>{calls.push(exe+" "+args.join(" "));return {code:0,stdout:options.version ?? "1.2.3\n",stderr:"",spawnFailed:false};}};
  const downloads:string[]=[];const download:Download=async url=>{downloads.push(url.href);if(options.downloadFailure)throw new Error("offline manifest");return url.pathname.endsWith("checksums.txt") ? options.manifest ?? Buffer.from(createHash("sha256").update(archive).digest("hex")+"  "+asset+"\n") : archive;};
  const run=():Promise<ToolInstallResult>=>installTool({contract:path,row:"secretScan",binDir:root,seams,arch:"x64",download});return {root,path,run,calls,downloads,seams,download};
}
describe("declared checksum-pinned tool install",()=>{
  it("installs only verified bytes, probes version and leaves an exact-pin install unchanged",async()=>{const f=fixture();expect(await f.run()).toMatchObject({exit:0,verdict:"installed",version:"v1.2.3"});expect(readFileSync(join(f.root,"scanner"),"utf8")).toBe("verified executable");expect(f.downloads).toHaveLength(2);expect(f.calls).toHaveLength(1);const before=readFileSync(join(f.root,"scanner"));expect(await f.run()).toMatchObject({exit:0,verdict:"unchanged"});expect(f.downloads).toHaveLength(2);expect(readFileSync(join(f.root,"scanner"))).toEqual(before);expect(readdirSync(f.root).some(name=>name.startsWith(".nen-tool"))).toBe(false);});
  it("checksum mismatch refuses before even parsing an invalid archive",async()=>{const f=fixture({archive:Buffer.from("not archive"),manifest:Buffer.from("0".repeat(64)+"  scanner_1.2.3_linux_x64.tar.gz\n")});expect(await f.run()).toMatchObject({exit:1,check:"archive checksum",verdict:"refused"});expect(f.calls).toHaveLength(0);expect(existsSync(join(f.root,"scanner"))).toBe(false);});
  for(const [label,options,check] of [["unfetchable manifest",{downloadFailure:true},"checksum manifest fetch"],["manifest silent",{manifest:Buffer.from("1".repeat(64)+"  other.tar.gz\n")},"checksum manifest entry"],["ambiguous manifest",{manifest:Buffer.from(("1".repeat(64)+"  scanner_1.2.3_linux_x64.tar.gz\n").repeat(2))},"checksum manifest entry"],["malformed verified archive",{archive:Buffer.from("not tar")},"verified archive structure"],["wrong reported version",{version:"9.0.0"},"staged version"]] as const){it(`refuses ${label} naming failed check without installation`,async()=>{const f=fixture(options);expect(await f.run()).toMatchObject({exit:1,verdict:"refused",check});expect(existsSync(join(f.root,"scanner"))).toBe(false);});}
  it("unsupported host is not scanned and never substitutes a platform",async()=>{const f=fixture({assets:{"darwin-arm64":"scanner_1.2.3_darwin_arm64.tar.gz"}});expect(await f.run()).toMatchObject({exit:3,verdict:"not-scanned",host:"linux-x64"});expect(f.downloads).toHaveLength(0);expect(f.calls).toHaveLength(0);});
  it("refuses a different installed version without downloads or replacement",async()=>{const f=fixture({version:"0.1.0"});writeFileSync(join(f.root,"scanner"),"original");expect(await f.run()).toMatchObject({exit:1,check:"installed version"});expect(f.downloads).toHaveLength(0);expect(readFileSync(join(f.root,"scanner"),"utf8")).toBe("original");});
  it("verified traversal, links and duplicate root executables never stage",async()=>{for(const entries of [[{name:"../scanner"}],[{name:"scanner",type:"2"}],[{name:"scanner"},{name:"scanner"}]]){const f=fixture({archive:tar(entries)});expect(await f.run()).toMatchObject({exit:1,check:"verified archive structure"});expect(f.calls).toHaveLength(0);expect(existsSync(join(f.root,"scanner"))).toBe(false);}});
  it("archive requires declared exact root executable",()=>{expect(()=>archiveBinary(tar([{name:"nested/scanner"}]),"tool.tar.gz","scanner")).toThrow(/root executable/);});
});

it("verified Windows ZIP installs exact .exe basename into a synthetic PATH",async()=>{const f=fixture({platform:"win32",assets:{"win32-x64":"scanner.zip"},archive:zip()});expect(await f.run()).toMatchObject({exit:0,verdict:"installed",host:"win32-x64"});expect(readFileSync(join(f.root,"scanner.exe"),"utf8")).toBe("123456789");});
it("malformed verified ZIP refuses before execution or installation",async()=>{for(const options of [{crc:0},{localSize:1},{mode:0x1000},{mode:0xc000},{count:4097}]){const f=fixture({platform:"win32",assets:{"win32-x64":"scanner.zip"},archive:zip(options)});expect(await f.run()).toMatchObject({exit:1,check:"verified archive structure"});expect(f.calls).toHaveLength(0);expect(existsSync(join(f.root,"scanner.exe"))).toBe(false);}});
it("a destination appearing during staged version verification is never overwritten",async()=>{const f=fixture();const seams={...f.seams,run:():CommandResult=>{writeFileSync(join(f.root,"scanner"),"concurrent install");return{code:0,stdout:"1.2.3",stderr:"",spawnFailed:false};}};expect(await installTool({contract:f.path,row:"secretScan",binDir:f.root,seams,arch:"x64",download:f.download})).toMatchObject({exit:1,check:"atomic install"});expect(readFileSync(join(f.root,"scanner"),"utf8")).toBe("concurrent install");});

describe("installer review regressions", () => {
  it.each([["1.2.3", "v1.2.3"], ["v1.2.3", "1.2.3"], ["v1.2.3", "v1.2.3"], ["1.2.3", "1.2.3"]])("accepts optional v for pin %s and report %s", async (pin, version) => {
    const f = fixture({ version }); const data = JSON.parse(readFileSync(f.path, "utf8")); data.secretScan.version = pin; writeFileSync(f.path, JSON.stringify(data));
    expect(await f.run()).toMatchObject({ verdict: "installed", exit: 0 });
    expect(await f.run()).toMatchObject({ verdict: "unchanged", exit: 0 });
  });
  it("ignores valid unrelated manifest names ending with the target basename", async () => {
    const archive = tar([{ name: "scanner" }]); const hash = createHash("sha256").update(archive).digest("hex"); const asset = "scanner.tar.gz";
    const f = fixture({ archive, assets: { "linux-x64": asset }, manifest: Buffer.from(`${hash}  other-${asset}\n${hash}  ${asset}\n`) });
    expect(await f.run()).toMatchObject({ verdict: "installed", exit: 0 });
  });
  it("still rejects malformed entries for the exact selected manifest name", async () => {
    const archive = tar([{ name: "scanner" }]); const hash = createHash("sha256").update(archive).digest("hex"); const asset = "scanner.tar.gz";
    const f = fixture({ archive, assets: { "linux-x64": asset }, manifest: Buffer.from(`${hash}  ${asset}\nbad-hash  ${asset}\n`) });
    expect(await f.run()).toMatchObject({ verdict: "refused", check: "checksum manifest entry" }); expect(f.calls).toHaveLength(0);
  });
  it.each(["linux", "win32"] as const)("uses the first existing %s PATH executable and never installs a shadowed copy", async platform => {
    for (const version of ["v1.2.3", "0.1.0"]) {
      const f = fixture({ platform, version, ...(platform === "win32" ? { assets: { "win32-x64": "scanner.zip" }, archive: zip() } : {}) });
      const other = join(f.root, "first"); mkdirSync(other); const executable = join(other, platform === "win32" ? "scanner.exe" : "scanner"); writeFileSync(executable, "existing executable"); chmodSync(executable, 0o700);
      const seams = { ...f.seams, env: { PATH: [other, f.root].join(delimiter) } };
      const result = await installTool({ contract: f.path, row: "secretScan", binDir: f.root, seams, arch: "x64", download: f.download });
      expect(result).toMatchObject({ verdict: version === "v1.2.3" ? "unchanged" : "refused", path: executable });
      expect(f.downloads).toHaveLength(0); expect(f.calls).toEqual([executable + " version"]); expect(readFileSync(executable, "utf8")).toBe("existing executable");
    }
  });
  it("does not download when the exact pin is after an empty destination on PATH", async () => {
    const f = fixture(); const other = join(f.root, "later"); mkdirSync(other); const executable = join(other, "scanner"); writeFileSync(executable, "existing"); chmodSync(executable, 0o700);
    const seams = { ...f.seams, env: { PATH: [f.root, other].join(delimiter) } };
    expect(await installTool({ contract: f.path, row: "secretScan", binDir: f.root, seams, arch: "x64", download: f.download })).toMatchObject({ verdict: "unchanged", path: executable }); expect(f.downloads).toHaveLength(0);
  });
});

it("requires an explicit PATH rather than treating an absent value as the current directory", async () => {
  const f = fixture(); const seams = { ...f.seams, env: {} };
  expect(await installTool({ contract: f.path, row: "secretScan", binDir: f.root, seams, arch: "x64", download: f.download })).toMatchObject({ exit: 2, check: "install destination" }); expect(f.downloads).toHaveLength(0);
});
it("refuses an earlier PATH executable appearing during staged verification", async () => {
  const f = fixture(); const earlier = join(f.root, "earlier"); mkdirSync(earlier);
  const seams = { ...f.seams, env: { PATH: [earlier, f.root].join(delimiter) }, run: (): CommandResult => { const path = join(earlier, "scanner"); writeFileSync(path, "concurrent old tool"); chmodSync(path, 0o700); return { code: 0, stdout: "1.2.3", stderr: "", spawnFailed: false }; } };
  expect(await installTool({ contract: f.path, row: "secretScan", binDir: f.root, seams, arch: "x64", download: f.download })).toMatchObject({ exit: 1, check: "atomic install" }); expect(existsSync(join(f.root, "scanner"))).toBe(false);
});

it("refuses an implicit Windows current-directory shadow without a child process", async () => {
  const f = fixture({ platform: "win32", assets: { "win32-x64": "scanner.zip" }, archive: zip() });
  const cwd = makeTempDir("nen-tool-shadow-"); writeFileSync(join(cwd, "scanner.exe"), "untrusted checkout executable");
  const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
  try { expect(await f.run()).toMatchObject({ verdict: "refused", check: "installed version", path: join(cwd, "scanner.exe") }); expect(f.calls).toHaveLength(0); expect(f.downloads).toHaveLength(0); }
  finally { spy.mockRestore(); }
});
it.each(["1.2.3+build.7", "v1.2.3-alpha.1+build.007"])("accepts exact SemVer metadata %s", async pin => {
  const f = fixture({ version: pin }); const data = JSON.parse(readFileSync(f.path, "utf8")); data.secretScan.version = pin; writeFileSync(f.path, JSON.stringify(data));
  expect(await f.run()).toMatchObject({ exit: 0, verdict: "installed" });
});
it.each(["v01.2.3-alpha..1", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+build..7", "1.2.3+", "latest"])("refuses invalid exact SemVer %s", async pin => {
  const f = fixture({ version: pin }); const data = JSON.parse(readFileSync(f.path, "utf8")); data.secretScan.version = pin; writeFileSync(f.path, JSON.stringify(data));
  expect(await f.run()).toMatchObject({ exit: 2, check: "declaration" }); expect(f.downloads).toHaveLength(0); expect(f.calls).toHaveLength(0);
});

it.each(["trailing", "interior", "quoted-empty"])("does not trust an implicit Windows CWD through %s PATH components", async kind => {
  const f = fixture({ platform: "win32", assets: { "win32-x64": "scanner.zip" }, archive: zip() });
  const cwd = makeTempDir("nen-tool-empty-path-"); writeFileSync(join(cwd, "scanner.exe"), "untrusted checkout executable");
  const parts = kind === "trailing" ? [f.root, ""] : kind === "interior" ? [f.root, "", f.root] : [f.root, '""'];
  const seams = { ...f.seams, env: { PATH: parts.join(delimiter) } }; const spy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
  try { expect(await installTool({ contract: f.path, row: "secretScan", binDir: f.root, seams, arch: "x64", download: f.download })).toMatchObject({ verdict: "refused", check: "installed version" }); expect(f.calls).toHaveLength(0); expect(f.downloads).toHaveLength(0); }
  finally { spy.mockRestore(); }
});
