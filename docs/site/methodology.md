# How Fact-check and UnEcho Chamber work

Fact-check checks the factual claims in a public post you pick against sources found on the web. UnEcho Chamber shows
how outlets across the spectrum covered the story behind a shared news link. Both run only when you click, show the
price first, are labelled AI-generated, and show every source they used, so you can read them yourself.

## When they run

- Only when you click. Nothing is checked or compared on its own.
- Only on public posts. A Facebook post that isn't public never gets either.
- Only on posts the AI flagged as news or as making checkable claims. UnEcho Chamber needs news that shares a link.
- Only when your AI option can search the web: your own Anthropic or OpenAI key, your own AI server with a Brave or
  Tavily key, or an unAlgorithm server that offers them.
- The price comes first, or "Free on this server", and nothing runs until you confirm.

Turn on Fact-check in Settings → AI → Fact-check, and UnEcho Chamber in Settings → AI → UnEcho Chamber. Both are off
until you do. UnEcho Chamber also needs a source list with at least one outlet with a lean (see
[Where leans come from](#where-leans-come-from)).

## Fact-check

### What is sent

The post's text, with the same masking as classification (email addresses and phone numbers always masked, @mentions
and tagged names masked unless you turned that off), at most 2,000 characters, and a shared link's domain and title.
Nothing about the post's author, and not your interests. It goes directly to your AI provider, or to your unAlgorithm
server only. The [privacy policy](../../PRIVACY.md) says where each AI option sends it.

### How a check works

1. The AI picks at most 3 claims from the post that can be checked against sources.
2. It researches them on the web: one search per claim plus one, at most 5 searches in all.
3. A separate verdict step gives each claim a verdict. It has no tools, so it can't search or open anything, and it
   must answer in a fixed format.

The exact instructions each step gets, the models and the answer formats are published in
[Published prompts](prompts.md).

### Verdicts

Each claim gets one of five verdicts, always in words:

- **Supported**: the sources clearly confirm the claim.
- **Disputed**: the sources clearly contradict the claim.
- **Misleading**: the facts are partly right but presented in a way that gives a wrong impression.
- **Needs context**: the claim is accurate but leaves out context that changes what it means.
- **Can't verify**: the sources don't settle it either way.

When the sources don't settle a claim, the verdict is Can't verify.

### What code checks, not the AI

The AI's answer is checked by code before you see it:

- A citation must point to a source found in that check. Any other citation is dropped.
- Each quote is at most 25 words and must be found in that source's text, or it is dropped.
- A verdict with citations from fewer than 2 independent sites becomes Can't verify.
- Satire and content-farm sites on the blocklist are never cited. People review the blocklist before anything is added
  to it, and it is published with the prompts.
- On an unAlgorithm server, links that no longer exist are dropped.
- Verdicts are about claims, never about people: a result has no place for the name of whoever made or shared a claim.

### Earlier checks

A claim checked in the last 24 hours on the same unAlgorithm server, or on your device, may show the earlier verdict
instead of being researched again, marked with the date it was checked. What is kept for each such claim is a keyed hash
of it (never the claim itself), the verdict, the short explanation, the sources' addresses, titles and quotes, and the
hour of the check; never the post or who checked. The [privacy policy](../../PRIVACY.md) has the details.

## UnEcho Chamber

### What is sent

The shared link (with tracking parameters removed) and its title, never the post's text, its author or anything about
you. To an unAlgorithm server, also your chosen list's outlets with a lean, as web addresses and leans without names,
kept in its memory for that comparison only and never stored or logged. To your own AI provider, each search's web
addresses, never which lean they have.

### How a comparison works

1. The AI writes a neutral search query for the story from the link and its title.
2. One search per lean bucket, only on the chosen list's outlets with that lean, for coverage dated within ± 3 days of
   the story (the date in the link's address, or else the time you ran it). Code, not the AI, picks the sites and the
   dates, and leaves out anything outside them. Each bucket keeps at most 4 sources.
3. A comparison step reads what was found and writes the facts agreed across at least 2 buckets; the differences in
   emphasis, framing, sourcing or omission; and the claims only one outlet reports. Every point cites its sources, and
   code checks the citations as it does for Fact-check.

A bucket with no coverage is shown as a gap, never filled in. The exact instructions are in
[Published prompts](prompts.md).

### Where leans come from

Each outlet on a source list sits in one of five buckets: Left, Leans left, Center, Leans right or Right. You choose the
list in Settings → AI → UnEcho Chamber:

- **unAlgorithm Cloud's source list** is set by unAlgorithm Cloud's admins. Each lean comes with evidence and is
  published as soon as it is saved, and every change is listed publicly on the list's page,
  [https://cloud.unalgorithm.app/outlets](https://cloud.unalgorithm.app/outlets), which never names the admin who made
  it.
- **Your own list** starts as a copy of the Cloud's (or of the candidate outlets, with no leans, while the Cloud's has
  none) and its leans are yours. No one reviews them.

Never the AI. No prompt names a side, and the AI is never told which bucket a source is in: code sorts every source
into its bucket from the list. Each result says which list it used, unAlgorithm Cloud's source list (with its version)
or your own list.

### When a list isn't balanced

UnEcho Chamber warns, in Settings, in the list editor, beside the price and on the result, when a bucket has fewer than
2 outlets with a lean, or when the left (Left, Leans left) and the right (Leans right, Right) differ by more than 2
times. It still runs, except on a list with no outlet with a lean.

Why it matters even though each bucket shows at most 4 sources: each bucket's search covers only that bucket's outlets,
so the more outlets one side has, the likelier its coverage of a story is found at all, and the other side's shows as a
gap.

## How we test

Before a prompt or a model changes, each AI option runs the evaluation sets, made up for testing with no real post,
person or outlet, and must pass the trust gates. For Fact-check: the same verdict on slant-flipped twins (two posts
stating one fact, one approvingly and one disapprovingly) 95 %, citations traced to a source found in that run 100 %,
and cited links still live 97 %. For UnEcho Chamber: citations traced 100 %, cited links still live 97 %, and leans
from the list 100 %: every source shown carries the lean the chosen list gives its outlet. Live runs are published,
passed or failed. The sets, the gates and the results are in [Evaluations and trust gates](evals.md).

## Known limits

- AI can be wrong. Open the sources and read them.
- With an OpenAI key, the text a quote is checked against is what the model wrote next to each link, not the page
  itself.
- Search results without a date are left out of UnEcho Chamber, so gaps are common.
- Whether two articles cover the same event is the AI's call.
- The candidate outlets are from the US and Canada only.
- A result on your own list is only as balanced as your list.

## Mistakes and appeals

If a result got something wrong, or an outlet's lean on unAlgorithm Cloud's source list looks wrong, see
[Corrections and appeals](corrections.md). Each quarter we publish a [transparency report](transparency.md).
