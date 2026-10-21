/**
 * The public source list every server serves at `/outlets` (P3-67, decision D97): the outlets UnEcho Chamber compares
 * coverage across, each lean with its evidence, the list's balance, and its change history without who made each
 * change. Read-only and the same for everyone: it reads `/outlets.json` and `/outlets/changes.json`, never a session.
 * Every server shows its own list here; the extension reads only HeitechSoft's server's (decision D98). The page names
 * the server only by its discovery document.
 *
 * `OutletTable`, `ChangeList` and `SourceListBalance` are shared with the admins' source control page (P3-74), which adds
 * each row's buttons and who made each change. Everything shown is a text node or an `https:` link from the schema.
 */
import { listBalance } from '@unalgorithm/outlets';
import {
  BUCKET_LABELS,
  CORRECTIONS_PAGE,
  FEATURE_NAMES,
  LEAN_BUCKETS,
  MAX_LISTED_CHANGES,
  type OfficialList,
  type OfficialOutlet,
  OUTLETS_JSON_PATH,
  type OutletChange,
  type ServerInfo,
  siteUrl,
} from '@unalgorithm/protocol';
import {
  BalanceNotice,
  Banner,
  Download,
  EmptyState,
  ListGroup,
  ListRow,
  type LucideIcon,
  Newspaper,
  Pencil,
  Plus,
  type TileTint,
  Trash2,
} from '@unalgorithm/ui';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { publicChanges, publicSourceList, serverInfo } from './api.ts';
import { Page, PageLoading } from './Page.tsx';
import { Section } from './ui.tsx';

const TITLE = 'Source list';
const INTRO =
  `The news outlets ${FEATURE_NAMES.perspectives} compares coverage across, and the lean bucket of each. Leans are set ` +
  "by this server's admins, each with evidence, and every change is listed below. Never by AI.";
const UNREACHABLE = "Couldn't load the source list.";
const NOT_LABELLED = 'Not labelled';
const LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';
/** The website's corrections and appeals page, where source list appeals are explained (P3-68). */
const APPEALS_URL = siteUrl(CORRECTIONS_PAGE);

const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
/** A UTC day (`2026-01-15`) or time, as a date in words. */
const date = (iso: string) => DATE.format(new Date(iso));
/** Each country in words: the table's, and the source control page's form (P3-74). */
export const COUNTRY_LABELS: Readonly<Record<OfficialOutlet['country'], string>> = { US: 'US', CA: 'Canada' };
const ACTION_LABELS: Readonly<Record<OutletChange['action'], string>> = {
  import: 'Imported',
  add: 'Added',
  edit: 'Edited',
  remove: 'Removed',
};
const ACTION_ICONS: Readonly<Record<OutletChange['action'], { icon: LucideIcon; tint: TileTint }>> = {
  import: { icon: Download, tint: 'gray' },
  add: { icon: Plus, tint: 'green' },
  edit: { icon: Pencil, tint: 'blue' },
  remove: { icon: Trash2, tint: 'slate' },
};
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const leanLabel = (outlet: OfficialOutlet) => (outlet.lean ? BUCKET_LABELS[outlet.lean.bucket] : NOT_LABELLED);

type Step = { name: 'loading' } | { name: 'unavailable' } | { name: 'loaded'; list: OfficialList; changes: OutletChange[] };

export function SourceList() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [step, setStep] = useState<Step>({ name: 'loading' });

  const load = useCallback(async () => {
    setStep({ name: 'loading' });
    try {
      const [found, list, history] = await Promise.all([serverInfo(), publicSourceList(), publicChanges()]);
      setInfo(found);
      document.title = `${TITLE} · ${found.name}`;
      setStep({ name: 'loaded', list, changes: history.changes });
    } catch {
      setStep({ name: 'unavailable' });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A link to one outlet (`/outlets#<id>`, as appeals quote it): its row exists only once the list has loaded.
  useEffect(() => {
    if (step.name !== 'loaded' || window.location.hash.length < 2) return;
    document.getElementById(window.location.hash.slice(1))?.scrollIntoView?.();
  }, [step]);

  if (step.name === 'loading') return <PageLoading />;
  if (step.name === 'unavailable') {
    return (
      <Page info={info} layout="app" title={TITLE} intro={INTRO}>
        <Banner tone="danger" title={UNREACHABLE} action={{ label: 'Try again', onAction: () => void load() }} />
      </Page>
    );
  }
  const { list, changes } = step;
  return (
    <Page
      info={info}
      layout="app"
      title={TITLE}
      intro={INTRO}
      wide
      actions={
        <a className="ua-button ua-button--secondary" href={OUTLETS_JSON_PATH} download="outlets.json">
          <Download aria-hidden="true" />
          Download JSON
        </a>
      }
    >
      <div className="web-meta web-prose">
        <p>
          Version {list.version}
          {list.updatedAt ? ` · Updated ${date(list.updatedAt)}` : null} · Data{' '}
          <a href={LICENSE_URL} rel="noopener noreferrer" target="_blank">
            CC BY 4.0
          </a>
        </p>
        <p>
          To appeal a listing or a lean, see <a href={APPEALS_URL}>Corrections and appeals</a>.
        </p>
      </div>
      <SourceListBalance outlets={list.outlets} />
      <Section title="Outlets">
        <OutletTable outlets={list.outlets} />
      </Section>
      <ChangeList changes={changes} />
    </Page>
  );
}

/**
 * The list's balance (decision D101): the warnings, which never block, or why the list can't be used at all; then the
 * outlets with a lean per bucket, in `LEAN_BUCKETS` order. Nothing for a list with no outlets.
 */
export function SourceListBalance({ outlets }: { outlets: readonly OfficialOutlet[] }) {
  if (outlets.length === 0) return null;
  const balance = listBalance({ outlets });
  const most = Math.max(1, ...LEAN_BUCKETS.map((b) => balance.counts[b]));
  return (
    <Section title="Balance" description="Outlets with a lean, in each bucket.">
      <BalanceNotice name="This list" empty={balance.empty} warnings={balance.warnings} />
      <ul className="web-card web-balance-buckets">
        {LEAN_BUCKETS.map((b) => (
          <li key={b}>
            <span className="web-bucket-bar" aria-hidden="true">
              <span style={{ height: `${(balance.counts[b] / most) * 100}%` }} />
            </span>
            <span className="web-bucket-count">{balance.counts[b]}</span>
            <span className="web-bucket-label">{BUCKET_LABELS[b]}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * Every outlet, sorted by id; each row's `id` is the outlet's, so `/outlets#<id>` links one. `actions` renders a row's
 * buttons (the source control page's); the public page passes none.
 */
export function OutletTable({
  outlets,
  actions,
}: {
  outlets: readonly OfficialOutlet[];
  actions?: (outlet: OfficialOutlet) => ReactNode;
}) {
  if (outlets.length === 0) {
    return (
      <div className="web-card">
        <EmptyState icon={Newspaper} title="No outlets yet." />
      </div>
    );
  }
  return (
    <div className="web-table-card">
      <table className="web-table web-outlets">
        <thead>
          <tr>
            <th scope="col">Outlet</th>
            <th scope="col">Web addresses</th>
            <th scope="col">Country</th>
            <th scope="col">Lean</th>
            <th scope="col">Evidence</th>
            <th scope="col">Changed</th>
            {actions ? (
              <th scope="col">
                <span className="ua-vh">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {[...outlets].sort(byId).map((outlet) => (
            <tr key={outlet.id} id={outlet.id}>
              <th scope="row">
                {outlet.name}
                <span className="web-outlet-id">{outlet.id}</span>
              </th>
              <td>{outlet.domains.join(', ')}</td>
              <td>{COUNTRY_LABELS[outlet.country]}</td>
              <td>
                <span className={outlet.lean ? 'ua-badge ua-badge--accent' : 'ua-badge'}>{leanLabel(outlet)}</span>
              </td>
              <td>
                {outlet.lean ? (
                  <ul className="web-evidence">
                    {outlet.lean.evidence.map((e) => (
                      <li key={`${e.url} ${e.note}`}>
                        <a href={e.url} rel="noopener noreferrer" target="_blank">
                          {e.note}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </td>
              <td>{date(outlet.changedOn)}</td>
              {actions ? <td>{actions(outlet)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What an edit changed, in plain words: the lean as "lean: Center → Leans left", any other field by name. */
function editedFields(before: OfficialOutlet, after: OfficialOutlet): string[] {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const fields: string[] = [];
  if (before.lean?.bucket !== after.lean?.bucket) fields.push(`lean: ${leanLabel(before)} → ${leanLabel(after)}`);
  if (!same(before.domains, after.domains)) fields.push('web addresses');
  if (before.name !== after.name) fields.push('name');
  if (before.country !== after.country) fields.push('country');
  if (!same(before.lean?.evidence ?? [], after.lean?.evidence ?? [])) fields.push('evidence');
  return fields;
}

/** One change: what happened to which outlet, and its day, what an edit changed and who (with `showBy`). */
function changeRow(change: OutletChange & { by?: string | null }, showBy: boolean): { title: string; subtitle: string } {
  const outlet = change.after ?? change.before;
  const parts = [date(change.at)];
  if (change.action === 'edit' && change.before && change.after) {
    const fields = editedFields(change.before, change.after);
    if (fields.length > 0) parts.push(fields.join(', '));
  }
  if (showBy && change.by) parts.push(`by ${change.by}`);
  return {
    title: `${ACTION_LABELS[change.action]} ${outlet?.name ?? change.outletId} (${change.outletId})`,
    subtitle: parts.join(' · '),
  };
}

/**
 * The change history, newest first. `showBy` adds who made each change: the source control page's (P3-74) only; the
 * public page never names anyone (decision D94).
 */
export function ChangeList({
  changes,
  showBy = false,
}: {
  changes: readonly (OutletChange & { by?: string | null })[];
  showBy?: boolean;
}) {
  return (
    <Section title="Changes">
      {changes.length === 0 ? (
        <ListGroup>
          <ListRow title={<span className="ua-secondary">No changes yet.</span>} />
        </ListGroup>
      ) : (
        <ListGroup footer={changes.length >= MAX_LISTED_CHANGES ? `The latest ${MAX_LISTED_CHANGES} changes.` : undefined}>
          {[...changes]
            .sort((a, b) => b.seq - a.seq)
            .map((change) => {
              const { title, subtitle } = changeRow(change, showBy);
              return <ListRow key={change.seq} icon={ACTION_ICONS[change.action]} title={title} subtitle={subtitle} />;
            })}
        </ListGroup>
      )}
    </Section>
  );
}
