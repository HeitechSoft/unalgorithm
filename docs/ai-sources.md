# AI sources

AI is optional. Rules handle ads, suggested posts, activity and people you don't follow on their own. AI adds:

- **Relevance** to your interests (0–100), used for "For you" highlights and, in Calm, for hiding off-topic posts.
- **Noise labels:** engagement bait, rage bait, clickbait, promotional, low-effort.
- A short reason, shown in "Why?" and always labelled "can be wrong".

## Choosing a source

| Source | Cost | Privacy | Setup |
|---|---|---|---|
| **On this device** (Chrome built-in AI, Gemini Nano) | Free | Nothing leaves your computer | Chrome 138+ on a capable computer; Chrome downloads the model once |
| **Your own key: Anthropic** | Pay Anthropic directly; about $0.07 per 1,000 posts with Claude Haiku 5.5 | Post text goes to Anthropic | Paste a key from console.anthropic.com |
| **Your own key: OpenAI** | Pay OpenAI | Post text goes to OpenAI (`store: false`) | Paste a key from platform.openai.com |
| **Google Gemini, OpenRouter, Groq** | Pay the provider | Post text goes to the provider | Paste a key; UnAlgorithm recognizes it by prefix |
| **Local: Ollama, LM Studio** | Free | Stays on your machine or network | Run the server and pick a model |
| **Self-hosted or private** (any OpenAI-compatible server, HeitechSoft Private AI) | Your infrastructure | Goes to your server | Enter the base URL and, if needed, a key |
| **UnAlgorithm Cloud** | Pay-as-you-go credits (Phase 2) | HeitechSoft gateway, zero retention | Coming soon |

Set it up in onboarding or **Settings → AI**. **Test and save** asks for permission to reach that one server,
lists its models, picks a small default and runs a one-post probe: "Connected · Claude Haiku 5.5 · 640 ms". To use
another model, choose it under **Model** in Settings → AI; each choice is tested with one post before it is saved.

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
rule that removes the `Origin` header for requests to your Ollama address only (it asks for the
`declarativeNetRequestWithHostAccess` permission). Alternatively start Ollama with
`OLLAMA_ORIGINS=chrome-extension://*`.

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
