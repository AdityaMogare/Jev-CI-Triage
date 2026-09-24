import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS failures (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  pr_number INTEGER,
  branch TEXT,
  workflow_name TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  job_id INTEGER NOT NULL,
  job_name TEXT NOT NULL,
  test_name TEXT,
  error_message TEXT,
  log_excerpt TEXT,
  changed_files TEXT NOT NULL,
  runner_name TEXT,
  duration_seconds INTEGER,
  was_rerun INTEGER NOT NULL,
  rerun_passed INTEGER,
  failed_at TEXT,
  true_label TEXT,
  UNIQUE (repo, job_id)
);
`;

export type FailureRow = {
  repo: string;
  commitSha: string;
  prNumber: number | null;
  branch: string | null;
  workflowName: string;
  runId: number;
  runAttempt: number;
  jobId: number;
  jobName: string;
  testName: string | null;
  errorMessage: string | null;
  logExcerpt: string | null;
  changedFiles: string[];
  runnerName: string | null;
  durationSeconds: number | null;
  wasRerun: boolean;
  rerunPassed: boolean | null;
  failedAt: string | null;
};

export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  const columns = db.prepare("PRAGMA table_info(failures)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "true_label")) {
    db.exec("ALTER TABLE failures ADD COLUMN true_label TEXT");
  }
  return db;
}

const INSERT_SQL = `
INSERT OR IGNORE INTO failures (
  repo, commit_sha, pr_number, branch, workflow_name, run_id, run_attempt,
  job_id, job_name, test_name, error_message, log_excerpt, changed_files,
  runner_name, duration_seconds, was_rerun, rerun_passed, failed_at
) VALUES (
  @repo, @commitSha, @prNumber, @branch, @workflowName, @runId, @runAttempt,
  @jobId, @jobName, @testName, @errorMessage, @logExcerpt, @changedFiles,
  @runnerName, @durationSeconds, @wasRerun, @rerunPassed, @failedAt
)
`;

export function insertFailure(db: Database.Database, row: FailureRow): boolean {
  const result = db.prepare(INSERT_SQL).run({
    ...row,
    changedFiles: JSON.stringify(row.changedFiles),
    wasRerun: row.wasRerun ? 1 : 0,
    rerunPassed: row.rerunPassed === null ? null : row.rerunPassed ? 1 : 0,
  });
  return result.changes === 1;
}

export function hasFailure(db: Database.Database, repo: string, jobId: number): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM failures WHERE repo = ? AND job_id = ?")
    .get(repo, jobId) as { ok: number } | undefined;
  return row !== undefined;
}

export function countFailures(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM failures").get() as { n: number };
  return row.n;
}

export type TrueLabel = "flaky" | "infra" | "regression" | "unknown";

export type LabelInput = {
  id: number;
  repo: string;
  commitSha: string;
  jobName: string;
  testName: string | null;
  errorMessage: string | null;
  logExcerpt: string | null;
  rerunPassed: boolean | null;
  failedAt: string | null;
};

export function listLabelInputs(db: Database.Database): LabelInput[] {
  const rows = db
    .prepare(
      `SELECT id, repo, commit_sha, job_name, test_name, error_message, log_excerpt,
              rerun_passed, failed_at
       FROM failures
       ORDER BY id`,
    )
    .all() as Array<{
      id: number;
      repo: string;
      commit_sha: string;
      job_name: string;
      test_name: string | null;
      error_message: string | null;
      log_excerpt: string | null;
      rerun_passed: number | null;
      failed_at: string | null;
    }>;
  return rows.map((row) => ({
    id: row.id,
    repo: row.repo,
    commitSha: row.commit_sha,
    jobName: row.job_name,
    testName: row.test_name,
    errorMessage: row.error_message,
    logExcerpt: row.log_excerpt,
    rerunPassed: row.rerun_passed === null ? null : row.rerun_passed === 1,
    failedAt: row.failed_at,
  }));
}

export function setTrueLabel(db: Database.Database, id: number, label: TrueLabel): void {
  db.prepare("UPDATE failures SET true_label = ? WHERE id = ?").run(label, id);
}
