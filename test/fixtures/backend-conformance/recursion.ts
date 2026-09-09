// Recursion: §4.2 rule 7 fixes the propagation to a fixed point. The backend's
// job is narrower — it must report the self-call and the cycle edges as
// resolved call targets, so the checker has a graph to reach a fixed point on.

/** @effects fs_read */
export function leafReadsFile(): number {
  return 1;
}

export function selfRecursive(n: number): number {
  if (n <= 0) return leafReadsFile();
  return selfRecursive(n - 1);
}

export function mutualA(n: number): number {
  if (n <= 0) return leafReadsFile();
  return mutualB(n - 1);
}

export function mutualB(n: number): number {
  if (n <= 0) return 0;
  return mutualA(n - 1);
}
