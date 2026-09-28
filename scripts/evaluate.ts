import "dotenv/config";
import fs from "node:fs";
import { classifyFailure } from "../src/jev/client.js";
import { formatReport, evaluateFailures } from "../src/eval/run.js";
import { openDatabase } from "../src/db/schema.js";

const limit = Number(arg("limit", "50"));
if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");

const db = openDatabase(arg("db", "data/failures.db"));
const report = await evaluateFailures(db, classifyFailure, { limit });
fs.mkdirSync("config", { recursive: true });
fs.writeFileSync("config/thresholds.json", `${JSON.stringify(report.thresholds, null, 2)}\n`);
console.log(formatReport(report));
console.log("Wrote config/thresholds.json");

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing --${name}`);
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for --${name}`);
  return value;
}
