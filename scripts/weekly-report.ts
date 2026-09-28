import "dotenv/config";
import { openDatabase } from "../src/db/schema.js";
import { buildWeeklyReport } from "../src/report/weekly.js";

const db = openDatabase(process.argv[2] ?? "data/failures.db");
const report = buildWeeklyReport(db);
console.log(report.text);

const webhook = process.env.SLACK_WEBHOOK_URL;
if (webhook && process.env.TRIAGE_DRY_RUN === "0") {
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: report.text }),
  });
  if (!response.ok) throw new Error(`Slack webhook returned ${response.status}`);
  console.log("Posted weekly report to Slack");
}
