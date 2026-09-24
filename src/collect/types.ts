export type RunSummary = {
  id: number;
  name: string;
  headSha: string;
  headBranch: string | null;
  runAttempt: number;
  createdAt: string;
};

export type JobSummary = {
  id: number;
  name: string;
  conclusion: string | null;
  runAttempt: number;
  startedAt: string | null;
  completedAt: string | null;
  runnerName: string | null;
};

export type ArtifactSummary = {
  id: number;
  name: string;
  expired: boolean;
};

export interface ActionsClient {
  listRuns(params: {
    status: "failure" | "success";
    since: string;
    workflow: string;
  }): Promise<RunSummary[]>;
  listJobs(runId: number): Promise<JobSummary[]>;
  getJobLog(jobId: number): Promise<string | null>;
  listArtifacts(runId: number): Promise<ArtifactSummary[]>;
  downloadArtifact(artifactId: number): Promise<Uint8Array | null>;
  getCommitFiles(sha: string): Promise<string[]>;
  getPullRequestNumber(sha: string): Promise<number | null>;
}

export type BackfillOptions = {
  repo: string;
  workflow: string;
  since: string;
  maxJobs: number;
  onProgress?: (message: string) => void;
};

export type BackfillResult = {
  inserted: number;
  skipped: number;
  seen: number;
};
