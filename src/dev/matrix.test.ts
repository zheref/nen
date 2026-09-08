import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { escapeCell } from "../cli/table.js";
import { loadProfilesPack, PLACEHOLDERS } from "../profiles/pack.js";
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
    // `| stack | host | template |` plus the thirteen verbs.
    expect((header ?? "").split("|").filter((cell): boolean => cell.trim() !== "").length).toBe(
      pack.verbs.length + 3,
    );
    expect(header).toContain("| host | template |");
    for (const id of pack.ids) expect(text).toContain(`| \`${id}\` |`);
  });

  it("gives every stack a host and a template cell in the grid", () => {
    // The two facts a reader needs BEFORE a verb cell means anything. Both are
    // compact by design; the full statement is in the stack's own section.
    const text = renderStackMatrix(pack);
    for (const id of pack.ids) {
      const profile = pack.profiles[id];
      const row = text.split("\n").find((line): boolean => line.startsWith(`| \`${id}\` |`));
      expect(row, id).toBeDefined();
      const cells = (row ?? "").split("|").map((cell): string => cell.trim());
      // cells[0] is the empty string before the leading pipe.
      expect(cells[2], `${id} host`).not.toBe("");
      const template = profile?.scaffoldTemplate;
      expect(cells[3], `${id} template`).toBe(template === null ? "—" : `\`${template ?? ""}\``);
    }
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

  it("counts the grid honestly, over the COMMAND verbs only", () => {
    // THE HEADLINE'S DENOMINATOR IS THE FINDING THIS TEST EXISTS FOR. Three of
    // the thirteen rows are not a spawned command -- a marker match, a
    // toolchain report, a delegation -- and folding them in moved the ratio in
    // both directions at once: their declared-only cells read as "stacks with
    // no answer" and their command cells read as builds. Neither is true.
    const text = renderStackMatrix(pack);
    const tally = (verbs: readonly string[]): Record<string, number> => {
      const out = { yes: 0, declared: 0, no: 0 };
      for (const id of pack.ids) {
        for (const verb of verbs) {
          const kind = pack.profiles[id]?.verbs[verb]?.kind;
          if (kind === "declared-only") out.declared += 1;
          else if (kind === "unsupported") out.no += 1;
          else out.yes += 1;
        }
      }
      return out;
    };
    const commands = tally(pack.commandVerbs);
    const others = tally(pack.verbs.filter((verb): boolean => !pack.commandVerbs.includes(verb)));
    const total = (counts: Record<string, number>): number =>
      (counts["yes"] ?? 0) + (counts["declared"] ?? 0) + (counts["no"] ?? 0);

    expect(text).toContain(`Over the **${total(commands)}** stack × verb cells`);
    expect(text).toContain(`**${commands["no"] ?? 0} are unsupported**`);
    expect(text).toContain(`${commands["declared"] ?? 0} are declared-only`);
    expect(text).toContain(`${commands["yes"] ?? 0} carry a command`);
    // And the rows left out are ACCOUNTED FOR, not dropped: a headline that
    // narrows its denominator without saying what it excluded is the same
    // dishonesty in the other direction.
    expect(text).toContain(`The remaining ${total(others)} cells are those`);
    expect(total(commands) + total(others)).toBe(pack.ids.length * pack.verbs.length);
  });

  it("names no verb of its own: the command/non-command split is data", () => {
    // ../taxonomy-purity.test.ts's property, restated for the one distinction
    // this renderer could most easily have hard-coded. `profiles/index.json`
    // carries `commandVerbs`; the renderer reads it.
    const source = readFileSync(join(process.cwd(), "src/dev/matrix.ts"), "utf8");
    for (const verb of pack.verbs) {
      expect(source, `matrix.ts names the verb '${verb}'`).not.toContain(`"${verb}"`);
    }
  });

  it("puts no `<` outside a code span, so no cell renders as HTML", () => {
    // `escapeCell` escapes the pipe and the newline -- the two characters that
    // break a markdown TABLE -- and deliberately not `<`, because it is shared
    // with ../cli/table.ts's terminal renderer where `&lt;` would be visible
    // garbage. Escaping here instead would corrupt the code spans, which is
    // where every `<` in this document actually lives: a `.csproj` property, an
    // `<n>` in a placeholder-shaped citation. So the rule is stated as a
    // PROPERTY OF THE OUTPUT: every `<` sits inside backticks, where markdown
    // renders it literally and no HTML parser sees a tag.
    const text = renderStackMatrix(pack);
    const offences: string[] = [];
    text.split("\n").forEach((line, index): void => {
      // A `\`` count that is odd means a span opens and never closes, which
      // would make the scan below meaningless rather than merely wrong.
      const ticks = (line.match(/`/g) ?? []).length;
      if (ticks % 2 !== 0) offences.push(`${index + 1}: unbalanced backticks -- ${line.slice(0, 60)}`);
      let inCode = false;
      for (const char of line) {
        if (char === "`") inCode = !inCode;
        else if (char === "<" && !inCode) {
          offences.push(`${index + 1}: bare '<' -- ${line.slice(0, 80)}`);
          break;
        }
      }
    });
    // The generated-file banner is the one HTML comment the page intends.
    expect(offences.filter((offence): boolean => !offence.startsWith("1:"))).toEqual([]);
  });

  it("renders the placeholder table from the loader's own closed set", () => {
    // ONE SOURCE FOR BOTH: the set the loader refuses an unknown token against
    // is the set this page explains. A token documented nowhere cannot ship,
    // and a documented token the page omits cannot happen.
    const text = renderStackMatrix(pack);
    expect(text).toContain("## Placeholders");
    for (const placeholder of PLACEHOLDERS) {
      expect(text, placeholder.token).toContain(`| \`${placeholder.token}\` |`);
      expect(text, placeholder.token).toContain(escapeCell(placeholder.meaning));
    }
    // And it says the two things a reader acts on.
    expect(text).toContain("nen/contract.json");
    expect(text).toContain("host-conditional");
    expect(text).toMatch(/unsubstituted token is refused/i);
  });

  it("renders an override pack rather than the bundled one when given one", () => {
    // The renderer takes a pack, never reaches for one: that is what makes
    // `--profiles <dir>` a parameter the day a verb needs it.
    const single = {
      ids: ["only"],
      verbs: ["build"],
      commandVerbs: ["build"],
      origin: "/fake",
      profiles: {
        only: {
          id: "only",
          displayName: "Only",
          markers: [{ pattern: "only.json", contains: null, why: "the marker" }],
          crossChecks: [],
          answers: [],
          references: [],
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
    expect(text).toContain("Over the **1** stack × verb cells");
    expect(text).not.toContain("## `nextjs`");
  });
});
