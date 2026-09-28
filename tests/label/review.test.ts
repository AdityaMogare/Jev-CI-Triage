import { describe, expect, it } from "vitest";
import { formatReviewRow } from "../../src/label/review.js";

describe("formatReviewRow", () => {
  it("prints the label, job, test, re-run, and a short error", () => {
    const line = formatReviewRow({
      id: 7,
      trueLabel: "flaky",
      jobName: "unit",
      testName: "saves",
      errorMessage: "FAIL saves\nexpected 1",
      rerunPassed: 1,
    });
    expect(line).toBe("#7 [flaky] unit | saves | rerun passed: yes | FAIL saves expected 1");
  });
});
