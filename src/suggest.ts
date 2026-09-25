function editDistance(a: string, b: string): number {
  const width = b.length + 1;
  let previous = Array.from({ length: width }, (_, i) => i);

  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(width).fill(0);
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    previous = current;
  }

  return previous[b.length]!;
}

export function didYouMean(input: string, candidates: Iterable<string>): string {
  let best: string | undefined;
  let bestDistance = Infinity;

  for (const candidate of candidates) {
    const distance = editDistance(input, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }

  if (best === undefined) return "";

  const limit = Math.max(1, Math.floor(Math.max(input.length, best.length) / 3));
  return bestDistance <= limit ? `\n  did you mean "${best}"?` : "";
}
