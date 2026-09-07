// src/cli/prose.ts -- the one list-to-sentence renderer, for the refusals.
//
// PULLED OUT OF ../issue/command.ts, where it was written for the foreign-flag
// guard, when ../issue/subissue.ts's object-class refusal needed the same
// thing (zheref/nen#77). Its rationale there applies unchanged and is worth
// repeating rather than re-deriving: a `join(" and ")` renders four items as
// "a and b and c and d", which reads as a machine that has never seen a
// sentence -- and the whole value of these refusals is that a caller believes
// and acts on them. Two copies of a sentence-shaping rule are two copies that
// agree today and drift the first time one of them is tuned, which is exactly
// the argument ./comma.ts's own header makes about the parsing half.
export function conjoin(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}
