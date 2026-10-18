# AI sources

AI is optional. Rules handle ads, suggested posts, activity and people you don't follow on their own. AI adds:

- **Relevance** to your interests (0–100), used for "For you" highlights and, in Calm, for hiding off-topic posts.
- **Noise labels:** engagement bait, rage bait, clickbait, promotional, low-effort.
- A short reason, shown in "Why?" and always labelled "can be wrong".

## Choosing a source

| Source | Cost | Privacy | Setup |
|---|---|---|---|
| **On this device** (the browser's built-in AI: Gemini Nano in Chrome, Edge's own model in its preview builds) | Free | Nothing leaves your computer | Chrome 138+ on a capable computer, or Edge Canary or Dev with the Prompt API turned on in `edge://flags`; the browser downloads the model once. Not in Firefox |
| **Your own key: Anthropic** | Pay Anthropic directly; about $0.07 per 1,000 posts with Claude Haiku 5.5 | Post text goes to Anthropic | Paste a key from console.anthropic.com |
| **Your own key: OpenAI** | Pay OpenAI | Post text goes to OpenAI (`store: false`) | Paste a key from platform.openai.com |
| **Google Gemini, OpenRouter, Groq** | Pay the provider | Post text goes to the provider | Paste a key; unAlgorithm recognizes it by prefix |
| **Local: Ollama, LM Studio** | Free | Stays on your machine or network | Run the server and pick a model |
| **Self-hosted or private** (any OpenAI-compatible server, HeitechSoft Private AI) | Your infrastructure | Goes to your server | Enter the base URL and, if needed, a key |
| **unAlgorithm Cloud** | Pay-as-you-go credits (Phase 2) | Goes to HeitechSoft's gateway (nothing logged or stored), then Anthropic; see the [privacy model](privacy-model.md#where-post-text-goes) | Coming soon |

Set it up in onboarding or **Settings → AI**. **Test and save** asks for permission to reach that one server,
lists its models, picks a small default and runs a one-post probe: "Connected · Claude Haiku 5.5 · 640 ms". To use
another model, choose it under **Model** in Settings → AI; each choice is tested with one post before it is saved.

In Firefox the same prompt also asks for Firefox's consent to share website content and personal communications (the
posts are other people's social media posts), for a server on this computer (`localhost`, `127.0.0.1`, `[::1]`) too:
it is outside the browser. If that consent is withdrawn in Firefox's add-ons page, the source stops like one whose
permission was removed, until **Test and save** asks again.

Paid sources have a **daily limit** (default 300 posts). When it is reached, posts that would have been classified
show "Daily limit reached" and rules keep working.

## How it works

- Only posts that pass the rules and are near the viewport are sent: 6 per request to Anthropic and OpenAI, 4 to
  OpenAI-compatible servers, 2 on-device.
- Results are cached for 14 days, keyed by post, text hash, interests hash, source and model, and prompt version, so
  reloads are free and changing your interests re-classifies only what you see.
- One strict JSON schema is used everywhere:
  - Anthropic: structured outputs (`output_config.format`), `claude-haiku-5-5`, effort low, thinking off, cached system
    prompt.
  - OpenAI: Responses API with strict `json_schema`, `store: false`.
  - OpenAI-compatible: tries `json_schema`, then `json_object`, then prompt-only, and remembers what works per server
    and model.
  - On-device: `responseConstraint`.
- If a model refuses a batch, the batch is split until only the offending post fails. Ids the model skipped are
  retried once. Usage is recorded even when a call fails, so the cost shown in Settings is honest.

## Local models

**Ollama** rejects requests from extension origins by default (HTTP 403). In Settings → AI, **Fix it for me** adds a
rule that removes the `Origin` header from unAlgorithm's own requests to your Ollama address only. In Chrome and Edge
it asks for the `declarativeNetRequestWithHostAccess` permission first; Firefox grants that permission with the
extension, so it asks nothing. Alternatively start Ollama with `OLLAMA_ORIGINS=chrome-extension://*,moz-extension://*`
(Chrome and Edge use the first, Firefox the second).

**LM Studio**: start the local server (Developer → Start Server) and enable CORS.

Small models (3–8B) work for noise labels; relevance is better with larger ones.

## Adding a provider

If it speaks the OpenAI chat completions API:

1. Add its id to `COMPAT_PRESETS` in `packages/core/src/ai-source.ts`.
2. Add an entry to `COMPAT_PRESET_INFO` in `packages/ai/src/presets.ts` (label, base URL, auth, whether it is local,
   help text).
3. Add preferred models to `COMPAT_PREFERENCES` in `packages/ai/src/models.ts`.
4. If users paste a key for it, add it to `KEY_PROVIDERS` in `packages/ai/src/presets.ts` (key prefix, origin, how
   to get a key).

Otherwise implement an `AIClient` in `packages/ai/src/` and add a source kind to `AISourceConfigSchema` in
`packages/core/src/ai-source.ts`.

## Fact-check

With your own Anthropic key, **Settings → AI → Fact-check** checks the claims in a public post you choose. It is
three calls on your key, directly from your browser: Claude Haiku 5.5 picks up to 3 claims, Claude Sonnet 5.5
researches them with Anthropic's web search (one search per claim plus one, at most 5; web search must be turned on for your Anthropic
organization), and Sonnet gives a verdict per claim, keeping only citations that trace to the sources it found.
A check ends within 4 minutes. Its cost is added to today's cost in Settings but does not count toward the daily post
limit. Results stay in the tab's session storage (the 5 newest per tab) and go when the tab closes. Facebook posts
that aren't public are never checked.

With an unAlgorithm server as your source, fact-check runs on that server when it offers it: the extension sends the
post (the same fields classification sends) to the server, which researches it with its own model and search provider
and keeps nothing of the post once the check is gone from its memory (at most 10 minutes). On a server that charges,
the price is shown before you confirm and a check that stops early costs nothing. Closing the tab cancels a running
check. See the [privacy model](privacy-model.md#fact-check).
