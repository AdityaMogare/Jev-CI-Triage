import type { Database } from "better-sqlite3";
import { getFailure, insertJevCall } from "../db/schema.js";
import { buildState, culpritFile, flakeRateFor } from "./state.js";
import type { Category, Classification } from "./types.js";

const INFRA_TEXT = /\btimeout\b|runner lost|disk full|no space left|\bnetwork\b|\bregistry\b/i;

export async function classifyFailure(db: Database, failureId: number): Promise<Classification> {
  const failure = getFailure(db, failureId);
  if (!failure) throw new Error(`No failure with id ${failureId}`);

  const state = buildState(failure, flakeRateFor(db, failure));
  const started = Date.now();
  const category = fakeCategory(failure);
  const picked = category === "regression" ? failure.changedFiles[0] : undefined;
  const result: Classification = {
    category,
    probabilities: { flaky: 0.05, infra: 0.05, regression: 0.05, [category]: 0.9 },
    confidence: 0.9,
    culpritFile: culpritFile(category, failure.changedFiles, picked),
  };

  insertJevCall(db, {
    failureId,
    inputChars: JSON.stringify(state).length,
    inputTokens: null,
    costUsd: null,
    durationMs: Date.now() - started,
    model: "mock",
    category: result.category,
    confidence: result.confidence,
  });
  return result;
}

function fakeCategory(failure: {
  rerunPassed: boolean | null;
  testName: string | null;
  errorMessage: string | null;
  logExcerpt: string | null;
}): Category {
  if (failure.rerunPassed === true) return "flaky";
  const text = `${failure.errorMessage ?? ""}\n${failure.logExcerpt ?? ""}`;
  if (failure.testName === null && INFRA_TEXT.test(text)) return "infra";
  return "regression";
}
