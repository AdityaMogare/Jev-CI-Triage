import type { LabelInput, TrueLabel } from "../db/schema.js";

const INFRA_TEXT =
  /\btimeout\b|runner lost|lost the runner|disk full|no space left|out of disk|\bnetwork\b|\bregistry\b/i;

export function autoLabel(failure: LabelInput, rows: LabelInput[]): TrueLabel {
  if (failure.rerunPassed === true) return "flaky";
  if (failure.testName === null && INFRA_TEXT.test(textOf(failure))) return "infra";
  if (isRegression(failure, rows)) return "regression";
  return "unknown";
}

export function labelAll(rows: LabelInput[]): Array<{ id: number; label: TrueLabel }> {
  return rows.map((row) => ({ id: row.id, label: autoLabel(row, rows) }));
}

function textOf(failure: LabelInput): string {
  return `${failure.errorMessage ?? ""}\n${failure.logExcerpt ?? ""}`;
}

function isRegression(failure: LabelInput, rows: LabelInput[]): boolean {
  if (!failure.testName || !failure.failedAt) return false;
  const sameTest = rows.filter(
    (other) =>
      other.id !== failure.id &&
      other.repo === failure.repo &&
      other.jobName === failure.jobName &&
      other.testName === failure.testName,
  );
  const happenedEarlier = sameTest.some(
    (other) => other.commitSha !== failure.commitSha && (other.failedAt ?? "") < failure.failedAt!,
  );
  if (!happenedEarlier) return false;

  const laterCommits = new Set(
    rows
      .filter(
        (other) =>
          other.repo === failure.repo &&
          other.commitSha !== failure.commitSha &&
          (other.failedAt ?? "") > failure.failedAt!,
      )
      .map((other) => other.commitSha),
  );
  for (const sha of laterCommits) {
    const stillFails = rows.some(
      (other) =>
        other.commitSha === sha &&
        other.jobName === failure.jobName &&
        other.testName === failure.testName,
    );
    if (!stillFails) return true;
  }
  return false;
}
