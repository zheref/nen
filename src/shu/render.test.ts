// src/shu/render.test.ts -- the pure half: a declaration in, the exact steps
// out, with no seam, no filesystem and no clock anywhere in the call.

import { describe, expect, it } from "vitest";
import { VerbUsageError } from "../cli/command.js";
import { parseProjectBlock, type ProjectBlock } from "../schema/contract.js";
import { ShuRefusal } from "./exit.js";
import {
  isLaunchTarget,
  LAUNCHING_VERBS,
  REFUSED_PLACEHOLDERS,
  renderArgv,
  renderInvocation,
  resolveLane,
  resolveTarget,
  TARGETED_VERBS,
  type RenderedInvocation,
  type ResolvedTarget,
} from "./render.js";

/**
 * The DEPLOY half of the report's one `target` key.
 *
 * The key carries a destination on `deploy` and a device on `dev`/`run`, and
 * `isLaunchTarget` is what tells them apart. A test about a destination says so
 * here rather than casting, so a resolver that started answering with the wrong
 * shape would fail loudly instead of reading `undefined`.
 */
function deployed(rendered: RenderedInvocation): ResolvedTarget {
  const target = rendered.target;
  if (target === null || isLaunchTarget(target)) {
    throw new Error(`expected a resolved deploy target, got ${JSON.stringify(target)}`);
  }
  return target;
}

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
    expect(rendered.steps).toEqual([{ exe: "tool", argv: ["go"], stall: null }]);
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

// ── resolveTarget: the destination, resolved onto a rendered plan ───────────
//
// PURE, LIKE THE REST OF THIS FILE. The order the executor applies it in is
// ./run.test.ts's subject; what a target DOES to a plan is this one's.

describe("resolveTarget", () => {
  const request = { lane: null, verb: "deploy", platform: "linux" };

  /** A one-lane declaration whose `deploy` is a real row, plus targets. */
  function deployable(targets: Record<string, unknown>, steps?: unknown): ProjectBlock {
    return parseProjectBlock("/fixture/nen/contract.json", {
      lanes: { one: { stack: "stack-a", cwd: "." } },
      defaultLane: "one",
      verbs: { one: { deploy: steps ?? { exe: "tool", argv: ["publish"] } } },
      targets,
    });
  }

  function plan(block: ProjectBlock): RenderedInvocation {
    return renderInvocation(block, request);
  }

  it("appends the target's args to the declared argv, in the declared order", () => {
    const block = deployable({ prod: { args: ["--env", "production"] } });
    const resolved = resolveTarget(block, plan(block), "prod");
    expect(resolved.steps).toEqual([
      { exe: "tool", argv: ["publish", "--env", "production"], stall: null },
    ]);
    expect(resolved.target).toEqual({ name: "prod", args: ["--env", "production"], requiresEnv: [] });
  });

  it("leaves the argv alone for a name-only target -- naming it is the requirement", () => {
    const block = deployable({ prod: {} });
    expect(resolveTarget(block, plan(block), "prod").steps).toEqual([
      { exe: "tool", argv: ["publish"], stall: null },
    ]);
  });

  it("adds requiresEnv as env preconditions, byte-ordered, after the lane's own", () => {
    const block = parseProjectBlock("/fixture/nen/contract.json", {
      lanes: { one: { stack: "stack-a", cwd: "." } },
      defaultLane: "one",
      verbs: { one: { deploy: { exe: "tool", argv: ["publish"] } } },
      preconditions: { one: [{ kind: "path", value: "deps" }] },
      targets: { prod: { requiresEnv: ["B_TOKEN", "A_TOKEN"] } },
    });
    const resolved = resolveTarget(block, plan(block), "prod");
    expect(resolved.preconditions).toEqual([
      { kind: "path", value: "deps", why: null, pointer: "project.preconditions.one[0].value" },
      {
        kind: "env",
        value: "A_TOKEN",
        why: expect.stringContaining("never reads, compares or prints its value") as unknown as string,
        // THE ROW'S OWN ADDRESS, and it is the index into what the FILE says
        // rather than into the byte-ordered list -- A_TOKEN is declared second.
        pointer: "project.targets.prod.requiresEnv[1]",
      },
      {
        kind: "env",
        value: "B_TOKEN",
        why: expect.stringContaining("required by the deploy target 'prod'") as unknown as string,
        pointer: "project.targets.prod.requiresEnv[0]",
      },
    ]);
    expect(deployed(resolved).requiresEnv).toEqual(["A_TOKEN", "B_TOKEN"]);
  });

  it("de-duplicates requiresEnv: one variable is one row, however often it is written", () => {
    // A name repeated -- by hand, or by whatever generated the block -- used to
    // print the row once per occurrence and count each of them, so ONE unset
    // variable was reported as "3 preconditions are not satisfied".
    const block = deployable({ prod: { requiresEnv: ["DUP", "DUP", "DUP"] } });
    const resolved = resolveTarget(block, plan(block), "prod");
    expect(deployed(resolved).requiresEnv).toEqual(["DUP"]);
    expect(resolved.preconditions).toEqual([
      {
        kind: "env",
        value: "DUP",
        why: expect.stringContaining("required by the deploy target 'prod'") as unknown as string,
        pointer: "project.targets.prod.requiresEnv[0]",
      },
    ]);
  });

  it("asserts a variable the LANE already declares once, and still reports it as required", () => {
    // Two true statements about one fact: the lane says this build needs the
    // variable, the target says this destination does. `target.requiresEnv`
    // keeps both -- it is what the DESTINATION requires -- while the assertion
    // runs once, because two identical `FAIL env X` rows leave a reader
    // wondering which of the two Xs they failed to set.
    const block = parseProjectBlock("/fixture/nen/contract.json", {
      lanes: { one: { stack: "stack-a", cwd: "." } },
      defaultLane: "one",
      verbs: { one: { deploy: { exe: "tool", argv: ["publish"] } } },
      preconditions: { one: [{ kind: "env", value: "SHARED_TOKEN", why: "the lane's own" }] },
      targets: { prod: { requiresEnv: ["SHARED_TOKEN", "ONLY_THE_TARGETS"] } },
    });
    const resolved = resolveTarget(block, plan(block), "prod");
    expect(deployed(resolved).requiresEnv).toEqual(["ONLY_THE_TARGETS", "SHARED_TOKEN"]);
    expect(resolved.preconditions).toEqual([
      {
        kind: "env",
        value: "SHARED_TOKEN",
        why: "the lane's own",
        pointer: "project.preconditions.one[0].value",
      },
      {
        kind: "env",
        value: "ONLY_THE_TARGETS",
        why: expect.stringContaining("required by the deploy target 'prod'") as unknown as string,
        pointer: "project.targets.prod.requiresEnv[1]",
      },
    ]);
  });

  it("refuses a placeholder a TARGET composes onto the argv, naming its own pointer", () => {
    // The lane's half is checked in renderInvocation, before this target
    // exists; a target's `args` had never been checked at all, so this argv
    // composed cleanly and handed the seam a literal `{destination}`.
    const block = deployable({ prod: { args: ["-destination", "{destination}"] } });
    expect(() => resolveTarget(block, plan(block), "prod")).toThrow(VerbUsageError);
    expect(() => resolveTarget(block, plan(block), "prod")).toThrow(
      /target 'prod' composes a placeholder nen cannot substitute onto 'deploy' on lane 'one': \{destination\}/,
    );
    expect(() => resolveTarget(block, plan(block), "prod")).toThrow(
      /project\.targets\.prod\.args/,
    );
    // The other direction: a braced argument that is NOT one of the pack's own
    // tokens is an ordinary argument and passes through untouched, exactly as
    // it does in a lane's argv.
    const ordinary = deployable({ prod: { args: ["--define={\"NODE_ENV\":\"production\"}"] } });
    expect(resolveTarget(ordinary, plan(ordinary), "prod").steps).toEqual([
      { exe: "tool", argv: ["publish", "--define={\"NODE_ENV\":\"production\"}"], stall: null },
    ]);
  });

  it("refuses a missing --target at 2, listing what IS declared in byte order", () => {
    const block = deployable({ staging: {}, production: {} });
    expect(() => resolveTarget(block, plan(block), null)).toThrow(VerbUsageError);
    expect(() => resolveTarget(block, plan(block), null)).toThrow(
      /Declared under project\.targets: production, staging\./,
    );
    expect(() => resolveTarget(block, plan(block), null)).toThrow(/there is no default/);
  });

  it("refuses a missing --target EVEN WHEN exactly one target is declared", () => {
    // THE SENTENCE THE WHOLE VERB IS BUILT AROUND. One entry does not make it a
    // default: a second destination arriving later must not silently change
    // where a scripted `nen shu deploy` sends a build -- the same argument
    // `resolveLane` makes about a lone lane, one blast radius further out.
    const block = deployable({ production: {} });
    expect(() => resolveTarget(block, plan(block), null)).toThrow(VerbUsageError);
    expect(() => resolveTarget(block, plan(block), null)).toThrow(
      /there is no default -- not even when exactly one target is declared/,
    );
    expect(() => resolveTarget(block, plan(block), null)).toThrow(
      /Declared under project\.targets: production\./,
    );
  });

  it("refuses an undeclared --target at 2 rather than accepting any word", () => {
    const block = deployable({ staging: {} });
    expect(() => resolveTarget(block, plan(block), "prod")).toThrow(
      /--target 'prod' is not declared under project\.targets\. Declared: staging\./,
    );
  });

  it("prints the block to paste when nothing is declared, for both refusals", () => {
    const block = deployable({});
    for (const requested of [null, "prod"]) {
      expect(() => resolveTarget(block, plan(block), requested)).toThrow(/declares no targets at all/);
      expect(() => resolveTarget(block, plan(block), requested)).toThrow(/"targets": \{ "<name>"/);
    }
  });

  it("refuses a destination with no command line at 4, in the repository's words", () => {
    const block = deployable({ pages: { unsupported: "an action publishes this, not a command" } });
    expect(() => resolveTarget(block, plan(block), "pages")).toThrow(ShuRefusal);
    expect(() => resolveTarget(block, plan(block), "pages")).toThrow(
      /an action publishes this, not a command/,
    );
    try {
      resolveTarget(block, plan(block), "pages");
    } catch (error) {
      expect((error as ShuRefusal).code).toBe(4);
    }
  });

  it("refuses to guess which step of a multi-step row reaches the destination", () => {
    const block = deployable(
      { prod: { args: ["--prod"] } },
      { steps: [{ exe: "tool", argv: ["build"] }, { exe: "tool", argv: ["publish"] }] },
    );
    expect(() => resolveTarget(block, plan(block), "prod")).toThrow(
      /appends 1 argument \(--prod\), and 'deploy' on lane 'one' declares 2 steps/,
    );
    // The same multi-step row with a target that appends nothing is fine: the
    // refusal is about composing an argv, not about multi-step deploys.
    const bare = deployable(
      { prod: {} },
      { steps: [{ exe: "tool", argv: ["build"] }, { exe: "tool", argv: ["publish"] }] },
    );
    expect(resolveTarget(bare, plan(bare), "prod").steps).toHaveLength(2);
  });

  it("appends onto a ONE-step 'steps' row -- the rule is about the count, not the form", () => {
    // `{steps: [one]}` and `{exe, argv}` are the same command written two ways,
    // and the refusal above is "nen will not guess WHICH step", which a row
    // with one step does not ask anyone to guess.
    const block = deployable({ prod: { args: ["--prod"] } }, { steps: [{ exe: "tool", argv: ["publish"] }] });
    expect(resolveTarget(block, plan(block), "prod").steps).toEqual([
      { exe: "tool", argv: ["publish", "--prod"], stall: null },
    ]);
  });

  it("looks a target up by OWN key, so an ordinary object's prototype is no target map", () => {
    // BELT AND BRACES, AND THE BRACES ARE PINNED HERE. ../schema/contract.ts
    // now builds `project.targets` with `Object.create(null)`, which alone
    // makes `targets["constructor"]` undefined -- so the `hasOwnProperty` in
    // this function is unreachable through the loader and a mutant that
    // removed it would survive against a parsed declaration. This function is
    // EXPORTED and takes a `ProjectBlock`, so it is pinned against one built
    // the ordinary way instead: the guard is the lookup's, not the loader's.
    const block = deployable({ staging: {} });
    const ordinary: ProjectBlock = { ...block, targets: { ...block.targets } };
    expect(Object.getPrototypeOf(ordinary.targets)).toBe(Object.prototype);
    for (const inherited of ["constructor", "toString", "valueOf"]) {
      expect(() => resolveTarget(ordinary, plan(ordinary), inherited), inherited).toThrow(
        new RegExp(`--target '${inherited}' is not declared under project\\.targets\\. Declared: staging\\.`),
      );
    }
  });

  it("refuses a --target naming an OBJECT PROTOTYPE member as the undeclared target it is", () => {
    // `project.targets["constructor"]` is a function on any ordinary object, so
    // a lookup that asked `!== undefined` instead of `hasOwnProperty` would
    // accept `--target constructor`, resolve `args`/`requiresEnv` off a
    // function, and deploy. Two spellings, one answer.
    const block = deployable({ staging: {} });
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(() => resolveTarget(block, plan(block), inherited), inherited).toThrow(
        new RegExp(`--target '${inherited === "__proto__" ? "__proto__" : inherited}' is not declared under project\\.targets\\. Declared: staging\\.`),
      );
    }
  });

  it("changes nothing else about the plan it was given", () => {
    const block = deployable({ prod: { args: ["--prod"], why: "the live site" } });
    const before = plan(block);
    const after = resolveTarget(block, before, "prod");
    expect(after.lane).toBe(before.lane);
    expect(after.stack).toBe(before.stack);
    expect(after.verb).toBe(before.verb);
    expect(after.env).toEqual(before.env);
    expect(after.host).toEqual(before.host);
    expect(after.artifacts).toEqual(before.artifacts);
    // And the plan it was handed is untouched: a target is resolved ONTO a
    // plan, not INTO one.
    expect(before.target).toBeNull();
    expect(before.steps).toEqual([{ exe: "tool", argv: ["publish"], stall: null }]);
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

describe("the two things --target can name", () => {
  it("shares no verb between the two lists", () => {
    // `deploy`'s --target is REQUIRED and names a destination; `dev`/`run`'s is
    // OPTIONAL and names a device. A verb in both lists would carry one flag
    // with two meanings and nothing to tell them apart by.
    const both = TARGETED_VERBS.filter((verb): boolean => LAUNCHING_VERBS.includes(verb));
    expect(both).toEqual([]);
    expect(LAUNCHING_VERBS).toEqual(["dev", "run"]);
  });
});
