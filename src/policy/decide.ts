import type { Category } from "../jev/types.js";

export type TriageAction = "retry" | "retry_and_alert" | "comment_regression" | "ask_human" | "quarantine";

export type Thresholds = Record<Category, number | null>;

export type DecisionInput = {
  category: Category;
  confidence: number;
  priorRetries: number;
  recentRetriesForTest: number;
};

const QUARANTINE_AFTER = 5;

export function chooseAction(input: DecisionInput, thresholds: Thresholds): TriageAction {
  if (input.priorRetries > 0 && (input.category === "flaky" || input.category === "infra")) {
    return "comment_regression";
  }
  if (
    (input.category === "flaky" || input.category === "infra") &&
    input.recentRetriesForTest >= QUARANTINE_AFTER
  ) {
    return "quarantine";
  }
  const threshold = thresholds[input.category];
  if (threshold === null || input.confidence < threshold) return "ask_human";
  if (input.category === "flaky") return "retry";
  if (input.category === "infra") return "retry_and_alert";
  return "comment_regression";
}

export function currentMode(): "shadow" | "live" {
  if (process.env.TRIAGE_KILL_SWITCH === "1") return "shadow";
  return process.env.TRIAGE_MODE === "live" ? "live" : "shadow";
}

export function isDryRun(): boolean {
  if (currentMode() !== "live") return true;
  return process.env.TRIAGE_DRY_RUN !== "0";
}
