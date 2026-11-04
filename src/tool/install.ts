// Caller-declared supply pin; downloaded bytes are verified before parsing/execution.
import { createHash } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { Seams } from "../seam/exec.js";
import { archiveBinary } from "./archive.js";
export type Download = (url:URL, maxBytes:number)=>Promise<Buffer>;
export const TOOL_INSTALL_CONTRACT="nen.tool.install/v0.1";
export interface ToolInstallResult {readonly contract:typeof TOOL_INSTALL_CONTRACT;readonly host:string;readonly tool:string|null;readonly version:string|null;readonly verdict:"installed"|"unchanged"|"not-scanned"|"refused";readonly exit:0|1|2|3;readonly path:string|null;readonly check:string;readonly detail:string;readonly cleanupWarning?:string}
interface Declaration {tool:string;version:string;checksumsUrl:string;assetUrlTemplate:string;assets:Record<string,string>;versionArgv:string[]}
function record(value:unknown):Record<string,unknown>{if(value===null || typeof value!=="object" || Array.isArray(value))throw new Error("declaration must be an object");return value as Record<string,unknown>;}
function url(value:string):URL {const result=new URL(value);if(result.protocol!=="https:" || result.username || result.password || result.hash)throw new Error("download URL must use HTTPS without credentials or fragment");return result;}
function declaration(path:string,row:string):Declaration {
  if(!isAbsolute(path))throw new Error("--contract must be an absolute trusted declaration path");
  const raw=record(JSON.parse(readFileSync(path,"utf8")));if(!Object.hasOwn(raw,row))throw new Error("declared row is missing");const data=record(raw[row]);
  for(const key of ["tool","version","checksumsUrl","assetUrlTemplate"])if(typeof data[key]!=="string" || data[key]==="")throw new Error(`declaration ${key} must be nonempty text`);
  const tool=data["tool"] as string;const version=data["version"] as string;
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(tool) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(tool))throw new Error("tool must be a literal executable basename");
  if(!/^v?\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))throw new Error("version must be an exact semver pin, never latest/range");
  const assets=record(data["assets"]);for(const [host,asset] of Object.entries(assets))if(!/^[a-z0-9]+-[a-z0-9]+$/.test(host) || typeof asset!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:tar\.gz|zip)$/.test(asset))throw new Error("assets must map exact host keys to archive basenames");
  const template=data["assetUrlTemplate"] as string;if(template.split("<asset>").length!==2)throw new Error("assetUrlTemplate must contain exactly one <asset> placeholder");url(template.replace("<asset>","asset"));url(data["checksumsUrl"] as string);
  const argv=data["versionArgv"] ?? ["version"];if(!Array.isArray(argv) || argv.length===0 || argv.length>10 || argv.some(arg=>typeof arg!=="string" || /[\x00-\x1f\x7f]/.test(arg)))throw new Error("versionArgv must be a bounded literal string array");
  return {tool,version,checksumsUrl:data["checksumsUrl"] as string,assetUrlTemplate:template,assets:assets as Record<string,string>,versionArgv:argv as string[]};
}
function versionMatches(output:string,version:string):boolean {return output.trim()===version || output.trim()===version.replace(/^v/,"");}
export async function installTool(options:{contract:string;row:string;binDir:string;seams:Seams;arch:string;download:Download;cleanup?: (path:string)=>void}):Promise<ToolInstallResult> {
  const host=`${options.seams.platform}-${options.arch}`;let tool:string|null=null;let version:string|null=null;let check="declaration";let temporary:string|null=null;let outcome:ToolInstallResult|null=null;
  const answer=(verdict:ToolInstallResult["verdict"],exit:ToolInstallResult["exit"],detail:string,path:string|null=null):ToolInstallResult=>{outcome={contract:TOOL_INSTALL_CONTRACT,host,tool,version,verdict,exit,path,check,detail};return outcome;};
  try {
    const pin=declaration(options.contract,options.row);tool=pin.tool;version=pin.version;
    if(!Object.hasOwn(pin.assets,host))return answer("not-scanned",3,`not scanned: no declared asset for ${host}`);
    const asset=pin.assets[host] as string;const binary=tool+(options.seams.platform==="win32"?".exe":"");
    check="install destination";if(!isAbsolute(options.binDir))throw new Error("--bin-dir must be an absolute existing PATH directory");
    const binDir=realpathSync(options.binDir);if(!lstatSync(binDir).isDirectory())throw new Error("bin directory is not a directory");
    const onPath=(options.seams.env["PATH"] ?? options.seams.env["Path"] ?? "").split(delimiter).some(entry=>{try{return isAbsolute(entry)&&realpathSync(entry)===binDir;}catch{return false;}});
    if(!onPath)throw new Error("bin directory is not on the existing PATH; no profile or PATH changes are made");
    const destination=join(binDir,binary);
    check="installed version";
    if(existsSync(destination)) {
      const stat=lstatSync(destination);if(!stat.isFile() || stat.isSymbolicLink())throw new Error("existing tool is not a regular file; refusing replacement");
      const probe=options.seams.run(destination,pin.versionArgv,{cwd:binDir});
      if(probe.code===0 && !probe.spawnFailed && versionMatches(probe.stdout,pin.version))return answer("unchanged",0,`already installed at exact pinned version ${pin.version}; nothing changed`,destination);
      return answer("refused",1,"installed version differs or could not be verified; existing tool was not changed",destination);
    }
    check="checksum manifest fetch";const manifest=await options.download(url(pin.checksumsUrl),2*1024*1024);if(manifest.length>2*1024*1024)throw new Error("manifest byte budget exceeded");const text=new TextDecoder("utf-8",{fatal:true}).decode(manifest);
    check="checksum manifest entry";const hashes:string[]=[];
    for(const line of text.split(/\r?\n/)){const match=/^([a-fA-F0-9]{64}) +\*?([^\r\n]+)$/.exec(line);if(match?.[2]===asset)hashes.push((match[1] as string).toLowerCase());else if(line.endsWith(asset))throw new Error("malformed asset manifest entry");}
    if(hashes.length!==1)throw new Error("manifest must contain exactly one SHA256 entry for the declared host asset");
    check="archive fetch";const archive=await options.download(url(pin.assetUrlTemplate.replace("<asset>",asset)),128*1024*1024);if(archive.length>128*1024*1024)throw new Error("archive byte budget exceeded");
    check="archive checksum";if(createHash("sha256").update(archive).digest("hex")!==hashes[0])return answer("refused",1,"archive SHA256 mismatch; nothing extracted or installed");
    check="verified archive structure";const bytes=archiveBinary(archive,asset,binary);
    check="staged version";temporary=mkdtempSync(join(binDir,".nen-tool-"));const staged=join(temporary,binary);writeFileSync(staged,bytes,{flag:"wx",mode:0o700});
    const probe=options.seams.run(staged,pin.versionArgv,{cwd:temporary});if(probe.code!==0 || probe.spawnFailed || !versionMatches(probe.stdout,pin.version))throw new Error("verified executable did not report the exact declared version; nothing installed");
    check="atomic install";if(realpathSync(options.binDir)!==binDir)throw new Error("install directory moved before publication");linkSync(staged,destination);
    return answer("installed",0,`installed ${tool} ${pin.version} after archive SHA256 verification`,destination);
  } catch(error) {return answer("refused",check==="declaration" || check==="install destination"?2:1,error instanceof Error?error.message:String(error));}
  finally {if(temporary!==null){try{if(options.cleanup)options.cleanup(temporary);else rmSync(temporary,{recursive:true,force:true});}catch{if(outcome!==null)Object.assign(outcome,{cleanupWarning:"temporary verified executable staging could not be removed; installed outcome and path above remain authoritative"});}}}
}
