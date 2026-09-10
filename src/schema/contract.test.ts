import { describe, expect, it } from "vitest";
import { ALT_REPO, BANKAI_REPO } from "./fixtures/paths.js";
import { SchemaError } from "./errors.js";
import {
  describeContract,
  INSTALLERS,
  loadContract,
  parseContract,
  VERSION_FROM,
  type RepositoryContract,
} from "./contract.js";

const AT = "/fake/nen/contract.json";

function parse(value: unknown): RepositoryContract {
  return parseContract(AT, "nen", value);
}

function refusal(value: unknown): SchemaError {
  try {
    parse(value);
  } catch (error) {
    if (error instanceof SchemaError) return error;
    throw error;
  }
  throw new Error("expected a SchemaError, got a successful parse");
}

const DEPENDENCY = {
  minimum: "0.3",
  pinned_ref: "v0.3.0",
  version_probe: ["nen", "--version"],
  bootstrap: {
    url: "https://example.invalid/nen.sh",
    script_path_in_source: "bootstrap/nen.sh",
  },
} as const;

const PROJECT = {
  lanes: { web: { stack: "nextjs", cwd: "." } },
  verbs: { web: { build: { exe: "pnpm", argv: ["run", "build"] } } },
} as const;

describe("the two blocks, and the empty file", () => {
  it("accepts a dependency-only file", () => {
    const contract = parse({ dependency: DEPENDENCY });
    expect(contract.dependency?.minimum).toBe("0.3");
    expect(contract.project).toBeNull();
  });

  it("accepts a project-only file", () => {
    const contract = parse({ project: PROJECT });
    expect(contract.dependency).toBeNull();
    expect(Object.keys(contract.project?.lanes ?? {})).toEqual(["web"]);
  });

  it("accepts both blocks together", () => {
    const contract = parse({ dependency: DEPENDENCY, project: PROJECT });
    expect(contract.dependency).not.toBeNull();
    expect(contract.project).not.toBeNull();
  });

  it("REFUSES a file with neither block, and says what was probably meant", () => {
    // A DECISION, stated in the loader's header: an empty object is formally
    // legal under "both blocks are optional" and operationally useless, and
    // the shape that produces one in practice is the migration typo -- a root
    // `nen.contract.json` moved here without being wrapped in `dependency`,
    // whose every key lands at the top level and gets preserved as unknown.
    expect(refusal({}).message).toContain('neither a "dependency" block');
    const unwrapped = refusal({ minimum: "0.3", pinned_ref: "v0.3.0" });
    expect(unwrapped.message).toContain("minimum, pinned_ref");
    expect(unwrapped.message).toContain('wrap that object in a "dependency" key');
  });

  it("refuses a document that is not an object at all", () => {
    expect(refusal([]).message).toMatch(/expected an object/);
    expect(refusal("nen").message).toMatch(/expected an object/);
  });

  it("does not count a $-prefixed key as a block", () => {
    expect(refusal({ $schema: "nen.contract/v0.1" }).message).toContain("The file is empty of both");
  });

  it("does not REFUSE a $schema that is not a string, because no `$`-key is data", () => {
    // This loader's header says `$`-keys are metadata "read by nobody". A
    // `$schema` typed as a string was the one exception: a document declaring
    // it as an object -- an inline JSON Schema, or an {id, version} pair -- was
    // refused over a field nen does not use, which is the opposite of the rule.
    // It is surfaced when it happens to be a string, ignored otherwise, and
    // preserved either way by `raw`.
    const object = parse({ $schema: { id: "nen.contract", version: 1 }, dependency: DEPENDENCY });
    expect(object.schema).toBeNull();
    expect(object.raw["$schema"]).toEqual({ id: "nen.contract", version: 1 });
    expect(parse({ $schema: 7, dependency: DEPENDENCY }).schema).toBeNull();
    expect(parse({ $schema: "nen.contract/v0.1", dependency: DEPENDENCY }).schema).toBe(
      "nen.contract/v0.1",
    );
  });
});

describe("dependency", () => {
  for (const field of ["minimum", "pinned_ref", "version_probe", "bootstrap"] as const) {
    it(`refuses a dependency missing '${field}'`, () => {
      const block: Record<string, unknown> = { ...DEPENDENCY };
      delete block[field];
      const error = refusal({ dependency: block });
      expect(error.pointer).toContain(`dependency.${field}`);
      expect(error.message).toContain("the field is absent");
    });
  }

  for (const field of ["url", "script_path_in_source"] as const) {
    it(`refuses a bootstrap missing '${field}'`, () => {
      const bootstrap: Record<string, unknown> = { ...DEPENDENCY.bootstrap };
      delete bootstrap[field];
      const error = refusal({ dependency: { ...DEPENDENCY, bootstrap } });
      expect(error.pointer).toBe(`dependency.bootstrap.${field}`);
    });
  }

  it("refuses a version_probe written as a STRING, and says why argv is a list", () => {
    const error = refusal({
      dependency: { ...DEPENDENCY, version_probe: "nen --version" },
    });
    expect(error.pointer).toBe("dependency.version_probe");
    expect(error.message).toContain("argv ARRAY");
    expect(error.message).toContain("sh -c");
  });

  it("refuses an EMPTY version_probe, which would run nothing", () => {
    expect(refusal({ dependency: { ...DEPENDENCY, version_probe: [] } }).message).toContain(
      "at least the program name",
    );
  });

  it("refuses a non-string argv element", () => {
    const error = refusal({ dependency: { ...DEPENDENCY, version_probe: ["nen", 1] } });
    expect(error.pointer).toBe("dependency.version_probe[1]");
  });

  it("PRESERVES every unknown key, which is the reason the block can be moved verbatim", () => {
    const contract = parse({
      dependency: {
        ...DEPENDENCY,
        zero_major_caveat: { rule: "a different minor is out of range in both directions" },
        no_jq: { rule: "take the literal values" },
        halt: { rule: "an unsatisfied contract halts the caller" },
      },
    });
    expect(contract.dependency?.raw["zero_major_caveat"]).toEqual({
      rule: "a different minor is out of range in both directions",
    });
    expect(Object.keys(contract.dependency?.raw ?? {})).toContain("no_jq");
    // …and the bootstrap object's own unknown keys survive too.
    const withExtras = parse({
      dependency: {
        ...DEPENDENCY,
        bootstrap: { ...DEPENDENCY.bootstrap, exit_codes: { "5": "EXIT_CHECKSUM" } },
      },
    });
    expect(withExtras.dependency?.bootstrap.raw["exit_codes"]).toEqual({ "5": "EXIT_CHECKSUM" });
  });
});

describe("project", () => {
  it("refuses a project with no lanes, and says a stack is per-lane", () => {
    const error = refusal({ project: { verbs: {} } });
    expect(error.pointer).toBe("project.lanes");
    expect(error.message).toContain("PER-LANE");
  });

  it("refuses a project with no verbs", () => {
    const error = refusal({ project: { lanes: PROJECT.lanes } });
    expect(error.pointer).toBe("project.verbs");
  });

  it("refuses an EMPTY lane map", () => {
    expect(refusal({ project: { lanes: {}, verbs: {} } }).message).toContain("declares no lane");
  });

  it("refuses an EMPTY verb map, at both levels, exactly as lanes does", () => {
    // `verbs` is REQUIRED, and its absence has its own sentence -- but `{}`,
    // `{"web": {}}` and a map holding only a `$comment` were all accepted, and
    // all three are the same file with the same consequence: a project block
    // that declares a stack nothing can be run against. The emptiness test has
    // to run AFTER the `$`-filter, or a map of pure metadata reads as populated.
    expect(refusal({ project: { ...PROJECT, verbs: {} } }).pointer).toBe("project.verbs");
    expect(refusal({ project: { ...PROJECT, verbs: {} } }).message).toContain("declares no lane");

    const onlyComment = refusal({ project: { ...PROJECT, verbs: { $comment: "notes" } } });
    expect(onlyComment.pointer).toBe("project.verbs");
    expect(onlyComment.message).toContain("declares no lane");

    const emptyLane = refusal({ project: { ...PROJECT, verbs: { web: {} } } });
    expect(emptyLane.pointer).toBe("project.verbs.web");
    expect(emptyLane.message).toContain("declares no verb for lane 'web'");
    expect(emptyLane.message).toContain("unsupported");

    const laneOfComments = refusal({
      project: { ...PROJECT, verbs: { web: { $comment: "notes" } } },
    });
    expect(laneOfComments.pointer).toBe("project.verbs.web");
    expect(laneOfComments.message).toContain("declares no verb");

    // …and the shape that says "this lane genuinely runs nothing" is still
    // accepted, because it says so in the repository's own words.
    expect(
      parse({ project: { ...PROJECT, verbs: { web: { build: { unsupported: "no build step" } } } } })
        .project?.verbs["web"]?.["build"]?.kind,
    ).toBe("unsupported");
  });

  for (const field of ["stack", "cwd"] as const) {
    it(`refuses a lane missing '${field}'`, () => {
      const lane: Record<string, unknown> = { stack: "nextjs", cwd: "." };
      delete lane[field];
      const error = refusal({ project: { lanes: { web: lane }, verbs: {} } });
      expect(error.pointer).toBe(`project.lanes.web.${field}`);
    });
  }

  it("refuses a verbs key, a preconditions key or a defaultLane naming an UNDECLARED lane", () => {
    // The same class of hole gates.json closes for an approver naming a
    // reviewer nobody declared: the only symptom otherwise is a verb that is
    // silently unavailable.
    expect(
      refusal({ project: { ...PROJECT, verbs: { mobile: {} } } }).message,
    ).toContain("not declared under project.lanes");
    expect(refusal({ project: { ...PROJECT, defaultLane: "mobile" } }).pointer).toBe(
      "project.defaultLane",
    );
    expect(
      refusal({ project: { ...PROJECT, preconditions: { mobile: [] } } }).pointer,
    ).toBe("project.preconditions.mobile");
  });

  it("accepts a null defaultLane, which means --lane is required", () => {
    expect(parse({ project: { ...PROJECT, defaultLane: null } }).project?.defaultLane).toBeNull();
  });

  it("reads the three invocation forms and refuses a fourth", () => {
    const contract = parse({
      project: {
        ...PROJECT,
        verbs: {
          web: {
            build: { exe: "pnpm", argv: ["run", "build"] },
            lint: { steps: [{ exe: "pnpm", argv: ["lint"] }], why: "two commands, in order" },
            deploy: { unsupported: "no target is wired." },
          },
        },
      },
    });
    expect(contract.project?.verbs["web"]?.["build"]?.kind).toBe("command");
    expect(contract.project?.verbs["web"]?.["lint"]?.kind).toBe("steps");
    expect(contract.project?.verbs["web"]?.["deploy"]?.kind).toBe("unsupported");

    expect(
      refusal({ project: { ...PROJECT, verbs: { web: { build: { why: "nothing" } } } } }).message,
    ).toContain("expected one of 'exe'");
    expect(
      refusal({
        project: {
          ...PROJECT,
          verbs: { web: { build: { exe: "pnpm", argv: [], unsupported: "no" } } },
        },
      }).message,
    ).toContain("more than one of");
    expect(
      refusal({ project: { ...PROJECT, verbs: { web: { build: { steps: [] } } } } }).message,
    ).toContain("at least one step");
  });

  it("preserves an UNKNOWN verb name rather than rejecting it", () => {
    const contract = parse({
      project: {
        ...PROJECT,
        verbs: { web: { "resume:pdf": { exe: "node", argv: ["scripts/resume.mjs"] } } },
      },
    });
    expect(contract.project?.verbs["web"]?.["resume:pdf"]?.kind).toBe("command");
  });

  it("keeps profiles verbatim, since nothing reads them yet", () => {
    const contract = parse({
      project: { ...PROJECT, profiles: { ci: { web: { build: { exe: "x", argv: ["y"] } } } } },
    });
    expect(contract.project?.profiles["ci"]).toBeDefined();
  });

  // ── project.targets: parsed, because something reads it now ───────────────
  //
  // It was an opaque record while the only question anyone asked of it was
  // "does this key exist". A target now contributes ARGUMENTS to a spawned
  // argv and NAMES to an assertion, and an unparsed map turns a mistyped key
  // into silence: the flag was accepted, nothing was appended, and a different
  // command deployed.

  it("reads a target's args, requiresEnv, unsupported and why, and keeps the rest", () => {
    const contract = parse({
      project: {
        ...PROJECT,
        targets: {
          prod: {
            args: ["--env", "production"],
            requiresEnv: ["PLACEHOLDER_TOKEN"],
            why: "the live site",
            host: "a",
          },
        },
      },
    });
    const target = contract.project?.targets["prod"];
    expect(target?.name).toBe("prod");
    expect(target?.args).toEqual(["--env", "production"]);
    expect(target?.requiresEnv).toEqual(["PLACEHOLDER_TOKEN"]);
    expect(target?.unsupported).toBeNull();
    expect(target?.why).toBe("the live site");
    // UNKNOWN KEYS ARE PRESERVED, NOT REFUSED -- this schema's convention
    // everywhere, so a shape a later release reads is not a shape this one
    // deletes. THE ONE EXCEPTION is a key one letter away from a key nen acts
    // on, refused below: `host` is four edits from the nearest of the four and
    // is a key somebody MEANT, while `arg` is a key somebody MISSPELLED and
    // preserving it silently drops the arguments a deploy was supposed to add.
    expect(target?.raw["host"]).toBe("a");
  });

  it("accepts a name-only target: naming it is the whole requirement", () => {
    const contract = parse({ project: { ...PROJECT, targets: { preview: {} } } });
    expect(contract.project?.targets["preview"]?.args).toEqual([]);
    expect(contract.project?.targets["preview"]?.requiresEnv).toEqual([]);
  });

  it("reads a target with no command line at all as its own sentence", () => {
    const contract = parse({
      project: { ...PROJECT, targets: { pages: { unsupported: "an action, not a command" } } },
    });
    expect(contract.project?.targets["pages"]?.unsupported).toBe("an action, not a command");
  });

  it("refuses a target that is both unsupported and carries arguments", () => {
    const error = refusal({
      project: { ...PROJECT, targets: { pages: { unsupported: "no command", args: ["--prod"] } } },
    });
    expect(error.pointer).toBe("project.targets.pages");
    expect(error.message).toContain("has no arguments either");
  });

  it("refuses the shapes a typo produces, by pointer", () => {
    expect(refusal({ project: { ...PROJECT, targets: { prod: "https://example.invalid" } } }).pointer).toBe(
      "project.targets.prod",
    );
    expect(refusal({ project: { ...PROJECT, targets: { prod: { args: "--prod" } } } }).pointer).toBe(
      "project.targets.prod.args",
    );
    expect(refusal({ project: { ...PROJECT, targets: { prod: { args: [7] } } } }).pointer).toBe(
      "project.targets.prod.args[0]",
    );
    expect(
      refusal({ project: { ...PROJECT, targets: { prod: { requiresEnv: [{}] } } } }).pointer,
    ).toBe("project.targets.prod.requiresEnv[0]");
    expect(refusal({ project: { ...PROJECT, targets: [] } }).pointer).toBe("project.targets");
  });

  it("refuses a near-miss key by pointer, SAYING WHICH misspelling it is", () => {
    // THE FAILURE THIS BLOCK WAS PARSED TO PREVENT, and the half a wrong-TYPE
    // check does not reach: `{"arg": ["--prod"]}` is a perfectly-shaped list
    // under a key nothing reads, so the flag is accepted, nothing is appended,
    // and a DIFFERENT command deploys at exit 0.
    //
    // AND THE PHRASE IS THE ONE THAT IS TRUE OF THAT KEY. The rule catches three
    // shapes, and calling all three "one letter away" hands a maintainer a false
    // clue about their own file at the exact moment they are trying to fix it:
    // `WHY` is three substitutions from `why` and is the same word. (The
    // English-plural shape needs a plural two letters out, which none of these
    // four keys has; `launches` is where it fires, below.)
    for (const [key, phrase] of [
      ["arg", "is one letter away from 'args'"],
      ["argss", "is one letter away from 'args'"],
      ["requireEnv", "is one letter away from 'requiresEnv'"],
      ["requiresEnvs", "is one letter away from 'requiresEnv'"],
      ["unsuported", "is one letter away from 'unsupported'"],
      ["hy", "is one letter away from 'why'"],
      ["Args", "differs from 'args' only in case"],
      ["WHY", "differs from 'why' only in case"],
    ] as const) {
      const error = refusal({
        project: { ...PROJECT, targets: { prod: { [key]: ["--prod"] } } },
      });
      expect(error.pointer, key).toBe(`project.targets.prod.${key}`);
      expect(error.message, key).toContain(phrase);
      // Whichever phrase it is, the way out names the key that was meant.
      expect(error.message, key).toContain("Fix the spelling");
    }
  });

  it("keeps a key that is nobody's typo -- and a $-key -- exactly as written", () => {
    // THE OTHER DIRECTION, and the reason the radius is one edit rather than
    // two: these are keys a repository MEANT, for a release that may read them.
    const contract = parse({
      project: {
        ...PROJECT,
        targets: {
          prod: { $note: "metadata", host: "a", region: "eu-west-1", branch: "main", url: "x" },
        },
      },
    });
    const target = contract.project?.targets["prod"];
    expect(target?.raw["$note"]).toBe("metadata");
    expect(target?.raw["region"]).toBe("eu-west-1");
    expect(target?.raw["branch"]).toBe("main");
    expect(target?.raw["url"]).toBe("x");
  });

  it("requires the SENTENCE on 'unsupported', exactly as an unsupported VERB row does", () => {
    // `""` read as a reason is exit 4 with nothing after the colon; `""` read
    // as "not unsupported" would run a destination the declaration was closing.
    const error = refusal({ project: { ...PROJECT, targets: { pages: { unsupported: "" } } } });
    expect(error.pointer).toBe("project.targets.pages.unsupported");
    expect(error.message).toContain("expected a non-empty string");
    // Absent is still `null` -- the key is optional, its VALUE is not.
    expect(parse({ project: { ...PROJECT, targets: { prod: {} } } }).project?.targets["prod"]?.unsupported).toBeNull();
  });

  it("refuses a requiresEnv entry that is not a name an environment variable can have", () => {
    for (const name of ["lower-case", "1ABC", "A B", "PATH=evil", "--flag", ""]) {
      const error = refusal({
        project: { ...PROJECT, targets: { prod: { requiresEnv: [name] } } },
      });
      expect(error.pointer, name).toBe("project.targets.prod.requiresEnv[0]");
    }
    // And the shapes that ARE names: a leading underscore, digits after the
    // first character, and the screaming-snake form every real one uses.
    const contract = parse({
      project: { ...PROJECT, targets: { prod: { requiresEnv: ["_X", "A1", "DEPLOY_TOKEN_2"] } } },
    });
    expect(contract.project?.targets["prod"]?.requiresEnv).toEqual(["_X", "A1", "DEPLOY_TOKEN_2"]);
  });

  it("holds an 'env' PRECONDITION to the same rule, for the same reason", () => {
    // The lane's own env rows are asserted by exactly the same code path as a
    // target's -- `seams.env[name] !== undefined` -- so a name no environment
    // could carry is a row that can only ever report FAIL there too.
    const error = refusal({
      project: {
        ...PROJECT,
        preconditions: { web: [{ kind: "env", value: "DEPLOY TOKEN" }] },
      },
    });
    expect(error.pointer).toBe("project.preconditions.web[0].value");
    expect(error.message).toContain("shell identifier");
    // A kind nen does not assert is NOT held to it: `kind` is the repository's
    // own word, and only `env` names a variable.
    expect(() =>
      parse({
        project: { ...PROJECT, preconditions: { web: [{ kind: "note", value: "anything at all" }] } },
      }),
    ).not.toThrow();
  });

  it("keeps a target named '__proto__' in the map AND in the listing", () => {
    // On an ordinary object literal that key sets the PROTOTYPE: the target
    // vanishes from the map and from Object.keys, so `--target __proto__` is
    // refused as undeclared and the refusal lists a set that does not include
    // it -- nen telling a maintainer their file does not say what it says.
    // Built through JSON.parse, which is how a declaration really reaches this
    // loader: an object LITERAL with that key sets the prototype at the call
    // site instead, so the test would never hand the loader the key at all.
    const contract = parse({
      project: {
        ...PROJECT,
        targets: JSON.parse('{"__proto__": {"args": ["--weird"]}, "prod": {}}') as unknown,
      },
    });
    expect(Object.keys(contract.project?.targets ?? {}).sort()).toEqual(["__proto__", "prod"]);
    expect(
      Object.prototype.hasOwnProperty.call(contract.project?.targets ?? {}, "__proto__"),
    ).toBe(true);
    expect(contract.project?.targets["__proto__"]?.args).toEqual(["--weird"]);
  });

  it("skips a $-prefixed key, as every other block in this schema does", () => {
    const contract = parse({
      project: { ...PROJECT, targets: { $comment: "a note", prod: {} } },
    });
    expect(Object.keys(contract.project?.targets ?? {})).toEqual(["prod"]);
  });

  it("has no targets at all when the block is absent", () => {
    expect(parse({ project: PROJECT }).project?.targets).toEqual({});
  });

  it("reads hosts as a per-verb platform allowlist", () => {
    const contract = parse({ project: { ...PROJECT, hosts: { "*": ["darwin", "linux"] } } });
    expect(contract.project?.hosts["*"]).toEqual(["darwin", "linux"]);
    expect(refusal({ project: { ...PROJECT, hosts: { "*": "darwin" } } }).pointer).toBe(
      "project.hosts.*",
    );
  });

  it("refuses a platform name process.platform never returns", () => {
    // AN ALLOWLIST FAILS SILENTLY WHEN IT IS WRONG, which is why this is worth
    // a refusal at all: `"macos"` does not error, it removes the verb from
    // every machine on earth and reports nothing. `"windows"` and `"osx"` are
    // the same mistake. This reader is shared with the profiles pack's `hosts`
    // (src/profiles/pack.ts), so both gained the check on one line.
    for (const wrong of ["macos", "windows", "osx", "Darwin"]) {
      const error = refusal({ project: { ...PROJECT, hosts: { "*": [wrong] } } });
      expect(error.pointer, wrong).toBe("project.hosts.*[0]");
      expect(error.message, wrong).toContain("CLOSED set");
    }
    expect(
      parse({ project: { ...PROJECT, hosts: { build: ["win32"] } } }).project?.hosts["build"],
    ).toEqual(["win32"]);
  });

  it("reads a precondition value as either a path or an argv list", () => {
    const contract = parse({
      project: {
        ...PROJECT,
        preconditions: {
          web: [
            { kind: "path", value: "node_modules", why: "the install has been run" },
            { kind: "command", value: ["corepack", "--version"] },
          ],
        },
      },
    });
    expect(contract.project?.preconditions["web"]?.[0]?.value).toBe("node_modules");
    expect(contract.project?.preconditions["web"]?.[1]?.value).toEqual(["corepack", "--version"]);
    expect(
      refusal({ project: { ...PROJECT, preconditions: { web: [{ value: "x" }] } } }).pointer,
    ).toBe("project.preconditions.web[0].kind");
  });
});

describe("project.evidence", () => {
  it("is null when the repository declares none", () => {
    expect(parse({ project: PROJECT }).project?.evidence).toBeNull();
  });

  it("reads globs, mechanism, and the two defaults", () => {
    const contract = parse({
      project: {
        ...PROJECT,
        evidence: { globs: ["**/__Snapshots__/**/*.png"], mechanism: "public-mirror" },
      },
    });
    const evidence = contract.project?.evidence;
    expect(evidence?.globs).toEqual(["**/__Snapshots__/**/*.png"]);
    expect(evidence?.mechanism).toBe("public-mirror");
    expect(evidence?.scene).toBe("{suite}-{scene}");
    expect(evidence?.suiteSuffix).toBe("SnapshotTests");
  });

  it("reads an explicit scene template and suiteSuffix over the defaults", () => {
    const contract = parse({
      project: {
        ...PROJECT,
        evidence: {
          globs: ["**/*.png"],
          mechanism: "files-changed",
          scene: "{scene} ({suite})",
          suiteSuffix: "Snapshots",
        },
      },
    });
    expect(contract.project?.evidence?.scene).toBe("{scene} ({suite})");
    expect(contract.project?.evidence?.suiteSuffix).toBe("Snapshots");
  });

  it("accepts every declared mechanism", () => {
    for (const mechanism of ["public-mirror", "files-changed", "embedded"] as const) {
      const contract = parse({
        project: { ...PROJECT, evidence: { globs: ["**/*.png"], mechanism } },
      });
      expect(contract.project?.evidence?.mechanism, mechanism).toBe(mechanism);
    }
  });

  it("refuses an unknown mechanism, naming the closed set", () => {
    const error = refusal({
      project: { ...PROJECT, evidence: { globs: ["**/*.png"], mechanism: "s3" } },
    });
    expect(error.pointer).toBe("project.evidence.mechanism");
    expect(error.message).toContain("CLOSED set");
  });

  it("refuses an absent globs list, naming the field", () => {
    const error = refusal({ project: { ...PROJECT, evidence: { mechanism: "embedded" } } });
    expect(error.pointer).toBe("project.evidence.globs");
    expect(error.message).toContain("nothing (the field is absent)");
  });

  it("refuses an empty globs list -- required means at least one", () => {
    const error = refusal({
      project: { ...PROJECT, evidence: { globs: [], mechanism: "embedded" } },
    });
    expect(error.pointer).toBe("project.evidence.globs");
    expect(error.message).toContain("empty array");
  });

  it("refuses an absent mechanism, naming the field", () => {
    const error = refusal({ project: { ...PROJECT, evidence: { globs: ["**/*.png"] } } });
    expect(error.pointer).toBe("project.evidence.mechanism");
  });

  it("refuses a non-array globs and a non-string element, by pointer", () => {
    expect(
      refusal({ project: { ...PROJECT, evidence: { globs: "**/*.png", mechanism: "embedded" } } })
        .pointer,
    ).toBe("project.evidence.globs");
    expect(
      refusal({ project: { ...PROJECT, evidence: { globs: [7], mechanism: "embedded" } } }).pointer,
    ).toBe("project.evidence.globs[0]");
  });

  it("preserves an unknown key nobody misspelled", () => {
    const contract = parse({
      project: {
        ...PROJECT,
        evidence: { globs: ["**/*.png"], mechanism: "embedded", $note: "metadata", host: "ios" },
      },
    });
    expect(contract.project?.evidence?.raw["$note"]).toBe("metadata");
    expect(contract.project?.evidence?.raw["host"]).toBe("ios");
  });

  it("refuses a near-miss key by pointer, SAYING WHICH misspelling it is -- like 'targets'", () => {
    // ONE HELPER, FOUR BLOCKS: this block goes through the same
    // `refuseNearMissKey` `project.targets`, `project.launch` and a launch
    // device do, so it reports the same three shapes in the same words. The
    // phrase is the one that is TRUE of the key -- `Mechanism` is three
    // substitutions from `mechanism` and is the same word, and a maintainer
    // told it is "one letter away" is being handed a false clue about their
    // own file at the moment they are trying to fix it.
    for (const [key, phrase] of [
      ["glob", "is one letter away from 'globs'"],
      ["globss", "is one letter away from 'globs'"],
      ["mechanisms", "is one letter away from 'mechanism'"],
      ["seene", "is one letter away from 'scene'"],
      ["suiteSufix", "is one letter away from 'suiteSuffix'"],
      ["Mechanism", "differs from 'mechanism' only in case"],
      ["SuiteSuffix", "differs from 'suiteSuffix' only in case"],
      ["scenes", "is one letter away from 'scene'"],
    ] as const) {
      const error = refusal({
        project: { ...PROJECT, evidence: { globs: ["**/*.png"], mechanism: "embedded", [key]: "x" } },
      });
      expect(error.pointer, key).toBe(`project.evidence.${key}`);
      expect(error.message, key).toContain(phrase);
      // Whichever phrase it is, the way out names the key that was meant.
      expect(error.message, key).toContain("Fix the spelling");
    }
  });
});

describe("project.toolchain", () => {
  const NODE = {
    version: ">=20.19.0",
    probe: ["node", "--version"],
    versionFrom: "first-semver-on-stdout",
    installer: "verify-only",
  } as const;

  function withToolchain(node: unknown): unknown {
    return { project: { ...PROJECT, toolchain: { node } } };
  }

  it("reads a well-formed entry", () => {
    const contract = parse(withToolchain(NODE));
    const entry = contract.project?.toolchain["node"];
    expect(entry?.version).toBe(">=20.19.0");
    expect(entry?.versionFrom).toBe("first-semver-on-stdout");
    expect(entry?.installer).toBe("verify-only");
  });

  it("REFUSES an entry with no version, rather than defaulting to latest", () => {
    const error = refusal(withToolchain({ ...NODE, version: undefined }));
    expect(error.pointer).toBe("project.toolchain.node.version");
    expect(error.message).toContain('never installs or certifies "latest"');
  });

  for (const field of ["probe", "versionFrom", "installer"] as const) {
    it(`refuses an entry missing '${field}'`, () => {
      const entry: Record<string, unknown> = { ...NODE };
      delete entry[field];
      expect(refusal(withToolchain(entry)).pointer).toContain(`project.toolchain.node.${field}`);
    });
  }

  it("refuses a versionFrom outside the closed set, listing the set", () => {
    // DELIBERATELY NOT A REGEX: a caller-supplied pattern is a
    // caller-supplied program, and this closed list is what keeps it data.
    const error = refusal(withToolchain({ ...NODE, versionFrom: "/v(\\d+)/" }));
    expect(error.pointer).toBe("project.toolchain.node.versionFrom");
    expect(error.message).toContain("CLOSED set");
    for (const allowed of VERSION_FROM) expect(error.message).toContain(allowed);
  });

  it("refuses an installer outside the closed set, listing the set", () => {
    const error = refusal(withToolchain({ ...NODE, installer: "brew" }));
    expect(error.pointer).toBe("project.toolchain.node.installer");
    for (const allowed of INSTALLERS) expect(error.message).toContain(allowed);
  });

  it("accepts every id in both closed sets", () => {
    for (const versionFrom of VERSION_FROM) {
      expect(parse(withToolchain({ ...NODE, versionFrom })).project?.toolchain["node"]?.versionFrom).toBe(
        versionFrom,
      );
    }
    for (const installer of INSTALLERS) {
      expect(parse(withToolchain({ ...NODE, installer })).project?.toolchain["node"]?.installer).toBe(
        installer,
      );
    }
  });

  it("refuses a probe written as a string", () => {
    expect(refusal(withToolchain({ ...NODE, probe: "node --version" })).message).toContain(
      "argv ARRAY",
    );
  });

  // ── the KEY, which does not stay in the file ─────────────────────────────

  it("REFUSES a tool name that would become an argument rather than a package", () => {
    // The only map key in this loader that is validated, because it is the only
    // one that leaves the file: `nen shu tools --install` renders
    // `<tool>@<version>` into the argv it spawns, so a key of `--all` becomes a
    // FLAG to the installer. There is no shell on that path -- an argv is a
    // list -- so this is an injection into the ARGUMENT LIST, which is the one
    // nen builds itself.
    const REFUSED: readonly string[] = [
      "--all",
      "-x",
      ".hidden",
      "_private",
      "two words",
      "pnpm@9.15.9",
      "../../etc/passwd",
      "a;rm -rf /",
      "id$(whoami)",
      "`id`",
      "a|b",
      "",
    ];
    for (const name of REFUSED) {
      const error = refusal({ project: { ...PROJECT, toolchain: { [name]: NODE } } });
      expect(error.pointer, name).toBe(`project.toolchain.${name}`);
      expect(error.message, name).toContain("not a tool name nen can act on");
    }
  });

  it("accepts every shape a real toolchain name takes, scoped forms included", () => {
    const ACCEPTED: readonly string[] = [
      "node",
      "pnpm",
      "dotnet-sdk",
      "expo-cli",
      "visual-studio",
      "placeholder-jdk",
      "python3.12",
      "gcc_toolchain",
      "@acme/build-tool",
      "Xcode",
    ];
    for (const name of ACCEPTED) {
      const contract = parse({ project: { ...PROJECT, toolchain: { [name]: NODE } } });
      expect(contract.project?.toolchain[name]?.tool, name).toBe(name);
    }
  });

  it("still skips a $-prefixed key rather than refusing it as a name", () => {
    // `$comment` is metadata every block in this family carries, and it is
    // filtered BEFORE the name rule -- otherwise documenting a toolchain block
    // would make it unreadable. A hostile-looking `$` key is skipped by the
    // same filter and is therefore never a row, never a `--only` match and
    // never part of an argv: not refused, and not reachable either.
    const contract = parse({
      project: {
        ...PROJECT,
        toolchain: { $comment: "why these tools", "$(id)": "not a tool", node: NODE },
      },
    });
    expect(Object.keys(contract.project?.toolchain ?? {})).toEqual(["node"]);
  });
});

describe("describeContract, the one line `schema check` prints", () => {
  it("counts in the singular when there is one of a thing", () => {
    // `lanes` and `toolchain entries` were already pluralised and `verbs` was
    // not, so the smallest legal project block printed "1 lane … 1 verbs".
    expect(describeContract(parse({ project: PROJECT }))).toBe(
      "project (1 lane: web; 1 verb; 0 toolchain entries)",
    );
  });

  it("counts in the plural when there is more than one", () => {
    const contract = parse({
      project: {
        lanes: { web: { stack: "nextjs", cwd: "." }, api: { stack: "node", cwd: "api" } },
        verbs: {
          web: { build: { exe: "pnpm", argv: ["build"] } },
          api: { build: { exe: "pnpm", argv: ["build"] } },
        },
        toolchain: {
          node: {
            version: ">=20.19.0",
            probe: ["node", "--version"],
            versionFrom: "first-semver-on-stdout",
            installer: "verify-only",
          },
        },
      },
    });
    expect(describeContract(contract)).toBe(
      "project (2 lanes: web, api; 2 verbs; 1 toolchain entry)",
    );
  });
});

describe("loadContract, against the bundled fixtures", () => {
  it("reads the both-blocks fixture and records where it came from", () => {
    const contract = loadContract(BANKAI_REPO);
    expect(contract.location).toBe("nen");
    expect(contract.schema).toBe("nen.contract/v0.1");
    expect(contract.dependency?.versionProbe).toEqual(["nen", "--version"]);
    expect(Object.keys(contract.project?.lanes ?? {})).toEqual(["web", "android"]);
    expect(contract.project?.lanes["android"]?.stack).toBe("gradle-android");
    expect(contract.project?.verbs["android"]?.["release"]?.kind).toBe("unsupported");
    expect(contract.project?.toolchain["pnpm"]?.installer).toBe("corepack");
  });

  it("reads the dependency-only fixture, and its project block is genuinely absent", () => {
    const contract = loadContract(ALT_REPO);
    expect(contract.project).toBeNull();
    expect(contract.dependency?.pinnedRef).toBe("v0.1.0");
    expect(contract.dependency?.bootstrap.scriptPathInSource).toBe("bootstrap/nen.sh");
    // The prose keys hatsu carries survive the move untouched.
    expect(Object.keys(contract.dependency?.raw ?? {})).toEqual(
      expect.arrayContaining(["no_jq", "halt", "no_improvised_fallback", "install_paths"]),
    );
  });

  it("phrases an absent contract with the marker checkTaxonomy branches on", () => {
    // The optional row's absence must stay distinguishable from a corrupt
    // file, exactly as gates.json's does.
    try {
      loadContract("/nen-does-not-exist-xyz");
      expect.unreachable();
    } catch (error) {
      expect((error as SchemaError).message).toContain("no such file.");
    }
  });
});

// ── project.launch ──────────────────────────────────────────────────────────
//
// The block `nen shu dev|run --target` reads. It is parsed rather than
// preserved for `project.targets`' reason, one release later and with one more
// hole to close: this block contributes not just ARGUMENTS to a spawned argv
// but a whole second and third command (the device probe, the after-steps), so
// a key nobody reads here is a launch that silently does two thirds of what the
// file says.

describe("project.launch", () => {
  const DEVICE = { name: "Placeholder Handset", kind: "simulator" } as const;

  it("is absent-means-empty, exactly as targets is", () => {
    expect(parse({ project: PROJECT }).project?.launch).toEqual({});
  });

  it("reads a whole target: verb, args, device, after, why", () => {
    const contract = parse({
      project: {
        ...PROJECT,
        launch: {
          box: {
            verb: "dev",
            args: ["--flag"],
            device: {
              name: "Placeholder Handset",
              resolve: { exe: "placeholder-probe", argv: ["list"] },
            },
            after: [{ exe: "placeholder-installer", argv: ["put", "{artifact}"] }],
            why: "the bench",
            note: "an unknown key, preserved",
          },
        },
      },
    });
    const target = contract.project?.launch["box"];
    expect(target?.verb).toBe("dev");
    expect(target?.args).toEqual(["--flag"]);
    expect(target?.device?.name).toBe("Placeholder Handset");
    expect(target?.device?.resolve).toEqual({ exe: "placeholder-probe", argv: ["list"] });
    expect(target?.after).toEqual([{ exe: "placeholder-installer", argv: ["put", "{artifact}"] }]);
    expect(target?.why).toBe("the bench");
    // UNKNOWN KEYS ARE PRESERVED HERE TOO -- this schema's convention, and the
    // reason the near-miss guard below has to exist at all.
    expect(target?.raw["note"]).toBe("an unknown key, preserved");
  });

  it("requires a verb, out of a CLOSED two-member set", () => {
    expect(refusal({ project: { ...PROJECT, launch: { box: { device: DEVICE } } } }).pointer).toBe(
      "project.launch.box.verb",
    );
    const wrong = refusal({
      project: { ...PROJECT, launch: { box: { verb: "build", device: DEVICE } } },
    });
    expect(wrong.pointer).toBe("project.launch.box.verb");
    expect(wrong.message).toContain("dev, run");
  });

  it("reads a target with no command line at all as its own sentence", () => {
    const contract = parse({
      project: { ...PROJECT, launch: { farm: { unsupported: "a web console, not a command" } } },
    });
    expect(contract.project?.launch["farm"]?.unsupported).toBe("a web console, not a command");
    expect(contract.project?.launch["farm"]?.verb).toBeNull();
  });

  it("refuses a target that is unsupported AND carries something to run", () => {
    const error = refusal({
      project: { ...PROJECT, launch: { farm: { unsupported: "no command", verb: "dev" } } },
    });
    expect(error.pointer).toBe("project.launch.farm");
    expect(error.message).toContain(
      "has no verb, lane, arguments, artifact, device or after-steps either",
    );
    // THE TWO NEWEST KEYS ARE IN THE SAME LIST, and each one alone is enough:
    // an `unsupported` target that named a lane or an artifact would be a row
    // saying "there is no command line for this, and here is where its build
    // lives", and honouring either half is a choice about somebody else's
    // machine that this refusal exists to decline.
    for (const key of ["lane", "artifact"] as const) {
      const both = refusal({
        project: {
          ...PROJECT,
          launch: { farm: { unsupported: "no command", [key]: key === "lane" ? "web" : "out/a" } },
        },
      });
      expect(both.pointer, key).toBe("project.launch.farm");
      expect(both.message, key).toContain(`'${key}'`);
    }
  });

  // ── lane and artifact: the two per-target overrides ───────────────────────
  //
  // A LAUNCH TARGET IS THE ONE PLACE THE TWO ORDINARY DEFAULTS ARE BOTH WRONG.
  // The lane a developer iterates in is not the lane that builds for a handset,
  // and the FIRST artifact a build declares is not the one an installer takes.
  // Both defaults stay exactly where they were for every target that says
  // nothing; these two keys are how a target says otherwise, in the file rather
  // than on somebody's command line.

  it("reads a per-target lane and artifact, and leaves both null when absent", () => {
    const contract = parse({
      project: {
        lanes: { web: { stack: "nextjs", cwd: "." }, device: { stack: "xcode-ios", cwd: "." } },
        verbs: {
          web: { dev: { exe: "placeholder-tool", argv: ["serve"] } },
          device: { dev: { exe: "placeholder-tool", argv: ["build"] } },
        },
        launch: {
          plain: { verb: "dev", device: DEVICE },
          both: {
            verb: "dev",
            lane: "device",
            artifact: "build/device/Placeholder.signed",
            device: DEVICE,
            after: [{ exe: "placeholder-installer", argv: ["put", "{artifact}"] }],
          },
        },
      },
    });
    expect(contract.project?.launch["plain"]?.lane).toBeNull();
    expect(contract.project?.launch["plain"]?.artifact).toBeNull();
    expect(contract.project?.launch["both"]?.lane).toBe("device");
    expect(contract.project?.launch["both"]?.artifact).toBe("build/device/Placeholder.signed");
  });

  it("refuses a lane the project does not declare, by pointer, listing the ones it does", () => {
    // AT LOAD, NOT AT LAUNCH. `nen schema check` reads this block; a lane that
    // was renamed last week would otherwise load clean and refuse only when
    // somebody reached for their phone -- which is the expensive moment.
    const error = refusal({
      project: { ...PROJECT, launch: { box: { verb: "dev", lane: "handheld", device: DEVICE } } },
    });
    expect(error.pointer).toBe("project.launch.box.lane");
    expect(error.message).toContain("names lane 'handheld'");
    expect(error.message).toContain("declared: web");
  });

  it("refuses an EMPTY artifact, which would substitute as nothing at all", () => {
    const error = refusal({
      project: { ...PROJECT, launch: { box: { verb: "dev", artifact: "", device: DEVICE } } },
    });
    expect(error.pointer).toBe("project.launch.box.artifact");
    expect(error.message).toContain("is an empty string");
  });

  it("refuses the wrong TYPE under either new key", () => {
    const bad = (launch: unknown): string | null =>
      refusal({ project: { ...PROJECT, launch } }).pointer;
    expect(bad({ box: { verb: "dev", lane: ["web"] } })).toBe("project.launch.box.lane");
    expect(bad({ box: { verb: "dev", artifact: ["out/app"] } })).toBe(
      "project.launch.box.artifact",
    );
  });

  it("refuses the PLURAL of each new key, which is the typo they invite", () => {
    // `artifacts` is what the VERB row calls its own list and `lanes` is what
    // the project block calls its map, so writing either on a launch target is
    // the natural slip -- and preserved verbatim it would leave the target
    // running on the default lane, or installing the verb's first artifact,
    // while the file plainly names another. Both are ONE INSERTION out, so the
    // refusal reports the letter rather than the grammar (`nearMissOf` checks
    // the distance rule before the plural one, deliberately).
    for (const [key, meant] of [
      ["lanes", "lane"],
      ["artifacts", "artifact"],
    ] as const) {
      const error = refusal({
        project: { ...PROJECT, launch: { box: { verb: "dev", [key]: "web" } } },
      });
      expect(error.pointer, key).toBe(`project.launch.box.${key}`);
      expect(error.message, key).toContain(`is one letter away from '${meant}'`);
    }
  });

  it("refuses the shapes a typo produces, by pointer", () => {
    const bad = (launch: unknown): string | null =>
      refusal({ project: { ...PROJECT, launch } }).pointer;
    expect(bad({ box: "a string" })).toBe("project.launch.box");
    expect(bad({ box: { verb: "dev", args: "--flag" } })).toBe("project.launch.box.args");
    expect(bad({ box: { verb: "dev", after: {} } })).toBe("project.launch.box.after");
    expect(bad({ box: { verb: "dev", after: [{ exe: "x" }] } })).toBe("project.launch.box.after[0].argv");
    expect(bad({ box: { verb: "dev", device: { kind: "simulator" } } })).toBe(
      "project.launch.box.device.name",
    );
    expect(bad({ box: { verb: "dev", device: { name: "n", resolve: { argv: ["x"] } } } })).toBe(
      "project.launch.box.device.resolve.exe",
    );
    // A STRING argv is refused everywhere in this family, this block included.
    expect(bad({ box: { verb: "dev", device: { name: "n", resolve: { exe: "p", argv: "list" } } } })).toBe(
      "project.launch.box.device.resolve.argv",
    );
  });

  it("refuses a key one spelling away from one nen reads, in the target and in the device", () => {
    for (const [launch, pointer, meant] of [
      [{ box: { verb: "dev", arg: ["--flag"] } }, "project.launch.box.arg", "args"],
      [{ box: { verb: "dev", devices: {} } }, "project.launch.box.devices", "device"],
      [{ box: { verb: "dev", afters: [] } }, "project.launch.box.afters", "after"],
      [{ box: { verbs: "dev" } }, "project.launch.box.verbs", "verb"],
      [
        { box: { verb: "dev", device: { name: "n", resolver: { exe: "p", argv: ["l"] } } } },
        "project.launch.box.device.resolver",
        "resolve",
      ],
    ] as const) {
      const error = refusal({ project: { ...PROJECT, launch } });
      expect(error.pointer, pointer).toBe(pointer);
      expect(error.message, pointer).toContain(`is one letter away from '${meant}'`);
    }
  });

  // ── readyWhen: which of a probe's own states count as ready ───────────────
  //
  // A NAME MATCH ANSWERS "IS IT PLUGGED IN"; the state beside the name answers
  // "will it take a build", and they are different facts. Every refusal below
  // is at LOAD, by pointer, for the reason the rest of this block is: a rule
  // nen could not read is a rule it would discover it could not read with
  // somebody's phone in their hand.

  const PROBED = {
    name: "PH0000000001",
    resolve: { exe: "placeholder-probe", argv: ["list"] },
  } as const;

  it("reads both shapes of the rule, and leaves it null when absent", () => {
    const contract = parse({
      project: {
        ...PROJECT,
        launch: {
          plain: { verb: "dev", device: { ...PROBED, readyWhen: { field: 2, in: ["ready"] } } },
          json: {
            verb: "dev",
            device: { ...PROBED, readyWhen: { path: "connection.state", in: ["a", "b"] } },
          },
          none: { verb: "dev", device: PROBED },
        },
      },
    });
    const plain = contract.project?.launch["plain"]?.device?.readyWhen;
    expect(plain?.field).toBe(2);
    expect(plain?.path).toBeNull();
    expect(plain?.in).toEqual(["ready"]);
    const json = contract.project?.launch["json"]?.device?.readyWhen;
    expect(json?.field).toBeNull();
    expect(json?.path).toBe("connection.state");
    expect(json?.in).toEqual(["a", "b"]);
    // ABSENT MEANS EXACTLY WHAT IT MEANT BEFORE THE KEY EXISTED: a row that
    // carries the name is taken as the device.
    expect(contract.project?.launch["none"]?.device?.readyWhen).toBeNull();
  });

  it("refuses a rule that names BOTH positions, or NEITHER", () => {
    const both = refusal({
      project: {
        ...PROJECT,
        launch: {
          box: { verb: "dev", device: { ...PROBED, readyWhen: { field: 2, path: "s", in: ["r"] } } },
        },
      },
    });
    expect(both.pointer).toBe("project.launch.box.device.readyWhen");
    expect(both.message).toContain("BOTH 'field' and 'path'");
    const neither = refusal({
      project: {
        ...PROJECT,
        launch: { box: { verb: "dev", device: { ...PROBED, readyWhen: { in: ["r"] } } } },
      },
    });
    expect(neither.pointer).toBe("project.launch.box.device.readyWhen");
    expect(neither.message).toContain("neither 'field' nor 'path'");
  });

  it("refuses a field position below 1: the row's first token is field 1", () => {
    // A ZERO-INDEXED DECLARATION IS THE SLIP THIS REFUSES BY NAME. Accepted, it
    // would read one column to the left of the state on every launch -- which
    // on the ordinary two-column listing is the device's own serial, a string
    // no `in` set will ever carry, so every launch would refuse and the file
    // would look right.
    for (const field of [0, -1, 1.5, "2"]) {
      const error = refusal({
        project: {
          ...PROJECT,
          launch: {
            box: { verb: "dev", device: { ...PROBED, readyWhen: { field, in: ["r"] } } },
          },
        },
      });
      expect(error.pointer, String(field)).toBe("project.launch.box.device.readyWhen.field");
      expect(error.message, String(field)).toContain("counting the row's first token as 1");
    }
  });

  it("refuses an accepted set that is empty, or carries an empty string", () => {
    const empty = refusal({
      project: {
        ...PROJECT,
        launch: { box: { verb: "dev", device: { ...PROBED, readyWhen: { field: 2, in: [] } } } },
      },
    });
    expect(empty.pointer).toBe("project.launch.box.device.readyWhen.in");
    expect(empty.message).toContain("no state this probe can report would ever count as ready");
    const blank = refusal({
      project: {
        ...PROJECT,
        launch: { box: { verb: "dev", device: { ...PROBED, readyWhen: { field: 2, in: [""] } } } },
      },
    });
    // AN EMPTY ENTRY IS A STATE NOTHING CAN EVER MATCH, refused by the same
    // non-empty-string rule every declared string in this schema gets, and at
    // the entry's OWN pointer rather than the list's.
    expect(blank.pointer).toBe("project.launch.box.device.readyWhen.in[0]");
    expect(blank.message).toContain("expected a non-empty string");
    // And the wrong TYPE under the key, by pointer like every other shape.
    const typed = refusal({
      project: {
        ...PROJECT,
        launch: {
          box: { verb: "dev", device: { ...PROBED, readyWhen: { field: 2, in: "ready" } } },
        },
      },
    });
    expect(typed.pointer).toBe("project.launch.box.device.readyWhen.in");
  });

  it("refuses a rule on a device with no probe, which would never be read", () => {
    // THE `artifact`-WITH-NO-TOKEN RULE, APPLIED HERE. A simulated device is
    // resolved from its own name with nothing spawned, so there is no output
    // for a readiness rule to read -- and a key that is never read while
    // reading in the file like a safety check is worse than an absent one.
    const error = refusal({
      project: {
        ...PROJECT,
        launch: {
          box: {
            verb: "dev",
            device: { name: "Bench", kind: "simulator", readyWhen: { field: 2, in: ["ready"] } },
          },
        },
      },
    });
    expect(error.pointer).toBe("project.launch.box.device.readyWhen");
    expect(error.message).toContain("no 'resolve' probe");
  });

  it("refuses a key one spelling away from one the rule reads", () => {
    for (const [key, meant] of [
      ["fields", "field"],
      ["paths", "path"],
      ["Field", "field"],
    ] as const) {
      const error = refusal({
        project: {
          ...PROJECT,
          launch: {
            box: {
              verb: "dev",
              device: { ...PROBED, readyWhen: { field: 2, in: ["r"], [key]: "x" } },
            },
          },
        },
      });
      expect(error.pointer, key).toBe(`project.launch.box.device.readyWhen.${key}`);
      expect(error.message, key).toContain(meant);
      expect(error.message, key).toContain("A readiness rule's keys are field, path, in");
    }
    // AND THE KEY ITSELF, on the device, where a case slip is the natural one.
    const cased = refusal({
      project: {
        ...PROJECT,
        launch: { box: { verb: "dev", device: { ...PROBED, readywhen: { field: 2, in: ["r"] } } } },
      },
    });
    expect(cased.pointer).toBe("project.launch.box.device.readywhen");
    expect(cased.message).toContain("differs from 'readyWhen' only in case");
  });

  it("refuses a misspelling of the BLOCK KEY, which no other guard would catch", () => {
    // `"launches": {...}` parses cleanly, is preserved as an unknown key, and
    // makes every --target this repository declares answer "not declared". The
    // distance rule alone does not reach it: `launches` is two insertions away.
    for (const key of ["launches", "Launch", "launchs"]) {
      const error = refusal({ project: { ...PROJECT, [key]: { box: { verb: "dev" } } } });
      expect(error.pointer, key).toBe(`project.${key}`);
      expect(error.message, key).toContain("the block nen reads for 'nen shu dev|run --target'");
    }
    // AND EACH ONE IS NAMED FOR THE MISSPELLING IT ACTUALLY IS -- the plural
    // shape exists for exactly this key, which the one-edit rule cannot reach.
    for (const [key, phrase] of [
      ["launches", "is 'launch' with an English plural on it"],
      ["Launch", "differs from 'launch' only in case"],
      ["launchs", "is one letter away from 'launch'"],
    ] as const) {
      const error = refusal({ project: { ...PROJECT, [key]: { box: { verb: "dev" } } } });
      expect(error.message, key).toContain(phrase);
    }
  });

  it("keeps a project-level key that is nobody's misspelling of it", () => {
    const contract = parse({
      project: { ...PROJECT, $launch: "a note", lunchbox: {}, launchpad: {} },
    });
    expect(contract.project?.raw["lunchbox"]).toEqual({});
    expect(contract.project?.raw["launchpad"]).toEqual({});
  });
});

// ── stdoutTo ────────────────────────────────────────────────────────────────
//
// The key that answers a shell this family does not have. `nen shu` captures a
// child's stdout already; `stdoutTo` says to write those bytes to a file rather
// than relay them, which is what an `xccov`-shaped extraction step -- one that
// PRINTS the report nen then parses -- has needed since the coverage reader
// landed. Everything refused below is refused at LOAD, because each shape is a
// declaration that can never be honoured rather than a run that fails.

describe("project.verbs.<lane>.<verb>.stdoutTo", () => {
  function verb(invocation: unknown): unknown {
    return { ...PROJECT, verbs: { web: { coverage: invocation } } };
  }

  it("is null when the key is absent, on both invocation forms", () => {
    const command = parse({ project: PROJECT }).project?.verbs["web"]?.["build"];
    expect(command?.kind === "command" ? command.stdoutTo : "not a command").toBeNull();
    const stepped = parse({ project: verb({ steps: [{ exe: "tool", argv: ["go"] }] }) }).project
      ?.verbs["web"]?.["coverage"];
    expect(stepped?.kind === "steps" ? stepped.steps[0]?.stdoutTo : "not steps").toBeNull();
  });

  it("reads a repo-relative path on an {exe, argv} invocation", () => {
    const invocation = parse({
      project: verb({ exe: "tool", argv: ["report"], stdoutTo: "nen/reports/coverage.json" }),
    }).project?.verbs["web"]?.["coverage"];
    expect(invocation?.kind === "command" ? invocation.stdoutTo : null).toBe(
      "nen/reports/coverage.json",
    );
  });

  it("reads it PER STEP, which is the shape the reason for this key has", () => {
    // The row that motivates the key is two steps: one that produces a bundle
    // and one that prints a report out of it. Only the second redirects.
    const invocation = parse({
      project: verb({
        steps: [
          { exe: "tool", argv: ["test"] },
          { exe: "tool", argv: ["extract"], stdoutTo: "nen/reports/xccov.json" },
        ],
      }),
    }).project?.verbs["web"]?.["coverage"];
    expect(invocation?.kind === "steps" ? invocation.steps.map((s): unknown => s.stdoutTo) : []).toEqual([
      null,
      "nen/reports/xccov.json",
    ]);
  });

  it("refuses an ABSOLUTE path, in either family's spelling", () => {
    for (const value of ["/etc/hosts", "\\\\windows\\\\path", "C:/temp/out.json", "C:\\\\temp\\\\out.json"]) {
      const error = refusal({ project: verb({ exe: "tool", argv: ["go"], stdoutTo: value }) });
      expect(error.pointer, value).toBe("project.verbs.web.coverage.stdoutTo");
      expect(error.message, value).toContain("is an ABSOLUTE path");
    }
  });

  it("refuses a path that climbs out of the tree with '..'", () => {
    for (const value of ["../escape.json", "nen/../../escape.json", "..\\escape.json"]) {
      const error = refusal({ project: verb({ exe: "tool", argv: ["go"], stdoutTo: value }) });
      expect(error.message, value).toContain("climbs out of the repository with '..'");
    }
    // And a directory that merely BEGINS with dots is not an escape: the check
    // is on whole segments, exactly as ../repo/contain.ts's is.
    const fine = parse({
      project: verb({ exe: "tool", argv: ["go"], stdoutTo: "..hidden/out.json" }),
    }).project?.verbs["web"]?.["coverage"];
    expect(fine?.kind === "command" ? fine.stdoutTo : null).toBe("..hidden/out.json");
  });

  it("refuses a GLOB, because nen expands nothing and would write that name", () => {
    for (const value of ["reports/*.json", "reports/out?.json", "reports/out[12].json"]) {
      const error = refusal({ project: verb({ exe: "tool", argv: ["go"], stdoutTo: value }) });
      expect(error.message, value).toContain("carries a glob character");
    }
  });

  it("refuses an empty string, a blank one, and a non-string, by pointer", () => {
    // `""` is refused by the shared string reader; `"   "` is the one this key
    // has to catch itself, because a path of three spaces is a filename nobody
    // meant and every later reader would print it as if it were one.
    expect(refusal({ project: verb({ exe: "tool", argv: ["go"], stdoutTo: "" }) }).message).toContain(
      "expected a non-empty string",
    );
    expect(refusal({ project: verb({ exe: "tool", argv: ["go"], stdoutTo: "   " }) }).message).toContain(
      "is empty",
    );
    const error = refusal({ project: verb({ exe: "tool", argv: ["go"], stdoutTo: 7 }) });
    expect(error.pointer).toBe("project.verbs.web.coverage.stdoutTo");
  });

  it("names the STEP's own pointer when a step's value is the bad one", () => {
    const error = refusal({
      project: verb({
        steps: [
          { exe: "tool", argv: ["a"] },
          { exe: "tool", argv: ["b"], stdoutTo: "../out.json" },
        ],
      }),
    });
    expect(error.pointer).toBe("project.verbs.web.coverage.steps[1].stdoutTo");
  });
});

// ── the `port` precondition ─────────────────────────────────────────────────

describe("project.preconditions -- kind 'port'", () => {
  function withRow(row: unknown): unknown {
    return { ...PROJECT, preconditions: { web: [row] } };
  }

  it("reads a port NUMBER and its direction", () => {
    const contract = parse({
      project: withRow({ kind: "port", value: 3000, expect: "listening", why: "the API" }),
    });
    const row = contract.project?.preconditions["web"]?.[0];
    expect(row?.value).toBe(3000);
    expect(row?.expect).toBe("listening");
    expect(row?.why).toBe("the API");
  });

  it("accepts both directions, and nothing else", () => {
    for (const expected of ["listening", "free"]) {
      expect(
        parse({ project: withRow({ kind: "port", value: 5173, expect: expected }) }).project
          ?.preconditions["web"]?.[0]?.expect,
      ).toBe(expected);
    }
    const error = refusal({ project: withRow({ kind: "port", value: 5173, expect: "busy" }) });
    expect(error.pointer).toBe("project.preconditions.web[0].expect");
    expect(error.message).toContain("CLOSED set: listening, free");
  });

  it("refuses a port row with no direction: nen will not pick one", () => {
    const error = refusal({ project: withRow({ kind: "port", value: 5173 }) });
    expect(error.pointer).toBe("project.preconditions.web[0].expect");
    expect(error.message).toContain("got nothing (the field is absent)");
  });

  it("refuses 'expect' on any OTHER kind rather than dropping it silently", () => {
    const error = refusal({ project: withRow({ kind: "path", value: "deps", expect: "free" }) });
    expect(error.pointer).toBe("project.preconditions.web[0].expect");
    expect(error.message).toContain("nen reads 'expect' on 'port' rows alone");
  });

  it("refuses a value that is not a whole number in 1..65535", () => {
    for (const value of ["3000", 0, 65_536, 3000.5, -1, true, null]) {
      const error = refusal({ project: withRow({ kind: "port", value, expect: "free" }) });
      expect(error.pointer, String(value)).toBe("project.preconditions.web[0].value");
      expect(error.message, String(value)).toContain("expected a port NUMBER between 1 and 65535");
    }
    // The two ends of the range are legal.
    for (const value of [1, 65_535]) {
      expect(
        parse({ project: withRow({ kind: "port", value, expect: "free" }) }).project
          ?.preconditions["web"]?.[0]?.value,
      ).toBe(value);
    }
  });

  it("leaves a LIST value alone, as it does for every assertable kind", () => {
    // The executor reports a list-valued row as "cannot assert" rather than
    // guessing which element was meant, so the loader has nothing to add.
    const row = parse({
      project: withRow({ kind: "port", value: ["3000", "3001"], expect: "free" }),
    }).project?.preconditions["web"]?.[0];
    expect(row?.value).toEqual(["3000", "3001"]);
    expect(row?.expect).toBe("free");
  });

  it("gives every other kind a null 'expect'", () => {
    expect(
      parse({ project: withRow({ kind: "path", value: "deps" }) }).project?.preconditions["web"]?.[0]
        ?.expect,
    ).toBeNull();
  });
});

// ── the evidence BLOCK KEY, guarded like launch's ───────────────────────────

describe("the project-level block keys whose own NAME is guarded", () => {
  it("refuses a misspelling of 'evidence', naming what it would cost", () => {
    for (const key of ["evidences", "Evidence", "evidenc"]) {
      const error = refusal({
        project: { ...PROJECT, [key]: { globs: ["**/*.png"], mechanism: "files-changed" } },
      });
      expect(error.pointer, key).toBe(`project.${key}`);
      expect(error.message, key).toContain("the block nen reads for 'nen shu evidence'");
      expect(error.message, key).toContain("Spell it 'evidence'");
    }
  });

  it("names each misspelling for the shape it actually is", () => {
    // `evidences` is ONE letter longer than `evidence`, so the distance rule
    // reaches it and says so -- unlike `launches`, which is two insertions from
    // `launch` and is the reason the plural shape exists at all.
    for (const [key, phrase] of [
      ["evidences", "is one letter away from 'evidence'"],
      ["Evidence", "differs from 'evidence' only in case"],
      ["evidenc", "is one letter away from 'evidence'"],
    ] as const) {
      const error = refusal({ project: { ...PROJECT, [key]: { globs: ["a"] } } });
      expect(error.message, key).toContain(phrase);
    }
  });

  it("still refuses a misspelling of 'launch', which arrived first", () => {
    const error = refusal({ project: { ...PROJECT, evidences: {}, launches: {} } });
    // Whichever fires, it fires by pointer -- the loop is over the FILE's keys,
    // so the first misspelt key in the document is the one named.
    expect(["project.evidences", "project.launches"]).toContain(error.pointer);
  });

  it("leaves 'targets' and its siblings unswept, and keeps their own guard", () => {
    // The older optional blocks are deliberately not swept at the BLOCK level:
    // a declaration written against 0.3.0 may park a `"target"` or `"host"` key
    // there, and refusing it is a change with its own blast radius. What
    // `targets` keeps is the PER-ENTRY guard, which still fires.
    const kept = parse({ project: { ...PROJECT, target: {}, host: {}, profile: {} } });
    expect(kept.project?.raw["target"]).toEqual({});
    expect(kept.project?.raw["host"]).toEqual({});
    const error = refusal({ project: { ...PROJECT, targets: { prod: { arg: ["--prod"] } } } });
    expect(error.pointer).toBe("project.targets.prod.arg");
  });

  it("keeps a project-level key that is nobody's misspelling of either", () => {
    const contract = parse({ project: { ...PROJECT, $evidence: "a note", evidently: {} } });
    expect(contract.project?.raw["evidently"]).toEqual({});
  });
});
