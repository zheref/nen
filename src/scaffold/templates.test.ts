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
  bundledTemplateNames,
  indexedTemplateNames,
  knownStacks,
  resolveStackId,
  stackHosts,
  substitute,
  templateForStack,
} from "./templates.js";

const ROOT = process.cwd();
const TEMPLATES = join(ROOT, TEMPLATE_DIRECTORY);

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
        // two arguments early. A per-statement test cannot be defeated that
        // way, because both halves are on the same line whatever nests inside.
        const offends = source
          .split(/[;\n]/)
          .some(
            (statement): boolean =>
              /\b(join|resolve|readFileSync|readdirSync|existsSync|statSync|openSync|Bun\.file)\s*\(/.test(
                statement,
              ) && /(["'`]templates["'`]|TEMPLATE_DIRECTORY)/.test(statement),
          );
        if (offends) offenders.push(path);
      }
    };
    walk(join(ROOT, "src"));
    expect(offenders).toEqual([]);
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
