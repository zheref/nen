import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { HOOK_COMPOSED_KEYS_ENV, renderCommitMsgHook, renderPreCommitHook, STRIP_SIDECAR_FILE, type HookSpec } from "./hook.js";

const SPEC: HookSpec = { agentTrailer: "X-Agent", runTrailer: "X-Run", markerEnvVar: "X_AUTOMATED" };

describe("renderCommitMsgHook -- conditional on the marker env var only", () => {
  it("is a POSIX sh script starting with a shebang", () => {
    expect(renderCommitMsgHook(SPEC).startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("exits 0 immediately when the marker env var is unset -- never touches a human commit", () => {
    const script = renderCommitMsgHook(SPEC);
    expect(script).toContain('if [ -z "${X_AUTOMATED:-}" ]; then');
  });

  it("checks for both trailer keys, by the caller-supplied names, when a run trailer is stated", () => {
    const script = renderCommitMsgHook(SPEC);
    expect(script).toContain("^X-Agent: .+");
    expect(script).toContain("^X-Run: .+");
  });

  it("carries a different trailer pair through untouched -- no literal baked in", () => {
    const script = renderCommitMsgHook({ agentTrailer: "Akatsuki-Agent", runTrailer: "Akatsuki-Run", markerEnvVar: "CI" });
    expect(script).toContain("^Akatsuki-Agent: .+");
    expect(script).toContain("^Akatsuki-Run: .+");
    expect(script).toContain('${CI:-}');
  });
});

describe("renderCommitMsgHook -- the run identifier is OPTIONAL (zheref/nen#167)", () => {
  it("checks only the agent trailer when runTrailer is null -- no second requirement", () => {
    const script = renderCommitMsgHook({ agentTrailer: "X-Agent", runTrailer: null, markerEnvVar: "X_AUTOMATED" });
    expect(script).toContain("^X-Agent: .+");
    expect(script).not.toContain("-Run");
    expect(script).not.toMatch(/carries no 'X-Run/);
  });

  it("requires the run trailer too when one is stated", () => {
    const script = renderCommitMsgHook(SPEC);
    expect(script).toContain("carries no 'X-Agent: <value>' trailer");
    expect(script).toContain("carries no 'X-Run: <value>' trailer");
  });

  it("regenerating from the SAME spec and policy is byte-stable", () => {
    expect(renderCommitMsgHook(SPEC, ["Co-Authored-By"], true)).toBe(
      renderCommitMsgHook(SPEC, ["Co-Authored-By"], true),
    );
    expect(renderCommitMsgHook({ ...SPEC, runTrailer: null })).toBe(
      renderCommitMsgHook({ ...SPEC, runTrailer: null }),
    );
  });
});

describe("renderCommitMsgHook -- a policy that does not admit the required key (zheref/nen#167)", () => {
  it("refuses EVERY automated commit outright, rather than checking for a trailer that could never be added", () => {
    const script = renderCommitMsgHook(SPEC, [], false);
    expect(script).not.toContain("grep -qE '^X-Agent: .+'");
    expect(script).toContain("does not admit 'X-Agent'");
    expect(script).toContain("commits.allowedAttributionTrailers");
    expect(script).toContain("exit 1");
  });

  it("still exits 0 for a human (non-automated) commit -- the marker-env gate still applies", () => {
    const script = renderCommitMsgHook(SPEC, [], false);
    expect(script.indexOf('if [ -z "${X_AUTOMATED:-}" ]; then')).toBeLessThan(
      script.indexOf("does not admit 'X-Agent'"),
    );
  });

  it("defaults agentTrailerAdmitted to true, so existing callers that pass only two arguments are unaffected", () => {
    expect(renderCommitMsgHook(SPEC)).toContain("^X-Agent: .+");
  });
});

describe("renderCommitMsgHook -- the refused attribution trailers, baked in as data", () => {
  it("adds nothing at all when the policy refuses nothing", () => {
    expect(renderCommitMsgHook(SPEC, [])).toBe(renderCommitMsgHook(SPEC));
  });

  it("greps THE MESSAGE FILE, expanded -- not a literal '$msg_file'", () => {
    // The bug this pins, found by running the generated hook against real git:
    // an over-escaped `\\$` in the TypeScript template emitted `"\\$msg_file"`,
    // which a shell reads as the literal filename `$msg_file`. Every grep then
    // failed with "No such file or directory", every `if` was false, and the
    // guard silently refused nothing while `git commit` reported success --
    // the worst available failure for a guard. Asserting the PATTERN alone
    // could not see it, which is why the argument is asserted too, and why
    // ./hook.integration.test.ts runs the script for real.
    const script = renderCommitMsgHook(SPEC, ["Co-Authored-By"]);
    expect(script).toContain(`grep -qiE '^Co-Authored-By:' "$msg_file"`);
    expect(script).not.toContain('\\$msg_file');
  });

  it("greps for each refused key CASE-INSENSITIVELY, and names it in the refusal", () => {
    const script = renderCommitMsgHook(SPEC, ["Co-Authored-By", "Claude-Session"]);
    expect(script).toContain("grep -qiE '^Co-Authored-By:'");
    expect(script).toContain("grep -qiE '^Claude-Session:'");
    expect(script).toContain("carries a 'Co-Authored-By:' trailer");
    // A guard one capital defeats is not a guard: the `-i` is the whole point.
    expect(script).not.toContain("grep -qE '^Co-Authored-By:'");
  });

  it("refuses them on EVERY commit -- the check sits ABOVE the marker-env gate", () => {
    // The trailer PAIR is an obligation an automated run takes on about itself;
    // a refused attribution trailer is a fact about the MESSAGE, and a guard
    // that only fires when a marker is set is one any agent evades by not
    // setting it.
    const script = renderCommitMsgHook(SPEC, ["Co-Authored-By"]);
    expect(script.indexOf("^Co-Authored-By:")).toBeLessThan(script.indexOf('${X_AUTOMATED:-}'));
  });

  it("names the file the list came from, so the fix is one edit away", () => {
    expect(renderCommitMsgHook(SPEC, ["Co-Authored-By"])).toContain(
      "commits.allowedAttributionTrailers",
    );
  });
});

describe("renderPreCommitHook -- the trunk guard", () => {
  it("is a POSIX sh script that compares the CURRENT branch with the stated trunk", () => {
    const script = renderPreCommitHook("main");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain('base="main"');
    expect(script).toContain("git branch --show-current");
    expect(script).toContain('if [ "$current" = "$base" ]; then');
    expect(script).toContain("exit 1");
  });

  it("carries a DIFFERENT trunk name through untouched -- no literal baked in", () => {
    expect(renderPreCommitHook("release/1.x")).toContain('base="release/1.x"');
  });

  it("says how to proceed rather than only refusing", () => {
    expect(renderPreCommitHook("main")).toContain("git switch -c");
  });

  it("lets a detached HEAD through: an empty branch name is not the trunk", () => {
    // `git branch --show-current` prints nothing during a rebase or a bisect,
    // and refusing those would make this hook the reason a rebase cannot end.
    const script = renderPreCommitHook("main");
    expect(script).toContain("2>/dev/null || true");
    expect(script).not.toContain("-z \"$current\"");
  });
});

describe("renderCommitMsgHook -- commits.stripInjected, the opt-in strip step (zheref/nen#594)", () => {
  const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

  // THE PIN THE OPT-IN STANDS ON. These digests are of the hook this function
  // rendered BEFORE the strip step existed (origin/main c6775f81), for three
  // shapes: an empty list must reproduce them byte for byte, or every
  // consumer's `nen scaffold init` would stop answering `unchanged`.
  it.each([
    ["a run trailer and two refused keys", SPEC, ["Co-Authored-By", "Claude-Session"], true, "da777316399ae3db3e2a26388b35a238a117b9a72f121d3d54815a04072aa358"],
    ["no run trailer, nothing refused", { ...SPEC, runTrailer: null }, [], true, "020070bb474f7c71be9e2571d61785e7953ceb4167383806641b994b3732b23f"],
    ["the agent trailer not admitted", SPEC, ["Co-Authored-By"], false, "ca45ce399f42f6dad1cd3ad724dcab433217cb7e6c2bf8cfc1618853b2decd06"],
  ] as const)("an EMPTY list is byte-identical to the hook before #594: %s", (_name, spec, refused, admitted, digest) => {
    expect(sha256(renderCommitMsgHook(spec, refused, admitted, []))).toBe(digest);
    expect(renderCommitMsgHook(spec, refused, admitted, [])).toBe(renderCommitMsgHook(spec, refused, admitted));
    expect(renderCommitMsgHook(spec, refused, admitted)).not.toContain(HOOK_COMPOSED_KEYS_ENV);
  });

  it("a non-empty list renders the step, gated on the variable being SET (set-but-empty counts), keys baked in", () => {
    const script = renderCommitMsgHook(SPEC, ["Co-Authored-By"], true, ["Co-authored-by", "Made-with"]);
    expect(script).toContain(`if [ -n "\${${HOOK_COMPOSED_KEYS_ENV}+x}" ]; then`);
    expect(script).not.toContain(`\${${HOOK_COMPOSED_KEYS_ENV}:-}`);
    expect(script).toContain("nen_strip_keys='Co-authored-by Made-with'");
    expect(script).toContain(`>>"$nen_git_dir/${STRIP_SIDECAR_FILE}"`);
    expect(script).toContain("git rev-parse --git-dir");
    expect(script).toContain("commit-msg: stripped the hook-injected '$nen_key:' trailer (commits.stripInjected)");
  });

  it("runs the strip BEFORE the refusal greps, and leaves every refusal in place", () => {
    const script = renderCommitMsgHook(SPEC, ["Co-Authored-By"], true, ["Co-Authored-By"]);
    expect(script.indexOf(HOOK_COMPOSED_KEYS_ENV)).toBeGreaterThan(script.indexOf('msg_file="$1"'));
    expect(script.indexOf(HOOK_COMPOSED_KEYS_ENV)).toBeLessThan(script.indexOf("grep -qiE '^Co-Authored-By:'"));
    expect(script).toContain(`grep -qiE '^Co-Authored-By:' "$msg_file"`);
  });

  it("skips a key the composed message carried -- the case match on the comma-joined, lower-cased list", () => {
    const script = renderCommitMsgHook(SPEC, [], true, ["Co-authored-by"]);
    expect(script).toContain(`*",$nen_lower,"*) continue ;;`);
    expect(script).toContain("tr '[:upper:]' '[:lower:]'");
  });

  it("de-duplicates the list case-insensitively, keeping the first spelling", () => {
    expect(renderCommitMsgHook(SPEC, [], true, ["Co-authored-by", "CO-AUTHORED-BY"])).toContain("nen_strip_keys='Co-authored-by'");
  });

  it("carries no bashism the step could trip on: no [[, no local, no echo -e, and the awk program holds no single quote", () => {
    const script = renderCommitMsgHook(SPEC, [], true, ["Co-authored-by"]);
    expect(script).not.toContain("[[");
    expect(script).not.toMatch(/\blocal\b/);
    expect(script).not.toContain("echo -e");
    const awk = /awk -v key="\$nen_lower" '([^']*)'/.exec(script);
    expect(awk).not.toBeNull();
    expect(awk?.[1]).toContain("tolower(substr(txt[i], 1, k)) == key \":\"");
  });

  it("is byte-stable: the same list renders the same script", () => {
    expect(renderCommitMsgHook(SPEC, ["Co-Authored-By"], true, ["Co-authored-by"])).toBe(
      renderCommitMsgHook(SPEC, ["Co-Authored-By"], true, ["Co-authored-by"]),
    );
  });
});
