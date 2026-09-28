export const CATEGORIES = ["flaky", "infra", "regression"] as const;

export type Category = (typeof CATEGORIES)[number];

export type Classification = {
  category: Category;
  probabilities: Record<Category, number>;
  confidence: number;
  culpritFile?: string;
};

export type FailureState = {
  errorMessage: string | null;
  logExcerpt: string | null;
  testName: string | null;
  changedFiles: string[];
  flakeRate: number;
};
