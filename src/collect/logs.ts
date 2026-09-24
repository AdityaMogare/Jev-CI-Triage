const ERROR_LINE =
  /##\[error\]|\bFAIL\b|\bError:|Process completed with exit code (?!0\b)\d+/;

const TEST_NAME_LINE = /^\s*(?:FAIL|×|❯)\s+(.+?)\s*$/;

export type LogExcerpt = {
  excerpt: string;
  errorMessage: string | null;
  testName: string | null;
};

export function extractLogExcerpt(log: string, maxLines = 200): LogExcerpt {
  const lines = log.split(/\r?\n/).map(cleanLogLine);
  const preferred = lines.findIndex((line) => TEST_NAME_LINE.test(line) || /\bError:/.test(line));
  const errorIndex = preferred === -1 ? lines.findIndex((line) => ERROR_LINE.test(line)) : preferred;

  if (errorIndex === -1) {
    return {
      excerpt: lines.slice(-maxLines).join("\n"),
      errorMessage: null,
      testName: null,
    };
  }

  const before = 30;
  let start = Math.max(0, errorIndex - before);
  let end = Math.min(lines.length, start + maxLines);
  if (end - start < maxLines) start = Math.max(0, end - maxLines);
  const window = lines.slice(start, end);

  return {
    excerpt: window.join("\n"),
    errorMessage: lines[errorIndex].trim().slice(0, 500),
    testName: findTestName(lines),
  };
}

function cleanLogLine(line: string): string {
  return line
    .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/, "")
    .replace(/\u001b\[[0-9;]*m/g, "");
}

function findTestName(lines: string[]): string | null {
  for (const line of lines) {
    const match = line.match(TEST_NAME_LINE);
    if (!match) continue;
    const name = match[1].replace(/\s+\[.*$/, "").trim();
    if (name.length > 0) return name.slice(0, 300);
  }
  return null;
}

export type JunitFailure = {
  testName: string;
  errorMessage: string | null;
};

export function parseJunitFailures(xml: string): JunitFailure[] {
  const failures: JunitFailure[] = [];
  const testcaseRe = /<testcase\b([^>]*)(?<!\/)>([\s\S]*?)<\/testcase>/g;
  for (const match of xml.matchAll(testcaseRe)) {
    const attrs = match[1];
    const body = match[2];
    const failure = body.match(/<failure\b([^>]*)(?:\/>|>([\s\S]*?)<\/failure>)/);
    const error = body.match(/<error\b([^>]*)(?:\/>|>([\s\S]*?)<\/error>)/);
    const problem = failure ?? error;
    if (!problem) continue;

    const name = attr(attrs, "name") ?? "unknown";
    const classname = attr(attrs, "classname");
    const message =
      attr(problem[1], "message") ??
      (problem[2] ? problem[2].trim().slice(0, 500) : null);

    failures.push({
      testName: classname ? `${classname} > ${name}` : name,
      errorMessage: message,
    });
  }
  return failures;
}

function attr(source: string, name: string): string | null {
  const match = source.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : null;
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}
