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

  it("keeps profiles and targets verbatim, since nothing reads them yet", () => {
    const contract = parse({
      project: { ...PROJECT, profiles: { ci: { web: { build: { exe: "x", argv: ["y"] } } } }, targets: { prod: { host: "a" } } },
    });
    expect(contract.project?.profiles["ci"]).toBeDefined();
    expect(contract.project?.targets["prod"]).toEqual({ host: "a" });
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
