import { Lockup, Search } from '@unalgorithm/ui';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { SourceListEditor } from '../../components/SourceListEditor.tsx';
import { useDevice, useSettings } from '../../lib/hooks.ts';
import { NAV, type PaneId } from './nav.ts';
import { AboutPane, AiPane, DisplayPane, InterestsPane, PlatformPane, PrivacyPane } from './panes.tsx';

function paneFromHash(): PaneId {
  const read = location.hash.replace(/^#\/?/, '').split('/')[0];
  // The Labs pane's switches moved to the end of AI (P3-64): old links in docs, issues and bookmarks open AI.
  const id = (read === 'labs' ? 'ai' : read) as PaneId;
  return NAV.some((n) => n.id === id) ? id : 'linkedin';
}

/** A page inside a pane: `#/ai/sources` is the AI pane's source list editor (P3-76). */
function subFromHash(): string | null {
  return location.hash.replace(/^#\/?/, '').split('/')[1] ?? null;
}

/** unAlgorithm Settings, laid out like macOS System Settings. Every change applies instantly. */
export function App() {
  const [settings, save] = useSettings();
  const [device, saveDevice] = useDevice();
  const [pane, setPane] = useState<PaneId>(paneFromHash());
  const [sub, setSub] = useState<string | null>(subFromHash());
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onHash = () => {
      setPane(paneFromHash());
      setSub(subFromHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const item = NAV.find((n) => n.id === pane);
    const title = pane === 'ai' && sub === 'sources' ? 'Your source list' : (item?.label ?? 'Settings');
    document.title = `${title} · unAlgorithm`;
    document.querySelector<HTMLElement>('.pane h1')?.focus();
  }, [pane, sub]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return NAV;
    return NAV.filter((n) => n.label.toLowerCase().includes(q) || n.keywords.some((k) => k.includes(q)));
  }, [query]);

  if (!settings || !device) return null;

  const go = (id: PaneId) => {
    location.hash = `#/${id}`;
    setPane(id);
    setSub(null);
  };

  let content: ReactNode;
  switch (pane) {
    case 'linkedin':
    case 'facebook':
      content = <PlatformPane platform={pane} settings={settings} save={save} device={device} />;
      break;
    case 'display':
      content = <DisplayPane settings={settings} device={device} save={save} saveDevice={saveDevice} />;
      break;
    case 'interests':
      content = <InterestsPane settings={settings} save={save} />;
      break;
    case 'ai':
      content =
        sub === 'sources' ? (
          <SourceListEditor settings={settings} save={save} />
        ) : (
          <AiPane settings={settings} save={save} device={device} saveDevice={saveDevice} />
        );
      break;
    case 'privacy':
      content = <PrivacyPane settings={settings} device={device} />;
      break;
    case 'about':
      content = <AboutPane device={device} saveDevice={saveDevice} />;
      break;
  }

  const groups = [...new Set(filtered.map((n) => n.group))];
  return (
    <div className="settings">
      <nav className="sidebar" aria-label="Settings">
        <div className="sidebar-search">
          <div className="ua-input-wrap" style={{ height: 30 }}>
            <Search size={14} aria-hidden="true" className="ua-tertiary" />
            <input
              className="ua-input"
              type="search"
              placeholder="Search"
              aria-label="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                const first = filtered[0];
                if (e.key === 'Enter' && first) go(first.id);
              }}
            />
          </div>
        </div>
        <button type="button" className="sidebar-item sidebar-identity" onClick={() => go('about')}>
          <Lockup size={28} />
        </button>
        <div className="ua-footnote" style={{ margin: '-6px 10px 6px 48px' }}>
          Free &amp; open source
        </div>
        {groups.map((g) => (
          <div key={g}>
            {g ? <div className="sidebar-group">{g}</div> : <div style={{ height: 8 }} />}
            {filtered
              .filter((n) => n.group === g)
              .map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className="sidebar-item"
                  aria-current={pane === n.id ? 'page' : undefined}
                  onClick={() => go(n.id)}
                >
                  <span className={`ua-tile ua-tile--sm ua-tile--${n.tint}`} aria-hidden="true">
                    <n.icon />
                  </span>
                  {n.label}
                </button>
              ))}
          </div>
        ))}
      </nav>
      <main className="pane">{content}</main>
    </div>
  );
}
