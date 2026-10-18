import { describe, expect, it } from "vitest";
import { scanContentSecrets, SECRET_ENTROPY_THRESHOLD, SECRET_MIN_TOKEN_LENGTH, tokenEntropy } from "./secrets.js";

describe("shared content secret shapes (#404)", () => {
  const entropyToken = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL";
  it("states and applies the entropy threshold, length and character classes", () => {
    expect(SECRET_ENTROPY_THRESHOLD).toBe(4.5);
    expect(SECRET_MIN_TOKEN_LENGTH).toBe(32);
    expect(tokenEntropy(entropyToken)).toBeGreaterThan(SECRET_ENTROPY_THRESHOLD);
    expect(scanContentSecrets(entropyToken)).toContain("high-entropy token");
    expect(scanContentSecrets(entropyToken.slice(0, 31))).toEqual([]);
    expect(scanContentSecrets("aB3".repeat(20))).toEqual([]);
    expect(scanContentSecrets("0123456789abcdef".repeat(4))).toEqual([]);
    expect(scanContentSecrets("ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(2))).toEqual([]);
  });

  for (const [shape, value] of [
    ["AWS access key", "AKIA" + "A".repeat(16)],
    ["AWS access key", "ASIA" + "B".repeat(16)],
    ["Google API key", "AIza" + "c".repeat(35)],
    ["Azure account key", "AccountKey=" + "D".repeat(86) + "=="],
    ["GitHub token", "ghp_" + "e".repeat(36)],
    ["fine-grained PAT", "github_pat_" + "f".repeat(40)],
    ["private-key block", "-----BEGIN PRIVATE KEY-----"],
    ["private-key block", "-----BEGIN RSA PRIVATE KEY-----"],
    ["private-key block", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["URL credential", "https://user:password@host/path"],
    ["URL credential", "https://user:secret/with-slash@host/repo"],
  ]) {
    it("names " + shape + " without returning its value", () => {
      const found = scanContentSecrets("before " + value + " after");
      expect(found).toContain(shape);
      expect(JSON.stringify(found)).not.toContain(value);
    });
  }

  it("keeps prose, commit hashes, public keys and URL ports with later @ signs", () => {
    for (const text of [
      "Fixed the repository path validation; the checks pass.",
      "Commit " + "a1b2c3d4".repeat(5),
      "-----BEGIN PUBLIC KEY-----",
      "https://example.com:8443/repo@main",
      "https://example.com:8443/?author=@alice",
      "ssh://git@host/repo",
      "AKIAshort",
    ]) expect(scanContentSecrets(text), text).toEqual([]);
  });
});
