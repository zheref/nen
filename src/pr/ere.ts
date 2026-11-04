// Bounded POSIX ERE subset, with C-locale byte semantics and explicit refusals.
import { compileReleaseLinePattern, type ReleaseLineMatcher } from "../schema/releasepattern.js";
const CLASSES: Readonly<Record<string, string>> = {
  alnum: "A-Za-z0-9", alpha: "A-Za-z", blank: "\\x09\\x20", cntrl: "\\x00-\\x1f\\x7f", digit: "0-9", graph: "\\x21-\\x7e", lower: "a-z", print: "\\x20-\\x7e", punct: "\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e", space: "\\x09-\\x0d\\x20", upper: "A-Z", xdigit: "A-Fa-f0-9",
};
export function compileEre(source: string): ReleaseLineMatcher {
  // POSIX C-locale ERE works on bytes, including ranges and repetition.
  const input = Buffer.from(source, "utf8").toString("latin1");
  let translated = ""; let inClass = false; let classStart = false;
  for (let at = 0; at < input.length; at += 1) {
    const char = input[at] as string;
    if (char === "\\") {
      const next = input[++at];
      if (next === undefined || !".^$[]()|*+?{}\\-".includes(next)) throw new Error("unsupported ERE escape (backreferences and GNU/JavaScript escape extensions are not supported)");
      translated += `\\${next}`; classStart = false; continue;
    }
    if (inClass) {
      if (char === "[" && input[at + 1] === ":") {
        const end = input.indexOf(":]", at + 2); const name = end < 0 ? "" : input.slice(at + 2, end);
        if (!Object.hasOwn(CLASSES, name)) throw new Error(`unsupported POSIX character class '${name}'`);
        translated += CLASSES[name]; at = end + 1; classStart = false; continue;
      }
      if (char === "[" && [".", "="].includes(input[at + 1] ?? "")) throw new Error("ERE collating/equivalence elements are not supported");
      if (char === "^" && classStart && input[at - 1] === "[") { translated += char; continue; }
      if (char === "]" && classStart) { translated += "\\]"; classStart = false; continue; }
      if (char === "]") inClass = false;
      translated += char === "[" ? "\\[" : char; classStart = false; continue;
    }
    if (char === "[") { inClass = true; classStart = true; translated += char; continue; }
    if (char === "(" && input[at + 1] === "?") throw new Error("ERE does not support JavaScript group extensions");
    translated += char === "." ? "[^\\x0a]" : char;
  }
  if (inClass) throw new Error("unfinished ERE bracket expression");
  const branches: string[] = []; let depth = 0; let bracket = false; let start = 0;
  for (let at = 0; at < translated.length; at += 1) {
    const char = translated[at];
    if (char === "\\") { at++; continue; }
    if (char === "[") bracket = true; else if (char === "]") bracket = false;
    if (bracket) continue;
    if (char === "(") depth++; else if (char === ")") depth--;
    if (char === "|" && depth === 0) { branches.push(translated.slice(start, at)); start = at + 1; }
  }
  branches.push(translated.slice(start));
  const any = "[\\x00-\\u00ff]*";
  const wrapped = branches.map((branch) => {
    const begins = branch.startsWith("^");
    let slashes = 0; for (let at = branch.length - 2; at >= 0 && branch[at] === "\\"; at--) slashes++;
    const ends = branch.endsWith("$") && slashes % 2 === 0;
    const body = branch.slice(begins ? 1 : 0, ends ? -1 : undefined);
    return `${begins ? "" : any}(${body})${ends ? "" : any}`;
  });
  // Anchors inside groups are explicitly refused by the shared compiler.
  const compiled = compileReleaseLinePattern(wrapped.join("|"));
  return { stateCount: compiled.stateCount, match: (subject, maxWork) => compiled.match(Buffer.from(subject, "utf8").toString("latin1"), maxWork) };
}
