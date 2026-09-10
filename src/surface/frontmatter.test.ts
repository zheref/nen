import { describe, expect, it } from "vitest";
import { hasValue, inlineValue, renderFrontmatter, splitDocument } from "./frontmatter.js";

const DOC = [
  "---",
  "name: alpha",
  "description: one line",
  "  wrapped onto a second",
  "allowed-tools:",
  "  - Read",
  "  - Write",
  "---",
  "",
  "# alpha",
  "body",
  "",
].join("\n");

describe("splitDocument -- keys own their continuation lines", () => {
  it("splits the fenced block from the body", () => {
    const document = splitDocument(DOC);
    expect(document.hasFrontmatter).toBe(true);
    expect(document.entries.map((entry): string => entry.key)).toEqual(["name", "description", "allowed-tools"]);
    expect(document.body).toBe("\n# alpha\nbody\n");
  });

  it("gives a wrapped value its continuation lines, verbatim", () => {
    const description = splitDocument(DOC).entries[1];
    expect(description?.lines).toEqual(["description: one line", "  wrapped onto a second"]);
  });

  it("gives a block list its items", () => {
    const tools = splitDocument(DOC).entries[2];
    expect(tools?.lines).toEqual(["allowed-tools:", "  - Read", "  - Write"]);
  });

  it("treats a document with no opening fence as all body", () => {
    const document = splitDocument("# just markdown\n");
    expect(document.hasFrontmatter).toBe(false);
    expect(document.entries).toEqual([]);
    expect(document.body).toBe("# just markdown\n");
  });

  it("treats an UNCLOSED fence as all body -- a rule, not a truncated block", () => {
    // Guessing where the block ends would silently eat the document.
    const document = splitDocument("---\nname: x\n\nno closing fence\n");
    expect(document.hasFrontmatter).toBe(false);
    expect(document.body).toBe("---\nname: x\n\nno closing fence\n");
  });

  it("survives a CRLF checkout -- the fence, and the \\r stays on its line", () => {
    const document = splitDocument("---\r\nname: x\r\n---\r\n\r\nbody\r\n");
    expect(document.hasFrontmatter).toBe(true);
    expect(document.entries[0]?.lines).toEqual(["name: x\r"]);
    expect(document.body).toBe("\r\nbody\r\n");
  });

  it("parks lines that precede the first key under the empty key, which no surface can name", () => {
    const document = splitDocument("---\n# a yaml comment\nname: x\n---\nbody");
    expect(document.entries.map((entry): string => entry.key)).toEqual(["", "name"]);
    expect(renderFrontmatter(document.entries, new Set(["name"]))).toBe("---\nname: x\n---\n");
  });
});

describe("renderFrontmatter -- a line filter, not a YAML round trip", () => {
  it("keeps the named keys in the SOURCE's order, byte for byte", () => {
    const entries = splitDocument(DOC).entries;
    expect(renderFrontmatter(entries, new Set(["description", "name"]))).toBe(
      "---\nname: alpha\ndescription: one line\n  wrapped onto a second\n---\n",
    );
  });

  it("drops a key together with every line it owns", () => {
    const kept = renderFrontmatter(splitDocument(DOC).entries, new Set(["name"]));
    expect(kept).toBe("---\nname: alpha\n---\n");
    expect(kept).not.toContain("Read");
  });

  it("renders nothing at all when no key survives", () => {
    expect(renderFrontmatter(splitDocument(DOC).entries, new Set(["nothing"]))).toBe("");
  });
});

describe("inlineValue / hasValue", () => {
  it("reads the value on the key's own line", () => {
    expect(inlineValue({ key: "name", lines: ["name:  alpha  "] })).toBe("alpha");
    expect(inlineValue({ key: "x", lines: [] })).toBe("");
  });

  it("counts a key with only continuation lines as present", () => {
    const entries = splitDocument(DOC).entries;
    expect(hasValue(entries, "allowed-tools")).toBe(true);
    expect(hasValue(entries, "name")).toBe(true);
  });

  it("counts an EMPTY key and an absent one as absent alike", () => {
    const entries = splitDocument("---\nname:\ndescription:  \n---\nbody").entries;
    expect(hasValue(entries, "name")).toBe(false);
    expect(hasValue(entries, "description")).toBe(false);
    expect(hasValue(entries, "model")).toBe(false);
  });
});
