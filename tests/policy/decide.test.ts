import { afterEach, describe, expect, it } from "vitest";
import type { FailureRow } from "../../src/db/schema.js";
import { insertFailure, openDatabase } from "../../src/db/schema.js";
import { executeAction } from "../../src/actions/execute.js";
import { shadowComment } from "../../src/actions/comment.js";
import { handleFailure } from "../../src/app/handle.js";
import { chooseAction, isDryRun } from "../../src/policy/decide.js";
import { buildWeeklyReport } from "../../src/report/weekly.js";

const thresholds = { flaky: 0.9, infra: 0.9, regression: 0.8 };

describe("chooseAction", () => {
  it("retries a confident flake once and then treats a second failure as a regression", () => {
    expect(chooseAction({ category: "flaky", confidence: 0.95, priorRetries: 0, recentRetriesForTest: 0 }, thresholds)).toBe("retry");
    expect(chooseAction({ category: "flaky", confidence: 0.95, priorRetries: 1, recentRetriesForTest: 1 }, thresholds)).toBe("comment_regression");
  });

  it("asks a human below the cutoff and quarantines a test retried five times", () => {
    expect(chooseAction({ category: "flaky", confidence: 0.5, priorRetries: 0, recentRetriesForTest: 0 }, thresholds)).toBe("ask_human");
    expect(chooseAction({ category: "infra", confidence: 0.99, priorRetries: 0, recentRetriesForTest: 5 }, thresholds)).toBe("quarantine");
  });

  it("stays in dry-run unless live mode turns it off", () => {
    delete process.env.TRIAGE_MODE;
    delete process.env.TRIAGE_DRY_RUN;
    delete process.env.TRIAGE_KILL_SWITCH;
    expect(isDryRun()).toBe(true);
    process.env.TRIAGE_MODE = "live";
    process.env.TRIAGE_DRY_RUN = "0";
    expect(isDryRun()).toBe(false);
    process.env.TRIAGE_KILL_SWITCH = "1";
    expect(isDryRun()).toBe(true);
  });
});

describe("shadow handling", () => {
  afterEach(() => {
    delete process.env.TRIAGE_MODE;
    delete process.env.TRIAGE_DRY_RUN;
    delete process.env.TRIAGE_KILL_SWITCH;
  });

  it("records the decision and does not call GitHub", async () => {
    const db = openDatabase(":memory:");
    const id = save(db);
    const calls: string[] = [];
    const result = await handleFailure(
      db,
      { failureId: id, runId: 9, repo: "vitest-dev/vitest", prNumber: 3, testName: "saves" },
      { category: "regression", confidence: 0.81, probabilities: { flaky: 0.1, infra: 0.1, regression: 0.8 }, culpritFile: "src/a.ts" },
      thresholds,
      {
        rerun: async () => {
          calls.push("rerun");
        },
        comment: async () => {
          calls.push("comment");
        },
        alert: async () => {
          calls.push("alert");
        },
      },
    );
    expect(result.dryRun).toBe(true);
    expect(result.action).toBe("comment_regression");
    expect(result.comment).toContain("shadow mode");
    expect(result.comment).toContain("src/a.ts");
    expect(calls).toEqual([]);
    const saved = db.prepare("SELECT action, dry_run, mode FROM decisions").get() as {
      action: string;
      dry_run: number;
      mode: string;
    };
    expect(saved).toEqual({ action: "comment_regression", dry_run: 1, mode: "shadow" });
  });

  it("prints a shadow comment for a flake", () => {
    const text = shadowComment([{ testName: "saves", category: "flaky", confidence: 0.93 }]);
    expect(text).toContain("looks **flaky** (93%)");
  });
});

describe("live actions", () => {
  afterEach(() => {
    delete process.env.TRIAGE_MODE;
    delete process.env.TRIAGE_DRY_RUN;
    delete process.env.TRIAGE_KILL_SWITCH;
  });

  it("re-runs once when live mode and dry-run are both turned off", async () => {
    process.env.TRIAGE_MODE = "live";
    process.env.TRIAGE_DRY_RUN = "0";
    const calls: string[] = [];
    const result = await executeAction(
      {
        failureId: 1,
        runId: 9,
        repo: "vitest-dev/vitest",
        prNumber: 3,
        action: "retry",
        item: { testName: "saves", category: "flaky", confidence: 0.95 },
      },
      {
        rerun: async () => {
          calls.push("rerun");
        },
        comment: async () => {
          calls.push("comment");
        },
        alert: async () => {
          calls.push("alert");
        },
      },
    );
    expect(result.dryRun).toBe(false);
    expect(calls).toEqual(["rerun", "comment"]);
  });
});

describe("weekly report", () => {
  it("summarizes decisions from the last week", () => {
    const db = openDatabase(":memory:");
    const id = save(db);
    db.prepare(
      `INSERT INTO decisions (created_at, failure_id, category, confidence, culprit_file, action, mode, dry_run)
       VALUES (?, ?, 'flaky', 0.95, NULL, 'retry', 'shadow', 1)`,
    ).run(new Date().toISOString(), id);
    db.prepare("INSERT INTO feedback (created_at, decision_id, helpful) VALUES (?, 1, 1)").run(new Date().toISOString());
    const report = buildWeeklyReport(db);
    expect(report.handled).toBe(1);
    expect(report.automatic).toBe(1);
    expect(report.feedbackPrecision).toBe(1);
    expect(report.topFlaky[0]?.testName).toBe("saves");
    expect(report.text).toContain("Failures handled: 1");
  });
});

function save(db: ReturnType<typeof openDatabase>): number {
  const row: FailureRow = {
    repo: "vitest-dev/vitest",
    commitSha: "abc",
    prNumber: 3,
    branch: "main",
    workflowName: "CI",
    runId: 9,
    runAttempt: 1,
    jobId: 1,
    jobName: "unit",
    testName: "saves",
    errorMessage: "FAIL saves",
    logExcerpt: "FAIL saves",
    changedFiles: ["src/a.ts"],
    runnerName: null,
    durationSeconds: 3600,
    wasRerun: false,
    rerunPassed: null,
    failedAt: "2026-09-01T00:00:00Z",
  };
  insertFailure(db, row);
  return (db.prepare("SELECT id FROM failures").get() as { id: number }).id;
}
