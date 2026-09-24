import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { backfillFailures } from "../../src/collect/github.js";
import type { ActionsClient, JobSummary, RunSummary } from "../../src/collect/types.js";
import { countFailures, openDatabase } from "../../src/db/schema.js";

describe("backfillFailures", () => {
  it("stores a failed job, a passing re-run, and does not duplicate", async () => {
    const db = openDatabase(":memory:");
    const client = new FakeClient();

    const first = await backfillFailures(db, client, {
      repo: "vitest-dev/vitest",
      workflow: "CI",
      since: "2026-06-01",
      maxJobs: 50,
    });
    expect(first).toEqual({ inserted: 2, skipped: 0, seen: 2 });

    const rows = db
      .prepare(
        "SELECT job_id, test_name, pr_number, changed_files, runner_name, duration_seconds, was_rerun, rerun_passed FROM failures ORDER BY job_id",
      )
      .all() as Array<Record<string, unknown>>;

    expect(rows).toEqual([
      {
        job_id: 10,
        test_name: "suite > saves",
        pr_number: 42,
        changed_files: JSON.stringify(["src/world.ts"]),
        runner_name: "runner-a",
        duration_seconds: 90,
        was_rerun: 1,
        rerun_passed: 1,
      },
      {
        job_id: 20,
        test_name: "test/physics.test.ts > steps",
        pr_number: 42,
        changed_files: JSON.stringify(["src/world.ts"]),
        runner_name: "runner-b",
        duration_seconds: 30,
        was_rerun: 0,
        rerun_passed: null,
      },
    ]);

    const second = await backfillFailures(db, client, {
      repo: "vitest-dev/vitest",
      workflow: "CI",
      since: "2026-06-01",
      maxJobs: 50,
    });
    expect(second).toEqual({ inserted: 0, skipped: 2, seen: 2 });
    expect(countFailures(db)).toBe(2);
    expect(client.logDownloads).toBe(2);
  });

  it("keeps an older passing re-run when newer failures would fill the cap", async () => {
    const db = openDatabase(":memory:");
    const client = new CrowdingClient();

    const result = await backfillFailures(db, client, {
      repo: "vitest-dev/vitest",
      workflow: "CI",
      since: "2026-06-01",
      maxJobs: 4,
    });

    expect(result).toEqual({ inserted: 4, skipped: 0, seen: 4 });
    const rows = db
      .prepare("SELECT job_id, rerun_passed FROM failures ORDER BY job_id")
      .all() as Array<{ job_id: number; rerun_passed: number | null }>;
    expect(rows).toEqual([
      { job_id: 2, rerun_passed: null },
      { job_id: 3, rerun_passed: null },
      { job_id: 4, rerun_passed: null },
      { job_id: 10, rerun_passed: 1 },
    ]);
  });
});

class FakeClient implements ActionsClient {
  logDownloads = 0;

  async listRuns(params: {
    status: "failure" | "success";
    since: string;
    workflow: string;
  }): Promise<RunSummary[]> {
    if (params.status === "success") {
      return [
        {
          id: 1,
          name: "CI",
          headSha: "abc123",
          headBranch: "flaky-fix",
          runAttempt: 2,
          createdAt: "2026-09-02T00:00:00Z",
        },
      ];
    }
    return [
      {
        id: 2,
        name: "CI",
        headSha: "abc123",
        headBranch: "flaky-fix",
        runAttempt: 1,
        createdAt: "2026-09-01T00:00:00Z",
      },
    ];
  }

  async listJobs(runId: number): Promise<JobSummary[]> {
    if (runId === 1) {
      return [
        job(10, "unit", "failure", 1, "runner-a", "2026-09-02T00:00:00Z", "2026-09-02T00:01:30Z"),
        job(11, "unit", "success", 2, "runner-a", "2026-09-02T00:02:00Z", "2026-09-02T00:03:00Z"),
      ];
    }
    return [
      job(20, "browser", "failure", 1, "runner-b", "2026-09-01T00:00:00Z", "2026-09-01T00:00:30Z"),
    ];
  }

  async getJobLog(jobId: number): Promise<string | null> {
    this.logDownloads += 1;
    if (jobId === 20) {
      return ["setup", "FAIL test/physics.test.ts > steps", "AssertionError: boom"].join("\n");
    }
    return "log without a parsed name";
  }

  async listArtifacts(runId: number) {
    if (runId !== 1) return [];
    return [{ id: 99, name: "junit-report", expired: false }];
  }

  async downloadArtifact(artifactId: number): Promise<Uint8Array | null> {
    if (artifactId !== 99) return null;
    const xml = `<testsuite><testcase classname="suite" name="saves"><failure message="disk full"/></testcase></testsuite>`;
    return zipSync({ "junit.xml": new TextEncoder().encode(xml) });
  }

  async getCommitFiles(): Promise<string[]> {
    return ["src/world.ts"];
  }

  async getPullRequestNumber(): Promise<number | null> {
    return 42;
  }
}

class CrowdingClient implements ActionsClient {
  async listRuns(params: { status: "failure" | "success" }): Promise<RunSummary[]> {
    if (params.status === "success") {
      return [run(1, 2, "2026-08-01T00:00:00Z")];
    }
    return [
      run(104, 1, "2026-09-04T00:00:00Z"),
      run(103, 1, "2026-09-03T00:00:00Z"),
      run(102, 1, "2026-09-02T00:00:00Z"),
      run(101, 1, "2026-09-01T00:00:00Z"),
    ];
  }

  async listJobs(runId: number): Promise<JobSummary[]> {
    if (runId === 1) {
      return [
        job(10, "unit", "failure", 1, "runner-a", "2026-08-01T00:00:00Z", "2026-08-01T00:01:00Z"),
        job(11, "unit", "success", 2, "runner-a", "2026-08-01T00:02:00Z", "2026-08-01T00:03:00Z"),
      ];
    }
    const plainId = runId - 100;
    return [
      job(plainId, "unit", "failure", 1, "runner-b", "2026-09-01T00:00:00Z", "2026-09-01T00:00:30Z"),
    ];
  }

  async getJobLog(): Promise<string | null> {
    return "FAIL test/plain.test.ts > fails";
  }

  async listArtifacts() {
    return [];
  }

  async downloadArtifact(): Promise<Uint8Array | null> {
    return null;
  }

  async getCommitFiles(): Promise<string[]> {
    return ["src/world.ts"];
  }

  async getPullRequestNumber(): Promise<number | null> {
    return null;
  }
}

function run(id: number, runAttempt: number, createdAt: string): RunSummary {
  return { id, name: "CI", headSha: `sha-${id}`, headBranch: "main", runAttempt, createdAt };
}

function job(
  id: number,
  name: string,
  conclusion: string,
  runAttempt: number,
  runnerName: string,
  startedAt: string,
  completedAt: string,
): JobSummary {
  return { id, name, conclusion, runAttempt, startedAt, completedAt, runnerName };
}
