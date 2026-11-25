import { emit, refuseExtraPositionals, requireSubcommand, requireValue, type Command, type CommandContext } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { installTool, type Download } from "./install.js";
const USAGE=`nen tool install --contract <absolute-file> --row <name> --bin-dir <absolute-existing-PATH-directory> [--json]

Install a caller-declared, exact-version, checksum-pinned tool. The trusted JSON
row declares tool, version, assets keyed by platform-architecture, checksumsUrl,
assetUrlTemplate (one <asset> placeholder), and optional versionArgv (default
["version"]). No tool/version/download host is selected by Nen. No unpinned
installation, PATH/profile editing, elevation, retries or overwrite occurs.

Both URLs must use credential-free HTTPS. The manifest must contain exactly one
SHA256 entry for the host asset. Downloaded archive bytes verify before any
archive parsing/extraction or execution. Only the root tool executable is staged;
links, special entries, traversal, malformed/oversized tar.gz or ZIP archives
refuse. Its exact version is probed before atomic no-overwrite publication.
Already installed exact pin: no change/download. Other existing versions refuse.
No declared host asset: not scanned (3), no platform substitution.

Exit0 installed/unchanged; exit1 named fetch/integrity/version/install refusal;
exit2 declaration/destination wiring; exit3 unsupported host, explicitly not scanned.
TLS certificate verification is forced. Runtime HTTPS proxy and additional trust
store settings may still apply; no credentials/cookies are attached. Redirects
follow at most five credential-free HTTPS destinations (release asset hosting).`;
/** Bounded HTTPS transport; injectable for offline fixtures, never a retry. */
export const downloadHttps:Download=async(input,maxBytes)=>{
  let target=input;
  const signal=AbortSignal.timeout(120000);
  for(let hop=0;hop<=5;hop++){
    if(target.protocol!=="https:" || target.username || target.password || target.hash)throw new Error("HTTPS redirect destination check failed");
    const response=await fetch(target,{redirect:"manual",signal,credentials:"omit",tls:{rejectUnauthorized:true}} as RequestInit);
    if(response.status>=300 && response.status<400){await response.body?.cancel();const location=response.headers.get("location");if(!location || hop===5)throw new Error("HTTPS redirect bound/location check failed");target=new URL(location,target);continue;}
    if(!response.ok){await response.body?.cancel();throw new Error(`HTTPS fetch returned ${response.status}`);}
    const reader=response.body?.getReader();if(!reader)throw new Error("HTTPS response has no body");let total=0;const chunks:Buffer[]=[];
    try{for(;;){const next=await reader.read();if(next.done)break;total+=next.value.length;if(total>maxBytes)throw new Error("HTTPS response byte budget exceeded");chunks.push(Buffer.from(next.value));}}finally{await reader.cancel();}
    return Buffer.concat(chunks,total);
  }
  throw new Error("HTTPS redirect bound exceeded");
};
export async function runTool(context:CommandContext,download:Download,arch:string):Promise<number>{
  requireSubcommand("tool",context.args,["install"]);refuseExtraPositionals(context.args,2);
  const result=await installTool({contract:requireValue(context.args,"contract","trusted declaration required"),row:requireValue(context.args,"row","declared row required"),binDir:requireValue(context.args,"bin-dir","existing PATH destination required"),seams:context.seams,download,arch});
  emit(context.io,context.json,result,[plainLine(`${result.verdict}: ${result.host}; ${result.check}: ${result.detail}${result.cleanupWarning ? `; cleanup: ${result.cleanupWarning}` : ""}`)]);return result.exit;
}
export const toolCommand:Command={name:"tool",summary:"Install a declared tool only after pinned archive checksum verification.",subcommands:["install"],usage:USAGE,flags:{values:["contract","row","bin-dir"],booleans:[]},run:context=>runTool(context,downloadHttps,process.arch)};
