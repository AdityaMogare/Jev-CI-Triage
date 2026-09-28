import { choice, TypeSafeClient, type Questions, type Usage } from "@typesafe-ai/sdk";
import type { Database } from "better-sqlite3";
import { getFailure, insertJevCall } from "../db/schema.js";
import { buildState, culpritFile, CULPRIT_FILE_LIMIT, flakeRateFor, isCategory } from "./state.js";
import type { Category, Classification } from "./types.js";

const MODEL = "typesafe/jev-1.13";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api";

const CATEGORY_QUESTION = choice("What kind of CI failure is this?", {
  flaky: "The test fails intermittently and a re-run usually passes.",
  infra: "The runner, disk, network, or registry failed. No product test failed.",
  regression: "This commit broke a test that had been passing.",
});

export async function classifyFailure(db: Database, failureId: number): Promise<Classification> {
  const failure = getFailure(db, failureId);
  if (!failure) throw new Error(`No failure with id ${failureId}`);

  const state = buildState(failure, flakeRateFor(db, failure));
  const questions: Questions = { category: CATEGORY_QUESTION };
  const files = uniqueFiles(failure.changedFiles);
  if (files.length >= 1 && files.length <= CULPRIT_FILE_LIMIT) {
    const criteria: Record<string, string> = {};
    for (const file of files) criteria[file] = "A file changed in the failing commit.";
    questions.culprit = choice("Which changed file most likely caused this regression?", criteria);
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Set OPENROUTER_API_KEY in .env. The key is never written to source.");

  const client = new TypeSafeClient({ apiKey, baseURL: OPENROUTER_BASE_URL });
  const started = Date.now();
  const response = await client.systemOne({ model: MODEL, state, questions });
  const durationMs = Date.now() - started;

  const categoryAnswer = response.answers.category;
  if (!categoryAnswer || categoryAnswer.type !== "choice" || !isCategory(categoryAnswer.choice)) {
    throw new Error("Jev did not return a flaky, infra, or regression choice");
  }

  const category = categoryAnswer.choice;
  const culpritAnswer = response.answers.culprit;
  const culpritChoice =
    culpritAnswer && culpritAnswer.type === "choice" ? culpritAnswer.choice : undefined;
  const result: Classification = {
    category,
    probabilities: probabilitiesFor(categoryAnswer.probabilities),
    confidence: categoryAnswer.confidence,
    culpritFile: culpritFile(category, files, culpritChoice),
  };

  const usage = response.usage as Usage & { cost?: number };
  insertJevCall(db, {
    failureId,
    inputChars: JSON.stringify(state).length,
    inputTokens: usage.input_tokens,
    costUsd: typeof usage.cost === "number" ? usage.cost : null,
    durationMs,
    model: response.model,
    category: result.category,
    confidence: result.confidence,
  });
  return result;
}

function uniqueFiles(files: string[]): string[] {
  return [...new Set(files.filter((file) => file.length > 0))];
}

function probabilitiesFor(raw: { readonly [label: string]: number }): Record<Category, number> {
  return {
    flaky: raw.flaky ?? 0,
    infra: raw.infra ?? 0,
    regression: raw.regression ?? 0,
  };
}
