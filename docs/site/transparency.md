# Transparency reports

Every quarter we publish what unAlgorithm Cloud did for Fact-check and UnEcho Chamber: how many checks and comparisons
it ran, with which AI models and prompts, how its source list changed, and what happened to the corrections and appeals
people sent. unAlgorithm Cloud keeps no post, no claim and no one's results, so a report counts only what the Cloud
keeps without them.

## What we count

For Fact-check and for UnEcho Chamber, in the quarter:

- how many finished;
- how many didn't finish (they failed, or were cancelled or abandoned);
- how many were refused before any AI call (a daily limit was reached, the feature wasn't offered, or too many requests
  came at once);
- how many web searches they made;
- how many people used them.

Counts from 1 to 9 are shown as "fewer than 10", so no one can be singled out.

Each report also lists:

- the AI models that served them and the prompt versions they ran;
- unAlgorithm Cloud's source list: its version at the end of the quarter, how many of its outlets had a lean in each
  bucket (Left, Leans left, Center, Leans right, Right), and how many outlets were added, edited, removed and imported
  during the quarter;
- the corrections people sent us, for each feature, and how they ended: corrected, no change, out of scope, closed
  another way (a duplicate, spam and the like), or not answered yet. These are shown exactly: they count requests, not
  people, and nothing in them identifies anyone;
- the source list appeals we received, and how they ended;
- the quarterly audit's findings.

## What we can't count

- Verdicts. unAlgorithm Cloud keeps no one's results: the only verdicts it holds are those of claims checked in the
  last 24 hours, under a keyed hash and with nothing about who checked them, so that an earlier check can be reused. It
  never records how many claims were found disputed, or what a comparison showed, so the reports have no verdict counts.
  The verdicts on our test sets are in [Evaluations and trust gates](evals.md).
- Checks and comparisons run on your own key or your own server. They never reach us.
- Anything about who checked what.
- Anything about people's own source lists.

## How a report is made

After the quarter ends, a HeitechSoft maintainer runs the server's `transparency` command on unAlgorithm Cloud:

```sh
docker compose exec server node apps/server/src/cli/transparency.ts --quarter 2026-Q4
```

It reads the counts above from the rows the Cloud keeps without content, prints the report and changes nothing. A
self-hosted server can print its own report with the same command.

The same command counts corrections, from what unAlgorithm Cloud keeps: the problem reports of kind `correction` that
people sent from unAlgorithm in the quarter, by feature and by how they ended. A correction is deleted after 90 days
and leaves only one more in its quarter's count, by feature and outcome, so the command adds those counts to the
corrections still kept. Corrections sent by email are added by hand, counted without names.

Source list appeals are counted by hand: the GitHub issues labelled `source-list-appeal` opened in the quarter, by how
they ended (closed as changed, closed with no change, still open), plus the appeals sent by email, counted without
names.

The audit's findings follow the [Quarterly audit](corrections.md#quarterly-audit), with the quarter's list changes
taken from the source list's public change history at
[https://cloud.unalgorithm.app/outlets](https://cloud.unalgorithm.app/outlets).

## Reports

The first report covers October to December 2026 and will be published in January 2027. Each report is added below,
newest first, as the command printed it, followed by the hand-counted appeals, emailed corrections and audit lines.
