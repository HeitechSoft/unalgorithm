import { dateKey, type HiddenItem, type HighlightItem } from '@unalgorithm/core';
import type { PlatformId, PostKey } from '@unalgorithm/protocol';
import {
  Banner,
  Button,
  Chip,
  EmptyState,
  Eye,
  IconButton,
  ListFilter,
  Newspaper,
  SegmentedControl,
  Settings,
  Sparkles,
} from '@unalgorithm/ui';
import { useState } from 'react';
import { browser } from 'wxt/browser';
import { FEED_URLS, platformOfUrl, useActiveTab, useStorageItem, useTabState } from '../../lib/hooks.ts';
import { sendQuietly, sendToTab } from '../../lib/messages.ts';
import { statsItem } from '../../lib/storage.ts';

const SITE: Record<PlatformId, string> = { linkedin: 'LinkedIn', facebook: 'Facebook' };

export function App() {
  const tab = useActiveTab();
  const state = useTabState(tab?.id);
  const stats = useStorageItem(statsItem, {});
  const [view, setView] = useState<'foryou' | 'hidden'>('foryou');
  const [filter, setFilter] = useState<string | null>(null);
  const platform = tab ? platformOfUrl(tab.url) : null;

  const goTo = async (key: PostKey, permalink?: string) => {
    if (!tab) return;
    const res = await sendToTab(tab.id, { type: 'scrollTo', key });
    if (!res?.ok && permalink) void browser.tabs.update(tab.id, { url: permalink });
  };

  const head = (
    <>
      <div className="panel-head">
        <h1 style={{ font: 'var(--ua-type-title2)' }}>Highlights</h1>
        <IconButton icon={Settings} label="Settings" onClick={() => sendQuietly({ type: 'openPage', page: 'options' })} />
      </div>
      <div className="panel-sub ua-footnote">
        {platform ? `${SITE[platform]} · this page` : 'Open your LinkedIn or Facebook feed'}
      </div>
    </>
  );

  if (!platform || !state.onFeed) {
    return (
      <main className="panel" data-density="compact">
        {head}
        <EmptyState
          icon={Newspaper}
          title="Open your feed to see highlights"
          body="UnAlgorithm lists the posts picked for you and everything it folded away, right here."
        />
        <div className="ua-hstack" style={{ justifyContent: 'center', gap: 8 }}>
          <Button variant="tinted" size="sm" href={FEED_URLS.linkedin}>
            Open LinkedIn
          </Button>
          <Button variant="tinted" size="sm" href={FEED_URLS.facebook}>
            Open Facebook
          </Button>
        </div>
      </main>
    );
  }

  const hiddenGroups = groupHidden(state.hiddenItems);
  const today = stats[dateKey()]?.hidden ?? 0;
  const visibleHidden = filter ? state.hiddenItems.filter((h) => h.reasonKey === filter) : state.hiddenItems;

  return (
    <main className="panel" data-density="compact">
      {head}
      <div className="ua-stack" style={{ '--ua-gap': '14px' } as React.CSSProperties}>
        <SegmentedControl<'foryou' | 'hidden'>
          fullWidth
          label="Show"
          value={view}
          onValueChange={setView}
          options={[
            { value: 'foryou', label: `For you ${state.counts.highlighted}` },
            { value: 'hidden', label: `Hidden ${state.counts.hiddenTotal}` },
          ]}
        />
        {state.ai.state === 'paused' ? (
          <Banner
            tone="warning"
            title="AI is paused"
            action={{
              label: 'Open AI settings',
              onAction: () => sendQuietly({ type: 'openPage', page: 'options', hash: '#/ai' }),
            }}
          >
            {state.ai.message}
          </Banner>
        ) : null}
        <div className="ua-card ua-card--pad ua-footnote">
          On this page: {state.counts.posts} posts seen · {state.counts.hiddenTotal} hidden · {state.counts.highlighted} for you
          <br />
          Today: {today} hidden
        </div>

        {view === 'foryou' ? (
          state.highlights.length ? (
            <div className="ua-card">
              {state.highlights.map((h) => (
                <PickRow key={h.id} item={h} onOpen={() => void goTo(h.id, h.permalink)} />
              ))}
            </div>
          ) : (
            <EmptyState
              icon={Sparkles}
              title="Nothing stands out yet"
              body="Pick a few interests and posts about them get a quiet For you highlight. Picks appear here as you scroll."
              action={{
                label: 'Choose interests',
                onAction: () => sendQuietly({ type: 'openPage', page: 'options', hash: '#/interests' }),
              }}
            />
          )
        ) : state.hiddenItems.length ? (
          <>
            <div className="ua-hstack ua-wrap" style={{ gap: 6 }}>
              <Chip size="sm" icon={ListFilter} label="All" selected={filter === null} onSelectedChange={() => setFilter(null)} />
              {hiddenGroups.map(([key, items]) => (
                <Chip
                  key={key}
                  size="sm"
                  label={state.reasonLabels[key] ?? key}
                  count={items.length}
                  selected={filter === key}
                  onSelectedChange={(v) => setFilter(v ? key : null)}
                />
              ))}
            </div>
            <div className="ua-card">
              {visibleHidden.map((h) => (
                <HiddenRow
                  key={h.id}
                  item={h}
                  onShow={async () => {
                    if (tab) await sendToTab(tab.id, { type: 'scrollTo', key: h.id });
                  }}
                />
              ))}
            </div>
            <Button variant="secondary" icon={Eye} onClick={() => tab && void sendToTab(tab.id, { type: 'peek', on: true })}>
              Show all on this page
            </Button>
          </>
        ) : (
          <EmptyState icon={Eye} title="Nothing hidden yet" body="Folded-away posts on this page will be listed here." />
        )}
      </div>
    </main>
  );
}

function PickRow({ item, onOpen }: { item: HighlightItem; onOpen: () => void }) {
  return (
    <div className="panel-item">
      <div className="ua-hstack" style={{ justifyContent: 'space-between' }}>
        <span className="ua-headline">{item.author ?? 'Post'}</span>
        {item.relevance !== undefined ? <span className="ua-badge ua-badge--accent">{item.relevance}</span> : null}
      </div>
      <div className="panel-snippet">{item.snippet}</div>
      <div className="ua-hstack ua-wrap" style={{ gap: 6 }}>
        {item.matched.slice(0, 3).map((m) => (
          <Chip key={m} size="sm" label={m} ai={item.source === 'ai'} />
        ))}
        <span className="ua-grow" />
        <Button size="sm" variant="plain" onClick={onOpen}>
          Go to post
        </Button>
      </div>
    </div>
  );
}

function HiddenRow({ item, onShow }: { item: HiddenItem; onShow: () => void }) {
  return (
    <div className="panel-item">
      <div className="ua-hstack" style={{ justifyContent: 'space-between' }}>
        <span className="ua-headline" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.author ?? item.label}
        </span>
        <Chip size="sm" label={item.label} ai={item.ai} />
      </div>
      {item.snippet ? <div className="panel-snippet ua-secondary">{item.snippet}</div> : null}
      <div className="ua-hstack" style={{ justifyContent: 'flex-end' }}>
        <Button size="sm" variant="plain" onClick={onShow}>
          Show
        </Button>
      </div>
    </div>
  );
}

function groupHidden(items: HiddenItem[]): [string, HiddenItem[]][] {
  const groups = new Map<string, HiddenItem[]>();
  for (const h of items) groups.set(h.reasonKey, [...(groups.get(h.reasonKey) ?? []), h]);
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}
