import type { Database } from "better-sqlite3";

export type WeeklyReport = {
  handled: number;
  automatic: number;
  feedbackPrecision: number | null;
  rerunHours: number;
  topFlaky: Array<{ testName: string; retries: number }>;
  shadowTriageHours: number | null;
  liveTriageHours: number | null;
  text: string;
};

export function buildWeeklyReport(db: Database, now = new Date()): WeeklyReport {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const handled = db
    .prepare("SELECT COUNT(*) AS n FROM decisions WHERE created_at >= ?")
    .get(since) as { n: number };
  const automatic = db
    .prepare(
      `SELECT COUNT(*) AS n FROM decisions
       WHERE created_at >= ? AND action IN ('retry', 'retry_and_alert', 'comment_regression')`,
    )
    .get(since) as { n: number };
  const feedback = db
    .prepare(
      `SELECT COUNT(*) AS n, SUM(CASE WHEN helpful = 1 THEN 1 ELSE 0 END) AS good
       FROM feedback WHERE created_at >= ?`,
    )
    .get(since) as { n: number; good: number | null };
  const rerun = db
    .prepare(
      `SELECT COALESCE(SUM(f.duration_seconds), 0) AS seconds
       FROM decisions d
       JOIN failures f ON f.id = d.failure_id
       WHERE d.created_at >= ? AND d.action IN ('retry', 'retry_and_alert')`,
    )
    .get(since) as { seconds: number };
  const topFlaky = db
    .prepare(
      `SELECT COALESCE(f.test_name, f.job_name) AS testName, COUNT(*) AS retries
       FROM decisions d
       JOIN failures f ON f.id = d.failure_id
       WHERE d.created_at >= ? AND d.category = 'flaky'
       GROUP BY testName
       ORDER BY retries DESC
       LIMIT 5`,
    )
    .all(since) as Array<{ testName: string; retries: number }>;

  const shadowTriageHours = triageHours(db, "shadow");
  const liveTriageHours = triageHours(db, "live");
  const precision = feedback.n === 0 ? null : (feedback.good ?? 0) / feedback.n;
  const report: WeeklyReport = {
    handled: handled.n,
    automatic: automatic.n,
    feedbackPrecision: precision,
    rerunHours: rerun.seconds / 3600,
    topFlaky,
    shadowTriageHours,
    liveTriageHours,
    text: "",
  };
  report.text = formatWeekly(report);
  return report;
}

function triageHours(db: Database, mode: string): number | null {
  const row = db
    .prepare(
      `SELECT AVG((julianday(h.acted_at) - julianday(f.failed_at)) * 24) AS hours
       FROM human_actions h
       JOIN failures f ON f.id = h.failure_id
       JOIN decisions d ON d.failure_id = f.id
       WHERE d.mode = ? AND f.failed_at IS NOT NULL`,
    )
    .get(mode) as { hours: number | null };
  return row.hours;
}

function formatWeekly(report: WeeklyReport): string {
  const precision = report.feedbackPrecision === null ? "n/a" : `${Math.round(report.feedbackPrecision * 100)}%`;
  const lines = [
    `Failures handled: ${report.handled}`,
    `Automatic actions: ${report.automatic}`,
    `Feedback precision: ${precision}`,
    `Re-run hours: ${report.rerunHours.toFixed(2)}`,
    "Top flaky tests:",
  ];
  if (report.topFlaky.length === 0) lines.push("- none");
  for (const test of report.topFlaky) lines.push(`- ${test.testName}: ${test.retries}`);
  lines.push(
    `Shadow triage hours: ${report.shadowTriageHours ?? "n/a"}`,
    `Live triage hours: ${report.liveTriageHours ?? "n/a"}`,
  );
  return lines.join("\n");
}
