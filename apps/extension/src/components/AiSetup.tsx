import { downloadOnDeviceModel } from '@unalgorithm/ai/chrome-builtin';
import {
  COMPAT_PRESET_INFO,
  detectProvider,
  isExpensiveModel,
  KEY_PROVIDERS,
  type KeyProvider,
  modelLabel,
  originPattern,
} from '@unalgorithm/ai/presets';
import { type AISourceConfig, type CompatPreset, type Device, sourceId } from '@unalgorithm/core';
import {
  Badge,
  Banner,
  Button,
  Check,
  ChoiceCard,
  ChoiceCardGroup,
  ExternalLink,
  ProgressBar,
  SecretField,
  TextField,
} from '@unalgorithm/ui';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { sendToBackground } from '../lib/messages.ts';
import { serverLabel } from '../lib/server-label.ts';
import { ORIGIN_RULE_ID } from '../lib/storage.ts';
import { CLOUD_ENABLED, ServerSetup } from './ServerSetup.tsx';

type Choice = 'none' | 'on-device' | 'key' | 'local' | 'cloud';
type Availability = 'no-api' | 'unavailable' | 'downloadable' | 'downloading' | 'available' | 'checking';

function choiceOf(cfg: AISourceConfig | null): Choice {
  if (!cfg) return 'none';
  if (cfg.kind === 'on-device') return 'on-device';
  if (cfg.kind === 'anthropic' || cfg.kind === 'openai') return 'key';
  if (cfg.kind === 'openai-compatible')
    return COMPAT_PRESET_INFO[cfg.preset].local || cfg.preset === 'heitech-private' ? 'local' : 'key';
  return 'cloud';
}

function keyConfig(p: KeyProvider): AISourceConfig {
  if (p === 'anthropic') return { kind: 'anthropic', model: null };
  if (p === 'openai') return { kind: 'openai', model: null };
  return { kind: 'openai-compatible', preset: p, baseUrl: COMPAT_PRESET_INFO[p].baseUrl, auth: 'bearer', model: null };
}

const LOCAL_PRESETS: CompatPreset[] = ['ollama', 'lmstudio', 'heitech-private', 'custom'];

/**
 * Add a rule that strips the Origin header from this extension's own requests to a local server (Ollama otherwise
 * refuses them). Limited to requests initiated by the extension so web pages gain nothing. See ADR 0004.
 */
async function fixLocalOrigin(baseUrl: string): Promise<boolean> {
  const granted = await browser.permissions.request({ permissions: ['declarativeNetRequestWithHostAccess'] });
  if (!granted) return false;
  const u = new URL(baseUrl);
  const dnr = browser.declarativeNetRequest;
  await dnr.updateDynamicRules({
    removeRuleIds: [ORIGIN_RULE_ID],
    addRules: [
      {
        id: ORIGIN_RULE_ID,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
        condition: {
          urlFilter: `|${u.protocol}//${u.host}/`,
          resourceTypes: ['xmlhttprequest', 'other'],
          initiatorDomains: [browser.runtime.id],
        },
      },
    ] as never,
  });
  return true;
}

export function AiSetup({
  device,
  onSaved,
  showCloud = true,
}: {
  device: Device;
  onSaved?(cfg: AISourceConfig | null): void;
  showCloud?: boolean;
}) {
  const current = device.aiSource;
  const [choice, setChoice] = useState<Choice>(choiceOf(current));
  const [availability, setAvailability] = useState<Availability>('checking');
  const [progress, setProgress] = useState<number | null>(null);
  const [provider, setProvider] = useState<KeyProvider>('anthropic');
  const [key, setKey] = useState('');
  const [preset, setPreset] = useState<CompatPreset>('ollama');
  const [baseUrl, setBaseUrl] = useState(COMPAT_PRESET_INFO.ollama.baseUrl);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; fix?: boolean } | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    void sendToBackground({ type: 'onDeviceStatus' })
      .then((r) => setAvailability(r.availability))
      .catch(() => setAvailability('no-api'));
  }, []);

  const finish = async (cfg: AISourceConfig | null, apiKey?: string) => {
    await sendToBackground({ type: 'saveSource', config: cfg, ...(apiKey ? { apiKey } : {}) });
    onSaved?.(cfg);
  };

  const test = async (cfg: AISourceConfig, apiKey?: string) => {
    setBusy(true);
    setResult(null);
    let res: Awaited<ReturnType<typeof sendToBackground<'testSource'>>>;
    try {
      res = await sendToBackground({ type: 'testSource', config: cfg, ...(apiKey ? { apiKey } : {}) });
    } catch {
      setResult({ ok: false, text: 'UnAlgorithm could not run the test. Reload this page and try again.' });
      return;
    } finally {
      setBusy(false);
    }
    if (!res.ok) {
      setResult({ ok: false, text: res.error.message, fix: res.error.code === 'origin-blocked' });
      return;
    }
    const saved = 'model' in cfg ? ({ ...cfg, model: res.model } as AISourceConfig) : cfg;
    try {
      await finish(saved, apiKey);
    } catch {
      setResult({ ok: false, text: 'The test worked, but the setting could not be saved. Try again.' });
      return;
    }
    setResult({
      ok: true,
      text: `Connected · ${modelLabel(res.model)} · ${res.latencyMs < 1000 ? `${res.latencyMs} ms` : `${(res.latencyMs / 1000).toFixed(1)} s`}${isExpensiveModel(res.model) ? ' · this model costs more for every post; you can choose a smaller one in Settings → AI' : ''}`,
    });
  };

  // Permission prompts must start directly from the click, before any other await.
  const testKey = () => {
    const p = detectProvider(key) ?? provider;
    const info = KEY_PROVIDERS[p];
    void browser.permissions.request({ origins: [`${info.origin}/*`] }).then((granted) => {
      if (!granted)
        return setResult({
          ok: false,
          text: `UnAlgorithm needs permission to reach ${new URL(info.origin).hostname}. That's the only place your key and post text go.`,
        });
      void test(keyConfig(p), key.trim());
    });
  };

  const testLocal = () => {
    let pattern: string;
    try {
      pattern = originPattern(baseUrl);
    } catch {
      return setResult({ ok: false, text: 'Enter a full address, like http://localhost:11434/v1' });
    }
    const info = COMPAT_PRESET_INFO[preset];
    void browser.permissions.request({ origins: [pattern] }).then((granted) => {
      if (!granted) return setResult({ ok: false, text: `UnAlgorithm needs permission to reach ${info.label}.` });
      void test(localConfig(), token || undefined);
    });
  };

  const localConfig = (): AISourceConfig => ({
    kind: 'openai-compatible',
    preset,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    auth: token ? 'bearer' : 'none',
    model: null,
  });

  const download = () => {
    setProgress(0);
    downloadOnDeviceModel((p) => setProgress(p))
      .then(async () => {
        setAvailability('available');
        setProgress(null);
        await test({ kind: 'on-device' });
      })
      .catch((e: unknown) => {
        setProgress(null);
        setResult({ ok: false, text: e instanceof Error ? e.message : 'The download could not start.' });
      });
  };

  const detected = detectProvider(key);
  const activeProvider = detected ?? provider;

  return (
    <ChoiceCardGroup<Choice>
      label="Run AI with"
      value={choice}
      onValueChange={(c) => {
        setChoice(c);
        setResult(null);
        if (c === 'none')
          finish(null).catch(() => {
            setChoice(choiceOf(current));
            setResult({ ok: false, text: 'AI could not be turned off. Try again.' });
          });
      }}
    >
      {!showCloud ? null : CLOUD_ENABLED ? (
        // Every `server` source lands on this card, self-hosted ones too, so it never carries the Cloud's name, and it
        // promises no sync (CL3) and no billing (CL2) that a server doesn't have yet.
        <ChoiceCard
          value="cloud"
          title="UnAlgorithm server"
          description="No API key needed. Sign in to UnAlgorithm Cloud (invite only during the beta) or to an UnAlgorithm server you trust."
        >
          <ServerSetup device={device} onSaved={onSaved} />
        </ChoiceCard>
      ) : (
        <ChoiceCard
          value="cloud"
          disabled
          title="UnAlgorithm Cloud"
          badge={<Badge>Coming soon</Badge>}
          description="Nothing to set up and works on all your devices. Pay only for what you use."
        />
      )}
      <ChoiceCard
        value="on-device"
        disabled={availability === 'no-api' || availability === 'unavailable'}
        title="On this device"
        badge={<Badge tone="success">Free · Private</Badge>}
        description={
          availability === 'no-api' || availability === 'unavailable'
            ? "Not available on this computer. Chrome's built-in AI needs a recent Chrome, about 22 GB of free disk space, and a graphics card with more than 4 GB of memory or 16 GB of RAM."
            : "Uses Chrome's built-in AI. Posts never leave your computer."
        }
      >
        {availability === 'available' ? (
          <div className="ua-stack">
            <Button variant="primary" loading={busy} onClick={() => void test({ kind: 'on-device' })}>
              Turn on
            </Button>
          </div>
        ) : progress !== null || availability === 'downloading' ? (
          <div className="ua-stack">
            <ProgressBar value={progress ?? 0} label="Downloading the on-device model" />
            <span className="ua-footnote">
              Downloading… {Math.round((progress ?? 0) * 100)}%. You can keep going; Chrome finishes in the background.
            </span>
          </div>
        ) : (
          <div className="ua-stack">
            <Button variant="primary" onClick={download}>
              Download and turn on
            </Button>
            <span className="ua-footnote">A one-time download of a few gigabytes.</span>
          </div>
        )}
      </ChoiceCard>
      <ChoiceCard
        value="key"
        title="Your own API key"
        description="Anthropic, OpenAI, Google Gemini, OpenRouter or Groq. You pay them directly, usually a few cents a day with a fast, low-cost model."
      >
        <div className="ua-stack">
          <label className="ua-field">
            <span className="ua-field-label">Provider</span>
            <select
              className="ua-select"
              value={activeProvider}
              onChange={(e) => setProvider(e.target.value as KeyProvider)}
              disabled={!!detected}
            >
              {Object.values(KEY_PROVIDERS).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                  {p.freeTier ? ' (has a free tier)' : ''}
                </option>
              ))}
            </select>
          </label>
          <SecretField
            label="API key"
            placeholder="Paste your key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            hint={
              detected
                ? `Recognized as ${KEY_PROVIDERS[detected].label}.`
                : 'Stored only in this browser. Never synced or shared.'
            }
          />
          {KEY_PROVIDERS[activeProvider].freeTier ? (
            <span className="ua-footnote">Free tiers may use what you send to improve their models. Check their terms.</span>
          ) : null}
          <div className="ua-hstack ua-wrap">
            <Button variant="primary" loading={busy} disabled={key.trim().length < 8} onClick={testKey}>
              Test and save
            </Button>
            <Button variant="plain" onClick={() => setShowHelp(!showHelp)}>
              How do I get a key?
            </Button>
          </div>
          {showHelp ? (
            <div className="ua-card ua-card--pad ua-callout" style={{ background: 'var(--ua-bg-secondary)' }}>
              <ol style={{ listStyle: 'decimal', paddingLeft: 18, display: 'grid', gap: 4 }}>
                {KEY_PROVIDERS[activeProvider].steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
              <div style={{ marginTop: 10 }}>
                <Button size="sm" variant="tinted" trailingIcon={ExternalLink} href={KEY_PROVIDERS[activeProvider].keyUrl}>
                  Open {KEY_PROVIDERS[activeProvider].label.split(' ')[0]} console
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </ChoiceCard>
      <ChoiceCard
        value="local"
        title="Local or self-hosted"
        description="Ollama, LM Studio, HeitechSoft Private AI, or any OpenAI-compatible server."
      >
        <div className="ua-stack">
          <label className="ua-field">
            <span className="ua-field-label">Server</span>
            <select
              className="ua-select"
              value={preset}
              onChange={(e) => {
                const p = e.target.value as CompatPreset;
                setPreset(p);
                setBaseUrl(COMPAT_PRESET_INFO[p].baseUrl);
              }}
            >
              {LOCAL_PRESETS.map((p) => (
                <option key={p} value={p}>
                  {COMPAT_PRESET_INFO[p].label}
                </option>
              ))}
            </select>
          </label>
          <TextField
            label="Address"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            mono
            hint={COMPAT_PRESET_INFO[preset].help}
          />
          {preset === 'heitech-private' || preset === 'custom' ? (
            <SecretField label="Token (if the server needs one)" value={token} onChange={(e) => setToken(e.target.value)} />
          ) : null}
          <div>
            <Button variant="primary" loading={busy} onClick={testLocal}>
              Test and save
            </Button>
          </div>
        </div>
      </ChoiceCard>
      <ChoiceCard
        value="none"
        title="Off, rules only"
        description="Hide ads, suggested posts and people you don't follow without any AI. Nothing leaves your browser."
      />
      {result ? (
        <div style={{ gridColumn: '1 / -1' }}>
          {result.ok ? (
            <Banner tone="success" title={result.text} />
          ) : (
            <Banner
              tone="danger"
              title="That didn't work"
              {...(result.fix
                ? {
                    action: {
                      label: 'Fix it for me',
                      onAction: () =>
                        void fixLocalOrigin(baseUrl).then((ok) => {
                          if (ok) void test(localConfig(), token || undefined);
                        }),
                    },
                  }
                : {})}
            >
              {result.text}
            </Banner>
          )}
        </div>
      ) : current && choiceOf(current) === choice && choice !== 'none' ? (
        <span className="ua-footnote ua-hstack" style={{ gridColumn: '1 / -1', gap: 6 }}>
          <Check size={14} aria-hidden="true" /> In use
          {current.kind === 'server'
            ? ` · ${serverLabel(current.baseUrl).title}`
            : 'model' in current && current.model
              ? ` · ${modelLabel(current.model)}`
              : ''}
        </span>
      ) : null}
    </ChoiceCardGroup>
  );
}

/**
 * Lets the user switch the model of the configured source. Each choice is tested with one probe post before it is
 * saved, so a model that can't return structured results is never left in use.
 */
export function ModelPicker({ config }: { config: AISourceConfig }) {
  const [models, setModels] = useState<string[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const current = 'model' in config ? config.model : null;
  const id = sourceId(config);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only when the source itself changes, not its model
  useEffect(() => {
    setModels(null);
    setListError(null);
    setNote(null);
    void sendToBackground({ type: 'listModels', config })
      .then((r) => (r.ok ? setModels(r.models) : setListError(r.error.message)))
      .catch(() => setListError('Could not reach the AI server.'));
  }, [id]);

  if (!('model' in config)) return null;

  const choose = async (model: string) => {
    if (model === current) return;
    setBusy(true);
    setNote(null);
    try {
      const res = await sendToBackground({ type: 'testSource', config: { ...config, model } as AISourceConfig });
      if (res.ok) {
        await sendToBackground({ type: 'saveSource', config: { ...config, model: res.model } as AISourceConfig });
        setNote({
          ok: true,
          text: `Now using ${modelLabel(res.model)}${isExpensiveModel(res.model) ? '. It costs more for every post.' : '.'}`,
        });
      } else {
        setNote({ ok: false, text: res.error.message });
      }
    } catch {
      setNote({ ok: false, text: 'Could not reach the AI server. Try again.' });
    } finally {
      setBusy(false);
    }
  };

  const options = models ? Array.from(new Set([...(current ? [current] : []), ...models])) : current ? [current] : [];
  return (
    <div className="ua-stack" style={{ gap: 6 }}>
      <label className="ua-field">
        <span className="ua-field-label">Model</span>
        <select
          className="ua-select"
          value={current ?? ''}
          disabled={busy || !models}
          onChange={(e) => void choose(e.target.value)}
        >
          {current ? null : <option value="">Choose a model</option>}
          {options.map((m) => (
            <option key={m} value={m}>
              {modelLabel(m)}
              {isExpensiveModel(m) ? ' (costs more)' : ''}
            </option>
          ))}
        </select>
      </label>
      <span className="ua-footnote" role="status">
        {busy
          ? 'Testing the model…'
          : note
            ? note.text
            : listError
              ? listError
              : models === null
                ? 'Loading the models this source offers…'
                : models.length
                  ? 'Smaller, faster models are usually best: every post you scroll past is one request.'
                  : "This server doesn't list its models."}
      </span>
    </div>
  );
}
