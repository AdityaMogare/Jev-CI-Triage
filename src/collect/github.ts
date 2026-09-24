import { Octokit } from "@octokit/rest";
import { unzipSync } from "fflate";
import type { Database } from "better-sqlite3";
import { hasFailure, insertFailure, type FailureRow } from "../db/schema.js";
import { extractLogExcerpt, parseJunitFailures, type JunitFailure } from "./logs.js";
import type {
  ActionsClient,
  ArtifactSummary,
  BackfillOptions,
  BackfillResult,
  JobSummary,
  RunSummary,
} from "./types.js";

const LOG_CHAR_CAP = 2_000_000;

export function createOctokitClient(token: string, repo: string): ActionsClient {
  const slash = repo.indexOf("/");
  if (slash === -1) throw new Error(`Expected owner/name, got ${repo}`);
  const owner = repo.slice(0, slash);
  const name = repo.slice(slash + 1);
  return new OctokitActionsClient(new Octokit({ auth: token }), owner, name);
}

class OctokitActionsClient implements ActionsClient {
  constructor(
    private readonly octokit: Octokit,
    private readonly owner: string,
    private readonly name: string,
  ) {}

  async listRuns(params: {
    status: "failure" | "success";
    since: string;
    workflow: string;
  }): Promise<RunSummary[]> {
    const workflowId = await this.workflowId(params.workflow);
    const runs = await this.octokit.paginate(this.octokit.rest.actions.listWorkflowRuns, {
      owner: this.owner,
      repo: this.name,
      workflow_id: workflowId,
      status: params.status,
      created: `>=${params.since}`,
      per_page: 100,
    });
    return runs.map((run) => ({
      id: run.id,
      name: run.name ?? params.workflow,
      headSha: run.head_sha,
      headBranch: run.head_branch,
      runAttempt: run.run_attempt ?? 1,
      createdAt: run.created_at,
    }));
  }

  async listJobs(runId: number): Promise<JobSummary[]> {
    const jobs = await this.octokit.paginate(this.octokit.rest.actions.listJobsForWorkflowRun, {
      owner: this.owner,
      repo: this.name,
      run_id: runId,
      filter: "all",
      per_page: 100,
    });
    return jobs.map((job) => ({
      id: job.id,
      name: job.name,
      conclusion: job.conclusion,
      runAttempt: job.run_attempt ?? 1,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      runnerName: job.runner_name ?? null,
    }));
  }

  async getJobLog(jobId: number): Promise<string | null> {
    try {
      const response = await this.octokit.request(
        "GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs",
        {
          owner: this.owner,
          repo: this.name,
          job_id: jobId,
          request: { redirect: "follow" },
        },
      );
      return asLogText(response.data).slice(0, LOG_CHAR_CAP);
    } catch (error) {
      if (statusOf(error) === 410 || statusOf(error) === 404) return null;
      throw error;
    }
  }

  async listArtifacts(runId: number): Promise<ArtifactSummary[]> {
    try {
      const artifacts = await this.octokit.paginate(
        this.octokit.rest.actions.listWorkflowRunArtifacts,
        {
          owner: this.owner,
          repo: this.name,
          run_id: runId,
          per_page: 100,
        },
      );
      return artifacts.map((artifact) => ({
        id: artifact.id,
        name: artifact.name,
        expired: artifact.expired,
      }));
    } catch (error) {
      if (statusOf(error) === 404) return [];
      throw error;
    }
  }

  async downloadArtifact(artifactId: number): Promise<Uint8Array | null> {
    try {
      const response = await this.octokit.request(
        "GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip",
        {
          owner: this.owner,
          repo: this.name,
          artifact_id: artifactId,
        },
      );
      return asBytes(response.data);
    } catch (error) {
      if (statusOf(error) === 410 || statusOf(error) === 404) return null;
      throw error;
    }
  }

  async getCommitFiles(sha: string): Promise<string[]> {
    const files: string[] = [];
    let page = 1;
    for (;;) {
      const response = await this.octokit.rest.repos.getCommit({
        owner: this.owner,
        repo: this.name,
        ref: sha,
        per_page: 100,
        page,
      });
      const batch = response.data.files ?? [];
      for (const file of batch) files.push(file.filename);
      if (batch.length < 100) break;
      page += 1;
      if (page > 5) break;
    }
    return files;
  }

  async getPullRequestNumber(sha: string): Promise<number | null> {
    const response = await this.octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner: this.owner,
      repo: this.name,
      commit_sha: sha,
    });
    return response.data[0]?.number ?? null;
  }

  private async workflowId(workflow: string): Promise<number | string> {
    const response = await this.octokit.rest.actions.listRepoWorkflows({
      owner: this.owner,
      repo: this.name,
      per_page: 100,
    });
    const match = response.data.workflows.find(
      (item) => item.name === workflow || item.path.endsWith(`/${workflow}.yml`),
    );
    if (!match) throw new Error(`Workflow ${workflow} was not found in ${this.owner}/${this.name}`);
    return match.id;
  }
}

export async function backfillFailures(
  db: Database,
  client: ActionsClient,
  options: BackfillOptions,
): Promise<BackfillResult> {
  const failedRuns = await client.listRuns({
    status: "failure",
    since: options.since,
    workflow: options.workflow,
  });
  const successRuns = await client.listRuns({
    status: "success",
    since: options.since,
    workflow: options.workflow,
  });
  const byNewest = (a: RunSummary, b: RunSummary) => b.createdAt.localeCompare(a.createdAt);
  const passingRerunRuns = successRuns.filter((run) => run.runAttempt > 1).sort(byNewest);
  const plainRuns = failedRuns.sort(byNewest);

  const commitCache = new Map<string, { files: string[]; prNumber: number | null }>();
  const totals = { inserted: 0, skipped: 0, seen: 0 };
  const rerunBudget = Math.floor(options.maxJobs / 4);

  await collectRuns(db, client, options, commitCache, totals, passingRerunRuns, rerunBudget, true);
  const plainBudget = options.maxJobs - totals.seen;
  await collectRuns(db, client, options, commitCache, totals, plainRuns, plainBudget, false);

  return totals;
}

async function collectRuns(
  db: Database,
  client: ActionsClient,
  options: BackfillOptions,
  commitCache: Map<string, { files: string[]; prNumber: number | null }>,
  totals: BackfillResult,
  runs: RunSummary[],
  limit: number,
  requirePassedRerun: boolean,
): Promise<void> {
  let taken = 0;
  for (const run of runs) {
    if (taken >= limit) break;
    const jobs = await client.listJobs(run.id);
    const failedJobs = jobs
      .filter((job) => job.conclusion === "failure")
      .sort((a, b) => a.runAttempt - b.runAttempt || a.id - b.id);

    for (const job of failedJobs) {
      if (taken >= limit) break;
      const later = jobs.filter(
        (other) => other.name === job.name && other.runAttempt > job.runAttempt,
      );
      const wasRerun = later.length > 0;
      const rerunPassed = wasRerun ? later.some((other) => other.conclusion === "success") : null;
      if (requirePassedRerun && rerunPassed !== true) continue;

      taken += 1;
      totals.seen += 1;
      if (hasFailure(db, options.repo, job.id)) {
        totals.skipped += 1;
        continue;
      }

      const commit = await loadCommit(client, commitCache, run.headSha);
      const log = await client.getJobLog(job.id);
      const excerpt = log ? extractLogExcerpt(log) : null;
      const junit = await readJunitFailures(client, run.id);

      const row: FailureRow = {
        repo: options.repo,
        commitSha: run.headSha,
        prNumber: commit.prNumber,
        branch: run.headBranch,
        workflowName: run.name,
        runId: run.id,
        runAttempt: job.runAttempt,
        jobId: job.id,
        jobName: job.name,
        testName: junit[0]?.testName ?? excerpt?.testName ?? null,
        errorMessage: junit[0]?.errorMessage ?? excerpt?.errorMessage ?? null,
        logExcerpt: excerpt?.excerpt ?? null,
        changedFiles: commit.files,
        runnerName: job.runnerName,
        durationSeconds: durationSeconds(job.startedAt, job.completedAt),
        wasRerun,
        rerunPassed,
        failedAt: job.completedAt,
      };

      if (insertFailure(db, row)) totals.inserted += 1;
      else totals.skipped += 1;

      if (totals.seen % 25 === 0) {
        options.onProgress?.(
          `Processed ${totals.seen} failed jobs (${totals.inserted} inserted, ${totals.skipped} skipped)`,
        );
      }
    }
  }
}

async function loadCommit(
  client: ActionsClient,
  cache: Map<string, { files: string[]; prNumber: number | null }>,
  sha: string,
): Promise<{ files: string[]; prNumber: number | null }> {
  const cached = cache.get(sha);
  if (cached) return cached;
  const [files, prNumber] = await Promise.all([
    client.getCommitFiles(sha),
    client.getPullRequestNumber(sha),
  ]);
  const value = { files, prNumber };
  cache.set(sha, value);
  return value;
}

async function readJunitFailures(client: ActionsClient, runId: number): Promise<JunitFailure[]> {
  const artifacts = await client.listArtifacts(runId);
  const candidates = artifacts.filter(
    (artifact) => !artifact.expired && /junit|test-results|vitest-results/i.test(artifact.name),
  );
  const failures: JunitFailure[] = [];
  for (const artifact of candidates) {
    const zip = await client.downloadArtifact(artifact.id);
    if (!zip) continue;
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(zip);
    } catch {
      continue;
    }
    for (const [name, bytes] of Object.entries(files)) {
      if (!name.endsWith(".xml")) continue;
      const xml = new TextDecoder().decode(bytes);
      if (!xml.includes("<testcase")) continue;
      failures.push(...parseJunitFailures(xml));
    }
  }
  return failures;
}

function durationSeconds(startedAt: string | null, completedAt: string | null): number | null {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 1000);
}

function statusOf(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status: unknown }).status;
    return typeof status === "number" ? status : undefined;
  }
  return undefined;
}

function asLogText(data: unknown): string {
  if (typeof data === "string") return data;
  const bytes = asBytes(data);
  return bytes ? new TextDecoder().decode(bytes) : "";
}

function asBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data === "string") return new TextEncoder().encode(data);
  return null;
}
