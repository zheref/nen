// src/scaffold/templates.test.ts -- the scaffold template pack, held to the
// three properties a bundled data directory has to have.
//
//   1. IT EMBEDS. `bun build --compile` follows a static import and cannot
//      follow a directory read, so the import list in ./templates.ts is the one
//      thing here that can fall behind the data -- and the failure it produces
//      is the worst available: a stack that has a template in a checkout and
//      none in every shipped binary. Three assertions in both directions.
//   2. IT AGREES WITH THE PROFILES PACK. `scaffoldTemplate` is a NAME, and a
//      name pointing at a template that does not exist is a stack every
//      scaffold refuses at run time, on a user's machine, for a fact that was
//      knowable at build time.
//   3. NO MODULE OF THIS FAMILY NAMES A TOOLCHAIN. The CI file is data for
//      exactly this reason; the sweep below is ../shu/purity.test.ts's rule,
//      pointed at `src/scaffold/`.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadProfilesPack, profileById } from "../profiles/pack.js";
import { VerbUsageError } from "../cli/command.js";
import {
  TEMPLATE_DIRECTORY,
  TEMPLATE_FILE,
  TEMPLATE_INDEX_FILE,
  TemplateError,
  assertWritablePath,
  bundledTemplateNames,
  compareNenRefs,
  freshTreeSupport,
  indexedTemplateNames,
  knownStacks,
  minimumNenRef,
  resolveStackId,
  stackHosts,
  substitute,
  templateForStack,
} from "./templates.js";

const ROOT = process.cwd();
const TEMPLATES = join(ROOT, TEMPLATE_DIRECTORY);

/** The filesystem/path modules a read of `templates/` would have to come from. */
const PATH_MODULES = "node:fs|node:fs/promises|node:path|node:path/posix|node:path/win32|fs|path";

/**
 * Every callee IN ONE FILE that could compose or read a path, ALIASES INCLUDED.
 *
 * A fixed name list is defeated by one rename (`readFileSync as _rfs`), which
 * is exactly the mutation that survived the first draft of this sweep. Reading
 * the file's own import clauses closes that: a binding renamed on the way in is
 * still bound to the module it came from, and the local name is what the call
 * site has to use.
 */
function pathCallers(source: string): RegExp {
  const names = new Set([
    "join",
    "resolve",
    "readFileSync",
    "readdirSync",
    "existsSync",
    "statSync",
    "lstatSync",
    "openSync",
  ]);
  const named = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*["'](?:${PATH_MODULES})["']`, "g");
  for (const match of source.matchAll(named)) {
    for (const clause of (match[1] ?? "").split(",")) {
      const local = clause.trim().split(/\s+as\s+/).at(-1)?.trim() ?? "";
      if (/^[A-Za-z_$][\w$]*$/.test(local)) names.add(local);
    }
  }
  const namespace = new RegExp(
    `import\\s*\\*\\s*as\\s+([A-Za-z_$][\\w$]*)\\s*from\\s*["'](?:${PATH_MODULES})["']`,
    "g",
  );
  for (const match of source.matchAll(namespace)) {
    if (match[1] !== undefined) names.add(`${match[1]}\\.[A-Za-z_$][\\w$]*`);
  }
  return new RegExp(`(?:\\b(?:${[...names].join("|")})|Bun\\.file)\\s*\\(`);
}

const onDisk = readdirSync(TEMPLATES, { withFileTypes: true })
  .filter((entry): boolean => entry.isDirectory())
  .map((entry): string => entry.name)
  .sort();

describe("the bundled template list", () => {
  it("names every template directory in templates/", () => {
    expect([...bundledTemplateNames()].sort()).toEqual(onDisk);
  });

  it("matches templates/index.json, so no listed template is missing from the binary", () => {
    expect([...indexedTemplateNames()].sort()).toEqual(onDisk);
  });

  it("has a template.json in every directory it names", () => {
    for (const name of bundledTemplateNames()) {
      expect(readdirSync(join(TEMPLATES, name))).toContain(TEMPLATE_FILE);
    }
  });

  it("carries the documents' real content, not an empty module", () => {
    // The way a JSON import silently degrades under a bundler is an empty
    // object, which every accessor below would then read as "absent". Comparing
    // the embedded body to the file on disk is what makes "it embedded" an
    // observation: this assertion is exactly the one that fails if the import
    // resolves to nothing.
    for (const name of bundledTemplateNames()) {
      const disk = JSON.parse(
        readFileSync(join(TEMPLATES, name, TEMPLATE_FILE), "utf8"),
      ) as { ci: { body: string } };
      const stack = knownStacks().find(
        (id): boolean => profileById(loadProfilesPack(), id).scaffoldTemplate === name,
      );
      expect(stack, `no stack points at '${name}'`).toBeDefined();
      const template = templateForStack(stack as string);
      expect(template?.ci.body).toBe(disk.ci.body);
      expect((template?.ci.body ?? "").length).toBeGreaterThan(200);
    }
  });

  it("names its index and document files as this module spells them", () => {
    expect(readdirSync(TEMPLATES)).toContain(TEMPLATE_INDEX_FILE);
  });

  it("does not let the LOADER import a filesystem or a path module at all", () => {
    // THE PROPERTY, STATED AS THE PROPERTY rather than as a pattern over call
    // sites. The sweep below asks "does any statement call a path function AND
    // name `templates`", and a one-line mutation defeats it:
    //
    //     import { readFileSync as _rfs } from "node:fs";
    //     const doc = JSON.parse(_rfs(_j(process.cwd(), "templates", ...)));
    //
    // -- the call names neither `readFileSync` nor `join`, and the sweep is
    // green while the loader reads from disk. The real property is simpler and
    // cannot be aliased around: THIS module has no business touching a
    // filesystem or composing a path in the first place. It reads two bundled
    // JSON documents and the profiles pack, and nothing else. So the import
    // list is the assertion, and the alias goes with the import it renames.
    const source = readFileSync(join(ROOT, "src", "scaffold", "templates.ts"), "utf8");
    // Every specifier this module imports, static and dynamic, by the only
    // syntax that can name one -- a bare `"path"` inside an expression is a
    // JSON field name, not a module, and matching it would make the rule
    // unreadable rather than strict.
    const specifiers = [
      ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
      ...source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match): string => match[1] ?? "");
    expect(specifiers.length, "the specifier scan must actually see this module's imports").toBeGreaterThan(3);
    const forbidden = specifiers.filter((specifier): boolean =>
      /^(?:node:)?(?:fs|path|os|child_process)(?:\/|$)/.test(specifier) || specifier === "bun",
    );
    expect(
      forbidden,
      "src/scaffold/templates.ts neither reads a file nor composes a path: it imports two bundled JSON documents and the profiles pack",
    ).toEqual([]);
    expect(source).not.toMatch(/Bun\s*\.\s*file/);
    expect(source).not.toMatch(/process\s*\.\s*cwd/);
  });

  it("is reached by STATIC IMPORT ONLY -- no shipped module reads templates/ by path", () => {
    // THE PROPERTY THAT MAKES EMBEDDING WORK, checked the way
    // ../profiles/inertness.test.ts checks the same one for `profiles/`: a
    // `readFileSync(join(root, "templates", ...))` works perfectly in a
    // checkout and finds nothing inside a compiled binary, where there is no
    // `templates/` directory to open. A test that only counted the import list
    // would pass while the loader quietly read from disk.
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "fixtures") walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        const source = readFileSync(path, "utf8");
        // A FILESYSTEM call naming the directory, as opposed to the static
        // specifier `"../../templates/full/template.json"` (which a bundler
        // follows) or the exported `TEMPLATE_DIRECTORY` constant appearing in
        // an error message (which is prose about a path, not a read of one).
        //
        // SPLIT INTO STATEMENTS FIRST, and that is not tidiness: an earlier
        // draft matched `callee\([^)]*templates` over the whole source, and a
        // seeded `join(process.cwd(), "templates", ...)` walked straight
        // through it -- the `)` of `process.cwd()` ended the character class
        // two arguments early. Splitting fixes that one, and does NOT make the
        // rule undefeatable: a second seeded mutant renamed the import
        // (`readFileSync as _rfs`) and the fixed name list saw nothing. So the
        // callee list is now BUILT FROM EACH FILE'S OWN IMPORTS -- every local
        // binding brought in from a filesystem or path module, whatever it was
        // renamed to -- and the test above closes the loader's own door
        // entirely by forbidding those imports there at all.
        const offends = source
          .split(/[;\n]/)
          .some(
            (statement): boolean =>
              pathCallers(source).test(statement) &&
              /(["'`]templates["'`]|TEMPLATE_DIRECTORY)/.test(statement),
          );
        if (offends) offenders.push(path);
      }
    };
    walk(join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });

  it("sees through an ALIASED import, which is how the first draft was defeated", () => {
    // The mutant, as a fixture: the pattern the old fixed name list missed.
    const aliased = [
      'import { readFileSync as _rfs } from "node:fs";',
      'import { join as _j } from "node:path";',
      'const document = JSON.parse(_rfs(_j(process.cwd(), "templates", "full", "template.json"), "utf8"));',
    ].join("\n");
    const offends = aliased
      .split(/[;\n]/)
      .some(
        (statement): boolean =>
          pathCallers(aliased).test(statement) &&
          /(["'`]templates["'`]|TEMPLATE_DIRECTORY)/.test(statement),
      );
    expect(offends, "an aliased filesystem read of templates/ must be caught").toBe(true);
  });
});

describe("the template pack agrees with the profiles pack", () => {
  const pack = loadProfilesPack();

  it("has a template directory for every stack the catalogue names one for", () => {
    // THE MUTATION THIS CATCHES: a stack gains `scaffoldTemplate: "x"` and no
    // `templates/x/` is added. Without this the failure is a runtime throw on
    // whichever machine first types `--stack <that one>`.
    const named = pack.ids
      .map((id): string | null => profileById(pack, id).scaffoldTemplate)
      .filter((name): name is string => name !== null);
    expect(named.length).toBeGreaterThan(0);
    for (const name of new Set(named)) expect(onDisk).toContain(name);
  });

  it("resolves a template for every stack with a template name, and null for the rest", () => {
    for (const id of pack.ids) {
      const expected = profileById(pack, id).scaffoldTemplate;
      const template = templateForStack(id);
      if (expected === null) {
        expect(template, id).toBeNull();
        continue;
      }
      expect(template?.template, id).toBe(expected);
      expect(template?.stack, id).toBe(id);
      expect(template?.runner, id).not.toBe("");
    }
  });

  it("gives every stack with a template EITHER a fresh tree OR a stated reason it has none", () => {
    for (const id of pack.ids) {
      const template = templateForStack(id);
      if (template === null) continue;
      if (template.noFreshTree === null) {
        expect(template.freshTree.length, id).toBeGreaterThan(0);
      } else {
        expect(template.freshTree, id).toEqual([]);
        expect(template.noFreshTree.length, id).toBeGreaterThan(40);
      }
    }
  });

  it("writes a CI workflow under .github/workflows for every template", () => {
    for (const name of bundledTemplateNames()) {
      const stack = knownStacks().find(
        (id): boolean => profileById(pack, id).scaffoldTemplate === name,
      ) as string;
      expect(templateForStack(stack)?.ci.path).toMatch(/^\.github\/workflows\/[a-z0-9-]+\.yml$/);
    }
  });

  it("runs build, test and lint through `nen shu`, dry-run first, and names no tool", () => {
    for (const name of bundledTemplateNames()) {
      const stack = knownStacks().find(
        (id): boolean => profileById(pack, id).scaffoldTemplate === name,
      ) as string;
      const body = templateForStack(stack)?.ci.body ?? "";
      expect(body).toContain("shu tools --repo .");
      expect(body).toContain("--dry-run");
      for (const verb of ["build", "test", "lint"]) expect(body).toContain(verb);
      // The dry run has to come FIRST in the file, or "dry-run-first" is a
      // claim the template does not make.
      expect(body.indexOf("--dry-run")).toBeLessThan(body.lastIndexOf("shu"));
    }
  });
});

describe("--stack is validated by shape first and membership second", () => {
  it("accepts every id the catalogue lists", () => {
    for (const id of knownStacks()) expect(resolveStackId(id)).toBe(id);
  });

  it("refuses a path-shaped value before it ever reaches a lookup", () => {
    expect((): unknown => resolveStackId("../../etc")).toThrow(VerbUsageError);
    expect((): unknown => resolveStackId("")).toThrow(VerbUsageError);
    expect((): unknown => resolveStackId("a b")).toThrow(VerbUsageError);
  });

  it("refuses an unknown id, listing the known ones", () => {
    expect((): unknown => resolveStackId("not-a-stack")).toThrow(/Known: .*nextjs/);
  });
});

describe("stackHosts", () => {
  it("is the catalogue's own map, verbatim", () => {
    const pack = loadProfilesPack();
    for (const id of pack.ids) expect(stackHosts(id)).toEqual(profileById(pack, id).hosts);
  });
});

describe("substitute", () => {
  it("replaces every occurrence of a token it was given", () => {
    expect(substitute("{{name}}/{{name}}", { name: "kro" }, "x")).toBe("kro/kro");
  });

  it("REFUSES an unsubstituted token rather than writing the placeholder to disk", () => {
    // A file written with `{{name}}` still in it looks scaffolded and is not,
    // and the caller finds out from whatever reads it next instead of from nen.
    expect((): unknown => substitute("{{name}} {{org}}", { name: "kro" }, "the x template")).toThrow(
      /\{\{org\}\}/,
    );
    expect((): unknown => substitute("{{org}}", {}, "the x template")).toThrow(VerbUsageError);
  });

  it("leaves text with no token alone, byte for byte", () => {
    const body = "name: nen shu\non:\n  pull_request:\n";
    expect(substitute(body, {}, "x")).toBe(body);
  });
});

// ── the family's own purity rule ────────────────────────────────────────────
//
// ../shu/purity.test.ts's rule, pointed at this directory: no module here may
// name a toolchain executable. `nen scaffold` writes a CI file whose every
// command is `nen shu <verb>`; the moment a module here knows what a package
// manager is called, "the CI file is data" has stopped being true for whichever
// stack it learned -- and the code still works, for that one stack, which is
// how a discipline of this shape dies.
//
// COMMENTS ARE SWEPT TOO, for ../shu/purity.test.ts's own reason: nothing a
// comment here needs to say requires a member name, so the only way this can be
// wrong is a false positive -- a reviewer told to rephrase -- and never a false
// negative.
const TOOLCHAIN_NAMES: readonly string[] = [
  "xcodebuild",
  "xcrun",
  "gradle",
  "gradlew",
  "fastlane",
  "eas-cli",
  "expo",
  "swiftlint",
  "msbuild",
  "dotnet",
  "turbo",
  "biome",
  "playwright",
  "maestro",
  "vercel",
  "npx",
  "npm",
  "pnpm",
  "yarn",
  "corepack",
  "gatsby",
  "storybook",
  "vitest",
  "cocoapods",
  "sdkmanager",
  "winget",
  "brew",
];

describe("no module of the scaffold family names a toolchain", () => {
  const modules = readdirSync(join(ROOT, "src", "scaffold"))
    .filter((file): boolean => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .sort();

  it("sweeps a non-empty module list", () => {
    expect(modules.length).toBeGreaterThan(3);
    expect(modules).toContain("templates.ts");
    expect(modules).toContain("init.ts");
    expect(modules).toContain("new.ts");
    expect(modules).toContain("command.ts");
  });

  for (const file of readdirSync(join(ROOT, "src", "scaffold"))
    .filter((name): boolean => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()) {
    it(`src/scaffold/${file} names none of the ${TOOLCHAIN_NAMES.length}`, () => {
      const source = readFileSync(join(ROOT, "src", "scaffold", file), "utf8").toLowerCase();
      const hits = TOOLCHAIN_NAMES.filter((name): boolean =>
        new RegExp(`(?<![a-z0-9_])${name}(?![a-z0-9_])`).test(source),
      );
      expect(hits, `${file} names a toolchain; the CI template is DATA for this reason`).toEqual([]);
    });
  }

  it("proves the sweep can fail, on a string that really is in the data", () => {
    // The rule is worth nothing if the pattern matches nothing anywhere. The
    // template BODY is where such a name is allowed to live, so it is also the
    // proof that the matcher works.
    const body = "run: pnpm install\n".toLowerCase();
    expect(
      TOOLCHAIN_NAMES.filter((name): boolean =>
        new RegExp(`(?<![a-z0-9_])${name}(?![a-z0-9_])`).test(body),
      ),
    ).toContain("pnpm");
  });
});

// ── a template writes INSIDE the tree it was pointed at ─────────────────────

describe("a template's paths are validated at LOAD time", () => {
  // WHY LOAD TIME AND NOT WRITE TIME. Every byte of a template ships inside the
  // binary, so a `files` key of `../ESCAPED.txt` is a file nen writes one
  // directory ABOVE `--dir`, reported by the key it was written from, at exit
  // 0. The containment checks in ./init.ts guard a path a CALLER typed; this
  // guards a path the DATA states, and a bad one must fail this repository's
  // own suite rather than a user's scaffold.
  const escapes = [
    "../ESCAPED.txt",
    "a/../../ESCAPED.txt",
    "/etc/hosts",
    "./relative.txt",
    ".",
    "..",
    "a//b.txt",
    "a\\b.txt",
    "C:/x.txt",
    "",
  ];
  for (const value of escapes) {
    it(`refuses '${value}' as a template path`, () => {
      expect((): string => assertWritablePath(value, "<doc>", "files.x")).toThrow(TemplateError);
    });
  }

  it("accepts the shapes a real template uses", () => {
    for (const value of ["package.json", ".gitignore", ".github/workflows/nen-shu.yml", "app.json"]) {
      expect(assertWritablePath(value, "<doc>", "files.x")).toBe(value);
    }
  });

  it("every bundled template's own paths pass it", () => {
    // The rule applied to the shipped data, so the two cannot come apart: a
    // template that gained an escaping key fails HERE, in this suite.
    for (const stack of knownStacks()) {
      const template = templateForStack(stack);
      if (template === null) continue;
      expect(assertWritablePath(template.ci.path, "<bundled>", "ci.path")).toBe(template.ci.path);
      for (const file of template.freshTree) {
        expect(assertWritablePath(file.path, "<bundled>", "files")).toBe(file.path);
      }
    }
  });
});

// ── substitution reads OWN properties only ──────────────────────────────────

describe("substitute", () => {
  it("refuses an INHERITED property name instead of substituting the prototype's", () => {
    // `values["constructor"]` is not undefined on a plain object: it is
    // `Object`, whose `String()` is the source of a native function. A template
    // body carrying `{{constructor}}` used to have that spliced into a
    // generated file at exit 0.
    for (const token of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect((): string => substitute(`x {{${token}}} y`, { name: "kro" }, "<doc>")).toThrow(
        VerbUsageError,
      );
      expect((): string => substitute(`x {{${token}}} y`, { name: "kro" }, "<doc>")).toThrow(
        `{{${token}}}`,
      );
    }
  });

  it("still substitutes an own property, including one whose value is empty", () => {
    expect(substitute("a {{name}} b", { name: "kro" }, "<doc>")).toBe("a kro b");
    expect(substitute("a {{name}} b", { name: "" }, "<doc>")).toBe("a  b");
  });
});

// ── the ref a generated workflow may pin nen at ─────────────────────────────

describe("templates/index.json's minimumNenRef", () => {
  const CHANGELOG = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

  /** Every released heading, newest first. `## vX.Y.Z -- <date>`. */
  const released = [...CHANGELOG.matchAll(/^## (v\d+\.\d+\.\d+)/gm)].map(
    (match): string => match[1] as string,
  );

  it("is a well-formed tag with a reason beside it", () => {
    const minimum = minimumNenRef();
    expect(minimum.ref).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(minimum.why.length).toBeGreaterThan(80);
  });

  it("is NEWER than every release the CHANGELOG has published", () => {
    // THE GIT-FREE EVIDENCE, AND THE ARGUMENT FOR CHOOSING IT. The question the
    // minimum answers is "which release first carried the verbs these templates
    // call", and this repository has exactly one artifact that records when a
    // verb SHIPPED: CHANGELOG.md, whose `## vX.Y.Z` headings are the published
    // releases and whose `## Unreleased` section is what has not shipped yet. A
    // constant in src/shu/command.ts was the alternative and is worse twice
    // over -- it is a second place to write a fact that already has a place,
    // and it would record what a developer TYPED rather than what was
    // RELEASED, which is the fact the bootstrap actually depends on.
    // `git ls-tree v0.2.0` is the direct evidence and is not available to a
    // test: this suite runs on three platforms, on a checkout that may be
    // shallow, with no network.
    expect(released.length, "the changelog must carry released headings").toBeGreaterThan(0);
    for (const version of released) {
      expect(
        compareNenRefs(minimumNenRef().ref, version),
        `${minimumNenRef().ref} must be newer than the released ${version}`,
      ).toBeGreaterThan(0);
    }
  });

  it("is justified: the shu family is announced under '## Unreleased', not under a release", () => {
    const firstRelease = `## ${released[0] as string}`;
    const unreleased = CHANGELOG.slice(CHANGELOG.indexOf("## Unreleased"), CHANGELOG.indexOf(firstRelease));
    expect(unreleased).toContain("new family `nen shu`");
    // ...and nowhere in a released section, which is what makes "no published
    // release carries these verbs" an observation rather than a claim.
    expect(CHANGELOG.slice(CHANGELOG.indexOf(firstRelease))).not.toContain("new family `nen shu`");
  });

  it("compares refs NUMERICALLY, field by field", () => {
    // `"v0.10.0" < "v0.9.0"` as strings, and a minimum compared that way would
    // accept a ref older than itself.
    expect(compareNenRefs("v0.10.0", "v0.9.0")).toBeGreaterThan(0);
    expect(compareNenRefs("v0.2.0", "v0.3.0")).toBeLessThan(0);
    expect(compareNenRefs("v1.0.0", "v0.99.99")).toBeGreaterThan(0);
    expect(compareNenRefs("v0.3.0", "v0.3.0")).toBe(0);
    expect(compareNenRefs("v0.3.1", "v0.3.0")).toBeGreaterThan(0);
  });
});

// ── which stacks have a fresh-tree form ─────────────────────────────────────

describe("freshTreeSupport", () => {
  it("partitions every known stack exactly once", () => {
    const support = freshTreeSupport();
    const all = [...support.freshTree, ...support.initOnly, ...support.noTemplate].sort();
    expect(all).toEqual([...knownStacks()].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("agrees with what each template actually says", () => {
    const support = freshTreeSupport();
    expect(support.freshTree.length).toBeGreaterThan(0);
    expect(support.initOnly.length).toBeGreaterThan(0);
    for (const stack of support.freshTree) {
      const template = templateForStack(stack);
      expect(template?.noFreshTree).toBeNull();
      expect(template?.freshTree.length).toBeGreaterThan(0);
    }
    for (const stack of support.initOnly) {
      const template = templateForStack(stack);
      expect(typeof template?.noFreshTree).toBe("string");
      expect(template?.freshTree).toEqual([]);
      // The refusal has to name the way forward, or it is a dead end.
      expect(template?.noFreshTree).toContain("scaffold init");
    }
    for (const stack of support.noTemplate) {
      expect(templateForStack(stack)).toBeNull();
    }
  });
});

// ── the generated workflow's own shape ──────────────────────────────────────

describe("every bundled CI body", () => {
  const bodies = (): readonly string[] =>
    bundledTemplateNames().map((name): string => {
      const stack = knownStacks().find(
        (id): boolean => profileById(loadProfilesPack(), id).scaffoldTemplate === name,
      );
      return templateForStack(stack as string)?.ci.body ?? "";
    });

  it("declares a read-only token", () => {
    // A generated workflow that declares no `permissions:` inherits whatever
    // the repository's default is -- write, in many repositories. This one
    // fetches a pinned release and runs read-only verbs against a checkout.
    for (const body of bodies()) {
      expect(body, "a workflow body declares no permissions block").toContain("permissions:");
      expect(body).toContain("contents: read");
    }
  });

  it("spells every workflow expression with spaces, so no token reads as a placeholder", () => {
    // `${{env.X}}` does NOT match PLACEHOLDER (`{{` + `[A-Za-z][A-Za-z0-9]*` +
    // `}}`, immediately closed -- src/scaffold/templates.ts): the `.` between
    // `env` and `}}` breaks the token, so `substitute()` leaves it untouched
    // rather than refusing the template. This is a readability guardrail, not a
    // refusal check -- `${{env.X}}` sits one character from `{{token}}`, and a
    // human skimming a generated workflow can misread which grammar they are
    // looking at. So every bundled body spells the GitHub Actions expression
    // with spaces (`${{ env.X }}`) to keep the two grammars visually apart.
    for (const body of bodies()) expect(body).not.toMatch(/\$\{\{[A-Za-z]/);
  });
});
