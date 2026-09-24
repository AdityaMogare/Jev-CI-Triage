import { formatReviewRow, type ReviewRow } from "../src/label/review.js";
import { openDatabase } from "../src/db/schema.js";

const dbPath = process.argv[2] ?? "data/failures.db";
const db = openDatabase(dbPath);
const rows = db
  .prepare(
    `SELECT id, true_label, job_name, test_name, error_message, rerun_passed
     FROM failures
     WHERE true_label IS NOT NULL AND true_label != 'unknown'
     ORDER BY RANDOM()
     LIMIT 50`,
  )
  .all() as Array<{
    id: number;
    true_label: string;
    job_name: string;
    test_name: string | null;
    error_message: string | null;
    rerun_passed: number | null;
  }>;

if (rows.length === 0) {
  console.log("No labeled rows to review. Run npm run label first.");
  process.exit(0);
}

for (const row of rows) {
  const review: ReviewRow = {
    id: row.id,
    trueLabel: row.true_label,
    jobName: row.job_name,
    testName: row.test_name,
    errorMessage: row.error_message,
    rerunPassed: row.rerun_passed,
  };
  console.log(formatReviewRow(review));
}
console.log(`\nPrinted ${rows.length} labeled failures.`);
