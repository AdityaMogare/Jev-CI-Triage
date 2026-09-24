import "dotenv/config";
import { countFailures, openDatabase } from "../src/db/schema.js";
import { backfillFailures, createOctokitClient } from "../src/collect/github.js";

const repo = arg("repo", "vitest-dev/vitest");
const workflow = arg("workflow", "CI");
const days = Number(arg("days", "90"));
const maxJobs = Number(arg("max-jobs", "400"));
const dbPath = arg("db", "data/failures.db");

if (!Number.isInteger(days) || days < 1) {
  throw new Error("--days must be a positive integer");
}
if (!Number.isInteger(maxJobs) || maxJobs < 1) {
  throw new Error("--max-jobs must be a positive integer");
}

const token = process.env.GITHUB_TOKEN;
if (!token) {
  throw new Error("Set GITHUB_TOKEN in .env (see .env.example). The token is never written to source.");
}

const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const db = openDatabase(dbPath);
const client = createOctokitClient(token, repo);

const result = await backfillFailures(db, client, {
  repo,
  workflow,
  since,
  maxJobs,
  onProgress: (message) => console.log(message),
});

console.log(
  `Inserted ${result.inserted}, skipped ${result.skipped}, seen ${result.seen}, total ${countFailures(db)}`,
);

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for --${name}`);
  }
  return value;
}
