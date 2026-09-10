import { describe, expect, it } from "vitest";
import { renderCommitMsgHook, renderPreCommitHook, type HookSpec } from "./hook.js";

const SPEC: HookSpec = { agentTrailer: "X-Agent", runTrailer: "X-Run", markerEnvVar: "X_AUTOMATED" };

describe("renderCommitMsgHook -- conditional on the marker env var only", () => {
  it("is a POSIX sh script starting with a shebang", () => {
    expect(renderCommitMsgHook(SPEC).startsWith("#!/bin/sh\n")).toBe(true);
  });

  it("exits 0 immediately when the marker env var is unset -- never touches a human commit", () => {
    const script = renderCommitMsgHook(SPEC);
    expect(script).toContain('if [ -z "${X_AUTOMATED:-}" ]; then');
  });

  it("checks for both trailer keys, by the caller-supplied names", () => {
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

describe("renderCommitMsgHook -- the refused attribution trailers, baked in as data", () => {
  it("adds nothing at all when the policy refuses nothing", () => {
    expect(renderCommitMsgHook(SPEC, [])).toBe(renderCommitMsgHook(SPEC));
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
