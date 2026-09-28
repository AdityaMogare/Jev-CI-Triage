import type { Database } from "better-sqlite3";
import type { StoredFailure } from "../db/schema.js";
import { CATEGORIES, type Category, type FailureState } from "./types.js";

export const LOG_CHAR_CAP = 8_000;
export const CULPRIT_FILE_LIMIT = 30;

export function buildState(failure: StoredFailure, flakeRate: number): FailureState {
  return {
    errorMessage: failure.errorMessage,
    logExcerpt: failure.logExcerpt ? failure.logExcerpt.slice(0, LOG_CHAR_CAP) : null,
    testName: failure.testName,
    changedFiles: failure.changedFiles,
    flakeRate,
  };
}

export function flakeRateFor(db: Database, failure: StoredFailure): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n,
              SUM(CASE WHEN rerun_passed = 1 THEN 1 ELSE 0 END) AS passed
       FROM failures
       WHERE repo = ?
         AND (
           (? IS NOT NULL AND test_name = ?)
           OR (? IS NULL AND job_name = ?)
         )`,
    )
    .get(
      failure.repo,
      failure.testName,
      failure.testName,
      failure.testName,
      failure.jobName,
    ) as { n: number; passed: number | null };
  if (row.n === 0) return 0;
  return (row.passed ?? 0) / row.n;
}

export function culpritFile(
  category: Category,
  files: string[],
  choice: string | undefined,
): string | undefined {
  if (category !== "regression") return undefined;
  if (files.length < 1 || files.length > CULPRIT_FILE_LIMIT) return undefined;
  if (!choice || !files.includes(choice)) return undefined;
  return choice;
}

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}
