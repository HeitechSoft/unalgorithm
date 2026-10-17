# @unalgorithm/outlets

Source lists for UnEcho Chamber: the shapes and rules of a list of news outlets that UnEcho Chamber sorts coverage
with, each outlet with its name, web addresses and, only where a person set one, a lean.

- **Code** (`src/`, `test/`): AGPL-3.0-only, as the rest of the repository.
- **Data** (`data/candidates.json`): Creative Commons Attribution 4.0 International (CC BY 4.0), legal code in
  [`data/LICENSE`](data/LICENSE). A server's published list (`/outlets.json`) is CC BY 4.0 too.

## What is here

- `SourceList`: the one shape every UnEcho Chamber run reads, whichever list it is: UnAlgorithm Cloud's published
  list (`officialSourceList`, from the protocol's `OfficialListSchema`), a person's own list, or the test fixture. An
  outlet's lean there is its bucket alone; evidence never travels with a run.
- The list rules (`listProblems`, `listProblemText`): ids are unique; a web address belongs to at most one outlet and
  is never nested under another outlet's; at most 300 outlets and 400 web addresses in all.
- The lookups: `outletForHost` (which outlet a link's host belongs to) and `outletsIn` (a bucket's outlets, the input
  of its search). `domainFromInput` and `outletIdFromName` turn what a person types into a web address and an id.
- The balance rule (`listBalance`), below.
- The candidate list (`bundledCandidates()`, `data/candidates.json`).

## Where leans come from

People only. On UnAlgorithm Cloud's list, its admins set a lean with one approval and evidence (an HTTPS link and a
note), and every change is published at once with a public change history. On a person's own list, that person sets
the leans, and every result from it says no one reviewed them. Never a model, never an agent, never inferred from
anything else.

`data/candidates.json` is a **candidate list**: 169 general-news outlets (114 US, 55 Canadian) that an agent listed by
name, main web addresses and country, as a starting point that admins import and people copy: national newspapers and
broadcasters, wire services, national digital-native news sites, the largest regional dailies, and a few major Spanish-
and French-language outlets. Satire, opinion-only blogs, aggregators and outlets based outside the US and Canada were
left out. No source page was opened while preparing it, so its web addresses are unchecked too. It is not an endorsement, a ranking or a grouping;
outlets are sorted by id. Its schema (`CandidatesSchema`) allows no lean at all: every `lean` is `null`, and a file
with any other value fails to parse.

## Appeals

A lean on UnAlgorithm Cloud's list, or an outlet's name, web addresses or country there, is appealed to the Cloud's
admins: see [Source list appeals](../../docs/site/corrections.md#source-list-appeals). A person's own list is theirs,
and is not appealed.

## The balance rule

`listBalance` counts the outlets with a lean in each bucket and warns, in plain words, when:

- a bucket has fewer than **2** outlets (`MIN_OUTLETS_PER_BUCKET`): "No outlets in Right.", "Only 1 outlet in Center.";
- one side has more than **2 times** the other's outlets (`MAX_SIDE_RATIO`), the left side being Left and Leans left,
  the right side Leans right and Right: "Left and Leans left have 9 outlets, Leans right and Right have 2."

A warning never blocks a run. The only list UnEcho Chamber can't use is one with no outlet with a lean. The same rule
and words apply to every list, wherever it is shown.

## Tests

Tests use `FIXTURE_OFFICIAL_LIST` and `FIXTURE_LIST` from `@unalgorithm/outlets/testing`: ten fictional outlets on
`.example` web addresses only, two per bucket, whose evidence notes carry `FIXTURE_MARKER` so a store build can be
checked for them. No test names a real outlet with a lean.
