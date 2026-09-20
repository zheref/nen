// src/schema/decisions.ts -- the decision matrix, read from the TARGET
// repository's `nen/decisions.json` (zheref/nen#216).
//
// WHAT THIS FILE IS. A repository's canon says which conditions a running
// workflow resolves on its own and which ones stop for a human. Written only
// as prose, that rule lives in every skill that can stop, and drifts one skill
// at a time; written as data, it is ONE table every skill consults before it
// asks. Each row names a condition by a stable id, classifies it, and states
// the default action taken without asking -- or the options a stop presents.
//
// THREE CLASSES, AND THE ORDER THEY MAY MOVE IN. `autonomous` is resolved by
// `default` with no question; `ask-once-per-run` asks once, seeded by
// `preferred`; `human-gate` is a gate the canon reserves for a person, and it
// names which. A consumer's own file may make an `ask-once-per-run` row
// `autonomous`, and may add rows; it may NEVER reclassify a `human-gate` row --
// that is not a policy knob, it is the definition of the gate -- so a loader
// asked to merge two files refuses the widening by pointer.
//
// NOTHING IS DEFAULTED. An absent file is `present: false` and an empty table,
// which `nen schema check` reports as `absent (none declared)`: a repository
// that declares no matrix has every stop decided by prose, exactly as before.
// A present file that does not say what it must fails by pointer.
//
// `mergeDecisions` SHIPS AS A FUNCTION, NOT YET AS A VERB. No verb in this
// release loads two matrices; a consumer that layers its file over a canon's
// calls the function (or the verb a later release adds). The refusal it makes
// -- a human-gate row reclassified -- is therefore enforced where the merge
// happens, and this file says so rather than implying a check nobody runs.
//
// NO CONDITION NAME IS BUILT IN. The ids are the repository's vocabulary
// (`dirty-tree`, `cap-reached`); this binary validates their shape and never
// interprets one.

import { isRecord, optionalString, requireArray, requireRecord, requireString, SchemaError } from "./errors.js";
import { DECISIONS_FILE, readSchemaJson } from "./source.js";

export const DECISIONS_CONTRACT = "nen.decisions/v0.1";

export type DecisionClass = "autonomous" | "ask-once-per-run" | "human-gate";

const CLASSES: readonly DecisionClass[] = ["autonomous", "ask-once-per-run", "human-gate"];

const GATES = ["G1", "G1-M", "G2", "G3", "G4", "G5"] as const;
export type GateId = (typeof GATES)[number];

/** One option a stop may present -- executable, or it is not an option. */
export interface DecisionOption {
  readonly key: string;
  readonly label: string;
  /** The exact command line that performs it. Never empty. */
  readonly command: string;
  readonly consequence: string | null;
  readonly recommended: boolean;
}

export interface DecisionRow {
  /** Stable slug: `[a-z0-9-]+`. */
  readonly id: string;
  readonly class: DecisionClass;
  /** The action taken without asking, as a command line; null for a gate. */
  readonly default: string | null;
  /** The seed options a stop presents; the model may rank and extend them. */
  readonly preferred: readonly DecisionOption[];
  /** For `human-gate` rows: which gate. */
  readonly gate: GateId | null;
  /** Whether a stop on this row carries a proposed process-issue draft. */
  readonly proposeIssue: boolean;
  /** Per-surface overrides -- an open map, validated for type only. */
  readonly surfaces: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly why: string | null;
}

export interface DecisionMatrix {
  readonly path: string;
  readonly present: boolean;
  readonly contract: string;
  readonly rows: readonly DecisionRow[];
  row(id: string): DecisionRow | undefined;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;

function parseOption(path: string, pointer: string, value: unknown): DecisionOption {
  const raw = requireRecord(path, pointer, value);
  const key = requireString(path, `${pointer}.key`, raw["key"]);
  const label = requireString(path, `${pointer}.label`, raw["label"]);
  const command = requireString(path, `${pointer}.command`, raw["command"]);
  if (command.trim() === "") {
    throw new SchemaError(
      path,
      `${pointer}.command`,
      "is empty. An option with nothing to execute is a suggestion, not an option; state the exact command line that performs it",
    );
  }
  if (/\b(open|read|view|see)\b.*\breport\b/i.test(label)) {
    throw new SchemaError(
      path,
      `${pointer}.label`,
      `reads '${label}'. A report is rendered and linked with every stop; it is never one of the decisions a stop asks for. Drop this option -- the picker lists only actions that move the workflow`,
    );
  }
  const consequence = optionalString(path, `${pointer}.consequence`, raw["consequence"]);
  const recommendedRaw = raw["recommended"];
  if (recommendedRaw !== undefined && typeof recommendedRaw !== "boolean") {
    throw new SchemaError(path, `${pointer}.recommended`, "must be a boolean when present");
  }
  return { key, label, command, consequence, recommended: recommendedRaw === true };
}

function parseRow(path: string, index: number, value: unknown, seen: Set<string>): DecisionRow {
  const pointer = `rows[${index}]`;
  const raw = requireRecord(path, pointer, value);
  const id = requireString(path, `${pointer}.id`, raw["id"]);
  if (!ID.test(id)) {
    throw new SchemaError(path, `${pointer}.id`, `is '${id}'; an id is lowercase letters, digits and hyphens, starting with a letter or digit`);
  }
  if (seen.has(id)) throw new SchemaError(path, `${pointer}.id`, `'${id}' is declared twice; a condition has one row`);
  seen.add(id);

  const klass = requireString(path, `${pointer}.class`, raw["class"]);
  if (!(CLASSES as readonly string[]).includes(klass)) {
    throw new SchemaError(path, `${pointer}.class`, `is '${klass}'; expected one of ${CLASSES.join(", ")}`);
  }
  const cls = klass as DecisionClass;

  const defaultRaw = optionalString(path, `${pointer}.default`, raw["default"]);
  const preferred = raw["preferred"] === undefined ? [] : requireArray(path, `${pointer}.preferred`, raw["preferred"]).map(
    (item, i): DecisionOption => parseOption(path, `${pointer}.preferred[${i}]`, item),
  );
  const gateRaw = optionalString(path, `${pointer}.gate`, raw["gate"]);
  if (gateRaw !== null && !(GATES as readonly string[]).includes(gateRaw)) {
    throw new SchemaError(path, `${pointer}.gate`, `is '${gateRaw}'; expected one of ${GATES.join(", ")}`);
  }
  const gate = gateRaw as GateId | null;

  // THE CLASS DECIDES WHICH FIELDS ARE LOAD-BEARING, and a row that says one
  // thing in `class` and another in its fields is refused rather than read
  // charitably: an autonomous row with no default is a stop wearing the wrong
  // label, and a gate row with a default is a gate something could skip.
  if (cls === "autonomous" && (defaultRaw === null || defaultRaw.trim() === "")) {
    throw new SchemaError(path, `${pointer}.default`, `is required on an 'autonomous' row: state the command line taken without asking`);
  }
  if (cls === "human-gate" && gate === null) {
    throw new SchemaError(path, `${pointer}.gate`, `is required on a 'human-gate' row: name the gate (${GATES.join(", ")})`);
  }
  if (cls === "human-gate" && defaultRaw !== null) {
    throw new SchemaError(path, `${pointer}.default`, `is set on a 'human-gate' row. A gate has no default -- that is what makes it a gate`);
  }
  if (cls === "ask-once-per-run" && preferred.length === 0) {
    throw new SchemaError(path, `${pointer}.preferred`, `is empty on an 'ask-once-per-run' row: seed at least one option, or make the row autonomous`);
  }
  if (preferred.filter((option): boolean => option.recommended).length > 1) {
    throw new SchemaError(path, `${pointer}.preferred`, "marks more than one option recommended; a star goes on one decision");
  }

  const proposeRaw = raw["proposeIssue"];
  if (proposeRaw !== undefined && typeof proposeRaw !== "boolean") {
    throw new SchemaError(path, `${pointer}.proposeIssue`, "must be a boolean when present");
  }
  const surfacesRaw = raw["surfaces"];
  const surfaces: Record<string, Readonly<Record<string, unknown>>> = {};
  if (surfacesRaw !== undefined) {
    const record = requireRecord(path, `${pointer}.surfaces`, surfacesRaw);
    for (const [surface, override] of Object.entries(record)) {
      if (surface.startsWith("$")) continue;
      if (!isRecord(override)) {
        throw new SchemaError(path, `${pointer}.surfaces.${surface}`, "must be an object of per-surface overrides");
      }
      surfaces[surface] = override;
    }
  }
  return {
    id,
    class: cls,
    default: defaultRaw,
    preferred,
    gate,
    proposeIssue: proposeRaw === true,
    surfaces,
    why: optionalString(path, `${pointer}.why`, raw["why"]),
  };
}

export function parseDecisions(path: string, value: unknown): DecisionMatrix {
  const raw = requireRecord(path, "(root)", value);
  const contract = optionalString(path, "contract", raw["contract"]) ?? DECISIONS_CONTRACT;
  if (contract !== DECISIONS_CONTRACT) {
    throw new SchemaError(path, "contract", `is '${contract}'; this build reads '${DECISIONS_CONTRACT}'`);
  }
  const seen = new Set<string>();
  const rows = requireArray(path, "rows", raw["rows"]).map((row, index): DecisionRow => parseRow(path, index, row, seen));
  return build(path, true, contract, rows);
}

function build(path: string, present: boolean, contract: string, rows: readonly DecisionRow[]): DecisionMatrix {
  const byId = new Map(rows.map((row): [string, DecisionRow] => [row.id, row]));
  return { path, present, contract, rows, row: (id): DecisionRow | undefined => byId.get(id) };
}

/** Absent is an empty matrix, never an error -- see the header. */
export function loadDecisions(repoRoot: string): DecisionMatrix {
  let read;
  try {
    read = readSchemaJson(repoRoot, DECISIONS_FILE);
  } catch (error) {
    if (error instanceof SchemaError && error.message.includes("no such file.")) {
      return build(`${repoRoot}/${DECISIONS_FILE}`, false, DECISIONS_CONTRACT, []);
    }
    throw error;
  }
  return parseDecisions(read.path, read.value);
}

/**
 * A consumer's rows over a canon's. Additive and narrowing only: a row the
 * override reclassifies from `human-gate` is refused by pointer, and an
 * override that turns any row INTO a `human-gate` is fine (a consumer may be
 * stricter than its canon, never looser).
 */
export function mergeDecisions(canon: DecisionMatrix, override: DecisionMatrix): DecisionMatrix {
  const merged = new Map(canon.rows.map((row): [string, DecisionRow] => [row.id, row]));
  for (const row of override.rows) {
    const base = merged.get(row.id);
    if (base !== undefined && base.class === "human-gate" && row.class !== "human-gate") {
      throw new SchemaError(
        override.path,
        `rows[${row.id}].class`,
        `reclassifies '${row.id}' from 'human-gate' to '${row.class}'. A human gate is defined by canon and cannot be widened by a consumer; override its options or its surfaces, never its class`,
      );
    }
    merged.set(row.id, row);
  }
  return build(override.path, override.present || canon.present, DECISIONS_CONTRACT, [...merged.values()]);
}

export function describeDecisions(matrix: DecisionMatrix): string {
  if (!matrix.present) return "absent (none declared)";
  const count = (cls: DecisionClass): number => matrix.rows.filter((row): boolean => row.class === cls).length;
  return `${matrix.rows.length} rows: ${count("autonomous")} autonomous, ${count("ask-once-per-run")} ask-once-per-run, ${count("human-gate")} human-gate`;
}
