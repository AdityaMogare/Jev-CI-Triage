import "dotenv/config";
import { classifyFailure } from "../src/jev/client.js";
import { openDatabase } from "../src/db/schema.js";

const id = Number(arg("id"));
if (!Number.isInteger(id) || id < 1) throw new Error("Pass --id with a saved failure id");

const db = openDatabase(arg("db", "data/failures.db"));
const result = await classifyFailure(db, id);
console.log(JSON.stringify(result, null, 2));

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
