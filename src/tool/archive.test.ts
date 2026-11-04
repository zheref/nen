import { describe, expect, it } from "vitest";
import { zip } from "./fixtures.js";
import { archiveBinary } from "./archive.js";

describe("verified ZIP structure",()=>{
  it("reads a regular root executable",()=>expect(archiveBinary(zip(),"scanner.zip","scanner.exe").toString()).toBe("123456789"));
  for(const [label,options] of [["CRC corruption",{crc:0}],["local metadata mismatch",{localSize:1}],["FIFO",{mode:0x1000}],["symlink",{mode:0xa000}],["socket",{mode:0xc000}],["entry count budget",{count:4097}]] as const)it(`refuses ${label}`,()=>expect(()=>archiveBinary(zip(options),"scanner.zip","scanner.exe")).toThrow());
});
