// Shared stop-marker contracts and pure validation. No command, filesystem or host effects.
// schema check --ledger and stop show must judge exactly the same v0.1/v0.2 document.

/**
 * Where `--mark` writes, repo-relative and forward-slashed.
 *
 * `.nen/`, NOT `nen/`, and the one-character difference is ../schema/source.ts's
 * rule rather than a preference: `nen/` is committed configuration and `.nen/`
 * is generated output, so a `git add nen/` after a stop cannot stage this file.
 */
export const MARKER_FILE = ".nen/last-stop.json";

/** `nen.stop.mark/v0.1` -- the marker's own versioned contract string. */
export const STOP_MARK_CONTRACT = "nen.stop.mark/v0.1";
/**
 * `nen.stop.mark/v0.2` -- written INSTEAD of v0.1 whenever the stop carries
 * any of the new fields (zheref/nen#216): a title, a body, a report link, the
 * lettered options, a proposed process issue. A stop that carries none keeps
 * writing v0.1, so a hook reading the old shape sees nothing change until its
 * caller starts saying more.
 */
export const STOP_MARK_CONTRACT_V2 = "nen.stop.mark/v0.2";
/** The v0.1 marker's keys, in written order. */
const MARKER_KEYS_V1: readonly string[] = ["contract", "who", "gate", "notified", "at"];
/** What v0.2 adds, in written order; every one present, null when empty. */
const MARKER_KEYS_V2_EXTRA: readonly string[] = ["title", "body", "reportUrl", "options", "proposedIssue"];

export const GATE_NAMES: Readonly<Record<string, string>> = {
  G1: "epic approval",
  "G1-M": "release into build",
  G2: "merge",
  G3: "release go/no-go",
  G4: "policy/spec change",
  G5: "decision / human-only action",
};

export interface StopOption {
  readonly key: string;
  readonly label: string;
  readonly command: string;
  readonly consequence: string | null;
  readonly recommended: boolean;
}

export interface ProposedIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

const REPORT_AS_OPTION = /\b(open|read|view|see)\b.*\breport\b/i;

/** The options file: a JSON array, every entry executable, one star. */
export function parseOptions(document: unknown, display: string): StopOption[] {
  if (!Array.isArray(document) || document.length === 0) {
    throw new Error(`--options ${display}: expected a non-empty JSON array of { key, label, command, consequence?, recommended? }.`);
  }
  const options = document.map((raw, index): StopOption => {
    const at = `--options ${display}[${index}]`;
    if (typeof raw !== "object" || raw === null) throw new Error(`${at}: not an object.`);
    const entry = raw as Record<string, unknown>;
    const key = entry["key"];
    const label = entry["label"];
    const command = entry["command"];
    if (typeof key !== "string" || key.trim() === "") throw new Error(`${at}.key: a non-empty string is required.`);
    if (typeof label !== "string" || label.trim() === "") throw new Error(`${at}.label: a non-empty string is required.`);
    if (typeof command !== "string" || command.trim() === "") {
      throw new Error(`${at}.command: a non-empty command line is required. An option nothing executes is a suggestion, not an option.`);
    }
    if (REPORT_AS_OPTION.test(label)) {
      throw new Error(`${at}.label reads '${label}'. The report is linked with every stop (--report-url) and is never one of the decisions; drop this option.`);
    }
    const consequence = entry["consequence"];
    if (consequence !== undefined && consequence !== null && typeof consequence !== "string") throw new Error(`${at}.consequence: a string when present.`);
    const recommended = entry["recommended"];
    if (recommended !== undefined && typeof recommended !== "boolean") throw new Error(`${at}.recommended: a boolean when present.`);
    return { key, label, command, consequence: (consequence as string | undefined) ?? null, recommended: recommended === true };
  });
  const starred = options.filter((option): boolean => option.recommended).length;
  if (starred !== 1) {
    throw new Error(`--options ${display}: exactly one option must be 'recommended' (found ${starred}). A stop with no star, or two, has not made a recommendation.`);
  }
  const keys = new Set(options.map((option): string => option.key));
  if (keys.size !== options.length) throw new Error(`--options ${display}: option keys must be distinct.`);
  return options;
}

export function parseProposedIssue(document: unknown, display: string): ProposedIssue {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error(`--propose-issue ${display}: expected a JSON object { title, body, labels? }.`);
  }
  const entry = document as Record<string, unknown>;
  const title = entry["title"];
  const body = entry["body"];
  if (typeof title !== "string" || title.trim() === "") throw new Error(`--propose-issue ${display}.title: a non-empty string is required.`);
  if (typeof body !== "string" || body.trim() === "") throw new Error(`--propose-issue ${display}.body: a non-empty string is required -- a draft with no body is not a draft.`);
  const labels = entry["labels"] ?? [];
  if (!Array.isArray(labels) || labels.some((label): boolean => typeof label !== "string")) {
    throw new Error(`--propose-issue ${display}.labels: an array of strings when present.`);
  }
  return { title, body, labels: labels as string[] };
}

/**
 * The marker read back and validated -- v0.1 or v0.2 -- or a one-line reason
 * it is not a marker. Shared by stop show and schema check --ledger.
 */
export function parseMarker(document: unknown): { ok: true; marker: Record<string, unknown> } | { ok: false; reason: string } {
  if (typeof document !== "object" || document === null || Array.isArray(document)) return { ok: false, reason: "not a JSON object" };
  const m = document as Record<string, unknown>;
  const contract = m["contract"];
  if (contract !== STOP_MARK_CONTRACT && contract !== STOP_MARK_CONTRACT_V2) {
    return { ok: false, reason: `contract is ${JSON.stringify(contract)}; expected '${STOP_MARK_CONTRACT}' or '${STOP_MARK_CONTRACT_V2}'` };
  }
  // THE KEY SET IS THE CONTRACT. v0.1 is exactly its five keys and v0.2 is
  // exactly those plus its five, every one PRESENT (null where the stop
  // carried nothing) -- an absent key is a defect, not a null, and a key
  // neither contract names is a marker written by something else (Copilot
  // review on zheref/nen#217).
  const expected = contract === STOP_MARK_CONTRACT_V2 ? [...MARKER_KEYS_V1, ...MARKER_KEYS_V2_EXTRA] : MARKER_KEYS_V1;
  const str = (key: string): string | null => {
    if (!Object.hasOwn(m, key)) throw new Error(`${key} is missing`);
    const v = m[key];
    if (v !== null && typeof v !== "string") throw new Error(`${key} must be a string or null`);
    return v as string | null;
  };
  try {
    for (const key of expected) if (!Object.hasOwn(m, key)) throw new Error(`${key} is missing`);
    const extra = Object.keys(m).filter((key): boolean => !expected.includes(key));
    if (extra.length > 0) throw new Error(`unexpected key(s) ${extra.join(", ")} for ${String(contract)}`);
    str("who");
    const gate = str("gate");
    if (gate !== null && !Object.hasOwn(GATE_NAMES, gate)) throw new Error(`gate '${gate}' is not one of ${Object.keys(GATE_NAMES).join(", ")}`);
    if (typeof m["notified"] !== "boolean") throw new Error("notified must be a boolean");
    const at = str("at");
    if (at === null || Number.isNaN(Date.parse(at))) throw new Error("at must be an ISO-8601 instant");
    if (contract === STOP_MARK_CONTRACT_V2) {
      str("title");
      str("body");
      str("reportUrl");
      if (m["options"] !== null && m["options"] !== undefined) parseOptions(m["options"], "marker");
      if (m["proposedIssue"] !== null && m["proposedIssue"] !== undefined) parseProposedIssue(m["proposedIssue"], "marker");
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true, marker: m };
}

