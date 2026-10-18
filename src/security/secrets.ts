// Content-only detection, shared independently of the publishing command.
// Findings carry shape names only: never a candidate or its surrounding text.
import { redactRemoteCredentials } from "../seam/exec.js";

export type SecretShape = "GitHub token" | "fine-grained PAT" | "URL credential" | "AWS access key" | "Google API key" | "Azure account key" | "private-key block" | "high-entropy token";

/** Shannon bits per character; hex hashes cannot cross this 4.5-bit threshold. */
export const SECRET_ENTROPY_THRESHOLD = 4.5;
export const SECRET_MIN_TOKEN_LENGTH = 32;

export function tokenEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Heuristic, not proof of secrecy or its absence. Scan cloud-key shapes,
 * PEM/OpenSSH private-key headers and base64-like runs of >=32 characters
 * with >=4.5 bits/character and three character classes. Low-entropy secrets
 * outside the named shapes can pass. No value is ever returned.
 *
 * Only settle calls this scanner today. Stage's filename secret-shape row
 * and the private-repository-name guard retain their existing policies.
 */
export function scanContentSecrets(text: string): readonly SecretShape[] {
  const shapes = new Set<SecretShape>();
  const github = /\bgh[pousr]_[A-Za-z0-9]{20,}/g;
  const fine = /\bgithub_pat_[A-Za-z0-9_]+/g;
  if (github.test(text)) shapes.add("GitHub token");
  if (fine.test(text)) shapes.add("fine-grained PAT");
  const withoutTokens = text.replace(github, "***").replace(fine, "***");
  if (redactRemoteCredentials(withoutTokens) !== withoutTokens) shapes.add("URL credential");
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text)) shapes.add("AWS access key");
  if (/\bAIza[A-Za-z0-9_-]{35}\b/.test(text)) shapes.add("Google API key");
  if (/\bAccountKey\s*=\s*[A-Za-z0-9+/]{43,}={0,2}/i.test(text)) shapes.add("Azure account key");
  if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(text)) shapes.add("private-key block");
  for (const match of text.matchAll(/[A-Za-z0-9+/_=-]{32,}/g)) {
    const candidate = match[0];
    const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[+/_=-]/].filter((kind): boolean => kind.test(candidate)).length;
    if (candidate.length >= SECRET_MIN_TOKEN_LENGTH && classes >= 3 && tokenEntropy(candidate) >= SECRET_ENTROPY_THRESHOLD) {
      shapes.add("high-entropy token");
      break;
    }
  }
  return [...shapes];
}
