import { Probot } from "probot";

export default (app: Probot) => {
  app.on("workflow_run.completed", async (context) => {
    if (context.payload.workflow_run.conclusion !== "failure") return;
    context.log.info(
      `CI triage shadow: workflow run ${context.payload.workflow_run.id} failed. Dry-run stays on unless TRIAGE_MODE=live and TRIAGE_DRY_RUN=0.`,
    );
  });
};
