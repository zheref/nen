import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadProfilesPack } from "../profiles/pack.js";
import {
  MATRIX_COMMAND,
  MATRIX_DRIFT_MESSAGE,
  MATRIX_PATH,
  renderStackMatrix,
} from "./matrix.js";

// THE DRIFT GUARD. It reads the committed page through `process.cwd()` --
// vitest runs from the repository root -- rather than from `import.meta.url`,
// so it exercises the same root-resolution discipline the shipped code is held
// to, exactly as ../version.test.ts does for package.json.
//
// LINE ENDINGS ARE NORMALISED ON BOTH SIDES. The tree is `* text=auto`, so this
// file is LF in the object database and may be CRLF in a Windows working tree.
// A guard that failed on one of three CI platforms is a guard somebody deletes.
function committed(): string {
  return readFileSync(join(process.cwd(), MATRIX_PATH), "utf8").replace(/\r\n/g, "\n");
}

describe(MATRIX_PATH, () => {
  it("matches a fresh render of the profiles pack, byte for byte", () => {
    const rendered = renderStackMatrix(loadProfilesPack());
    expect(committed(), MATRIX_DRIFT_MESSAGE).toBe(rendered);
  });

  it("says, in the file itself, that it is generated and how to regenerate it", () => {
    // The header is the only thing that stops a well-meaning hand edit, since
    // the person making one has not run the suite yet.
    const text = committed();
    expect(text.split("\n")[0]).toContain("GENERATED FILE");
    expect(text).toContain(MATRIX_COMMAND);
  });
});

describe("renderStackMatrix", () => {
  const pack = loadProfilesPack();

  it("is deterministic: two renders of one pack are identical", () => {
    // A drift test over a non-deterministic render is a test that fails at
    // random and then gets deleted, which is how the ancestor artifact ended up
    // hand-maintained with no check at all.
    expect(renderStackMatrix(pack)).toBe(renderStackMatrix(loadProfilesPack()));
  });

  it("carries no timestamp and no version stamp", () => {
    // Both would make the render depend on WHEN it ran or on an input that did
    // not change, and both would turn an unrelated bump into a red build.
    const text = renderStackMatrix(pack);
    expect(text).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
    expect(text).not.toMatch(/\b\d+\.\d+\.\d+\b(?=[^`]*generated)/i);
  });

  it("ends with exactly one newline and contains no carriage return", () => {
    const text = renderStackMatrix(pack);
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text).not.toContain("\r");
  });

  it("renders one row per stack and one column per verb", () => {
    const text = renderStackMatrix(pack);
    const header = text
      .split("\n")
      .find((line): boolean => line.startsWith("| stack |"));
    expect(header).toBeDefined();
    // `| stack |` plus the thirteen verbs, so fourteen cells between pipes.
    expect((header ?? "").split("|").filter((cell): boolean => cell.trim() !== "").length).toBe(
      pack.verbs.length + 1,
    );
    for (const id of pack.ids) expect(text).toContain(`| \`${id}\` |`);
  });

  it("gives every stack its own section, with its host, template and markers", () => {
    const text = renderStackMatrix(pack);
    for (const id of pack.ids) {
      const profile = pack.profiles[id];
      expect(profile).toBeDefined();
      expect(text).toContain(`## \`${id}\` -- ${profile?.displayName ?? ""}`);
      expect(text).toContain(profile?.hostNote ?? "");
      expect(text).toContain(profile?.scaffoldNote ?? "");
      for (const marker of profile?.markers ?? []) expect(text).toContain(`\`${marker.pattern}\``);
    }
  });

  it("carries every cell's citation into the page", () => {
    // The whole value of this artifact is that no cell is unattributed.
    const text = renderStackMatrix(pack);
    for (const id of pack.ids) {
      const profile = pack.profiles[id];
      for (const verb of pack.verbs) {
        const cell = profile?.verbs[verb];
        expect(cell, `${id}.${verb}`).toBeDefined();
        expect(text, `${id}.${verb}`).toContain(`*(source: ${cell?.source ?? ""})*`);
      }
    }
  });

  it("renders every command cell as its own exe and argv, unabbreviated", () => {
    const text = renderStackMatrix(pack);
    for (const id of pack.ids) {
      const profile = pack.profiles[id];
      for (const verb of pack.verbs) {
        const cell = profile?.verbs[verb];
        if (cell?.kind !== "command") continue;
        if (cell.invocation.kind !== "command") continue;
        const line = [cell.invocation.exe, ...cell.invocation.argv].join(" ");
        expect(text, `${id}.${verb}`).toContain(`\`${line}\``);
      }
    }
  });

  it("counts the grid honestly in its own summary line", () => {
    const text = renderStackMatrix(pack);
    let carried = 0;
    let declaredOnly = 0;
    let unsupported = 0;
    for (const id of pack.ids) {
      for (const verb of pack.verbs) {
        const kind = pack.profiles[id]?.verbs[verb]?.kind;
        if (kind === "declared-only") declaredOnly += 1;
        else if (kind === "unsupported") unsupported += 1;
        else carried += 1;
      }
    }
    expect(text).toContain(`Of the ${carried + declaredOnly + unsupported} stack × verb cells`);
    expect(text).toContain(`**${unsupported} are unsupported**`);
    expect(text).toContain(`${declaredOnly} are declared-only`);
    expect(text).toContain(`${carried} carry an answer`);
  });

  it("renders an override pack rather than the bundled one when given one", () => {
    // The renderer takes a pack, never reaches for one: that is what makes
    // `--profiles <dir>` a parameter the day a verb needs it.
    const single = {
      ids: ["only"],
      verbs: ["build"],
      origin: "/fake",
      profiles: {
        only: {
          id: "only",
          displayName: "Only",
          markers: [{ pattern: "only.json", contains: null, why: "the marker" }],
          hosts: { "*": ["linux"] },
          hostNote: "linux",
          scaffoldTemplate: null,
          scaffoldNote: "none",
          verbs: {
            build: {
              kind: "declared-only" as const,
              reason: "nothing observed",
              summary: "nothing",
              source: "a:1",
            },
          },
          toolchain: {},
          notes: [],
          raw: {},
        },
      },
    };
    const text = renderStackMatrix(single);
    expect(text).toContain("## `only` -- Only");
    expect(text).toContain("Of the 1 stack × verb cells");
    expect(text).not.toContain("## `nextjs`");
  });
});
