import type { TriageAction } from "../policy/decide.js";
import { isDryRun } from "../policy/decide.js";
import { liveComment, type CommentItem } from "./comment.js";

export type ActionContext = {
  failureId: number;
  runId: number;
  repo: string;
  prNumber: number | null;
  item: CommentItem;
  action: TriageAction;
};

export type ActionDeps = {
  rerun: (repo: string, runId: number) => Promise<void>;
  comment: (repo: string, prNumber: number, body: string) => Promise<void>;
  alert: (text: string) => Promise<void>;
};

export async function executeAction(ctx: ActionContext, deps: ActionDeps): Promise<{ dryRun: boolean }> {
  const dryRun = isDryRun();
  if (dryRun || ctx.action === "ask_human" || ctx.action === "quarantine") {
    if (!dryRun && ctx.prNumber !== null && (ctx.action === "ask_human" || ctx.action === "quarantine")) {
      await deps.comment(ctx.repo, ctx.prNumber, liveComment(ctx.item, ctx.action));
    }
    return { dryRun };
  }
  if (ctx.action === "retry" || ctx.action === "retry_and_alert") {
    await deps.rerun(ctx.repo, ctx.runId);
  }
  if (ctx.action === "retry_and_alert") {
    await deps.alert(`${ctx.repo} run ${ctx.runId} looks like infra and was re-run once.`);
  }
  if (ctx.prNumber !== null) {
    await deps.comment(ctx.repo, ctx.prNumber, liveComment(ctx.item, ctx.action));
  }
  return { dryRun: false };
}
