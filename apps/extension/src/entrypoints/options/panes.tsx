import {
  clipText,
  type Device,
  dayCostMicros,
  dayUsage,
  defaultSettings,
  FILTER_KEYS,
  type FilterKey,
  formatApproxCost,
  migrateSettings,
  noiseName,
  type PersonRule,
  type PlatformSettings,
  type Preset,
  presetOf,
  presetSummary,
  type Settings,
  STARTER_LESS_OF,
  STARTER_TOPICS,
  type Topic,
} from '@unalgorithm/core';
import { NOISE_LABELS, type NoiseLabel, type PlatformId, uuidv7 } from '@unalgorithm/protocol';
import {
  Badge,
  Banner,
  Button,
  Chip,
  Dialog,
  DisplayModeThumb,
  Download,
  ExternalLink,
  ListGroup,
  ListRow,
  Logo,
  Plus,
  SegmentedControl,
  Switch,
  TextField,
  Trash2,
  Upload,
  useToast,
  Wordmark,
  X,
} from '@unalgorithm/ui';
import { type ReactNode, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { AiSetup, ModelPicker } from '../../components/AiSetup.tsx';
import { CLOUD_ENABLED } from '../../components/ServerSetup.tsx';
import { useStorageItem, useSyncedServer } from '../../lib/hooks.ts';
import { sendQuietly, sendToBackground } from '../../lib/messages.ts';
import { recipientText, serverLabel } from '../../lib/server-label.ts';
import { replaceSettings } from '../../lib/settings-store.ts';
import { learnedItem, usageItem } from '../../lib/storage.ts';

type Save = (mutate: (s: Settings) => Settings | void) => Promise<void>;

const SITE: Record<PlatformId, string> = { linkedin: 'LinkedIn', facebook: 'Facebook' };

function Title({ children, intro }: { children: ReactNode; intro?: ReactNode }) {
  return (
    <>
      <h1 className="pane-title" tabIndex={-1}>
        {children}
      </h1>
      {intro ? <p className="pane-intro">{intro}</p> : null}
    </>
  );
}

const FILTER_COPY: Record<PlatformId, Record<FilterKey, { title: string; subtitle?: string }>> = {
  linkedin: {
    sponsored: { title: 'Promoted posts', subtitle: 'Ads labelled "Promoted"' },
    suggested: { title: 'Suggested posts', subtitle: 'Posts LinkedIn recommends from people you don’t follow' },
    networkActivity: { title: 'Activity from your network', subtitle: '"Jane likes this", unless you follow the author' },
    unjoinedGroups: { title: "Groups you haven't joined" },
    modules: { title: 'Feed panels', subtitle: 'People you may know, jobs, games, newsletters' },
    notFollowed: { title: "People and pages you don't follow", subtitle: 'Hides anyone shown with a Follow button' },
    reshares: { title: 'Reposts by people you follow' },
    reels: { title: 'Short videos' },
  },
  facebook: {
    sponsored: { title: 'Sponsored posts', subtitle: 'Ads in the feed and the right-hand column' },
    suggested: { title: 'Suggested for you', subtitle: 'Posts from pages, groups and people you don’t follow' },
    networkActivity: { title: 'Friend activity', subtitle: '"Jane commented on this", unless you follow the author' },
    unjoinedGroups: { title: "Groups you're not in" },
    modules: { title: 'Feed panels', subtitle: 'Reels tray, People you may know, suggested groups' },
    notFollowed: { title: "Pages you don't follow", subtitle: 'Posts shown with a Follow or Join button' },
    reshares: { title: 'Shares of other posts' },
    reels: { title: 'Reels in your feed' },
  },
};

const STRENGTHS = [
  { value: 'light', label: 'Light' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'calm', label: 'Calm' },
] as const;

// ---------- LinkedIn / Facebook ----------

export function PlatformPane({
  platform,
  settings,
  save,
  device,
}: {
  platform: PlatformId;
  settings: Settings;
  save: Save;
  device: Device;
}) {
  const ps = settings.platforms[platform];
  const preset = presetOf(platform, ps);
  const toast = useToast();
  const update = (mutate: (p: PlatformSettings) => void) =>
    save((s) => {
      mutate(s.platforms[platform]);
      s.platforms[platform].preset = presetOf(platform, s.platforms[platform]);
    });
  const order: FilterKey[] = [
    'sponsored',
    'suggested',
    'networkActivity',
    'unjoinedGroups',
    'modules',
    'reels',
    'notFollowed',
    'reshares',
  ];
  const aiOn = !!device.aiSource;

  return (
    <>
      <Title>{SITE[platform]}</Title>
      <ListGroup footer={`Works with ${SITE[platform]} in English. Changes apply instantly to open tabs.`}>
        <ListRow
          title={`Clean up my ${SITE[platform]} feed`}
          control={
            <Switch
              checked={ps.enabled}
              label={`Clean up my ${SITE[platform]} feed`}
              onCheckedChange={(v) => void update((p) => void (p.enabled = v))}
            />
          }
        />
      </ListGroup>
      <ListGroup header="Strength" footer={presetSummary(platform, preset)}>
        <div style={{ padding: 12 }}>
          <SegmentedControl<Preset>
            fullWidth
            label="Strength"
            value={preset === 'custom' ? null : preset}
            customLabel="Custom"
            options={STRENGTHS}
            onValueChange={(v) => sendQuietly({ type: 'settingsAction', action: { op: 'setPreset', platform, preset: v } })}
          />
        </div>
      </ListGroup>
      <ListGroup header="Hide" id="filters">
        {order
          .filter((k) => FILTER_KEYS.includes(k) && !(platform === 'linkedin' && k === 'reels'))
          .map((k) => {
            const copy = FILTER_COPY[platform][k];
            return (
              <ListRow
                key={k}
                id={`${platform}-${k}`}
                title={copy.title}
                subtitle={copy.subtitle}
                control={
                  <Switch
                    checked={ps.filters[k]}
                    label={copy.title}
                    onCheckedChange={(v) => void update((p) => void (p.filters[k] = v))}
                  />
                }
              />
            );
          })}
      </ListGroup>
      <ListGroup
        header={
          <span className="ua-hstack" style={{ gap: 6 }}>
            AI filters {aiOn ? null : <Badge tone="ai">Needs AI</Badge>}
          </span>
        }
        footer={aiOn ? 'AI decisions are marked with a sparkle and can be wrong. Use Why? on any hidden post.' : undefined}
      >
        {!aiOn ? (
          <ListRow
            title="Set up AI"
            subtitle="On-device, your own key, or a local model"
            accessory="chevron"
            onSelect={() => (location.hash = '#/ai')}
          />
        ) : null}
        <ListRow
          title="Off-topic posts"
          subtitle="Posts that don't match your interests"
          control={
            <Switch
              disabled={!aiOn}
              checked={ps.ai.lowRelevance}
              label="Off-topic posts"
              onCheckedChange={(v) => void update((p) => void (p.ai.lowRelevance = v))}
            />
          }
        />
        {NOISE_LABELS.map((l: NoiseLabel) => (
          <ListRow
            key={l}
            title={noiseName(l)}
            control={
              <Switch
                disabled={!aiOn}
                checked={ps.ai.noise[l]}
                label={noiseName(l)}
                onCheckedChange={(v) => void update((p) => void (p.ai.noise[l] = v))}
              />
            }
          />
        ))}
      </ListGroup>
      <ExceptionsGroup
        platform={platform}
        list="alwaysShow"
        title="Always show"
        empty="Use Why? on a hidden post to add people here."
        rules={ps.alwaysShow}
        onRemove={(id) => {
          void sendToBackground({
            type: 'settingsAction',
            action: { op: 'removePersonRule', platform, list: 'alwaysShow', id },
          })
            .then((r) =>
              toast({
                title: 'Removed.',
                ...(r.undo
                  ? {
                      action: {
                        label: 'Undo',
                        onAction: () => sendQuietly({ type: 'settingsAction', action: r.undo as never }),
                      },
                    }
                  : {}),
              }),
            )
            .catch(() => toast({ title: "Couldn't remove it. Try again." }));
        }}
      />
      <ExceptionsGroup
        platform={platform}
        list="alwaysHide"
        title="Always hide"
        empty="Add people or pages you never want to see."
        rules={ps.alwaysHide}
        onRemove={(id) =>
          sendQuietly({ type: 'settingsAction', action: { op: 'removePersonRule', platform, list: 'alwaysHide', id } })
        }
      />
    </>
  );
}

function matchFor(input: string): { label: string; match: string } | null {
  const v = input.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    const path = u.pathname.replace(/\/+$/, '').toLowerCase();
    if (!path) return null;
    return { label: path.split('/').pop() ?? v, match: path };
  } catch {
    return { label: v, match: `name:${v.toLowerCase()}` };
  }
}

function ExceptionsGroup({
  platform,
  list,
  title,
  empty,
  rules,
  onRemove,
}: {
  platform: PlatformId;
  list: 'alwaysShow' | 'alwaysHide';
  title: string;
  empty: string;
  rules: Record<string, PersonRule>;
  onRemove(id: string): void;
}) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState('');
  const entries = Object.entries(rules).sort((a, b) => b[1].addedAt - a[1].addedAt);
  const add = () => {
    const m = matchFor(value);
    if (!m) return;
    sendQuietly({
      type: 'settingsAction',
      action: { op: 'addPersonRule', platform, list, id: uuidv7(), rule: { ...m, addedAt: Date.now() } },
    });
    setValue('');
    setAdding(false);
  };
  return (
    <ListGroup header={title} footer={entries.length ? undefined : empty}>
      {entries.map(([id, r]) => (
        <ListRow
          key={id}
          title={r.label}
          subtitle={r.match.startsWith('name:') ? 'By name' : r.match}
          control={<Button size="sm" variant="plain" icon={X} onClick={() => onRemove(id)} aria-label={`Remove ${r.label}`} />}
        />
      ))}
      {adding ? (
        <div className="ua-hstack" style={{ padding: 12 }}>
          <TextField
            className="ua-grow"
            label="Profile, page or group link, or a name"
            labelHidden
            placeholder="Paste a profile link or type a name"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            autoFocus
          />
          <Button variant="primary" size="sm" onClick={add}>
            Add
          </Button>
        </div>
      ) : (
        <ListRow title="Add…" icon={{ icon: Plus, tint: 'gray' }} onSelect={() => setAdding(true)} />
      )}
    </ListGroup>
  );
}

// ---------- Display ----------

export function DisplayPane({
  settings,
  save,
  saveDevice,
}: {
  settings: Settings;
  save: Save;
  saveDevice: (m: (d: Device) => void) => Promise<void>;
}) {
  const d = settings.display;
  const set = <K extends keyof Settings['display']>(k: K, v: Settings['display'][K]) => save((s) => void (s.display[k] = v));
  const modes = [
    { value: 'collapse', label: 'Collapse', note: 'A thin line with Show and Why?' },
    { value: 'hide', label: 'Hide', note: 'Removed completely' },
    { value: 'dim', label: 'Dim', note: 'Faded until you point at it' },
  ] as const;
  return (
    <>
      <Title>Display</Title>
      <ListGroup header="Hidden posts look like" footer={modes.find((m) => m.value === d.mode)?.note}>
        <div className="thumbs" role="radiogroup" aria-label="Hidden posts look like">
          {modes.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={d.mode === m.value}
              className="thumb-option"
              onClick={() => void set('mode', m.value)}
            >
              <DisplayModeThumb mode={m.value} />
              {m.label}
            </button>
          ))}
        </div>
      </ListGroup>
      <ListGroup header="On hidden posts, show">
        <ListRow
          title="Reason"
          control={<Switch checked={d.showReason} label="Show the reason" onCheckedChange={(v) => void set('showReason', v)} />}
        />
        <ListRow
          title="Who it's from"
          control={
            <Switch checked={d.showAuthor} label="Show who it's from" onCheckedChange={(v) => void set('showAuthor', v)} />
          }
        />
        <ListRow
          title="Group hidden posts that are next to each other"
          subtitle='One line like "3 hidden" instead of a ladder of lines'
          control={<Switch checked={d.groupRuns} label="Group hidden posts" onCheckedChange={(v) => void set('groupRuns', v)} />}
        />
      </ListGroup>
      <ListGroup header="Posts for you">
        <ListRow
          title="Highlight posts for you"
          control={
            <Switch
              checked={settings.highlights.enabled}
              label="Highlight posts for you"
              onCheckedChange={(v) => void save((s) => void (s.highlights.enabled = v))}
            />
          }
        />
        <div style={{ padding: 12 }}>
          <SegmentedControl
            fullWidth
            label="Highlight style"
            value={d.forYou}
            options={[
              { value: 'ring', label: 'Ring and label' },
              { value: 'label', label: 'Label only' },
              { value: 'off', label: 'Off' },
            ]}
            onValueChange={(v) => void set('forYou', v)}
          />
        </div>
      </ListGroup>
      <ListGroup header="Toolbar and tips">
        <ListRow
          title="Show number of hidden posts on the toolbar icon"
          control={
            <Switch
              checked={d.badgeCount}
              label="Show count on toolbar icon"
              onCheckedChange={(v) => void set('badgeCount', v)}
            />
          }
        />
        <ListRow
          title="Show tips"
          control={<Switch checked={d.tips} label="Show tips" onCheckedChange={(v) => void set('tips', v)} />}
        />
        <ListRow
          title="Show the feed tip again"
          onSelect={() =>
            void saveDevice((dev) => {
              dev.onboarding.coachMarkShown = { linkedin: false, facebook: false };
            })
          }
        />
        <ListRow
          title="Replay setup"
          accessory="chevron"
          onSelect={() => sendQuietly({ type: 'openPage', page: 'onboarding' })}
        />
      </ListGroup>
    </>
  );
}

// ---------- Interests ----------

function TokenList({
  items,
  onAdd,
  onRemove,
  placeholder,
}: {
  items: [string, string][];
  onAdd(v: string): void;
  onRemove(id: string): void;
  placeholder: string;
}) {
  const [v, setV] = useState('');
  return (
    <div className="chips">
      {items.map(([id, label]) => (
        <span key={id} className="ua-pchip ua-pchip--static">
          {label}
          <button
            type="button"
            className="ua-icon-button"
            style={{ width: 20, height: 20 }}
            aria-label={`Remove ${label}`}
            onClick={() => onRemove(id)}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </span>
      ))}
      <input
        className="ua-input"
        style={{ minWidth: 160, flex: 1, height: 28 }}
        placeholder={placeholder}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && v.trim()) {
            onAdd(v.trim());
            setV('');
          }
        }}
        aria-label={placeholder}
      />
    </div>
  );
}

export function InterestsPane({ settings, save }: { settings: Settings; save: Save }) {
  const learned = useStorageItem(learnedItem, { weights: {}, events: [], decayedAt: 0 });
  const [about, setAbout] = useState(settings.interests.about);
  const toast = useToast();
  const toggleTopic = (list: 'more' | 'less', t: { id: string; label: string; keywords: string[] }, on: boolean) =>
    save((s) => {
      if (on) s.interests[list][t.id] = { label: t.label, keywords: t.keywords, addedAt: Date.now() } satisfies Topic;
      else delete s.interests[list][t.id];
    });
  const custom = (list: 'more' | 'less') =>
    Object.entries(settings.interests[list]).filter(([id]) => ![...STARTER_TOPICS, ...STARTER_LESS_OF].some((t) => t.id === id));
  return (
    <>
      <Title intro="Without AI, UnAlgorithm looks for related words. With AI, it understands topics, so it also catches posts that don't use the exact words.">
        Interests
      </Title>
      <ListGroup header="More of" footer="Posts about these get a quiet For you highlight.">
        <div className="chips">
          {STARTER_TOPICS.map((t) => (
            <Chip
              key={t.id}
              label={t.label}
              selected={!!settings.interests.more[t.id]}
              onSelectedChange={(on) => void toggleTopic('more', t, on)}
            />
          ))}
          {custom('more').map(([id, t]) => (
            <Chip key={id} label={t.label} selected onSelectedChange={() => void save((s) => void delete s.interests.more[id])} />
          ))}
        </div>
        <TokenList
          items={[]}
          placeholder="Add a topic, e.g. Supply chain"
          onAdd={(label) =>
            void save((s) => void (s.interests.more[uuidv7()] = { label, keywords: [label], addedAt: Date.now() }))
          }
          onRemove={() => undefined}
        />
      </ListGroup>
      <ListGroup header="Less of" footer="Posts that mention these are folded away, even without AI.">
        <div className="chips">
          {STARTER_LESS_OF.map((t) => (
            <Chip
              key={t.id}
              label={t.label}
              selected={!!settings.interests.less[t.id]}
              onSelectedChange={(on) => void toggleTopic('less', t, on)}
            />
          ))}
          {custom('less').map(([id, t]) => (
            <Chip key={id} label={t.label} selected onSelectedChange={() => void save((s) => void delete s.interests.less[id])} />
          ))}
        </div>
        <TokenList
          items={[]}
          placeholder="Add a topic to mute"
          onAdd={(label) =>
            void save((s) => void (s.interests.less[uuidv7()] = { label, keywords: [label], addedAt: Date.now() }))
          }
          onRemove={() => undefined}
        />
      </ListGroup>
      <ListGroup
        header="About you"
        footer="Optional. Sent to your AI with each request so it can judge relevance. Keep it general."
      >
        <div style={{ padding: 12 }}>
          <textarea
            className="ua-textarea"
            maxLength={500}
            placeholder="e.g. I run a small software company and follow AI, hiring and local tech events."
            value={about}
            onChange={(e) => setAbout(e.target.value)}
            onBlur={() => void save((s) => void (s.interests.about = clipText(about, 500))).then(() => toast({ title: 'Saved' }))}
            aria-label="About you"
          />
        </div>
      </ListGroup>
      <ListGroup header="Keywords" footer="Matches whole words, any letter case.">
        <ListRow title="Always highlight posts that mention" />
        <TokenList
          items={Object.entries(settings.interests.highlightWords).map(([id, k]) => [id, k.label])}
          placeholder="Add a word"
          onAdd={(label) => void save((s) => void (s.interests.highlightWords[uuidv7()] = { label, addedAt: Date.now() }))}
          onRemove={(id) => void save((s) => void delete s.interests.highlightWords[id])}
        />
        <ListRow title="Always hide posts that mention" />
        <TokenList
          items={Object.entries(settings.interests.muteWords).map(([id, k]) => [id, k.label])}
          placeholder="Add a word"
          onAdd={(label) => void save((s) => void (s.interests.muteWords[uuidv7()] = { label, addedAt: Date.now() }))}
          onRemove={(id) => void save((s) => void delete s.interests.muteWords[id])}
        />
      </ListGroup>
      <ListGroup header="What UnAlgorithm learned">
        <ListRow
          title="Learn from More like this and Not for me"
          control={
            <Switch
              checked={settings.ai.learnFromFeedback}
              label="Learn from feedback"
              onCheckedChange={(v) => void save((s) => void (s.ai.learnFromFeedback = v))}
            />
          }
        />
        <ListRow
          title={`You've rated ${learned.events.length} post${learned.events.length === 1 ? '' : 's'}`}
          subtitle={`${Object.keys(learned.weights).length} topics adjusted`}
        />
        <ListRow
          title="Reset what UnAlgorithm learned"
          tone="destructive"
          onSelect={() =>
            void sendToBackground({ type: 'clearData', what: 'learned' })
              .then(() => toast({ title: 'Reset.' }))
              .catch(() => toast({ title: "Couldn't reset. Try again." }))
          }
        />
      </ListGroup>
    </>
  );
}

// ---------- AI ----------

export function AiPane({ settings, save, device }: { settings: Settings; save: Save; device: Device }) {
  const usage = useStorageItem(usageItem, {});
  const day = dayUsage(usage);
  const cost = dayCostMicros(day);
  const cutoff = settings.ai.relevanceCutoff;
  return (
    <>
      <Title intro="Rules catch labelled noise. AI can also spot off-topic posts and engagement bait, and pick the posts most worth your time.">
        AI
      </Title>
      <section className="ua-group">
        <h3 className="ua-group-header">Run AI with</h3>
        <AiSetup device={device} />
      </section>
      {device.aiSource && 'model' in device.aiSource ? (
        <section className="ua-group">
          <h3 className="ua-group-header">Model</h3>
          <div className="ua-card ua-card--pad">
            <ModelPicker config={device.aiSource} />
          </div>
        </section>
      ) : null}
      <ListGroup header="Behaviour">
        <div style={{ padding: 12 }}>
          <div className="ua-headline" style={{ marginBottom: 6 }}>
            How strict is "off-topic"?
          </div>
          <SegmentedControl
            fullWidth
            label="Off-topic sensitivity"
            value={cutoff <= 25 ? 'gentle' : cutoff >= 50 ? 'strict' : 'standard'}
            options={[
              { value: 'gentle', label: 'Gentle' },
              { value: 'standard', label: 'Standard' },
              { value: 'strict', label: 'Strict' },
            ]}
            onValueChange={(v) => void save((s) => void (s.ai.relevanceCutoff = v === 'gentle' ? 25 : v === 'strict' ? 50 : 35))}
          />
        </div>
        <div style={{ padding: '0 12px 12px' }}>
          <div className="ua-headline" style={{ marginBottom: 6 }}>
            How many posts get a For you highlight?
          </div>
          <SegmentedControl
            fullWidth
            label="Highlights"
            value={settings.highlights.amount}
            options={[
              { value: 'fewer', label: 'Fewer' },
              { value: 'standard', label: 'Standard' },
              { value: 'more', label: 'More' },
            ]}
            onValueChange={(v) => void save((s) => void (s.highlights.amount = v))}
          />
        </div>
        <ListRow
          title="Hide @mentions and tagged people from the AI"
          subtitle="Email addresses and phone numbers are always hidden."
          control={
            <Switch
              checked={settings.ai.redactMentions}
              label="Hide @mentions and tagged people from the AI"
              onCheckedChange={(v) => void save((s) => void (s.ai.redactMentions = v))}
            />
          }
        />
      </ListGroup>
      <ListGroup header="Daily limit" footer="Applies to sources that cost money. Local and on-device AI are unlimited.">
        <ListRow
          title="Posts per day"
          subtitle={`Today: ${day.posts} posts${cost !== undefined && cost > 0 ? ` · ${formatApproxCost(cost)}` : ''}`}
          control={
            <input
              type="number"
              className="ua-input-wrap ua-input"
              style={{ width: 96, height: 32, padding: '0 10px' }}
              min={0}
              max={5000}
              step={50}
              value={settings.ai.dailyCap}
              aria-label="Posts per day"
              onChange={(e) => {
                const n = Math.max(0, Math.min(5000, Number(e.target.value) || 0));
                void save((s) => void (s.ai.dailyCap = n));
              }}
            />
          }
        />
      </ListGroup>
    </>
  );
}

// ---------- Privacy & Data ----------

export function PrivacyPane({ settings, device }: { settings: Settings; device: Device }) {
  const toast = useToast();
  const [origins, setOrigins] = useState<string[]>([]);
  const [erase, setErase] = useState(false);
  const refreshPermissions = () =>
    void browser.permissions
      .getAll()
      .then((p) => setOrigins((p.origins ?? []).filter((o) => !/linkedin\.com|facebook\.com/.test(o))));
  useEffect(refreshPermissions, []);

  // Settings, interests and exceptions go to the server while sync is on, whatever the AI source (CL3-22).
  const syncedWith = useSyncedServer(CLOUD_ENABLED);
  const src = device.aiSource;
  const flow: { to: string | null; text: string; stays?: string } = !src
    ? { to: null, text: 'Rules run in your browser.', stays: 'Nothing leaves your computer.' }
    : src.kind === 'on-device'
      ? { to: null, text: "Chrome's built-in AI runs on this computer.", stays: 'Nothing leaves it.' }
      : src.kind === 'openai-compatible'
        ? {
            to: new URL(src.baseUrl).host,
            text: `Post text goes from your browser straight to ${new URL(src.baseUrl).host}. HeitechSoft never sees it.`,
          }
        : src.kind === 'server'
          ? recipientText(serverLabel(src.baseUrl))
          : {
              to: src.kind === 'anthropic' ? 'Anthropic' : 'OpenAI',
              text: `Post text goes from your browser straight to ${src.kind === 'anthropic' ? 'Anthropic' : 'OpenAI'}. HeitechSoft never sees it. Author names, emails and phone numbers are never sent.`,
            };

  const recipients = [...new Set([flow.to, syncedWith].filter((to): to is string => !!to))];

  const exportSettings = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'unalgorithm-settings.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const importSettings = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await replaceSettings(migrateSettings(JSON.parse(await file.text())));
        toast({ title: 'Settings imported.' });
      } catch {
        toast({ title: "That file isn't UnAlgorithm settings." });
      }
    };
    input.click();
  };

  return (
    <>
      <Title>Privacy &amp; Data</Title>
      <ListGroup
        header="Where your data goes"
        footer={
          syncedWith
            ? `${flow.text} Your settings, interests and exceptions are synced with ${syncedWith}.`
            : [flow.text, flow.stays].filter(Boolean).join(' ')
        }
      >
        <div className="flow-diagram">
          <span className="flow-box">This browser</span>
          {recipients.length ? (
            <>
              <span aria-hidden="true">→</span>
              {recipients.map((to) => (
                <span key={to} className="flow-box">
                  {to}
                </span>
              ))}
            </>
          ) : null}
        </div>
      </ListGroup>
      <ListGroup
        header="Stored in this browser"
        footer="Your API keys stay in this browser. They are never synced, exported or sent to HeitechSoft."
      >
        <ListRow title="Export settings" icon={{ icon: Download, tint: 'gray' }} onSelect={exportSettings} />
        <ListRow title="Import settings" icon={{ icon: Upload, tint: 'gray' }} onSelect={importSettings} />
        <ListRow
          title="Clear AI results cache"
          onSelect={() =>
            void sendToBackground({ type: 'clearData', what: 'cache' })
              .then(() => toast({ title: 'Cache cleared.' }))
              .catch(() => toast({ title: "Couldn't clear the cache. Try again." }))
          }
        />
        <ListRow
          title="Clear stats"
          onSelect={() =>
            void sendToBackground({ type: 'clearData', what: 'stats' })
              .then(() => toast({ title: 'Stats cleared.' }))
              .catch(() => toast({ title: "Couldn't clear stats. Try again." }))
          }
        />
        {/* A server source has no saved API key, only a sign-in, which this row can't end. */}
        {src && src.kind !== 'on-device' && src.kind !== 'server' ? (
          <ListRow
            title="Remove saved API key"
            tone="destructive"
            onSelect={() =>
              void sendToBackground({ type: 'forgetKey', config: src })
                .then(() => toast({ title: 'Key removed.' }))
                .catch(() => toast({ title: "Couldn't remove the key. Try again." }))
            }
          />
        ) : null}
      </ListGroup>
      <ListGroup
        header="Permissions"
        footer="UnAlgorithm can always read linkedin.com and facebook.com pages you open. Nothing else unless you allow it."
      >
        <ListRow title="linkedin.com and facebook.com" subtitle="Required" />
        {origins.map((o) => (
          <ListRow
            key={o}
            title={o.replace(/\/\*$/, '')}
            subtitle="Allowed for AI"
            control={
              <Button
                size="sm"
                variant="plain"
                onClick={() => void browser.permissions.remove({ origins: [o] }).then(refreshPermissions)}
              >
                Remove
              </Button>
            }
          />
        ))}
      </ListGroup>
      {/* With a server source the person has an account there: they signed in with an email. */}
      <ListGroup footer={src?.kind === 'server' ? 'No analytics. No tracking.' : 'No analytics. No tracking. No account.'}>
        <ListRow
          title="Erase everything…"
          tone="destructive"
          icon={{ icon: Trash2, tint: 'gray' }}
          onSelect={() => setErase(true)}
        />
      </ListGroup>
      <Dialog
        open={erase}
        onOpenChange={setErase}
        alert
        title="Erase everything?"
        // The background ends the device on the server before it erases the refresh token. Store builds have no
        // server card yet, so nobody can be signed in to a server there.
        description={`This removes your settings, exceptions, what UnAlgorithm learned, stats, AI usage history and saved API keys from this browser${CLOUD_ENABLED ? ', and signs it out of any UnAlgorithm server' : ''}. This can't be undone.`}
        actions={
          <>
            <Button onClick={() => setErase(false)} autoFocus>
              Cancel
            </Button>
            <Button
              variant="destructive-solid"
              onClick={() =>
                void sendToBackground({ type: 'clearData', what: 'all' })
                  .then(() => sendToBackground({ type: 'saveSource', config: null }))
                  .then(() => replaceSettings(defaultSettings()))
                  .then(() => {
                    setErase(false);
                    toast({ title: 'Everything was erased.' });
                  })
                  // Erasing is safe to repeat, so the dialog stays open for another try.
                  .catch(() => toast({ title: "Couldn't erase everything. Try again." }))
              }
            >
              Erase everything
            </Button>
          </>
        }
      />
    </>
  );
}

// ---------- About ----------

export function AboutPane() {
  const version = browser.runtime.getManifest().version;
  const repo = 'https://github.com/HeitechSoft/unalgorithm';
  return (
    <>
      <div className="ua-stack" style={{ justifyItems: 'center', textAlign: 'center', padding: '12px 0 28px' }}>
        <Logo size={72} />
        <Wordmark size={26} />
        <span className="ua-secondary">Version {version}</span>
        <span className="ua-footnote">by HeitechSoft · Ontario, Canada</span>
      </div>
      <ListGroup footer="UnAlgorithm is free software under the GNU AGPL, version 3 only. Not affiliated with LinkedIn or Meta.">
        <ListRow title="Source code" accessory="external" href={repo} />
        <ListRow title="Report a problem" accessory="external" href={`${repo}/issues/new/choose`} />
        <ListRow title="Privacy policy" accessory="external" href={`${repo}/blob/main/PRIVACY.md`} />
        <ListRow title="What's new" accessory="external" href={`${repo}/releases`} />
        <ListRow title="Licenses & acknowledgements" accessory="external" href={`${repo}/blob/main/THIRD_PARTY_NOTICES.md`} />
        <ListRow
          title="Replay setup"
          accessory="chevron"
          onSelect={() => sendQuietly({ type: 'openPage', page: 'onboarding' })}
        />
      </ListGroup>
      <Banner title="Built in the open">
        Found a post that was hidden by mistake? Use Why? → Wrong call on the post, or open an issue.{' '}
        <ExternalLink size={12} aria-hidden="true" style={{ display: 'inline' }} />
      </Banner>
    </>
  );
}
