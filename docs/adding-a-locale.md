# Adding a language

unAlgorithm has two kinds of language support: the **extension's own UI** (popup, settings, in-feed text) and
**reading a site in another language** (detecting "Sponsored" or "Suggested" when LinkedIn or Facebook is set to
French, Spanish…). Today both are English only.

## Reading a site in another language

Detection relies on the site's labels, so each site needs markers per UI language.

1. Set the site to the language in your dev profile.
2. Capture fixtures with the capture script ([fixtures.md](fixtures.md)). The scrambler keeps the site's English UI
   labels; add the new language's labels to the `KEEP` pattern in `scripts/capture/<platform>.js` and to `ALLOW` in
   `scripts/check-fixtures.mjs` first, or they will be scrambled too.
3. Copy `packages/platforms/src/<platform>/markers/en.ts` to `markers/<lang>.ts` and translate each pattern from what
   you see in the fixtures. Keep patterns anchored (`^…$`) so names cannot match.
4. Register it in the `MARKERS` map in `packages/platforms/src/<platform>/adapter.ts`.
5. Add tests that run the fixtures through the adapter with `markersFor('<lang>')`.

Until a language has markers, `markersFor()` returns `null`: text-based detectors switch off and the health monitor
reports `unsupported-locale`, so nothing is hidden by mistake.

## Translating the extension

The manifest name and description are in `apps/extension/public/_locales/<lang>/messages.json`. Moving the remaining
interface strings into `_locales` is on the roadmap (French for Canada first). Until then, UI copy lives next to the
components; follow the voice guide in [design/ux-spec.md](design/ux-spec.md) when changing it.
