import { describe, expect, it } from "vitest";
import { countFailures, insertFailure, openDatabase, type FailureRow } from "../../src/db/schema.js";

describe("failures table", () => {
  it("ignores a second insert of the same job", () => {
    const db = openDatabase(":memory:");
    expect(insertFailure(db, row(1))).toBe(true);
    expect(insertFailure(db, row(1))).toBe(false);
    expect(countFailures(db)).toBe(1);
    expect(insertFailure(db, row(2))).toBe(true);
    expect(countFailures(db)).toBe(2);
  });
});

function row(jobId: number): FailureRow {
  return {
    repo: "vitest-dev/vitest",
    commitSha: "abc",
    prNumber: 7,
    branch: "feat",
    workflowName: "CI",
    runId: 10,
    runAttempt: 1,
    jobId,
    jobName: "test",
    testName: "saves",
    errorMessage: "FAIL saves",
    logExcerpt: "FAIL saves",
    changedFiles: ["src/a.ts"],
    runnerName: "GitHub Actions 1",
    durationSeconds: 42,
    wasRerun: false,
    rerunPassed: null,
    failedAt: "2026-09-01T00:00:00Z",
  };
}
