import { describe, expect, it } from "vitest";
import { tar, zip } from "./fixtures.js";
import { archiveBinary } from "./archive.js";

describe("verified ZIP structure",()=>{
  it("reads a regular root executable",()=>expect(archiveBinary(zip(),"scanner.zip","scanner.exe").toString()).toBe("123456789"));
  for(const [label,options] of [["CRC corruption",{crc:0}],["local metadata mismatch",{localSize:1}],["FIFO",{mode:0x1000}],["symlink",{mode:0xa000}],["socket",{mode:0xc000}],["entry count budget",{count:4097}]] as const)it(`refuses ${label}`,()=>expect(()=>archiveBinary(zip(options),"scanner.zip","scanner.exe")).toThrow());
});

it.each([
  [{ name: "docs/", type: "5", bytes: Buffer.alloc(0) }, { name: "docs/", type: "5", bytes: Buffer.alloc(0) }, { name: "scanner" }],
  [{ name: "scanner", type: "5", bytes: Buffer.alloc(0) }, { name: "scanner" }],
  [{ name: "scanner/", type: "5", bytes: Buffer.alloc(0) }, { name: "scanner" }],
])("rejects duplicate tar directories and file-directory aliases", (...entries) => {
  expect(() => archiveBinary(tar(entries), "scanner.tar.gz", "scanner")).toThrow(/duplicate/);
});

function zipMembers(members: Buffer[]): Buffer {
  const locals: Buffer[] = [], directories: Buffer[] = []; let offset = 0;
  for (const member of members) {
    const end = member.length - 22; const start = member.readUInt32LE(end + 16);
    const local = member.subarray(0, start); const directory = Buffer.from(member.subarray(start, end));
    directory.writeUInt32LE(offset, 42); locals.push(local); directories.push(directory); offset += local.length;
  }
  const directory = Buffer.concat(directories); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(members.length, 8); end.writeUInt16LE(members.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
it.each(["docs/", "scanner.exe/"])("rejects duplicate ZIP directories and file-directory aliases: %s", name => {
  const members = name === "docs/" ? [zip({ name, directory: true }), zip({ name, directory: true }), zip()] : [zip({ name, directory: true }), zip()];
  expect(() => archiveBinary(zipMembers(members), "scanner.zip", "scanner.exe")).toThrow(/duplicate/);
});
it("accepts distinct ZIP directories alongside the root executable", () => {
  expect(archiveBinary(zipMembers([zip({ name: "docs/", directory: true }), zip()]), "scanner.zip", "scanner.exe").toString()).toBe("123456789");
});
