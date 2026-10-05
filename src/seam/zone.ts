// src/seam/zone.ts -- the IANA zone this host names for itself, read in the
// order the C library itself trusts (zheref/nen#258, Nobunaga N14).
//
// 1. `/etc/localtime` as a SYMLINK into a zoneinfo tree: its target IS the
//    name (`.../zoneinfo/America/Bogota`), relative or absolute -- the
//    authoritative answer on macOS and most Linux hosts.
// 2. `/etc/timezone`'s first line, where Debian and friends name the zone
//    beside a COPIED localtime that no symlink names.
// 3. Only then ICU's own guess (`Intl...resolvedOptions().timeZone`), which on
//    a copied localtime may be a match-by-content rather than a name anybody
//    configured. "Etc/Unknown" is ICU saying it could not tell, and is null.
//
// READ-ONLY, and every failure is "this source does not name it", never an
// error: the caller turns a null into a reason on stderr.

import { readFileSync, readlinkSync } from "node:fs";

export interface HostZonePaths {
  readonly localtime: string;
  readonly timezone: string;
}

export const HOST_ZONE_PATHS: HostZonePaths = { localtime: "/etc/localtime", timezone: "/etc/timezone" };

export function readHostZone(
  paths: HostZonePaths = HOST_ZONE_PATHS,
  icu: () => string = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string | null {
  try {
    const target = readlinkSync(paths.localtime).replace(/\\/g, "/");
    const at = target.lastIndexOf("/zoneinfo/");
    if (at >= 0) {
      const name = target.slice(at + "/zoneinfo/".length);
      if (name !== "") return name;
    }
  } catch {
    // Not a symlink, or absent.
  }
  try {
    const first = (readFileSync(paths.timezone, "utf8").split(/\r?\n/)[0] ?? "").trim();
    if (first !== "") return first;
  } catch {
    // Absent or unreadable.
  }
  const guess = icu();
  return guess === "" || guess === "Etc/Unknown" ? null : guess;
}
