import { describe, expect, it } from "vitest";
import { extractLogExcerpt, parseJunitFailures } from "../../src/collect/logs.js";

describe("extractLogExcerpt", () => {
  it("keeps about 200 lines around the first error", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
    lines[250] = "FAIL test/save.test.ts > saves the world";
    const result = extractLogExcerpt(lines.join("\n"));
    const excerptLines = result.excerpt.split("\n");
    expect(excerptLines).toHaveLength(200);
    expect(excerptLines[0]).toBe("line 200");
    expect(result.errorMessage).toBe("FAIL test/save.test.ts > saves the world");
    expect(result.testName).toBe("test/save.test.ts > saves the world");
  });

  it("reads a Vitest FAIL line that includes a timestamp and color codes", () => {
    const line =
      "2026-09-24T17:41:28.1298140Z \u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m specs/file.test.ts\u001b[2m > \u001b[22mplus sign";
    const result = extractLogExcerpt(["setup", line, "AssertionError: boom"].join("\n"));
    expect(result.testName).toBe("specs/file.test.ts > plus sign");
    expect(result.errorMessage).toContain("FAIL");
    expect(result.errorMessage).not.toContain("\u001b");
  });

  it("uses a FAIL line that comes after a generic process-exit error", () => {
    const lines = [
      "##[error]Process completed with exit code 1.",
      "still going",
      " FAIL  specs/a.test.ts > works",
    ];
    const result = extractLogExcerpt(lines.join("\n"));
    expect(result.testName).toBe("specs/a.test.ts > works");
    expect(result.errorMessage).toContain("specs/a.test.ts");
  });

  it("returns the tail when no error line is present", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `ok ${i}`);
    const result = extractLogExcerpt(lines.join("\n"), 10);
    expect(result.excerpt.split("\n")).toHaveLength(10);
    expect(result.errorMessage).toBeNull();
    expect(result.testName).toBeNull();
  });
});

describe("parseJunitFailures", () => {
  it("reads the failing test name and message", () => {
    const xml = `
      <testsuite>
        <testcase classname="suite" name="passes"/>
        <testcase classname="suite" name="saves">
          <failure message="expected 1 to be 2">stack</failure>
        </testcase>
      </testsuite>
    `;
    expect(parseJunitFailures(xml)).toEqual([
      { testName: "suite > saves", errorMessage: "expected 1 to be 2" },
    ]);
  });
});
