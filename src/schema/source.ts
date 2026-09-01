// src/schema/source.ts -- where a taxonomy file lives, and how it is read.
//
// ONE PLACE THE PATHS ARE WRITTEN. `schemas/labels.json`, `schemas/repos.json`
// and `schemas/colors.yml` are the target REPOSITORY's files, resolved from the
// root ../repo/root.ts computed for THIS invocation -- never bundled into the
// binary, never looked for beside the executable, never derived from
// `import.meta.url`.
//
// THE DISTINCTION THAT MATTERS: these are relative paths INSIDE the target repo,
// not names of things nen knows. `schemas/labels.json` is a location; the label
// NAMES inside it are the data. A future repo that keeps its taxonomy somewhere
// else changes one constant here (or, better, gets a `--schemas` flag) -- and
// that is a different kind of change from teaching the binary a label name.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SchemaError } from "./errors.js";

export const LABELS_FILE = "schemas/labels.json";
export const REPOS_FILE = "schemas/repos.json";
export const COLORS_FILE = "schemas/colors.yml";
export const GATES_FILE = "schemas/gates.json";

export function schemaPath(repoRoot: string, relative: string): string {
  return join(repoRoot, ...relative.split("/"));
}

// Read a schema file, converting the two failure modes a caller cares about into
// a SchemaError that names the path.
//
// ENOENT GETS ITS OWN SENTENCE, because it is the failure an operator will
// actually hit and the one a fallback would have swallowed: pointed at the wrong
// directory, or at a repository that does not carry this taxonomy. The message
// says which file is missing, where it looked, and that --repo is how you point
// it somewhere else -- everything needed to fix it without reading this source.
export function readSchemaFile(repoRoot: string, relative: string): { path: string; text: string } {
  const path = schemaPath(repoRoot, relative);
  try {
    return { path, text: readFileSync(path, "utf8") };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new SchemaError(
        path,
        null,
        `no such file. Nen reads this repository's taxonomy from '${relative}' in the TARGET repo and has no built-in copy to fall back on -- a binary that guessed the names would report a taxonomy this repository does not have. Point it at a checkout that carries the file with --repo <path>, or add the file.`,
      );
    }
    if (code === "EISDIR") {
      throw new SchemaError(path, null, "expected a file, found a directory");
    }
    throw new SchemaError(path, null, `could not be read (${code ?? String(error)})`);
  }
}

export function readSchemaJson(repoRoot: string, relative: string): { path: string; value: unknown } {
  const { path, text } = readSchemaFile(repoRoot, relative);
  try {
    return { path, value: JSON.parse(text) as unknown };
  } catch (error) {
    throw new SchemaError(
      path,
      null,
      `is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}
