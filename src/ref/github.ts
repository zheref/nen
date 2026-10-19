// Strict syntax-only parsing: a URL never implies authentication or a lookup.
import { resolveToken } from "../repo/resolve.js";
import type { RepoRegistry } from "../schema/repos.js";
import { RefError, type ObjectKind } from "./notation.js";

export interface GithubRef {
  readonly slug: string;
  readonly kind: ObjectKind | null;
  readonly number: number;
}

export function parseGithubRef(token: string): GithubRef {
  // Match the original string, never URL-normalized paths (dot segments,
  // encoded separators, credentials, ports and fragments are not this grammar).
  const part = "[A-Za-z0-9_][A-Za-z0-9_.-]*";
  const short = new RegExp(`^(${part}/${part})#([1-9][0-9]*)$`).exec(token);
  if (short !== null && short[0] === token) return reference(short[1]!, null, short[2]!);
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token)) {
    let url: URL;
    try { url = new URL(token); } catch { throw new RefError("Input is not a valid GitHub object URL."); }
    if (url.hostname !== "github.com") throw new RefError(`Host '${url.hostname}' is refused; ref parse accepts only github.com.`);
    const match = new RegExp(String.raw`^https://github\.com/(${part}/${part})/(issues|pull)/([1-9][0-9]*)$`).exec(token);
    if (match !== null && match[0] === token) return reference(match[1]!, match[2] === "issues" ? "IS" : "PR", match[3]!);
    throw new RefError(`URL path '${url.pathname}' or authority is refused; expected https://github.com/<owner>/<name>/(issues|pull)/<N>, without credentials, port, query, fragment or extra segments.`);
  }
  throw new RefError("GitHub subject is refused; expected <owner>/<name>#<N> or https://github.com/<owner>/<name>/(issues|pull)/<N>.");
}

function reference(slug: string, kind: ObjectKind | null, digits: string): GithubRef {
  const number = Number(digits);
  if (!Number.isSafeInteger(number)) throw new RefError(`Object number '${digits}' is not a safe positive integer.`);
  return { slug, kind, number };
}

/** Enrich an already explicit slug only from recorded owner/name identity.
 * Legacy repo resolution intentionally accepts bare names; this reader must
 * not infer an owner for a subject that has already named one. */
export function githubRefCode(registry: RepoRegistry, slug: string): string | null {
  const wanted = slug.toLowerCase();
  const codes = new Set([
    ...Object.keys(registry.productCodes),
    ...registry.consumers.flatMap((entry) => entry.code === null ? [] : [entry.code]),
  ]);
  for (const code of codes) {
    // Ask the existing resolver what THIS CODE identifies, not what a bare
    // repository name might resemble. An optional code may be omitted; it
    // must never identify a different owner, even when both are recorded.
    const resolved = resolveToken(registry, code);
    const canonical = resolved.length === 1 ? resolved[0] : undefined;
    if (canonical?.kind === "code" && canonical.repo.toLowerCase() === wanted) return canonical.code;
  }
  return null;
}
