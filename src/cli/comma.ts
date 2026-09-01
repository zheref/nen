// src/cli/comma.ts -- `--flag a,b,c` read as a trimmed, non-empty list.
//
// PULLED OUT OF ../issue/command.ts (where every other family that took a
// comma-separated flag had quietly copied it) so that ../idea/command.ts,
// ../pr/command.ts, ../scaffold/command.ts and ../stage/command.ts share ONE
// definition instead of five that happen to agree today and can drift
// tomorrow.
export function commaList(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((item): string => item.trim())
    .filter((item): boolean => item !== "");
}
