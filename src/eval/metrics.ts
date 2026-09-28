import type { Category } from "../jev/types.js";

export type ScoredPrediction = {
  trueLabel: Category;
  predicted: Category;
  confidence: number;
};

export function accuracy(rows: ScoredPrediction[]): number {
  if (rows.length === 0) return 0;
  return rows.filter((row) => row.predicted === row.trueLabel).length / rows.length;
}

export function precision(rows: ScoredPrediction[], category: Category): number | null {
  const selected = rows.filter((row) => row.predicted === category);
  if (selected.length === 0) return null;
  return selected.filter((row) => row.trueLabel === category).length / selected.length;
}

export function expectedCalibrationError(rows: ScoredPrediction[], bins = 10): number {
  if (rows.length === 0) return 0;
  let error = 0;
  for (let bin = 0; bin < bins; bin++) {
    const low = bin / bins;
    const high = (bin + 1) / bins;
    const group = rows.filter((row) =>
      bin === bins - 1
        ? row.confidence >= low && row.confidence <= high
        : row.confidence >= low && row.confidence < high,
    );
    if (group.length === 0) continue;
    const meanConfidence = group.reduce((sum, row) => sum + row.confidence, 0) / group.length;
    const binAccuracy = accuracy(group);
    error += (group.length / rows.length) * Math.abs(binAccuracy - meanConfidence);
  }
  return error;
}

export function lowestPreciseThreshold(
  rows: ScoredPrediction[],
  category: Category,
  minPrecision = 0.95,
): number | null {
  let best: number | null = null;
  for (let step = 100; step >= 0; step--) {
    const threshold = step / 100;
    const selected = rows.filter((row) => row.predicted === category && row.confidence >= threshold);
    if (selected.length === 0) continue;
    const hit = selected.filter((row) => row.trueLabel === category).length / selected.length;
    if (hit >= minPrecision) best = threshold;
  }
  return best;
}
