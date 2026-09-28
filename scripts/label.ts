import { labelAll } from "../src/label/autoLabel.js";
import { listLabelInputs, openDatabase, setTrueLabel } from "../src/db/schema.js";

const dbPath = process.argv[2] ?? "data/failures.db";
const db = openDatabase(dbPath);
const rows = listLabelInputs(db);
const labeled = labelAll(rows);

const write = db.transaction(() => {
  for (const row of labeled) setTrueLabel(db, row.id, row.label);
});
write();

const counts = { flaky: 0, infra: 0, regression: 0, unknown: 0 };
for (const row of labeled) counts[row.label] += 1;
console.log(
  `Labeled ${labeled.length}: flaky ${counts.flaky}, infra ${counts.infra}, regression ${counts.regression}, unknown ${counts.unknown}`,
);
