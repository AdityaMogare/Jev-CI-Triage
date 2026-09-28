import { describe, expect, it } from "vitest";
import type { FailureRow } from "../../src/db/schema.js";
import { insertFailure, openDatabase, setTrueLabel } from "../../src/db/schema.js";
import { evaluateFailures } from "../../src/eval/run.js";
import { lowestPreciseThreshold, precision } from "../../src/eval/metrics.js";
import type { Classification } from "../../src/jev/types.js";

describe("evaluateFailures", () => {
  it("scores labels, baselines, and a flaky threshold without calling Jev", async () => {
    const db = openDatabase(":memory:");
    const flaky = save(db, 1, "flaky");
    const infra = save(db, 2, "infra");
    const regression = save(db, 3, "regression");
    save(db, 4, "unknown");

    const answers = new Map<number, Classification>([
      [flaky, answer("flaky", 0.99)],
      [infra, answer("infra", 0.8)],
      [regression, answer("regression", 0.7)],
    ]);

    const report = await evaluateFailures(
      db,
      async (_db, id) => answers.get(id) ?? answer("regression", 0.5),
      { limit: 10 },
    );

    expect(report.scored).toBe(3);
    expect(report.byCategory.flaky.precision).toBe(1);
    expect(report.thresholds.flaky).toBe(0);
    expect(report.replay.autoRetried).toBe(1);
    expect(report.replay.autoRetryPrecision).toBe(1);
    expect(report.replay.regressionsFlagged).toBe(1);
  });
});

describe("lowestPreciseThreshold", () => {
  it("picks the lowest confidence that keeps precision at 95%", () => {
    const rows = [
      { trueLabel: "flaky" as const, predicted: "flaky" as const, confidence: 0.99 },
      { trueLabel: "flaky" as const, predicted: "flaky" as const, confidence: 0.96 },
      { trueLabel: "infra" as const, predicted: "flaky" as const, confidence: 0.5 },
    ];
    expect(lowestPreciseThreshold(rows, "flaky")).toBe(0.51);
    expect(precision(rows.filter((row) => row.confidence >= 0.96), "flaky")).toBe(1);
  });
});

function answer(category: Classification["category"], confidence: number): Classification {
  return {
    category,
    confidence,
    probabilities: { flaky: 0.1, infra: 0.1, regression: 0.1, [category]: confidence },
  };
}

function save(db: ReturnType<typeof openDatabase>, jobId: number, label: "flaky" | "infra" | "regression" | "unknown"): number {
  insertFailure(db, stored(jobId, label === "infra" ? "timeout talking to the registry" : "FAIL saves"));
  const row = db.prepare("SELECT id FROM failures WHERE job_id = ?").get(jobId) as { id: number };
  setTrueLabel(db, row.id, label);
  return row.id;
}

function stored(jobId: number, errorMessage: string): FailureRow {
  return {
    repo: "vitest-dev/vitest",
    commitSha: `sha-${jobId}`,
    prNumber: null,
    branch: "main",
    workflowName: "CI",
    runId: jobId,
    runAttempt: 1,
    jobId,
    jobName: "unit",
    testName: jobId === 2 ? null : "saves",
    errorMessage,
    logExcerpt: errorMessage,
    changedFiles: ["src/a.ts"],
    runnerName: null,
    durationSeconds: 10,
    wasRerun: false,
    rerunPassed: null,
    failedAt: "2026-09-01T00:00:00Z",
  };
}
