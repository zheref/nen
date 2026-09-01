import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchemaError } from "./errors.js";
import { readSchemaFile, readSchemaJson, schemaPath } from "./source.js";
import { ABSENT_FILE_MARKER } from "./taxonomy.js";

describe("readSchemaFile", () => {
  it("reads a file that is there", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-source-"));
    mkdirSync(join(root, "schemas"));
    writeFileSync(join(root, "schemas", "labels.json"), "{}");
    const result = readSchemaFile(root, "schemas/labels.json");
    expect(result.text).toBe("{}");
    expect(result.path).toBe(schemaPath(root, "schemas/labels.json"));
  });

  it("phrases an ABSENT file with the marker checkTaxonomy branches on", () => {
    // LOAD-BEARING WORDING, not prose. `checkTaxonomy` distinguishes "the file
    // is not there" (tolerable for an optional schema) from "the file is there
    // and is wrong" (never tolerable) by looking for this marker. If the ENOENT
    // message is ever reworded without updating ABSENT_FILE_MARKER, a CORRUPT
    // optional schema would start reporting as merely absent and stop failing
    // the report -- silently, which is the whole failure class this repository's
    // loaders exist to avoid.
    const root = mkdtempSync(join(tmpdir(), "nen-source-"));
    try {
      readSchemaFile(root, "schemas/labels.json");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as SchemaError).message).toContain(ABSENT_FILE_MARKER);
      // and it stays actionable
      expect((error as SchemaError).message).toMatch(/--repo/);
      expect((error as SchemaError).message).toMatch(/no built-in copy/);
    }
  });

  it("does NOT carry the absent marker for a file that is present but unreadable", () => {
    // A directory where a file belongs: present, unreadable, and therefore a
    // different finding from absent.
    const root = mkdtempSync(join(tmpdir(), "nen-source-"));
    mkdirSync(join(root, "schemas", "labels.json"), { recursive: true });
    try {
      readSchemaFile(root, "schemas/labels.json");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as SchemaError).message).not.toContain(ABSENT_FILE_MARKER);
    }
  });
});

describe("readSchemaJson", () => {
  it("reports malformed JSON as itself, not as an absent file", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-source-"));
    mkdirSync(join(root, "schemas"));
    writeFileSync(join(root, "schemas", "repos.json"), "{ not json");
    try {
      readSchemaJson(root, "schemas/repos.json");
      expect.unreachable();
    } catch (error) {
      expect((error as SchemaError).message).toMatch(/not valid JSON/);
      expect((error as SchemaError).message).not.toContain(ABSENT_FILE_MARKER);
    }
  });
});
