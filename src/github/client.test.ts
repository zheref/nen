// ============================================================================
// SEEDED FROM bankai-core `cli/src/github/client.test.ts` (zheref/nen#1, Akatsuki migration P1).
//
// The header below this block is the ORIGINAL's, carried VERBATIM. It is not
// decoration: every WHY in it names a production incident, and a port that
// arrives without the explanation of why a branch exists is a port whose next
// maintainer "simplifies" it back into the bug (the BC-IS-#737 discipline).
// Only file PATHS have been rewritten, because this repository has no `cli/`
// subdirectory -- nen IS the CLI. References to bankai-core's own scripts,
// workflows and clause IDs are left alone: they are accurate statements about
// the system this code came from and where its reasoning is recorded.
// ============================================================================
// Tests for the octokit wrapper's non-I/O surface (BC-IS-#736, epic BC-IS-#733
// Phase 1).
//
// NO NETWORK. What is tested here is the one piece of behaviour that decides
// something before any request happens: WHICH token is used. A wrong answer is
// silent -- an ambient token runs as the wrong identity, and an unauthenticated
// read of a private repo 404s in a way that reads like a deleted PR.
//
// THE CLIENT'S OTHER BRANCHING IS NOT UNTESTED, IT MOVED (BC-9, BC-PR-#802
// verification). `checkRollup()` used to decide which commit's rollup is read
// inside an async method that only a live PR could exercise, which is BC-9's
// auto-reject: real branching, no vitest test. That logic is pure, so it now
// lives in ./graphql.ts and is driven directly -- including the client-response
// -> parser -> typed-model composition the old split had nobody testing -- by
// ./graphql.test.ts. The methods left in ./client.ts are one await plus one
// extraction call each, with no branch to cover.

import { describe, expect, it } from "vitest";
import { tokenFromEnv } from "./client.js";

describe("tokenFromEnv", () => {
  it("reads the variable the caller names", () => {
    const result = tokenFromEnv("BANKAI_APP_TOKEN", { BANKAI_APP_TOKEN: "ghs_x" });

    expect(result).toEqual({ ok: true, token: "ghs_x" });
  });

  it("reports an UNSET variable as itself, rather than failing later as an auth error", () => {
    const result = tokenFromEnv("GITHUB_TOKEN", {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("GITHUB_TOKEN");
  });

  it("reports an EMPTY variable -- an empty token authenticates as nobody, and an unauthenticated read of a private repo 404s like a deleted PR", () => {
    expect(tokenFromEnv("GITHUB_TOKEN", { GITHUB_TOKEN: "" }).ok).toBe(false);
    expect(tokenFromEnv("GITHUB_TOKEN", { GITHUB_TOKEN: "   " }).ok).toBe(false);
  });

  it("NEVER falls back to another variable -- the identity a call runs as is a property of the code, not of the environment", () => {
    // The failure this prevents: a job that forgot to mint its App token
    // silently running as whatever GH_TOKEN happened to be exported, which is
    // how `gh` behaves and is precisely what this client does not do.
    const result = tokenFromEnv("BANKAI_APP_TOKEN", {
      GH_TOKEN: "ghp_ambient",
      GITHUB_TOKEN: "ghs_ambient",
    });

    expect(result.ok).toBe(false);
  });
});
