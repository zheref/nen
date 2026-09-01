import { describe, expect, it } from "vitest";
import { renderCommitMsgHook, type HookSpec } from "./hook.js";

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
