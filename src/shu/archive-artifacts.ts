// Artifact observations are separate from the build proof: timestamps are
// evidence of freshness, never proof that a package belongs to a source tree.
import * as fs from "node:fs";
import { createHash } from "node:crypto";

export interface ArchiveWindow {
  readonly started: number;
  readonly ended: number;
}

export interface ArchiveFacts {
  readonly status: "file" | "directory" | "symlink" | "other" | "missing" | "unreadable" | "not-inspected";
  readonly bytes: number | null;
  readonly modifiedAt: string | null;
  readonly runStartedAt: string | null;
  readonly runEndedAt: string | null;
  readonly producedThisRun: boolean | null;
  readonly freshness: "during-run" | "older-than-run" | "after-run" | "not-run" | "unknown";
  readonly digest: { readonly algorithm: "sha256"; readonly value: string } | null;
  readonly error: string | null;
}

interface FileSystem {
  readonly lstatSync: (path: string) => fs.Stats;
  readonly openSync: (path: string, flags: number) => number;
  readonly fstatSync: (fd: number) => fs.Stats;
  readonly readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  readonly closeSync: (fd: number) => void;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && right.isFile();
}

/** Read one regular file through a bounded buffer; never descend into bundles. */
export function archiveFacts(path: string, window: ArchiveWindow | null, io: FileSystem = fs): ArchiveFacts {
  const empty: ArchiveFacts = {
    status: "not-inspected", bytes: null, modifiedAt: null,
    runStartedAt: window === null ? null : new Date(window.started).toISOString(),
    runEndedAt: window === null ? null : new Date(window.ended).toISOString(),
    producedThisRun: null, freshness: window === null ? "not-run" : "unknown", digest: null, error: null,
  };
  // A dry/preflight report never opens an artifact or claims a run produced it.
  if (window === null) return empty;
  let observed = false;
  try {
    const entry = io.lstatSync(path);
    observed = true;
    const modifiedAt = entry.mtime.toISOString();
    if (!entry.isFile()) {
      return { ...empty, status: entry.isDirectory() ? "directory" : entry.isSymbolicLink() ? "symlink" : "other", modifiedAt };
    }
    const fd = io.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      const before = io.fstatSync(fd);
      if (!sameFile(entry, before)) throw new Error("artifact changed before it could be read");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      // Bound the read to the original size even if another process appends.
      while (position < before.size) {
        const read = io.readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (read === 0) throw new Error("artifact changed while being read (early end of file)");
        hash.update(buffer.subarray(0, read));
        position += read;
      }
      if (!sameFile(before, io.fstatSync(fd)) || !sameFile(before, io.lstatSync(path))) {
        throw new Error("artifact changed while being read");
      }
      // The run clock and published ISO timestamps have millisecond precision.
      // Filesystem sub-milliseconds must not make the same reported instant
      // look later than the run's end.
      const modifiedMs = Math.floor(before.mtimeMs);
      const freshness = modifiedMs < window.started ? "older-than-run"
        : modifiedMs > window.ended ? "after-run" : "during-run";
      return { ...empty, status: "file", bytes: before.size, modifiedAt,
        producedThisRun: freshness === "during-run", freshness,
        digest: { algorithm: "sha256", value: hash.digest("hex") } };
    } finally {
      io.closeSync(fd);
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Missing at first observation is distinct from disappearing mid-read.
    const missing = !observed && (code === "ENOENT" || code === "ENOTDIR");
    return { ...empty, status: missing ? "missing" : "unreadable", error: missing ? null : String(error) };
  }
}
