import { statSync } from "node:fs";

/**
 * Whether two paths name one file, lexically or by device + inode, following
 * links so an output path cannot overwrite the caller's input through an alias.
 * A missing path can only match lexically. Bigint preserves full Windows IDs:
 * distinct 64-bit file IDs can round to the same JavaScript number.
 */
export function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  const identity = (path: string): { dev: bigint; ino: bigint } | null => {
    try {
      const stats = statSync(path, { bigint: true });
      return { dev: stats.dev, ino: stats.ino };
    } catch {
      return null;
    }
  };
  const left = identity(a);
  const right = identity(b);
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}
