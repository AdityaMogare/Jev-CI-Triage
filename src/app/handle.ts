import type { Database } from "better-sqlite3";
import type { Classification } from "../jev/types.js";
import { chooseAction, currentMode, isDryRun, type Thresholds } from "../policy/decide.js";
import { shadowComment } from "../actions/comment.js";
import { executeAction, type ActionDeps } from "../actions/execute.js";

export type IncomingFailure = {
  failureId: number;
  runId: number;
  repo: string;
  prNumber: number | null;
  testName: string | null;
};

export async function handleFailure(
  db: Database,
  failure: IncomingFailure,
  classification: Classification,
  thresholds: Thresholds,
  deps: ActionDeps,
): Promise<{ action: string; comment: string; dryRun: boolean }> {
  const prior = db
    .prepare(
      `SELECT COUNT(*) AS n FROM decisions
       WHERE failure_id = ? AND action IN ('retry', 'retry_and_alert')`,
    )
    .get(failure.failureId) as { n: number };
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recent = db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM decisions d
       JOIN failures f ON f.id = d.failure_id
       WHERE d.action IN ('retry', 'retry_and_alert')
         AND d.created_at >= ?
         AND f.test_name IS ?`,
    )
    .get(weekAgo, failure.testName) as { n: number };

  const action = chooseAction(
    {
      category: classification.category,
      confidence: classification.confidence,
      priorRetries: prior.n,
      recentRetriesForTest: recent.n,
    },
    thresholds,
  );
  const item = {
    testName: failure.testName ?? "job",
    category: classification.category,
    confidence: classification.confidence,
    culpritFile: classification.culpritFile,
  };
  const comment = shadowComment([item]);
  const executed = await executeAction(
    {
      failureId: failure.failureId,
      runId: failure.runId,
      repo: failure.repo,
      prNumber: failure.prNumber,
      item,
      action,
    },
    deps,
  );
  db.prepare(
    `INSERT INTO decisions (
      created_at, failure_id, category, confidence, culprit_file, action, mode, dry_run
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    failure.failureId,
    classification.category,
    classification.confidence,
    classification.culpritFile ?? null,
    action,
    currentMode(),
    executed.dryRun || isDryRun() ? 1 : 0,
  );
  return { action, comment, dryRun: executed.dryRun };
}
