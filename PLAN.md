# CI Triage with Jev: Implementation Plan

## What we are building

When a test fails in CI, a person has to figure out why. Usually it is one of three things:

- **Flaky**: the test sometimes fails for no real reason. Running it again usually passes.
- **Infra**: the CI machine had a problem (timeout, out of disk, network down). Not the code's fault.
- **Regression**: the new code actually broke something. A human needs to fix it.

This tool looks at each failure, asks Jev (TypeSafe's decision model) which of the three it is, and then does the right thing:

- Flaky → re-run it once
- Infra → re-run it and post an alert
- Regression → comment on the PR and tag the owner
- Not sure → ask a human

**The goal is one number:** "We cut triage time by X% while being right Y% of the time on automatic actions."

## Rules for building this (for Cursor)

1. Build **one phase at a time**. Do not start the next phase until the current one works and has tests.
2. Never put API keys in code. Use a `.env` file and add it to `.gitignore`.
3. All Jev calls go through **one wrapper file**. Nothing else calls the Jev API directly.
4. Tests must use a **fake (mock) Jev**, so tests never cost money or need the internet.
5. Anything that changes GitHub (re-running jobs, posting comments) must have a **dry-run mode that is ON by default**.
6. Never re-run the same failure more than **once**.
7. Keep it simple. No dashboards, no login system, no Docker until Phase 7.
8. Do not guess the Jev API format. Read the official TypeSafe docs and the OpenRouter Jev docs, then write the wrapper to match them.

## Tech stack

| Part | Tool |
|---|---|
| Language | TypeScript, Node 20 |
| GitHub API | Octokit |
| GitHub App (Phase 5) | Probot |
| Database | SQLite (better-sqlite3) |
| Tests | Vitest |
| Jev | TypeSafe Jev, via the official JS SDK or OpenRouter |

## Folder layout

```text
ci-triage/
  src/
    collect/     # gets failures from GitHub
    label/       # figures out the "true answer" for past failures
    jev/         # the ONLY place that talks to Jev
    eval/        # measures accuracy and picks thresholds
    policy/      # decides what action to take
    actions/     # re-run, comment, alert (dry-run by default)
    app/         # GitHub App webhook (Phase 5+)
    db/          # SQLite setup and queries
  scripts/       # command-line entry points
  tests/
  PLAN.md
  .env.example
```

---

## Phase 1: Collect past failures

**Goal:** Build a local database of real CI failures from one repo.

**Steps:**

1. Pick a target repo. Use a public open-source repo with lots of CI runs and known flaky tests. Later, switch to your own repo.
2. Write `scripts/backfill.ts` that uses the GitHub API to fetch failed workflow runs from the last 60–90 days.
3. For each failed job, save:
   - repo, commit SHA, PR number (if any), branch
   - job name, test name (if we can find it)
   - error message and the part of the log around the error (keep about 200 lines max, not the whole log)
   - files changed in that commit
   - runner info and how long the job took
   - whether the same job was re-run, and whether the re-run passed
4. If the repo uploads JUnit XML test reports, read those, because they are cleaner than raw logs. If not, cut the raw log down to the part around the first error.
5. Save everything in SQLite, in a table called `failures`.

**Done when:** `npm run backfill` fills the database with at least a few hundred failures, and running it again does not create duplicates.

**Status (2026-09-24):** Target repo is `vitest-dev/vitest`, workflow `CI`, last 90 days. `npm test` passes. `npm run backfill` stored 400 failed jobs in `data/failures.db`. A second run inserted 0 and skipped 400. 72 rows have a parsed Vitest test name; the rest are build or process failures with no `FAIL` line. None of these newest 400 jobs had a later re-run (`was_rerun` is 0).

---

## Phase 2: Figure out the true answers

**Goal:** For past failures, work out what really happened so we can check Jev's answers against it.

**Simple rules to label history:**

- Same commit, same job, re-run **passed** → **flaky**
- Error mentions a timeout, runner lost, out of disk, network or registry errors, and no test actually failed → **infra**
- Failure kept happening until a **later commit** fixed it → **regression**
- Anything else → **unknown** (leave these out of scoring)

**Steps:**

1. Write `src/label/autoLabel.ts` using the rules above.
2. Write `scripts/review-labels.ts`, which prints 50 random labeled failures so you can check them by hand. Fix the rules if they are often wrong.
3. Save the answers in a column `true_label` on the `failures` table.

**Done when:** You have hand-checked 50 labels and at least about 85% look right.

---

## Phase 3: The Jev wrapper

**Goal:** One function that sends a failure to Jev and returns a typed answer.

**Steps:**

1. Create `src/jev/client.ts` with one main function:

   ```ts
   classifyFailure(failure) => {
     category: "flaky" | "infra" | "regression",
     probabilities: { flaky: number, infra: number, regression: number },
     confidence: number, // the top probability
     culpritFile?: string // most likely changed file, for regressions
   }
   ```

2. Use a Jev **Choice** question for the category. Use a second Choice question, where the options are the changed files, to pick the likely culprit file (only for regressions, and only if there are 30 files or fewer).
3. Build the "state" we send to Jev from: the error message, the trimmed log, test name, changed files, and the test's past flake rate. Keep it well under Jev's context limit.
4. Create `src/jev/mock.ts`, a fake version with the same function shape, used in tests.
5. Log every call's input size, cost and time to a `jev_calls` table.

**Done when:** `npm run classify -- --id 123` prints Jev's answer for one saved failure, and tests pass using the mock.

---

## Phase 4: Measure accuracy and pick thresholds

**Goal:** Find out how good Jev is on your history, and pick safe confidence cutoffs.

**Steps:**

1. Write `scripts/evaluate.ts`, which runs `classifyFailure` on every labeled failure (with a `--limit` option to control cost).
2. Report:
   - accuracy for each category
   - **precision** for each category (when Jev says "flaky", how often is it really flaky?)
   - calibration error (ECE): does 90% confidence mean right about 90% of the time?
   - total cost and average time per call
3. Compare against simple baselines:
   - "always retry once" (what many teams do now)
   - a keyword rule (for example, "timeout" means infra)
4. Pick thresholds. For example: auto-retry only if flaky confidence is at least X, where X is the lowest value that keeps flaky precision at 95% or higher. Save thresholds in `config/thresholds.json`.
5. Print a **replay report**: "If this had been on, it would have auto-retried N failures with Y% precision and flagged M regressions."

**Done when:** `npm run evaluate` prints the report and writes the thresholds file. If Jev does not beat the keyword baseline, stop and rethink before Phase 5.

---

## Phase 5: Shadow mode (live, but no actions)

**Goal:** Run on real new failures, show the answer, but change nothing.

**Steps:**

1. Create a GitHub App with Probot. Permissions: read Actions, read Checks, write Pull Request comments.
2. Listen for the `workflow_run` completed event. When a run fails, collect the same data as Phase 1.
3. Call `classifyFailure` and apply the thresholds.
4. Post **one** PR comment (update it instead of posting a new one each time), like:

   > CI triage (shadow mode, no actions taken)
   > - `test_save_load`: looks **flaky** (93%)
   > - `test_physics_step`: looks like a **regression**, likely in `PhysicsWorld.cs` (81%)
   >
   > React 👍 if right, 👎 if wrong.

5. Read the 👍/👎 reactions and save them as feedback in a `feedback` table.
6. Save every decision to an append-only `decisions` table: time, failure id, answer, confidence, and action it *would* have taken.

**Done when:** It runs on real PRs for one to two weeks and you have feedback on at least 50 decisions.

---

## Phase 6: Live mode (take real actions)

**Goal:** Let the tool actually act, safely.

**Steps:**

1. Add a config switch `mode: "shadow" | "live"`. The default is `"shadow"`.
2. Actions:
   - **Flaky** above threshold → re-run failed jobs **once**. If the re-run fails too, treat it as a regression.
   - **Infra** above threshold → re-run once and post in a Slack channel (Slack webhook URL in `.env`).
   - **Regression** → PR comment naming the likely file, and request a review from its owner (use `CODEOWNERS` if the repo has it).
   - **Below all thresholds** → comment "needs a human look" and take no action.
3. Keep a per-test flake counter. If one test is retried too often (for example, 5 times in a week), stop auto-retrying it and flag it for quarantine.
4. Add a kill switch: an env variable that instantly puts everything back into shadow mode.

**Done when:** It runs live on one repo for a week, with no double retries and no silent actions (every action is in the `decisions` table).

---

## Phase 7: Weekly report and final numbers

**Goal:** Prove it works with one clear number.

**Steps:**

1. For every failure, record two times: when it failed, and the first real human action on it (comment, commit, re-run by a person). The difference is **triage time**.
2. Compare triage time in shadow mode (before) against live mode (after).
3. Write `scripts/weekly-report.ts`, which posts to Slack:
   - failures handled, and how many automatically
   - precision of automatic actions (from 👍/👎 plus a manual check of 20 random ones)
   - re-run hours saved
   - top 5 flakiest tests
4. Optionally add Docker and deploy it (Fly.io, Railway, or a small VM).

**Done when:** You can write: "Cut triage time by X% at Y% precision on N real failures."

---

## How to use this plan in Cursor

1. Save this file as `PLAN.md` in the root of an empty repo.
2. Start each Cursor session with a prompt like:
   > "Read PLAN.md. Do Phase 1 only. Follow the 'Rules for building this' section. Write tests. Stop when Phase 1's 'Done when' is true and tell me how to check it."
3. After each phase, check the "Done when" line yourself before moving on.
4. When a phase is finished, ask Cursor to add a short "Status" note under that phase in this file, so the next session knows where things stand.
