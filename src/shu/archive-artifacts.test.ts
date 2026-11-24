import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { makeTempDir } from "../testing/tempdir.js";
import { archiveFacts } from "./archive-artifacts.js";

const window = { started: 0, ended: Date.parse("2100-01-01") };
function file(content = "abc"): string {
  const path = join(makeTempDir("nen-archive-facts-"), "artifact");
  fs.writeFileSync(path, content);
  return path;
}

describe("archive artifact reader", () => {
  it("AC-3 names an unreadable artifact distinctly from absence", () => {
    const result = archiveFacts(file(), window, { ...fs, readSync: (): never => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    } });
    expect(result).toMatchObject({ status: "unreadable", bytes: null, digest: null, producedThisRun: null, error: expect.stringContaining("permission denied") });
  });

  it("keeps a stat permission failure distinct from missing", () => {
    const result = archiveFacts(file(), window, { ...fs, lstatSync: (): never => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    } });
    expect(result.status).toBe("unreadable");
  });

  it("classifies an artifact disappearing after observation as unreadable", () => {
    const result = archiveFacts(file(), window, { ...fs, openSync: (): never => {
      throw Object.assign(new Error("removed"), { code: "ENOENT" });
    } });
    expect(result.status).toBe("unreadable");
  });

  it("hashes empty and multi-buffer files by their actual bytes", () => {
    for (const content of ["", "é".repeat(65537)]) {
      const result = archiveFacts(file(content), window);
      expect(result.bytes).toBe(Buffer.byteLength(content));
      expect(result.digest?.value).toBe(createHash("sha256").update(content).digest("hex"));
    }
  });

  it("does not follow a symlink or descend into a directory", () => {
    const root = makeTempDir("nen-archive-link-");
    const target = join(root, "target");
    fs.mkdirSync(target);
    const link = join(root, "link");
    fs.symlinkSync(target, link, "junction");
    expect(archiveFacts(link, window).status).toBe("symlink");
    expect(archiveFacts(target, window)).toMatchObject({ status: "directory", bytes: null, digest: null });
  });

  it("does no file read without a real run window", () => {
    expect(archiveFacts(file(), null, { ...fs, lstatSync: (): never => { throw new Error("must not inspect"); } }))
      .toMatchObject({ status: "not-inspected", freshness: "not-run", producedThisRun: null });
  });

  it("does not publish a digest after an early EOF", () => {
    expect(archiveFacts(file(), window, { ...fs, readSync: (): number => 0 }))
      .toMatchObject({ status: "unreadable", digest: null, error: expect.stringContaining("early end") });
  });

  it("does not publish a digest if the artifact changes during the read", () => {
    const path = file();
    let statCalls = 0;
    expect(archiveFacts(path, window, { ...fs, fstatSync: ((fd: number): fs.Stats => {
      if (++statCalls === 2) fs.appendFileSync(path, "changed");
      return fs.fstatSync(fd);
    }) as typeof fs.fstatSync })).toMatchObject({ status: "unreadable", digest: null });
  });

  it("reports descriptor-close failure per artifact without throwing", () => {
    expect(archiveFacts(file(), window, { ...fs, closeSync: (fd: number): never => {
      fs.closeSync(fd);
      throw new Error("close failed");
    } })).toMatchObject({ status: "unreadable", digest: null, error: expect.stringContaining("close failed") });
  });

  it("refuses a file changed between lstat and opening the descriptor", () => {
    const path = file();
    expect(archiveFacts(path, window, { ...fs, fstatSync: ((fd: number): fs.Stats => {
      fs.appendFileSync(path, "changed");
      return fs.fstatSync(fd);
    }) as typeof fs.fstatSync })).toMatchObject({ status: "unreadable", digest: null, error: expect.stringContaining("before") });
  });
});
