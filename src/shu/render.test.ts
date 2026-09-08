// src/shu/render.test.ts -- the pure half: a declaration in, the exact steps
// out, with no seam, no filesystem and no clock anywhere in the call.

import { describe, expect, it } from "vitest";
import { VerbUsageError } from "../cli/command.js";
import { parseProjectBlock, type ProjectBlock } from "../schema/contract.js";
import { ShuRefusal } from "./exit.js";
import { REFUSED_PLACEHOLDERS, renderArgv, renderInvocation, resolveLane } from "./render.js";

function project(overrides: Record<string, unknown> = {}): ProjectBlock {
  return parseProjectBlock("/fixture/nen/contract.json", {
    lanes: { one: { stack: "stack-a", cwd: "." }, two: { stack: "stack-b", cwd: "sub" } },
    defaultLane: "one",
    verbs: {
      one: { build: { exe: "tool", argv: ["go"] } },
      two: { build: { exe: "other", argv: ["go"] } },
    },
    ...overrides,
  });
}

describe("resolveLane", () => {
  it("takes --lane when it names a declared lane", () => {
    expect(resolveLane(project(), "two")).toBe("two");
  });

  it("falls back to defaultLane when --lane is absent", () => {
    expect(resolveLane(project(), null)).toBe("one");
  });

  it("refuses an unknown --lane, naming every declared one", () => {
    expect(() => resolveLane(project(), "three")).toThrow(/Declared: one, two/);
    expect(() => resolveLane(project(), "three")).toThrow(VerbUsageError);
  });

  // A declaration is allowed to decline to have a default, and nen honours the
  // decline rather than picking the only lane: a second lane arriving later
  // must not silently change what a scripted `nen shu build` builds.
  it("refuses when there is no default, EVEN IF there is exactly one lane", () => {
    const single = parseProjectBlock("/fixture/nen/contract.json", {
      lanes: { only: { stack: "stack-a", cwd: "." } },
      defaultLane: null,
      verbs: { only: { build: { exe: "tool", argv: ["go"] } } },
    });
    expect(() => resolveLane(single, null)).toThrow(/--lane is required/);
  });
});

describe("renderInvocation", () => {
  const request = { lane: null, verb: "build", platform: "linux" };

  it("renders a single-command verb as one step, exe apart from argv", () => {
    const rendered = renderInvocation(project(), request);
    expect(rendered.steps).toEqual([{ exe: "tool", argv: ["go"] }]);
    expect(rendered.lane).toBe("one");
    expect(rendered.stack).toBe("stack-a");
    expect(rendered.cwdRelative).toBe(".");
  });

  it("renders a multi-step verb in the declared order", () => {
    const rendered = renderInvocation(
      project({
        verbs: {
          one: {
            lint: {
              steps: [
                { exe: "tool", argv: ["first"] },
                { exe: "tool", argv: ["second"] },
              ],
            },
          },
        },
      }),
      { ...request, verb: "lint" },
    );
    expect(rendered.steps.map((step): readonly string[] => step.argv)).toEqual([["first"], ["second"]]);
  });

  it("refuses at 4 for a verb the lane does not declare", () => {
    try {
      renderInvocation(project(), { ...request, verb: "coverage" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ShuRefusal);
      expect((error as ShuRefusal).code).toBe(4);
      expect((error as Error).message).toMatch(/It declares: build\./);
    }
  });

  it("refuses at 4 quoting the declaration's own sentence for `unsupported`", () => {
    try {
      renderInvocation(
        project({ verbs: { one: { build: { unsupported: "this lane is a document set." } } } }),
        request,
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ShuRefusal).code).toBe(4);
      expect((error as Error).message).toContain("this lane is a document set.");
    }
  });

  describe("hosts", () => {
    it("constrains nothing when the declaration names no hosts", () => {
      const rendered = renderInvocation(project(), request);
      expect(rendered.host).toEqual({ platform: "linux", supported: true, declared: null });
    });

    it("prefers an exact verb entry over the wildcard", () => {
      const declaration = project({ hosts: { "*": ["linux"], build: ["darwin"] } });
      expect(() => renderInvocation(declaration, request)).toThrow(/declared for darwin/);
      expect(renderInvocation(declaration, { ...request, platform: "darwin" }).host.declared).toEqual([
        "darwin",
      ]);
    });

    it("falls back to the wildcard for a verb with no entry of its own", () => {
      const declaration = project({ hosts: { "*": ["win32"] } });
      try {
        renderInvocation(declaration, request);
        expect.unreachable();
      } catch (error) {
        expect((error as ShuRefusal).code).toBe(3);
        expect((error as Error).message).toMatch(/this host is linux/);
      }
    });
  });

  describe("placeholders -- exactly the reference pack's closed set, and nothing else", () => {
    it("refuses every unsubstituted placeholder at once, naming each", () => {
      const declaration = project({
        verbs: { one: { build: { exe: "{gw}", argv: ["{scheme}", "--flag"] } } },
      });
      expect(() => renderInvocation(declaration, request)).toThrow(VerbUsageError);
      expect(() => renderInvocation(declaration, request)).toThrow(/\{gw\}, \{scheme\}/);
    });

    it("says it will not guess, rather than offering a substitution", () => {
      const declaration = project({ verbs: { one: { build: { exe: "{gw}", argv: ["x"] } } } });
      expect(() => renderInvocation(declaration, request)).toThrow(/will not guess/);
    });

    it("RUNS a braced argument that is not one of those tokens", () => {
      // The first draft refused `/\{[^}]*\}/` outright, which is a rule about
      // somebody else's command line rather than about nen: each of these means
      // exactly itself, and refusing it told a repository its own verb was
      // un-runnable for a reason it could do nothing about.
      const ordinary = [
        '--define={"NODE_ENV":"test"}',
        "{}",
        "-Pflavour={release}",
        "{not-a-known-token}",
      ];
      for (const argument of ordinary) {
        const rendered = renderInvocation(
          project({ verbs: { one: { build: { exe: "tool", argv: [argument] } } } }),
          request,
        );
        expect(rendered.steps[0]?.argv, argument).toEqual([argument]);
      }
    });

    it("refuses every member of the published set, one at a time", () => {
      // The whole set, not a sample: a token dropped from the refusal would
      // otherwise reach a spawn as a literal argument, and only the token
      // nobody wrote a case for would do it.
      for (const token of REFUSED_PLACEHOLDERS) {
        const declaration = project({
          verbs: { one: { build: { exe: "tool", argv: [`--x=${token}`] } } },
        });
        expect(() => renderInvocation(declaration, request), token).toThrow(VerbUsageError);
      }
    });
  });

  describe("the invocation's unknown keys nen DOES act on", () => {
    it("reads `env` as NAME -> value and keeps the values out of the plan's names", () => {
      const rendered = renderInvocation(
        project({ verbs: { one: { build: { exe: "tool", argv: ["go"], env: { A: "1", B: "2" } } } } }),
        request,
      );
      expect(Object.keys(rendered.env).sort()).toEqual(["A", "B"]);
    });

    it("refuses a malformed `env` by pointer rather than ignoring it", () => {
      expect(() =>
        renderInvocation(
          project({ verbs: { one: { build: { exe: "tool", argv: ["go"], env: ["A"] } } } }),
          request,
        ),
      ).toThrow(/project\.verbs\.one\.build\.env is not an object/);
      expect(() =>
        renderInvocation(
          project({ verbs: { one: { build: { exe: "tool", argv: ["go"], env: { A: 1 } } } } }),
          request,
        ),
      ).toThrow(/project\.verbs\.one\.build\.env\.A is not a string/);
    });

    it("reads `artifacts` as a list of paths, and refuses a malformed one", () => {
      expect(
        renderInvocation(
          project({ verbs: { one: { build: { exe: "tool", argv: ["go"], artifacts: ["out/x"] } } } }),
          request,
        ).artifacts,
      ).toEqual(["out/x"]);
      expect(() =>
        renderInvocation(
          project({ verbs: { one: { build: { exe: "tool", argv: ["go"], artifacts: "out/x" } } } }),
          request,
        ),
      ).toThrow(/artifacts is not an array/);
    });
  });

  // (d1), the invariant zheref/nen#91's design names: the execution path takes a
  // DECLARATION and nothing else, so "the reference pack is a catalogue rather
  // than an authority" is a property of the program instead of a sentence in a
  // header. The enforcement is the signature -- there is no parameter a pack
  // could arrive through -- and this asserts the shape a refactor would have to
  // break on purpose.
  it("takes a declaration and a request, and nothing else", () => {
    expect(renderInvocation.length).toBe(2);
  });
});

describe("renderArgv", () => {
  it("joins exe and argv with a single space when nothing needs quoting", () => {
    expect(renderArgv({ exe: "tool", argv: ["a", "b"] })).toBe("tool a b");
  });

  it("quotes an element containing whitespace, so the boundary is visible", () => {
    expect(renderArgv({ exe: "tool", argv: ["-d", "name=A B,os=1"] })).toBe("tool -d 'name=A B,os=1'");
  });

  it("escapes a quote inside an element rather than ending the quoting early", () => {
    expect(renderArgv({ exe: "tool", argv: ["it's here"] })).toBe("tool 'it'\\''s here'");
  });
});
