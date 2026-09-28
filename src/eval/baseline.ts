import type { Category } from "../jev/types.js";

const INFRA_TEXT =
  /\btimeout\b|runner lost|disk full|no space left|out of disk|\bnetwork\b|\bregistry\b/i;

export function keywordPredict(text: string): Category {
  return INFRA_TEXT.test(text) ? "infra" : "regression";
}

export function alwaysRetryPredict(): Category {
  return "flaky";
}
