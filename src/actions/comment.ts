export type CommentItem = {
  testName: string;
  category: string;
  confidence: number;
  culpritFile?: string;
};

export function shadowComment(items: CommentItem[]): string {
  const lines = ["CI triage (shadow mode, no actions taken)"];
  for (const item of items) {
    const confidence = `${Math.round(item.confidence * 100)}%`;
    if (item.category === "regression" && item.culpritFile) {
      lines.push(
        `- \`${item.testName}\`: looks like a **regression**, likely in \`${item.culpritFile}\` (${confidence})`,
      );
    } else {
      lines.push(`- \`${item.testName}\`: looks **${item.category}** (${confidence})`);
    }
  }
  lines.push("", "React :+1: if right, :-1: if wrong.");
  return lines.join("\n");
}

export function liveComment(item: CommentItem, action: string): string {
  if (action === "ask_human") {
    return `CI triage: \`${item.testName}\` needs a human look (${Math.round(item.confidence * 100)}% ${item.category}).`;
  }
  if (action === "quarantine") {
    return `CI triage: \`${item.testName}\` was retried too often this week. Auto-retry is paused until it is quarantined.`;
  }
  if (action === "comment_regression") {
    const file = item.culpritFile ? `, likely in \`${item.culpritFile}\`` : "";
    return `CI triage: \`${item.testName}\` looks like a regression${file}.`;
  }
  return `CI triage: \`${item.testName}\` looks ${item.category}. A re-run was requested once.`;
}
