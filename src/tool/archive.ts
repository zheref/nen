// Read verified archives in memory: no archive path is ever extracted to disk.
import { gunzipSync, inflateRawSync } from "node:zlib";
const LIMIT = 256 * 1024 * 1024;
function pathName(name:string):void {
  if (!name || name.startsWith("/") || name.includes("\\") || /[\x00-\x1f\x7f:]/.test(name) || name.split("/").some(part=>part === ".." || part === ".")) throw new Error("archive path check failed");
}
function utf8(bytes:Buffer):string { return new TextDecoder("utf-8",{fatal:true}).decode(bytes); }
function crc32(bytes:Buffer):number {let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)!==0?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
export function archiveBinary(bytes:Buffer, asset:string, binary:string):Buffer {
  const files=new Map<string,Buffer>(); let total=0;
  const add=(name:string,data:Buffer):void=>{ pathName(name); if(files.has(name)) throw new Error("archive duplicate path check failed");total+=data.length;if(total>LIMIT)throw new Error("archive expanded size budget exceeded");files.set(name,data); };
  if(asset.endsWith(".tar.gz")) {
    const tar=gunzipSync(bytes,{maxOutputLength:LIMIT});let offset=0;let ended=false;
    while(offset+512<=tar.length) {
      const header=tar.subarray(offset,offset+512);if(header.every(byte=>byte===0)){if(tar.length-offset<1024 || !tar.subarray(offset).every(byte=>byte===0))throw new Error("archive tar trailing/termination check failed");ended=true;break;}
      const string=(start:number,length:number):string=>utf8(header.subarray(start,start+length)).split("\0",1)[0] ?? "";
      const octal=(start:number,length:number):number=>{const value=string(start,length).trim();if(!/^[0-7]+$/.test(value))throw new Error("archive numeric header check failed");return Number.parseInt(value,8);};
      let checksum=0;for(let i=0;i<512;i++)checksum+=i>=148&&i<156 ? 32 : header[i] ?? 0;
      if(checksum!==octal(148,8))throw new Error("archive tar header checksum failed");
      const name=[string(345,155),string(0,100)].filter(Boolean).join("/");pathName(name);const size=octal(124,12);const type=string(156,1);
      if(size>LIMIT || offset+512+size>tar.length)throw new Error("archive truncated or oversized entry");
      if(type === "" || type === "0") add(name,tar.subarray(offset+512,offset+512+size));
      else if(type!=="5" || size!==0)throw new Error("archive links and special entries are refused");
      offset+=512+Math.ceil(size/512)*512;
    }
    if(!ended)throw new Error("archive tar terminator missing");
  } else if(asset.endsWith(".zip")) {
    let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50 && i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
    if(end<0)throw new Error("archive ZIP directory missing");
    const count=bytes.readUInt16LE(end+10);const start=bytes.readUInt32LE(end+16);const directorySize=bytes.readUInt32LE(end+12);
    if(bytes.readUInt16LE(end+4)!==0 || bytes.readUInt16LE(end+6)!==0 || count!==bytes.readUInt16LE(end+8) || count>4096 || start+directorySize!==end)throw new Error("archive multi-volume/ZIP64 or malformed directory refused");
    let at=start;const ranges:{start:number;end:number}[]=[];
    for(let n=0;n<count;n++){
      if(at+46>end || bytes.readUInt32LE(at)!==0x02014b50)throw new Error("archive ZIP entry missing");
      const flags=bytes.readUInt16LE(at+8);const method=bytes.readUInt16LE(at+10);const expectedCrc=bytes.readUInt32LE(at+16);const compressed=bytes.readUInt32LE(at+20);const size=bytes.readUInt32LE(at+24);const length=bytes.readUInt16LE(at+28);const extra=bytes.readUInt16LE(at+30);const comment=bytes.readUInt16LE(at+32);const local=bytes.readUInt32LE(at+42);const mode=bytes.readUInt32LE(at+38)>>>16;
      if(at+46+length+extra+comment>end || (flags&~(8|2048))!==0 || ![0,8].includes(method) || size>LIMIT || ![0,0x8000,0x4000].includes(mode&0xf000) || bytes.readUInt16LE(at+34)!==0)throw new Error("archive ZIP entry type/size check failed");
      const name=utf8(bytes.subarray(at+46,at+46+length));pathName(name);
      if(local+30>start || bytes.readUInt32LE(local)!==0x04034b50 || bytes.readUInt16LE(local+8)!==method || bytes.readUInt16LE(local+6)!==flags)throw new Error("archive ZIP local header check failed");
      const localLength=bytes.readUInt16LE(local+26);const body=local+30+localLength+bytes.readUInt16LE(local+28);if(body+compressed>start || utf8(bytes.subarray(local+30,local+30+localLength))!==name)throw new Error("archive ZIP overlap/path check failed");let payloadEnd=body+compressed;
      if((flags&8)===0){if(bytes.readUInt32LE(local+14)!==expectedCrc || bytes.readUInt32LE(local+18)!==compressed || bytes.readUInt32LE(local+22)!==size)throw new Error("archive ZIP local metadata mismatch");}
      else {for(const [offset,value] of [[14,expectedCrc],[18,compressed],[22,size]] as const){const found=bytes.readUInt32LE(local+offset);if(found!==0 && found!==value)throw new Error("archive ZIP descriptor local metadata mismatch");}let descriptor=payloadEnd;if(descriptor+4<=start && bytes.readUInt32LE(descriptor)===0x08074b50)descriptor+=4;if(descriptor+12>start || bytes.readUInt32LE(descriptor)!==expectedCrc || bytes.readUInt32LE(descriptor+4)!==compressed || bytes.readUInt32LE(descriptor+8)!==size)throw new Error("archive ZIP data descriptor mismatch");payloadEnd=descriptor+12;}
      ranges.push({start:local,end:payloadEnd});
      if(total+size>LIMIT)throw new Error("archive expanded size budget exceeded");
      const payload=bytes.subarray(body,body+compressed);const data=method===0?payload:inflateRawSync(payload,{maxOutputLength:LIMIT});if(crc32(data)!==expectedCrc)throw new Error("archive ZIP CRC mismatch");if(data.length!==size)throw new Error("archive ZIP expanded length mismatch");
      if(((mode&0xf000)===0x4000 && !name.endsWith("/")) || ((mode&0xf000)===0x8000 && name.endsWith("/")))throw new Error("archive ZIP mode/name mismatch");
      if(!name.endsWith("/"))add(name,data);else if(size!==0)throw new Error("archive directory has content");
      at+=46+length+extra+comment;
    }
    ranges.sort((a,b)=>a.start-b.start);if(ranges.some((range,index)=>index>0 && range.start<(ranges[index-1]?.end ?? 0)))throw new Error("archive ZIP overlapping entries refused");
    if(at!==end)throw new Error("archive ZIP directory count mismatch");
  } else throw new Error("archive format must be .tar.gz or .zip");
  const found=files.get(binary);if(found===undefined || found.length===0)throw new Error(`archive must contain one nonempty root executable '${binary}'`);return found;
}
