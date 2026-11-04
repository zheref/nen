import { gzipSync } from "node:zlib";
export function tar(entries:{name:string;bytes?:Buffer;type?:string}[]):Buffer {
  const rows:Buffer[]=[];
  for(const entry of entries){const bytes=entry.bytes ?? Buffer.from("verified executable");const head=Buffer.alloc(512);head.write(entry.name,0,100);head.write("0000700\0",100);head.write("0000000\0",108);head.write("0000000\0",116);head.write(bytes.length.toString(8).padStart(11,"0")+"\0",124);head.write("00000000000\0",136);head.fill(32,148,156);head.write(entry.type ?? "0",156);head.write("ustar\0",257);const sum=head.reduce((a,b)=>a+b,0);head.write(sum.toString(8).padStart(6,"0")+"\0 ",148);rows.push(head,bytes,Buffer.alloc((512-bytes.length%512)%512));}
  return gzipSync(Buffer.concat([...rows,Buffer.alloc(1024)]));
}

export function zip(options:{mode?:number;crc?:number;localSize?:number;count?:number}={}):Buffer {
  const body=Buffer.from("123456789");const name=Buffer.from("scanner.exe");const crc=options.crc ?? 0xcbf43926;
  const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt32LE(crc,14);local.writeUInt32LE(options.localSize ?? body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(name.length,26);
  const directory=Buffer.alloc(46);directory.writeUInt32LE(0x02014b50,0);directory.writeUInt32LE(crc,16);directory.writeUInt32LE(body.length,20);directory.writeUInt32LE(body.length,24);directory.writeUInt16LE(name.length,28);directory.writeUInt32LE(((options.mode ?? 0x81c0)*65536)>>>0,38);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(options.count ?? 1,8);end.writeUInt16LE(options.count ?? 1,10);end.writeUInt32LE(directory.length+name.length,12);end.writeUInt32LE(local.length+name.length+body.length,16);
  return Buffer.concat([local,name,body,directory,name,end]);
}
