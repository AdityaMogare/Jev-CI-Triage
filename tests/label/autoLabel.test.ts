import { describe, expect, it } from "vitest";
import type { FailureRow, LabelInput } from "../../src/db/schema.js";
import { insertFailure, listLabelInputs, openDatabase, setTrueLabel } from "../../src/db/schema.js";
import { autoLabel, labelAll } from "../../src/label/autoLabel.js";

describe("autoLabel", () => {
  it("marks a passing re-run as flaky", () => {
    const row = failure({ id: 1, rerunPassed: true, testName: "saves" });
    expect(autoLabel(row, [row])).toBe("flaky");
  });

  it("marks a timeout with no test name as infra", () => {
    const row = failure({ id: 1, errorMessage: "runner lost connection", testName: null });
    expect(autoLabel(row, [row])).toBe("infra");
  });

  it("marks a repeated test that a later commit no longer fails as a regression", () => {
    const earlier = failure({
      id: 1,
      commitSha: "aaa",
      testName: "saves",
      failedAt: "2026-09-01T00:00:00Z",
    });
    const current = failure({
      id: 2,
      commitSha: "bbb",
      testName: "saves",
      failedAt: "2026-09-02T00:00:00Z",
    });
    const later = failure({
      id: 3,
      commitSha: "ccc",
      jobName: "other",
      testName: "unrelated",
      failedAt: "2026-09-03T00:00:00Z",
    });
    expect(autoLabel(current, [earlier, current, later])).toBe("regression");
    expect(autoLabel(earlier, [earlier, current, later])).toBe("unknown");
  });

  it("leaves anything else unknown", () => {
    const row = failure({ id: 1, errorMessage: "AssertionError: boom", testName: "saves" });
    expect(autoLabel(row, [row])).toBe("unknown");
  });

  it("writes labels into the database", () => {
    const db = openDatabase(":memory:");
    insertFailure(db, stored({ jobId: 1, rerunPassed: true, testName: "saves" }));
    const labels = labelAll(listLabelInputs(db));
    for (const row of labels) setTrueLabel(db, row.id, row.label);
    const saved = db.prepare("SELECT true_label FROM failures").get() as { true_label: string };
    expect(saved.true_label).toBe("flaky");
  });
});

function stored(overrides: Partial<FailureRow> & { jobId: number }): FailureRow {
  return {
    repo: "vitest-dev/vitest",
    commitSha: "abc",
    prNumber: null,
    branch: "main",
    workflowName: "CI",
    runId: 1,
    runAttempt: 1,
    jobName: "unit",
    testName: null,
    errorMessage: null,
    logExcerpt: null,
    changedFiles: [],
    runnerName: null,
    durationSeconds: null,
    wasRerun: false,
    rerunPassed: null,
    failedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

function failure(overrides: Partial<LabelInput> & { id: number }): LabelInput {
  return {
    repo: "vitest-dev/vitest",
    commitSha: "abc",
    jobName: "unit",
    testName: null,
    errorMessage: null,
    logExcerpt: null,
    rerunPassed: null,
    failedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}
