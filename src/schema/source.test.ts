import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BANKAI_REPO, LEGACY_REPO } from "./fixtures/paths.js";
import { SchemaError } from "./errors.js";
import {
  COLORS_FILE,
  CONTRACT_FILE,
  GATES_FILE,
  LABELS_FILE,
  readSchemaFile,
  readSchemaJson,
  resolveSchemaFile,
  schemaPath,
  shadowState,
} from "./source.js";
import { ABSENT_FILE_MARKER } from "./taxonomy.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "nen-source-"));
}

function write(root: string, relative: string, text: string): string {
  const path = schemaPath(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe("the five canonical constants", () => {
  it("all name the nen/ directory", () => {
    // The constants ARE the contract; a stray `schemas/` here would silently
    // make one file's canonical location the legacy one.
    for (const file of [LABELS_FILE, "nen/repos.json", COLORS_FILE, GATES_FILE, CONTRACT_FILE]) {
      expect(file.startsWith("nen/")).toBe(true);
    }
  });
});

describe("resolveSchemaFile", () => {
  it("prefers nen/ when only nen/ is there", () => {
    const root = scratch();
    const canonical = write(root, LABELS_FILE, "{}");
    const resolved = resolveSchemaFile(root, LABELS_FILE);
    expect(resolved.location).toBe("nen");
    expect(resolved.path).toBe(canonical);
    expect(resolved.relative).toBe("nen/labels.json");
    expect(resolved.legacy?.present).toBe(false);
  });

  it("falls back to schemas/ when only schemas/ is there", () => {
    const root = scratch();
    const legacy = write(root, "schemas/labels.json", "{}");
    const resolved = resolveSchemaFile(root, LABELS_FILE);
    expect(resolved.location).toBe("schemas");
    expect(resolved.path).toBe(legacy);
    expect(resolved.relative).toBe("schemas/labels.json");
    expect(resolved.canonical.present).toBe(false);
  });

  it("nen/ WINS when both are there -- the order is the whole point of the map", () => {
    // MUTATION GUARD. Swap the precedence in `resolveSchemaFile` and this is
    // the assertion that goes red: a repository that has migrated but not yet
    // deleted the old copy must be served the NEW file, or the migration
    // silently does nothing.
    const root = scratch();
    const canonical = write(root, LABELS_FILE, '{"which":"nen"}');
    write(root, "schemas/labels.json", '{"which":"schemas"}');
    const resolved = resolveSchemaFile(root, LABELS_FILE);
    expect(resolved.location).toBe("nen");
    expect(resolved.path).toBe(canonical);
    expect(readSchemaFile(root, LABELS_FILE).text).toBe('{"which":"nen"}');
  });

  it("answers the CANONICAL path when neither is there, because that is the one to create", () => {
    const root = scratch();
    const resolved = resolveSchemaFile(root, GATES_FILE);
    expect(resolved.location).toBe("nen");
    expect(resolved.path).toBe(schemaPath(root, GATES_FILE));
    expect(resolved.canonical.present).toBe(false);
    expect(resolved.legacy?.present).toBe(false);
  });

  it("resolves every one of the five files, including the contract", () => {
    const root = scratch();
    for (const file of [LABELS_FILE, "nen/repos.json", COLORS_FILE, GATES_FILE, CONTRACT_FILE]) {
      const resolved = resolveSchemaFile(root, file);
      expect(resolved.canonical.relative).toBe(file);
      expect(resolved.legacy).not.toBeNull();
      expect(resolved.legacy?.relative.startsWith("schemas/")).toBe(true);
    }
  });

  it("reads the un-migrated fixture repository entirely through the fallback", () => {
    // The `legacy-repo` fixture is the only thing in this tree keeping the old
    // layout alive; when the map goes in v0.4.0, this test goes with it.
    for (const file of [LABELS_FILE, "nen/repos.json", COLORS_FILE, GATES_FILE]) {
      const resolved = resolveSchemaFile(LEGACY_REPO, file);
      expect(resolved.location, file).toBe("schemas");
      expect(resolved.relative, file).toBe(resolved.legacy?.relative);
    }
  });

  it("reads the migrated fixture repositories entirely from nen/", () => {
    for (const file of [LABELS_FILE, "nen/repos.json", COLORS_FILE, GATES_FILE, CONTRACT_FILE]) {
      expect(resolveSchemaFile(BANKAI_REPO, file).location, file).toBe("nen");
    }
  });
});

describe("shadowState", () => {
  it("is 'none' when only one location carries the file", () => {
    const root = scratch();
    write(root, LABELS_FILE, "{}");
    expect(shadowState(resolveSchemaFile(root, LABELS_FILE))).toBe("none");
  });

  it("is 'identical' for a byte-identical leftover", () => {
    const root = scratch();
    write(root, LABELS_FILE, '{"a":1}');
    write(root, "schemas/labels.json", '{"a":1}');
    expect(shadowState(resolveSchemaFile(root, LABELS_FILE))).toBe("identical");
  });

  it("is 'different' for a leftover whose bytes drifted", () => {
    // MUTATION GUARD. Make the comparison always answer `identical` (or drop
    // it) and this goes red -- the whole reason the check exists is a
    // repository where somebody is still editing the file nen no longer reads.
    const root = scratch();
    write(root, LABELS_FILE, '{"a":1}');
    write(root, "schemas/labels.json", '{"a":2}');
    expect(shadowState(resolveSchemaFile(root, LABELS_FILE))).toBe("different");
  });

  it("is 'different' -- fail-closed -- when a copy cannot be read to compare", () => {
    const root = scratch();
    write(root, LABELS_FILE, "{}");
    mkdirSync(schemaPath(root, "schemas/labels.json"), { recursive: true });
    expect(shadowState(resolveSchemaFile(root, LABELS_FILE))).toBe("different");
  });

  it("treats whitespace as a difference, because bytes are what nen compared", () => {
    const root = scratch();
    write(root, COLORS_FILE, "categories:\n");
    write(root, "schemas/colors.yml", "categories:\n\n");
    expect(shadowState(resolveSchemaFile(root, COLORS_FILE))).toBe("different");
  });
});

describe("readSchemaFile", () => {
  it("reads a file that is there", () => {
    const root = scratch();
    write(root, LABELS_FILE, "{}");
    const result = readSchemaFile(root, LABELS_FILE);
    expect(result.text).toBe("{}");
    expect(result.path).toBe(schemaPath(root, LABELS_FILE));
    expect(result.location).toBe("nen");
    expect(result.legacy).toBe(false);
  });

  it("records that a read came from the LEGACY location", () => {
    const root = scratch();
    write(root, "schemas/labels.json", "{}");
    const result = readSchemaFile(root, LABELS_FILE);
    expect(result.text).toBe("{}");
    expect(result.path).toBe(schemaPath(root, "schemas/labels.json"));
    expect(result.location).toBe("schemas");
    expect(result.legacy).toBe(true);
  });

  it("phrases an ABSENT file with the marker checkTaxonomy branches on", () => {
    // LOAD-BEARING WORDING, not prose. `checkTaxonomy` distinguishes "the file
    // is not there" (tolerable for an optional schema) from "the file is there
    // and is wrong" (never tolerable) by looking for this marker. If the ENOENT
    // message is ever reworded without updating ABSENT_FILE_MARKER, a CORRUPT
    // optional schema would start reporting as merely absent and stop failing
    // the report -- silently, which is the whole failure class this repository's
    // loaders exist to avoid.
    //
    // TWO CANDIDATE PATHS, STILL ONE SENTENCE. The fallback added a second
    // place to look; it must not add a second ENOENT message, or the marker
    // stops being a reliable discriminator.
    const root = scratch();
    try {
      readSchemaFile(root, LABELS_FILE);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      const message = (error as SchemaError).message;
      expect(message).toContain(ABSENT_FILE_MARKER);
      expect(message.split(ABSENT_FILE_MARKER).length - 1).toBe(1);
      // BOTH locations are named, so an operator who has not migrated is not
      // told to create a file they already have.
      expect(message).toContain("'nen/labels.json'");
      expect(message).toContain("'schemas/labels.json'");
      expect(message).toContain("v0.4.0");
      // and it stays actionable
      expect(message).toMatch(/--repo/);
      expect(message).toMatch(/no built-in copy/);
      // The path the error CARRIES is the canonical one -- the file to add.
      expect((error as SchemaError).path).toBe(schemaPath(root, LABELS_FILE));
    }
  });

  it("does NOT carry the absent marker for a file that is present but unreadable", () => {
    // A directory where a file belongs: present, unreadable, and therefore a
    // different finding from absent.
    const root = scratch();
    mkdirSync(schemaPath(root, LABELS_FILE), { recursive: true });
    try {
      readSchemaFile(root, LABELS_FILE);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as SchemaError).message).not.toContain(ABSENT_FILE_MARKER);
    }
  });

  it("does NOT fall through to schemas/ when nen/ is present and broken", () => {
    // `nen/` winning means winning even when it loses: a directory (or an
    // unreadable file) where `nen/labels.json` belongs is a defect to report,
    // not a reason to quietly serve the legacy copy.
    const root = scratch();
    mkdirSync(schemaPath(root, LABELS_FILE), { recursive: true });
    write(root, "schemas/labels.json", "{}");
    try {
      readSchemaFile(root, LABELS_FILE);
      expect.unreachable();
    } catch (error) {
      expect((error as SchemaError).message).toMatch(/found a directory/);
      expect((error as SchemaError).path).toBe(schemaPath(root, LABELS_FILE));
    }
  });

  it("reports an unreadable file by its errno rather than as an absence", () => {
    // chmod is a no-op for root and on Windows; the assertion below only runs
    // where the mode actually takes.
    const root = scratch();
    const path = write(root, LABELS_FILE, "{}");
    chmodSync(path, 0o000);
    let message: string | null = null;
    try {
      readSchemaFile(root, LABELS_FILE);
    } catch (error) {
      message = (error as SchemaError).message;
    } finally {
      chmodSync(path, 0o644);
    }
    if (message !== null) {
      expect(message).toContain("could not be read");
      expect(message).not.toContain(ABSENT_FILE_MARKER);
    }
  });
});

describe("readSchemaJson", () => {
  it("reports malformed JSON as itself, not as an absent file", () => {
    const root = scratch();
    write(root, "nen/repos.json", "{ not json");
    try {
      readSchemaJson(root, "nen/repos.json");
      expect.unreachable();
    } catch (error) {
      expect((error as SchemaError).message).toMatch(/not valid JSON/);
      expect((error as SchemaError).message).not.toContain(ABSENT_FILE_MARKER);
    }
  });

  it("carries the read's location through to the caller", () => {
    const root = scratch();
    write(root, "schemas/repos.json", "{}");
    expect(readSchemaJson(root, "nen/repos.json").location).toBe("schemas");
  });
});
