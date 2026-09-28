export type ReviewRow = {
  id: number;
  trueLabel: string;
  jobName: string;
  testName: string | null;
  errorMessage: string | null;
  rerunPassed: number | null;
};

export function formatReviewRow(row: ReviewRow): string {
  const testName = row.testName ?? "(no test name)";
  const error = (row.errorMessage ?? "").replace(/\s+/g, " ").slice(0, 160);
  const rerun = row.rerunPassed === null ? "n/a" : row.rerunPassed === 1 ? "yes" : "no";
  return `#${row.id} [${row.trueLabel}] ${row.jobName} | ${testName} | rerun passed: ${rerun} | ${error}`;
}
