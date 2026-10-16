import { type Device, type WebSearchProviderId, webSearchName, webSearchOrigin } from '@unalgorithm/core';
import { FEATURE_NAMES } from '@unalgorithm/protocol';
import { Banner, Button, ChoiceCard, ChoiceCardGroup, ExternalLink, SecretField } from '@unalgorithm/ui';
import { useState } from 'react';
import { browser } from 'wxt/browser';
import { sendToBackground } from '../lib/messages.ts';

/** Where each provider hands out API keys. */
const KEY_PAGES: Record<WebSearchProviderId, string> = {
  brave: 'https://api-dashboard.search.brave.com/app/keys',
  tavily: 'https://app.tavily.com/home',
};

const DESCRIPTIONS: Record<WebSearchProviderId, string> = {
  brave: 'Brave Search API. Has a free monthly allowance.',
  tavily: 'Tavily search API. Has a free monthly allowance.',
};

type Result = { ok: boolean; text: string };

/**
 * Settings → Labs, for an OpenAI-compatible source only (P3-45, F24): the person's own Brave or Tavily key, which
 * fact-check and UnEcho Chamber search the web with. The provider's host permission is asked for from the Save
 * click only. The saved key stays in the background and is never read back into this page.
 */
export function WebSearchKey({ device }: { device: Device }) {
  const saved = device.webSearch;
  const [provider, setProvider] = useState<WebSearchProviderId>(saved?.provider ?? 'brave');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  const store = async (p: WebSearchProviderId, apiKey: string) => {
    setBusy(true);
    try {
      const res = await sendToBackground({ type: 'saveSearchKey', provider: p, apiKey });
      if (!res.ok) return setResult({ ok: false, text: res.error.message });
      setKey('');
      setResult({ ok: true, text: `Connected · ${webSearchName(p)}` });
    } catch {
      setResult({ ok: false, text: 'UnAlgorithm could not save the key. Reload this page and try again.' });
    } finally {
      setBusy(false);
    }
  };

  // The permission prompt must start directly from the click, before any other await (Chrome needs the gesture).
  const save = () => {
    const p = provider;
    const apiKey = key.trim();
    const denied = () =>
      setResult({
        ok: false,
        text: `UnAlgorithm needs permission to reach ${new URL(webSearchOrigin(p)).hostname}. That's the only place your web search key and the search words go.`,
      });
    setResult(null);
    void browser.permissions
      .request({ origins: [`${webSearchOrigin(p)}/*`] })
      .then((granted) => (granted ? store(p, apiKey) : denied()), denied);
  };

  const remove = () => {
    setBusy(true);
    setResult(null);
    sendToBackground({ type: 'forgetSearchKey' })
      .catch(() => setResult({ ok: false, text: 'The key could not be removed. Try again.' }))
      .finally(() => setBusy(false));
  };

  return (
    <section className="ua-group">
      <h3 className="ua-group-header">Web search key</h3>
      <div className="ua-stack">
        <p className="ua-footnote" style={{ margin: 0 }}>
          {FEATURE_NAMES.factcheck} and {FEATURE_NAMES.perspectives} search the web with your own Brave or Tavily key. Only the
          claims (or, for {FEATURE_NAMES.perspectives}, the story's search words) are sent to it.
        </p>
        {saved ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span className="ua-grow">{webSearchName(saved.provider)} key saved</span>
            <Button variant="secondary" size="sm" loading={busy} onClick={remove}>
              Remove
            </Button>
          </div>
        ) : (
          <>
            <ChoiceCardGroup<WebSearchProviderId>
              label="Search with"
              value={provider}
              columns={2}
              onValueChange={(p) => {
                setProvider(p);
                setResult(null);
              }}
            >
              {(['brave', 'tavily'] as const).map((p) => (
                <ChoiceCard key={p} value={p} title={webSearchName(p)} description={DESCRIPTIONS[p]} />
              ))}
            </ChoiceCardGroup>
            <SecretField
              label={`${webSearchName(provider)} API key`}
              placeholder="Paste your key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              hint="Stored only in this browser. Never synced or shared."
            />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Button variant="primary" loading={busy} disabled={!key.trim()} onClick={save}>
                Save
              </Button>
              <Button variant="plain" size="sm" trailingIcon={ExternalLink} href={KEY_PAGES[provider]}>
                Get a {webSearchName(provider)} key
              </Button>
            </div>
          </>
        )}
        {result ? (
          <Banner tone={result.ok ? 'success' : 'danger'} title={result.ok ? result.text : "That didn't work"}>
            {result.ok ? undefined : result.text}
          </Banner>
        ) : null}
      </div>
    </section>
  );
}
