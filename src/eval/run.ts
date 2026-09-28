import type { Database } from "better-sqlite3";
import type { Category, Classification } from "../jev/types.js";
import { alwaysRetryPredict, keywordPredict } from "./baseline.js";
import { accuracy, expectedCalibrationError, lowestPreciseThreshold, precision, type ScoredPrediction } from "./metrics.js";

export type Classifier = (db: Database, failureId: number) => Promise<Classification>;

export type EvaluateOptions = {
  limit: number;
};

export type CategoryScore = {
  accuracy: number;
  precision: number | null;
};

export type Thresholds = Record<Category, number | null>;

export type EvaluateReport = {
  scored: number;
  byCategory: Record<Category, CategoryScore>;
  calibrationError: number;
  totalCostUsd: number;
  averageDurationMs: number;
  baselines: {
    alwaysRetryAccuracy: number;
    keywordAccuracy: number;
  };
  jevBeatsKeyword: boolean;
  thresholds: Thresholds;
  replay: {
    autoRetried: number;
    autoRetryPrecision: number | null;
    regressionsFlagged: number;
  };
};

const CATEGORIES: Category[] = ["flaky", "infra", "regression"];

export async function evaluateFailures(
  db: Database,
  classify: Classifier,
  options: EvaluateOptions,
): Promise<EvaluateReport> {
  const examples = db
    .prepare(
      `SELECT id, true_label AS trueLabel, COALESCE(error_message, '') || char(10) || COALESCE(log_excerpt, '') AS text
       FROM failures
       WHERE true_label IN ('flaky', 'infra', 'regression')
       ORDER BY id
       LIMIT ?`,
    )
    .all(options.limit) as Array<{ id: number; trueLabel: Category; text: string }>;

  const started = new Date().toISOString();
  const predictions: ScoredPrediction[] = [];
  const keywordRows: ScoredPrediction[] = [];
  const retryRows: ScoredPrediction[] = [];

  for (const example of examples) {
    const result = await classify(db, example.id);
    predictions.push({
      trueLabel: example.trueLabel,
      predicted: result.category,
      confidence: result.confidence,
    });
    keywordRows.push({
      trueLabel: example.trueLabel,
      predicted: keywordPredict(example.text),
      confidence: 1,
    });
    retryRows.push({
      trueLabel: example.trueLabel,
      predicted: alwaysRetryPredict(),
      confidence: 1,
    });
  }

  const callStats = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS cost, COALESCE(AVG(duration_ms), 0) AS avgMs
       FROM jev_calls
       WHERE created_at >= ?`,
    )
    .get(started) as { cost: number; avgMs: number };

  const thresholds = {
    flaky: lowestPreciseThreshold(predictions, "flaky"),
    infra: lowestPreciseThreshold(predictions, "infra"),
    regression: lowestPreciseThreshold(predictions, "regression"),
  };

  const retried = predictions.filter(
    (row) => row.predicted === "flaky" && thresholds.flaky !== null && row.confidence >= thresholds.flaky,
  );
  const flagged = predictions.filter(
    (row) =>
      row.predicted === "regression" &&
      thresholds.regression !== null &&
      row.confidence >= thresholds.regression,
  );

  const jevAccuracy = accuracy(predictions);
  const keywordAccuracy = accuracy(keywordRows);

  return {
    scored: predictions.length,
    byCategory: Object.fromEntries(
      CATEGORIES.map((category) => [
        category,
        {
          accuracy: accuracy(predictions.filter((row) => row.trueLabel === category)),
          precision: precision(predictions, category),
        },
      ]),
    ) as Record<Category, CategoryScore>,
    calibrationError: expectedCalibrationError(predictions),
    totalCostUsd: callStats.cost,
    averageDurationMs: callStats.avgMs,
    baselines: {
      alwaysRetryAccuracy: accuracy(retryRows),
      keywordAccuracy,
    },
    jevBeatsKeyword: jevAccuracy > keywordAccuracy,
    thresholds,
    replay: {
      autoRetried: retried.length,
      autoRetryPrecision: retried.length === 0 ? null : precision(retried, "flaky"),
      regressionsFlagged: flagged.length,
    },
  };
}

export function formatReport(report: EvaluateReport): string {
  const lines = [
    `Scored ${report.scored} labeled failures`,
    `Calibration error ${pct(report.calibrationError)}`,
    `Cost $${report.totalCostUsd.toFixed(6)}, average ${Math.round(report.averageDurationMs)} ms`,
    `Always-retry accuracy ${pct(report.baselines.alwaysRetryAccuracy)}`,
    `Keyword accuracy ${pct(report.baselines.keywordAccuracy)}`,
    `Jev beats keyword baseline: ${report.jevBeatsKeyword ? "yes" : "no"}`,
  ];
  for (const category of CATEGORIES) {
    const score = report.byCategory[category];
    lines.push(
      `${category}: accuracy ${pct(score.accuracy)}, precision ${score.precision === null ? "n/a" : pct(score.precision)}, threshold ${report.thresholds[category] ?? "none"}`,
    );
  }
  const retryPrecision =
    report.replay.autoRetryPrecision === null ? "n/a" : pct(report.replay.autoRetryPrecision);
  lines.push(
    `Replay: auto-retried ${report.replay.autoRetried} at ${retryPrecision} precision and flagged ${report.replay.regressionsFlagged} regressions.`,
  );
  return lines.join("\n");
}

function pct(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}
