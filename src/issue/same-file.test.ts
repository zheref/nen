import { describe, expect, it, vi } from "vitest";
import { sameFile } from "./same-file.js";

// Windows file IDs can exceed Number.MAX_SAFE_INTEGER. Model the fs API's
// number/bigint representations of adjacent IDs without requiring an NTFS host.
vi.mock("node:fs", () => ({
  statSync(path: string, options?: { bigint?: boolean }): { dev: bigint; ino: bigint } | { dev: number; ino: number } {
    const identities: Record<string, { dev: bigint; ino: bigint }> = {
      body: { dev: 1n, ino: 9007199254740992n },
      other: { dev: 1n, ino: 9007199254740993n },
      alias: { dev: 1n, ino: 9007199254740992n },
      otherDevice: { dev: 2n, ino: 9007199254740992n },
    };
    const identity = identities[path];
    if (!identity) throw new Error("ENOENT");
    return options?.bigint ? identity : { dev: Number(identity.dev), ino: Number(identity.ino) };
  },
}));

describe("sameFile with full-width file IDs", () => {
  it("distinguishes adjacent file IDs that round to the same number", () => {
    expect(Number(9007199254740992n)).toBe(Number(9007199254740993n));
    expect(sameFile("body", "other")).toBe(false);
  });

  it("retains aliases of the same ID and distinguishes devices", () => {
    expect(sameFile("body", "alias")).toBe(true);
    expect(sameFile("body", "otherDevice")).toBe(false);
  });

  it("compares missing paths lexically without inventing an identity", () => {
    expect(sameFile("missing", "missing")).toBe(true);
    expect(sameFile("body", "missing")).toBe(false);
    expect(sameFile("missing", "body")).toBe(false);
    expect(sameFile("missing", "alsoMissing")).toBe(false);
  });
});
