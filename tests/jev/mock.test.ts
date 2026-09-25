import { describe, expect, it } from "vitest";
import type { FailureRow } from "../../src/db/schema.js";
import { insertFailure, openDatabase } from "../../src/db/schema.js";
import { classifyFailure } from "../../src/jev/mock.js";
import { LOG_CHAR_CAP, buildState } from "../../src/jev/state.js";

describe("mock classifyFailure", () => {
  it("marks a passing re-run as flaky and does not name a culprit file", async () => {
    const db = openDatabase(":memory:");
    const id = save(db, { rerunPassed: true, testName: "saves", changedFiles: ["src/a.ts"] });
    const result = await classifyFailure(db, id);
    expect(result.category).toBe("flaky");
    expect(result.probabilities.flaky).toBeGreaterThan(result.probabilities.infra);
    expect(result.confidence).toBe(result.probabilities.flaky);
    expect(result.culpritFile).toBeUndefined();
  });

  it("marks a runner failure with no test name as infra", async () => {
    const db = openDatabase(":memory:");
    const id = save(db, { testName: null, errorMessage: "runner lost connection" });
    expect((await classifyFailure(db, id)).category).toBe("infra");
  });

  it("names a culprit file for a regression with 30 or fewer files", async () => {
    const db = openDatabase(":memory:");
    const id = save(db, { testName: "saves", changedFiles: ["src/a.ts", "src/b.ts"] });
    const result = await classifyFailure(db, id);
    expect(result.category).toBe("regression");
    expect(result.culpritFile).toBe("src/a.ts");
  });

  it("leaves the culprit unset when more than 30 files changed", async () => {
    const db = openDatabase(":memory:");
    const files = Array.from({ length: 31 }, (_, index) => `src/f${index}.ts`);
    const id = save(db, { testName: "saves", changedFiles: files });
    const result = await classifyFailure(db, id);
    expect(result.category).toBe("regression");
    expect(result.culpritFile).toBeUndefined();
  });

  it("writes a jev_calls row without calling the network", async () => {
    const db = openDatabase(":memory:");
    const id = save(db, { testName: "saves", changedFiles: ["src/a.ts"] });
    await classifyFailure(db, id);
    const row = db.prepare("SELECT failure_id, model, category FROM jev_calls").get() as {
      failure_id: number;
      model: string;
      category: string;
    };
    expect(row).toEqual({ failure_id: id, model: "mock", category: "regression" });
  });
});

describe("buildState", () => {
  it("caps the log excerpt", () => {
    const state = buildState(
      {
        id: 1,
        ...stored({ logExcerpt: "x".repeat(LOG_CHAR_CAP + 50) }),
      },
      0.25,
    );
    expect(state.logExcerpt).toHaveLength(LOG_CHAR_CAP);
    expect(state.flakeRate).toBe(0.25);
  });
});

function save(db: ReturnType<typeof openDatabase>, overrides: Partial<FailureRow>): number {
  insertFailure(db, stored(overrides));
  const row = db.prepare("SELECT id FROM failures ORDER BY id DESC LIMIT 1").get() as { id: number };
  return row.id;
}

function stored(overrides: Partial<FailureRow>): FailureRow {
  return {
    repo: "vitest-dev/vitest",
    commitSha: "abc",
    prNumber: null,
    branch: "main",
    workflowName: "CI",
    runId: 1,
    runAttempt: 1,
    jobId: 1,
    jobName: "unit",
    testName: null,
    errorMessage: "FAIL saves",
    logExcerpt: "FAIL saves",
    changedFiles: [],
    runnerName: null,
    durationSeconds: 10,
    wasRerun: false,
    rerunPassed: null,
    failedAt: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}
