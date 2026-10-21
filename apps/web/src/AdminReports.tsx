/**
 * The problem reports page every server serves at `/admin/reports` (ADR 0009 §7): what people sent with unAlgorithm's
 * Report a problem, grouped by platform, detection version, kind and topic, open groups first; corrections in their
 * own list, each against the answer promise; the last 30 days per platform; "Fixed in" per platform; and a lookup by
 * reference for privacy requests. A group opens its reports, 50 at a time, newest first, and a report opens in full.
 * Its session flow is the admin page's (`useAdminSession`); every change goes through the admin routes, which check the
 * page's own origin, the session and the role again.
 *
 * A report holds versions, codes and counts, and a correction also the person's own words and maybe an email address.
 * The page shows them as text only: React escapes everything, the words go through `cleanReportMessage` first (which
 * strips bidi and zero-width characters that could reorder or hide them), and a reply address becomes a `mailto:` link
 * only when it is an email address.
 */
import { cleanReportMessage, REPORT_LINE_COPY } from '@unalgorithm/core';
import {
  ADMIN_REPORTS_PAGE_PATH,
  type AdminReportList,
  type AdminReportRow,
  type AdminReportsSummary,
  adapterOrder,
  CORRECTION_ANSWER_BUSINESS_DAYS,
  CORRECTION_RESOLUTIONS,
  FEATURE_NAMES,
  PLATFORM_NAMES,
  PLATFORMS,
  type PlatformId,
  parseReportRef,
  REPORT_BACKUP_NIGHTS,
  REPORT_GROUP_DAYS,
  REPORT_RESOLUTIONS,
  type ReportDay,
  type ReportFloor,
  type ReportGroup,
  type ReportKind,
  type ReportResolution,
} from '@unalgorithm/protocol';
import {
  Badge,
  Banner,
  Button,
  Dialog,
  ListGroup,
  ListRow,
  Mail,
  SegmentedControl,
  type SegmentedOption,
  Switch,
  TextField,
  Trash2,
  useToast,
} from '@unalgorithm/ui';
import { type FormEvent, type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import { AdminGate, AdminPage, useAdminSession } from './Admin.tsx';
import {
  ApiError,
  adminReport,
  adminReports,
  adminReportsSummary,
  deleteReports,
  forgetReportContact,
  handleReports,
  type ReportDetail,
  setReportFloor,
} from './api.ts';
import { failureMessage } from './SignIn.tsx';
import { BackButton, Card, Facts, Section, SectionLoading, StatTile } from './ui.tsx';

/** Days of daily counts the page shows. */
const DAYS = 30;
const TITLE = 'Problem reports';
const INTRO =
  'Problem reports people sent from unAlgorithm. They hold versions, counts, the rules that matched and, for ' +
  'corrections, what people wrote; never posts or names.';
const OFF = 'Problem reports are off on this server (REPORTS=off).';
const LOAD_FAILED = "Couldn't load the reports.";
const GONE = 'That report no longer exists.';
const NO_GROUPS = `No reports in the last ${DAYS} days.`;
const NO_CORRECTIONS = 'No corrections are waiting.';
const NOT_A_REFERENCE = 'A reference looks like 7KQ3-M2PA.';
const NO_REFERENCE = 'No report has this reference.';
const FLOOR_NOTE =
  "Reports from older detection versions count as handled, so installs that haven't updated don't reopen alerts.";
const DELETE_LINE =
  `It's deleted for good. Use this for a privacy request or a message holding personal data. Encrypted backups keep ` +
  `it for up to ${REPORT_BACKUP_NIGHTS} more nights.`;
/** How many pages of open corrections the corrections list reads at most (50 each). */
const MAX_CORRECTION_PAGES = 10;

const C = REPORT_LINE_COPY;
const COUNT = new Intl.NumberFormat('en-US');
/** A report day ("2026-10-15", a UTC day): "Oct 15". */
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
/** An instant in UTC, followed by " UTC" where it is shown: "Oct 15, 2026, 14:00". */
const TIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23', timeZone: 'UTC' });
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** A kind as the groups list names it, before its topic: "Filtering looks broken: feed-not-started". */
const KIND_LABELS: Readonly<Record<ReportKind, string>> = {
  detection: 'Filtering looks broken',
  'wrong-call': 'Wrong call',
  correction: 'Correction',
  other: 'Something else',
};
const RESOLUTION_LABELS: Readonly<Record<ReportResolution, string>> = {
  fixed: 'Fixed',
  duplicate: 'Duplicate',
  'cant-reproduce': "Can't reproduce",
  'not-a-bug': 'Not a bug',
  'older-version': 'Older version',
  spam: 'Spam',
  corrected: 'Corrected',
  'no-change': 'No change',
  'out-of-scope': 'Out of scope',
};
/** A correction is corrected, left as it is or out of scope; a duplicate or spam is closed another way. */
const CORRECTION_CLOSINGS: readonly ReportResolution[] = [...CORRECTION_RESOLUTIONS, 'duplicate', 'spam'];
/** The bars of a day, in the legend's order. */
const PARTS = ['linkedin', 'facebook', 'other'] as const;
const PART_LABELS: Readonly<Record<(typeof PARTS)[number], string>> = { ...PLATFORM_NAMES, other: 'Other' };

type ListStatus = 'open' | 'handled' | 'all';
const STATUSES: readonly SegmentedOption<ListStatus>[] = [
  { value: 'open', label: 'Open' },
  { value: 'handled', label: 'Handled' },
  { value: 'all', label: 'All' },
];

/** What the page shows: the summary, one group's reports, or one report (with where "Back" goes). */
type GroupView = { name: 'group'; group: ReportGroup; status: ListStatus };
type View = { name: 'summary' } | GroupView | { name: 'report'; id: string; back: { name: 'summary' } | GroupView };
const SUMMARY = { name: 'summary' } as const;

/** A section's own request: loading, failed (with "Try again"), or its answer. */
type Loadable<T> = { name: 'loading' } | { name: 'failed' } | { name: 'gone' } | { name: 'loaded'; data: T };

/** The summary as the page opens: without development builds. A module function, so the page loads once. */
const loadSummary = () => adminReportsSummary({ days: DAYS, dev: false });

function count(n: number, one: string, many: string): string {
  return `${COUNT.format(n)} ${n === 1 ? one : many}`;
}

/** `linkedin@2026.10.2` → `2026.10.2`. */
function versionOf(adapter: string): string {
  return adapter.split('@')[1] ?? adapter;
}

/** "LinkedIn · detection 2026.10.2 · Filtering looks broken: feed-not-started". */
export function groupTitle(g: Pick<ReportGroup, 'platform' | 'adapter' | 'kind' | 'topic'>): string {
  const parts: string[] = [];
  if (g.platform) parts.push(PLATFORM_NAMES[g.platform]);
  if (g.adapter) parts.push(`detection ${versionOf(g.adapter)}`);
  parts.push(g.topic ? `${KIND_LABELS[g.kind]}: ${g.topic}` : KIND_LABELS[g.kind]);
  return parts.join(' · ');
}

/**
 * How long ago a report arrived, from times stored to the hour: "within the hour", "2 h ago" up to two days, then
 * "3 days ago".
 */
export function ago(iso: string, now: number): string {
  const hours = Math.floor((now - Date.parse(iso)) / HOUR_MS);
  if (hours < 1) return 'within the hour';
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** "7 reports from 5 networks · last 2 h ago · 7 open". Networks count each network once a day (`first_from_network`). */
export function groupStats(g: Pick<ReportGroup, 'total' | 'networks' | 'lastAt' | 'open'>, now: number): string {
  const from = g.networks > 0 ? ` from ${count(g.networks, 'network', 'networks')}` : '';
  const open = g.open > 0 ? `${COUNT.format(g.open)} open` : 'all handled';
  return [`${count(g.total, 'report', 'reports')}${from}`, `last ${ago(g.lastAt, now)}`, open].join(' · ');
}

/**
 * Business days a report has waited, Monday to Friday in UTC: the weekdays after the day it arrived, up to and
 * including today. One that arrived on a Friday has waited 1 on Monday.
 */
export function businessDaysWaiting(receivedAt: string, now: number): number {
  const today = Math.floor(now / DAY_MS);
  let days = 0;
  for (let d = Math.floor(Date.parse(receivedAt) / DAY_MS) + 1; d <= today; d++) {
    const weekday = new Date(d * DAY_MS).getUTCDay();
    if (weekday !== 0 && weekday !== 6) days++;
  }
  return days;
}

/** "Waiting 2 of 5 business days", or past the promise "Waiting 7 business days, 2 more than the 5 promised". */
export function waitingLine(days: number): string {
  const promise = CORRECTION_ANSWER_BUSINESS_DAYS;
  if (days <= promise) return `Waiting ${days} of ${promise} business days`;
  return `Waiting ${days} business days, ${days - promise} more than the ${promise} promised`;
}

/** "unAlgorithm 0.4.1 from the Chrome Web Store · Chrome 141 · Ads are still showing". */
export function rowLine(row: AdminReportRow): string {
  const channel = C.channels[row.channel];
  const parts = [`unAlgorithm ${row.extension}${channel ? ` ${channel}` : ''}`, `${C.browsers[row.browser]} ${row.browserMajor}`];
  if (row.choices.length > 0) parts.push(row.choices.map((choice) => C.choices[choice] ?? choice).join('; '));
  return parts.join(' · ');
}

/** "Open", or "Handled Oct 16, 2026: Fixed". */
function statusLine(row: Pick<AdminReportRow, 'handledAt' | 'resolution'>): string {
  if (row.handledAt === null) return 'Open';
  const resolution = row.resolution ? `: ${RESOLUTION_LABELS[row.resolution]}` : '';
  return `Handled ${DATE.format(new Date(row.handledAt))}${resolution}`;
}

function resolutionsFor(kind: ReportKind): readonly ReportResolution[] {
  return kind === 'correction' ? CORRECTION_CLOSINGS : REPORT_RESOLUTIONS;
}

/** "Fact-check" for a correction's topic (its feature); the code itself for one this page doesn't know. */
function featureName(topic: string | null): string {
  if (topic === 'factcheck' || topic === 'perspectives') return FEATURE_NAMES[topic];
  return topic ?? 'Correction';
}

const isEmail = (text: string): boolean => z.email().max(254).safeParse(text).success;

/**
 * A reply link to a validated address: its local part and domain each URL-encoded around a literal "@" (RFC 6068), and
 * a subject naming the reference.
 */
export function replyLink(address: string, ref: string): string {
  const at = address.lastIndexOf('@');
  const to = `${encodeURIComponent(address.slice(0, at))}@${encodeURIComponent(address.slice(at + 1))}`;
  return `mailto:${to}?subject=${encodeURIComponent(`Your unAlgorithm correction ${ref}`)}`;
}

/** Puts the focus on the element once it is shown: a view's heading, so a screen reader starts there. */
function useFocusWhen<T extends HTMLElement>(ready: boolean) {
  const ref = useRef<T>(null);
  const done = useRef(false);
  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    ref.current?.focus();
  }, [ready]);
  return ref;
}

export function AdminReports() {
  const session = useAdminSession(TITLE, loadSummary);
  const { info, step, sessionEnded } = session;
  /**
   * The summary asked for since it loaded (after a change, or with development builds), with the answer it replaced:
   * after a new sign-in the page's own load is newer, and this one no longer counts.
   */
  const [fetched, setFetched] = useState<{ base: AdminReportsSummary; dev: boolean; data: AdminReportsSummary } | null>(null);
  const [view, setView] = useState<View>(SUMMARY);
  /** The request in flight: 'dev', a group's key, a platform's floor, or a report's action. */
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The groups' heading takes the focus when "Back" returns to the summary. */
  const [returned, setReturned] = useState(false);
  const toast = useToast();

  if (step.name !== 'loaded' || !info) {
    return <AdminGate session={session} intro={INTRO} returnTo={ADMIN_REPORTS_PAGE_PATH} />;
  }
  const base = step.data;
  const current = fetched?.base === base ? fetched : null;
  const summary = current?.data ?? base;
  const dev = current?.dev ?? false;
  const now = Date.now();

  /** A refused or failed request: a 401 ends the page's session; anything else is said above the page. */
  function failed(err: unknown, byStatus: Partial<Record<number, string>> = {}) {
    if (err instanceof ApiError && err.status === 401) sessionEnded();
    else setNotice(failureMessage(err, byStatus));
  }

  /** The summary again, with or without development builds. */
  async function refresh(withDev = dev) {
    try {
      setFetched({ base, dev: withDev, data: await adminReportsSummary({ days: DAYS, dev: withDev }) });
    } catch (err) {
      failed(err);
    }
  }

  /** One change, then the summary again; true when it was made. A 404 is said in the page's words. */
  async function run(key: string, action: () => Promise<void>, done: string): Promise<boolean> {
    setPending(key);
    setNotice(null);
    try {
      await action();
      toast({ title: done });
      await refresh();
      return true;
    } catch (err) {
      failed(err, { 404: GONE });
      return false;
    } finally {
      setPending(null);
    }
  }

  function show(next: View) {
    setNotice(null);
    setReturned(next.name === 'summary');
    setView(next);
    if (next.name === 'summary') void refresh();
  }

  async function onDev(next: boolean) {
    setPending('dev');
    setNotice(null);
    await refresh(next);
    setPending(null);
  }

  const handleGroup = (group: ReportGroup, resolution: ReportResolution) =>
    run(group.key, () => handleReports({ group: group.key, handled: true, resolution }), 'Marked handled.');

  /** The group as the latest summary counts it, once its reports have changed. */
  const latest = (group: ReportGroup) => summary.groups.find((g) => g.key === group.key) ?? group;

  let body: ReactNode;
  if (view.name === 'group') {
    const group = latest(view.group);
    body = (
      <GroupReports
        key={group.key}
        group={group}
        status={view.status}
        now={now}
        busy={pending !== null}
        pending={pending === group.key}
        onStatus={(status) => show({ ...view, status })}
        onOpen={(id) => show({ name: 'report', id, back: view })}
        onBack={() => show(SUMMARY)}
        onHandle={(resolution) => handleGroup(group, resolution)}
        onSignedOut={sessionEnded}
      />
    );
  } else if (view.name === 'report') {
    const { id, back } = view;
    body = (
      <ReportDetails
        key={id}
        id={id}
        backLabel={back.name === 'group' ? groupTitle(latest(back.group)) : 'All reports'}
        pending={pending}
        onBack={() => show(back)}
        onHandle={(resolution) => run('handle', () => handleReports({ ids: [id], handled: true, resolution }), 'Marked handled.')}
        onReopen={() => run('handle', () => handleReports({ ids: [id], handled: false }), 'Reopened.')}
        onForget={() => run('forget', () => forgetReportContact(id), 'Email forgotten.')}
        onDelete={async () => {
          if (await run('delete', () => deleteReports([id]), 'Deleted.')) show(back);
        }}
        onSignedOut={sessionEnded}
      />
    );
  } else {
    body = (
      <Summary
        summary={summary}
        dev={dev}
        now={now}
        pending={pending}
        focusGroups={returned}
        onDev={(next) => void onDev(next)}
        onView={(group, status = 'open') => show({ name: 'group', group, status })}
        onOpen={(id) => show({ name: 'report', id, back: SUMMARY })}
        onHandle={(group, resolution) => void handleGroup(group, resolution)}
        onFloor={(platform, adapter) =>
          void run(
            `floor:${platform}`,
            () => setReportFloor({ platform, adapter }),
            adapter ? 'Fixed in set.' : 'Fixed in cleared.',
          )
        }
        onSignedOut={sessionEnded}
      />
    );
  }

  return (
    <AdminPage session={session} nav="reports" title={TITLE} intro={INTRO}>
      {notice ? <Banner tone="danger" title={notice} /> : null}
      {body}
    </AdminPage>
  );
}

function Summary({
  summary,
  dev,
  now,
  pending,
  focusGroups,
  onDev,
  onView,
  onOpen,
  onHandle,
  onFloor,
  onSignedOut,
}: {
  summary: AdminReportsSummary;
  dev: boolean;
  now: number;
  pending: string | null;
  focusGroups: boolean;
  onDev(next: boolean): void;
  onView(group: ReportGroup, status?: ListStatus): void;
  onOpen(id: string): void;
  onHandle(group: ReportGroup, resolution: ReportResolution): void;
  onFloor(platform: PlatformId, adapter: string | null): void;
  onSignedOut(): void;
}) {
  const off = summary.enabled ? null : <Banner tone="info" title={OFF} />;
  // A server that never took reports has nothing more to show.
  if (!summary.enabled && summary.groups.length === 0) return off;
  return (
    <>
      {off}
      <div className="web-stats">
        <StatTile
          label="Open"
          value={COUNT.format(summary.groups.reduce((n, g) => n + g.open, 0))}
          detail={`in ${count(summary.groups.filter((g) => g.open > 0).length, 'group', 'groups')}`}
        />
        <StatTile
          label="Reports today"
          value={COUNT.format(summary.today)}
          meter={summary.dailyMax > 0 ? summary.today / summary.dailyMax : 0}
          detail={`of at most ${COUNT.format(summary.dailyMax)} a day`}
        />
        <StatTile
          label="From unlisted extension ids"
          value={COUNT.format(summary.unlisted7d)}
          detail="in the last 7 days"
          tone={summary.unlisted7d > 0 ? 'warning' : 'accent'}
        />
      </div>
      <div className="web-admin">
        <div className="web-admin-column">
          <Groups
            groups={summary.groups.filter((g) => g.kind !== 'correction')}
            dev={dev}
            now={now}
            pending={pending}
            focusHeading={focusGroups}
            onDev={onDev}
            onView={onView}
            onHandle={onHandle}
          />
          <Corrections
            groups={summary.groups.filter((g) => g.kind === 'correction')}
            now={now}
            onView={(group) => onView(group, 'all')}
            onOpen={onOpen}
            onSignedOut={onSignedOut}
          />
        </div>
        <div className="web-admin-column">
          <FindReport onFound={onOpen} onSignedOut={onSignedOut} />
          <FixedIn summary={summary} pending={pending} onFloor={onFloor} />
          <LastDays days={summary.days} />
        </div>
      </div>
    </>
  );
}

function Groups({
  groups,
  dev,
  now,
  pending,
  focusHeading,
  onDev,
  onView,
  onHandle,
}: {
  groups: readonly ReportGroup[];
  dev: boolean;
  now: number;
  pending: string | null;
  focusHeading: boolean;
  onDev(next: boolean): void;
  onView(group: ReportGroup): void;
  onHandle(group: ReportGroup, resolution: ReportResolution): void;
}) {
  const headingRef = useFocusWhen<HTMLHeadingElement>(focusHeading);
  return (
    <Section
      title="Groups"
      description="Reports grouped by platform, detection version, kind and topic; open groups first."
      headingRef={headingRef}
      actions={
        <label className="web-switch-label">
          <span>Development builds</span>
          <Switch label="Show development builds" checked={dev} disabled={pending !== null} onCheckedChange={onDev} />
        </label>
      }
    >
      {groups.length === 0 ? (
        <Card>
          <p className="web-empty-line">{NO_GROUPS}</p>
        </Card>
      ) : (
        <ul className="web-groups" aria-label="Groups">
          {groups.map((group) => {
            const title = groupTitle(group);
            return (
              <li key={group.key} className="web-group">
                <div className="web-group-text">
                  <p className="web-group-title">{title}</p>
                  <p className="web-group-stats">{groupStats(group, now)}</p>
                </div>
                <Spark perDay={group.perDay} />
                <div className="web-group-tools">
                  <Button size="sm" aria-label={`View ${title}`} disabled={pending !== null} onClick={() => onView(group)}>
                    View
                  </Button>
                  {group.open > 0 ? (
                    <MarkHandled
                      kind={group.kind}
                      name={title}
                      busy={pending === group.key}
                      disabled={pending !== null}
                      onHandle={(resolution) => onHandle(group, resolution)}
                    />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** A group's last 14 days as small bars; screen readers get the numbers. */
function Spark({ perDay }: { perDay: readonly number[] }) {
  const most = Math.max(1, ...perDay);
  // Each bar is known by how many days ago it was: today is 0.
  const bars = perDay.map((n, i) => ({ n, daysAgo: perDay.length - 1 - i }));
  return (
    <span
      className="web-spark"
      role="img"
      aria-label={`Last ${REPORT_GROUP_DAYS} days, oldest first: ${perDay.map((n) => COUNT.format(n)).join(', ')}`}
    >
      {bars.map(({ n, daysAgo }) => (
        <span
          key={daysAgo}
          className={n > 0 ? 'web-spark-day' : 'web-spark-day web-spark-none'}
          style={{ height: `${(n / most) * 100}%` }}
        />
      ))}
    </span>
  );
}

/** A resolution and "Mark handled", for a group or one report. */
function MarkHandled({
  kind,
  name,
  busy,
  disabled,
  onHandle,
}: {
  kind: ReportKind;
  /** What is marked, for screen readers: the group's title, or "report 7KQ3-M2PA". */
  name: string;
  busy: boolean;
  disabled: boolean;
  onHandle(resolution: ReportResolution): void;
}) {
  const id = useId();
  const options = resolutionsFor(kind);
  const [resolution, setResolution] = useState<ReportResolution>(options[0] ?? 'fixed');
  return (
    <div className="ua-hstack ua-wrap">
      <label className="ua-vh" htmlFor={id}>
        {`Resolution for ${name}`}
      </label>
      <select
        id={id}
        className="ua-select"
        value={resolution}
        onChange={(e) => setResolution(e.target.value as ReportResolution)}
      >
        {options.map((r) => (
          <option key={r} value={r}>
            {RESOLUTION_LABELS[r]}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        loading={busy}
        disabled={disabled}
        aria-label={`Mark handled: ${name}`}
        onClick={() => onHandle(resolution)}
      >
        Mark handled
      </Button>
    </div>
  );
}

/**
 * Open corrections, the longest waiting first, each against the answer promise. They come from their groups' lists
 * (newest first, 50 a page), read to the end so the oldest are never left out.
 */
function Corrections({
  groups,
  now,
  onView,
  onOpen,
  onSignedOut,
}: {
  groups: readonly ReportGroup[];
  now: number;
  onView(group: ReportGroup): void;
  onOpen(id: string): void;
  onSignedOut(): void;
}) {
  // The groups' identity changes with every summary; their keys say when the lists need reading again.
  const waiting = groups
    .filter((g) => g.open > 0)
    .map((g) => g.key)
    .join('\n');
  const [state, setState] = useState<Loadable<{ rows: AdminReportRow[]; more: boolean }>>({ name: 'loading' });

  const load = useCallback(async () => {
    setState({ name: 'loading' });
    try {
      const rows: AdminReportRow[] = [];
      let more = false;
      for (const group of waiting ? waiting.split('\n') : []) {
        let before: string | undefined;
        for (let page = 0; page < MAX_CORRECTION_PAGES; page++) {
          const list: AdminReportList = await adminReports({ group, status: 'open', ...(before ? { before } : {}) });
          rows.push(...list.rows);
          if (list.nextBefore === null) break;
          before = list.nextBefore;
          if (page === MAX_CORRECTION_PAGES - 1) more = true;
        }
      }
      rows.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
      setState({ name: 'loaded', data: { rows, more } });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setState({ name: 'failed' });
    }
  }, [waiting, onSignedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Section
      title="Corrections"
      description={`We answer corrections within ${CORRECTION_ANSWER_BUSINESS_DAYS} business days. The longest waiting come first.`}
      busy={state.name === 'loading'}
      actions={
        groups.length > 0
          ? groups.map((group) => (
              <Button key={group.key} size="sm" variant="plain" onClick={() => onView(group)}>
                {`All ${featureName(group.topic)} corrections`}
              </Button>
            ))
          : undefined
      }
    >
      {state.name === 'loading' ? <SectionLoading /> : null}
      {state.name === 'failed' ? (
        <Banner tone="danger" title={LOAD_FAILED} action={{ label: 'Try again', onAction: () => void load() }} />
      ) : null}
      {state.name !== 'loaded' ? null : state.data.rows.length === 0 ? (
        <Card>
          <p className="web-empty-line">{NO_CORRECTIONS}</p>
        </Card>
      ) : (
        <ListGroup>
          {state.data.rows.map((row) => {
            const days = businessDaysWaiting(row.receivedAt, now);
            return (
              <ListRow
                key={row.id}
                title={
                  <>
                    {`${row.ref} · ${featureName(row.topic)}`}{' '}
                    {days > CORRECTION_ANSWER_BUSINESS_DAYS ? <Badge tone="danger">Late</Badge> : null}
                  </>
                }
                subtitle={[
                  `Received ${DATE.format(new Date(row.receivedAt))}`,
                  waitingLine(days),
                  row.hasContact ? 'Wants a reply' : 'No reply email',
                ].join(' · ')}
                control={
                  <Button size="sm" aria-label={`View ${row.ref}`} onClick={() => onOpen(row.id)}>
                    View
                  </Button>
                }
              />
            );
          })}
        </ListGroup>
      )}
      {state.name === 'loaded' && state.data.more ? (
        <p className="ua-footnote">More corrections are waiting than this list shows: open their group to see them all.</p>
      ) : null}
    </Section>
  );
}

/** Lookup by reference (an exact match, for privacy requests); a found report opens at once. */
function FindReport({ onFound, onSignedOut }: { onFound(id: string): void; onSignedOut(): void }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function onFind(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    // Typed as people read it out: lowercase, spaces, O for 0 and I or L for 1 are all the same reference.
    const ref = parseReportRef(typed);
    if (ref === null) {
      setError(NOT_A_REFERENCE);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const found = (await adminReports({ ref })).rows[0];
      if (found) onFound(found.id);
      else setError(NO_REFERENCE);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setError(failureMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Find a report">
      <Card>
        <form className="web-inline-form web-find" noValidate onSubmit={(e) => void onFind(e)}>
          <TextField
            label="Reference"
            mono
            autoComplete="off"
            spellCheck={false}
            hint="The reference the person was shown, as in a privacy request."
            error={error}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <Button type="submit" loading={busy}>
            Find
          </Button>
        </form>
      </Card>
    </Section>
  );
}

/** "Fixed in" per platform: a detection version seen in the groups, or the one already set. */
function FixedIn({
  summary,
  pending,
  onFloor,
}: {
  summary: AdminReportsSummary;
  pending: string | null;
  onFloor(platform: PlatformId, adapter: string | null): void;
}) {
  return (
    <Section title="Fixed in">
      <ListGroup footer={FLOOR_NOTE}>
        {PLATFORMS.map((platform) => {
          const floor = summary.floors.find((f) => f.platform === platform) ?? null;
          const seen = summary.groups.flatMap((g) => (g.platform === platform && g.adapter ? [g.adapter] : []));
          // Newest first, the floor's own version among them.
          const versions = [...new Set([...seen, ...(floor ? [floor.adapter] : [])])].sort(
            (a, b) => (adapterOrder(b) ?? 0) - (adapterOrder(a) ?? 0),
          );
          return (
            <FloorRow
              key={platform}
              platform={platform}
              floor={floor}
              versions={versions}
              busy={pending === `floor:${platform}`}
              disabled={pending !== null}
              onFloor={onFloor}
            />
          );
        })}
      </ListGroup>
    </Section>
  );
}

function FloorRow({
  platform,
  floor,
  versions,
  busy,
  disabled,
  onFloor,
}: {
  platform: PlatformId;
  floor: ReportFloor | null;
  versions: readonly string[];
  busy: boolean;
  disabled: boolean;
  onFloor(platform: PlatformId, adapter: string | null): void;
}) {
  const id = useId();
  const name = PLATFORM_NAMES[platform];
  const [picked, setPicked] = useState<string | null>(null);
  // The newest version until one is picked, and again if the picked one is no longer listed.
  const value = picked !== null && versions.includes(picked) ? picked : (versions[0] ?? '');
  const subtitle = floor
    ? `Fixed in ${versionOf(floor.adapter)} since ${DATE.format(new Date(floor.setAt))}`
    : versions.length > 0
      ? 'Not set'
      : `Not set. No reports from ${name} yet.`;
  return (
    <ListRow
      title={name}
      subtitle={subtitle}
      control={
        <div className="web-row-buttons">
          {versions.length > 0 ? (
            <>
              <label className="ua-vh" htmlFor={id}>
                {`${name} detection version`}
              </label>
              <select id={id} className="ua-select" value={value} onChange={(e) => setPicked(e.target.value)}>
                {versions.map((v) => (
                  <option key={v} value={v}>
                    {versionOf(v)}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                loading={busy}
                disabled={disabled}
                aria-label={`Set ${name} fixed-in version`}
                onClick={() => onFloor(platform, value)}
              >
                Set
              </Button>
            </>
          ) : null}
          {floor ? (
            <Button
              size="sm"
              disabled={disabled}
              aria-label={`Clear ${name} fixed-in version`}
              onClick={() => onFloor(platform, null)}
            >
              Clear
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

const dayTotal = (day: ReportDay) => day.linkedin + day.facebook + day.other;

/**
 * The last 30 days, newest first: a row of bars a day, as wide as its count against the busiest day, then the same
 * numbers as a table. The bars are hidden from screen readers, which read the table.
 */
function LastDays({ days }: { days: readonly ReportDay[] }) {
  const newest = [...days].reverse();
  const most = Math.max(1, ...days.map(dayTotal));
  return (
    <Section title={`Last ${DAYS} days`} description="Reports a day, newest first (UTC).">
      <div className="web-card web-bars" aria-hidden="true">
        <p className="web-bars-key">
          {PARTS.map((part) => (
            <span key={part}>
              <span className={`web-bar web-bar--${part}`} />
              {PART_LABELS[part]}
            </span>
          ))}
        </p>
        {newest.map((day) => (
          <div key={day.day} className="web-bar-row">
            <span>{DAY.format(new Date(day.day))}</span>
            <span className="web-bar-track">
              {PARTS.map((part) =>
                day[part] > 0 ? (
                  <span key={part} className={`web-bar web-bar--${part}`} style={{ width: `${(day[part] / most) * 100}%` }} />
                ) : null,
              )}
            </span>
            <span className="web-amount">{COUNT.format(dayTotal(day))}</span>
          </div>
        ))}
      </div>
      <details className="web-disclosure">
        <summary>Show as a table</summary>
        <div className="web-table-card">
          <table className="web-table">
            <caption>Reports a day (UTC)</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                {PARTS.map((part) => (
                  <th key={part} scope="col">
                    {PART_LABELS[part]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {newest.map((day) => (
                <tr key={day.day}>
                  <th scope="row">{DAY.format(new Date(day.day))}</th>
                  {PARTS.map((part) => (
                    <td key={part}>{COUNT.format(day[part])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </Section>
  );
}

/** A group's reports, 50 a page, newest first, by status; "Older" and "Newer" move through the pages. */
function GroupReports({
  group,
  status,
  now,
  busy,
  pending,
  onStatus,
  onOpen,
  onBack,
  onHandle,
  onSignedOut,
}: {
  group: ReportGroup;
  status: ListStatus;
  now: number;
  /** Any change in flight. */
  busy: boolean;
  /** This group's "Mark handled" in flight. */
  pending: boolean;
  onStatus(status: ListStatus): void;
  onOpen(id: string): void;
  onBack(): void;
  onHandle(resolution: ReportResolution): Promise<boolean>;
  onSignedOut(): void;
}) {
  const headingId = useId();
  const headingRef = useFocusWhen<HTMLHeadingElement>(true);
  /**
   * Each page's `before` for the status shown, the first page's none: "Newer" goes back one. Another status starts
   * again from its first page. The view stays mounted across statuses, so the focus stays on the status picked.
   */
  const [paging, setPaging] = useState<{ status: ListStatus; cursors: (string | undefined)[] }>({
    status,
    cursors: [undefined],
  });
  const cursors = paging.status === status ? paging.cursors : [undefined];
  const before = cursors.at(-1);
  const [state, setState] = useState<Loadable<AdminReportList>>({ name: 'loading' });
  /** A page is on its way. The page shown stays, with its buttons, so the focus isn't lost while it comes. */
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState({ name: 'loaded', data: await adminReports({ group: group.key, status, ...(before ? { before } : {}) }) });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setState({ name: 'failed' });
    } finally {
      setLoading(false);
    }
  }, [group.key, status, before, onSignedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  const title = groupTitle(group);
  const empty = status === 'open' ? 'No open reports.' : status === 'handled' ? 'No handled reports.' : 'No reports.';
  return (
    <section className="web-section web-view" aria-labelledby={headingId} aria-busy={loading || undefined}>
      <BackButton label="All reports" onBack={onBack} />
      <div className="web-view-head">
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>
          {title}
        </h2>
        <p className="web-group-stats">{groupStats(group, now)}</p>
      </div>
      <div className="web-toolbar">
        <SegmentedControl label="Show" value={status} options={STATUSES} onValueChange={onStatus} />
        {group.open > 0 ? (
          <MarkHandled
            kind={group.kind}
            name={title}
            busy={pending}
            disabled={busy}
            onHandle={(resolution) => {
              void onHandle(resolution).then((done) => (done ? load() : undefined));
            }}
          />
        ) : null}
      </div>
      {state.name === 'failed' ? (
        <Banner tone="danger" title={LOAD_FAILED} action={{ label: 'Try again', onAction: () => void load() }} />
      ) : null}
      {state.name === 'loading' ? <SectionLoading /> : null}
      {state.name !== 'loaded' ? null : state.data.rows.length === 0 ? (
        <Card>
          <p className="web-empty-line">{empty}</p>
        </Card>
      ) : (
        <ListGroup>
          {state.data.rows.map((row) => (
            <ListRow
              key={row.id}
              title={
                <>
                  {`${row.ref} · ${TIME.format(new Date(row.receivedAt))} UTC`}{' '}
                  {row.listed ? null : <Badge tone="warning">Unlisted id</Badge>}
                </>
              }
              subtitle={`${rowLine(row)} · ${statusLine(row)}`}
              control={
                <Button size="sm" aria-label={`View ${row.ref}`} onClick={() => onOpen(row.id)}>
                  View
                </Button>
              }
            />
          ))}
        </ListGroup>
      )}
      {state.name === 'loaded' && (cursors.length > 1 || state.data.nextBefore !== null) ? (
        <div className="web-pager">
          <Button
            size="sm"
            disabled={cursors.length === 1}
            onClick={() => {
              if (!loading) setPaging({ status, cursors: cursors.slice(0, -1) });
            }}
          >
            Newer
          </Button>
          <Button
            size="sm"
            disabled={state.data.nextBefore === null}
            onClick={() => {
              // Passed back exactly as it came: the server reads it as a cursor, not a time.
              const next = state.data.nextBefore;
              if (!loading && next !== null) setPaging({ status, cursors: [...cursors, next] });
            }}
          >
            Older
          </Button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * One report in full: when it came and how it stands, `describeReport`'s lines, a correction's words and reply
 * address, and what the server stored, as JSON text. Then "Mark handled" or "Reopen", and "Delete" after a question.
 */
function ReportDetails({
  id,
  backLabel,
  pending,
  onBack,
  onHandle,
  onReopen,
  onForget,
  onDelete,
  onSignedOut,
}: {
  id: string;
  backLabel: string;
  pending: string | null;
  onBack(): void;
  onHandle(resolution: ReportResolution): Promise<boolean>;
  onReopen(): Promise<boolean>;
  onForget(): Promise<boolean>;
  onDelete(): Promise<void>;
  onSignedOut(): void;
}) {
  const headingId = useId();
  const headingRef = useFocusWhen<HTMLHeadingElement>(true);
  const [state, setState] = useState<Loadable<ReportDetail>>({ name: 'loading' });
  const [asking, setAsking] = useState(false);

  /** The report is on its way; after a change the one shown stays until it comes, so the page doesn't jump. */
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setState({ name: 'loaded', data: await adminReport(id) });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else if (err instanceof ApiError && err.status === 404) setState({ name: 'gone' });
      else setState({ name: 'failed' });
    } finally {
      setLoading(false);
    }
  }, [id, onSignedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  /** A change, then the report again. */
  async function change(action: () => Promise<boolean>) {
    if (await action()) await load();
  }

  const report = state.name === 'loaded' ? state.data : null;
  return (
    <article className="web-section web-view" aria-labelledby={headingId} aria-busy={loading || undefined}>
      <BackButton label={backLabel} onBack={onBack} />
      <div className="web-view-head">
        <h2 id={headingId} ref={headingRef} tabIndex={-1}>
          {report ? `Report ${report.ref}` : 'Report'}
        </h2>
        {report ? <p className="web-group-stats">{handledLine(report)}</p> : null}
      </div>
      {state.name === 'loading' ? <SectionLoading /> : null}
      {state.name === 'failed' ? (
        <Banner tone="danger" title={LOAD_FAILED} action={{ label: 'Try again', onAction: () => void load() }} />
      ) : null}
      {state.name === 'gone' ? (
        <Card>
          <p className="web-empty-line">{GONE}</p>
        </Card>
      ) : null}
      {report ? (
        <>
          <div className="web-toolbar">
            {report.handledAt === null ? (
              <MarkHandled
                kind={report.kind}
                name={`report ${report.ref}`}
                busy={pending === 'handle'}
                disabled={pending !== null}
                onHandle={(resolution) => void change(() => onHandle(resolution))}
              />
            ) : (
              <Button size="sm" loading={pending === 'handle'} disabled={pending !== null} onClick={() => void change(onReopen)}>
                Reopen
              </Button>
            )}
            <Button size="sm" variant="destructive" icon={Trash2} disabled={pending !== null} onClick={() => setAsking(true)}>
              Delete
            </Button>
          </div>
          <Card>
            <Facts
              items={[
                ['Received', `${TIME.format(new Date(report.receivedAt))} UTC`],
                ['About', groupTitle(report)],
                ['Status', handledLine(report)],
                ['Extension id', report.listed ? 'Listed on this server' : 'Not listed on this server (EXTENSION_IDS)'],
                [
                  'Network',
                  report.firstFromNetwork
                    ? 'The first report of its kind about this site from its network that day'
                    : 'Not the first of its kind about this site from its network that day',
                ],
                ...(report.unknownCodes > 0
                  ? ([['Codes left out', `${count(report.unknownCodes, 'code', 'codes')} this server doesn't know yet`]] as const)
                  : []),
              ]}
            />
          </Card>
          <section className="web-report-part">
            <h3>What was sent</h3>
            <Card>
              <ul className="web-lines">
                {report.lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </Card>
          </section>
          {report.message !== null ? (
            <section className="web-report-part">
              <h3>In their own words</h3>
              <p className="web-message">{cleanReportMessage(report.message)}</p>
            </section>
          ) : null}
          {report.kind === 'correction' || report.contact !== null ? (
            <section className="web-report-part">
              <h3>Reply to</h3>
              {report.contact === null ? (
                <Card>
                  <p className="web-empty-line">No reply email.</p>
                </Card>
              ) : (
                <ListGroup>
                  <ListRow
                    icon={{ icon: Mail, tint: 'blue' }}
                    title={
                      isEmail(report.contact) ? (
                        <a className="web-contact" href={replyLink(report.contact, report.ref)}>
                          {report.contact}
                        </a>
                      ) : (
                        <span className="web-contact">{`Not an email address: ${cleanReportMessage(report.contact)}`}</span>
                      )
                    }
                    control={
                      <Button
                        size="sm"
                        loading={pending === 'forget'}
                        disabled={pending !== null}
                        onClick={() => void change(onForget)}
                      >
                        Forget email
                      </Button>
                    }
                  />
                </ListGroup>
              )}
            </section>
          ) : null}
          <details className="web-disclosure web-report-part">
            <summary>As stored</summary>
            <pre className="web-json">{JSON.stringify(report.details, null, 2)}</pre>
          </details>
          <Dialog
            open={asking}
            onOpenChange={setAsking}
            alert
            title={`Delete report ${report.ref}?`}
            description={DELETE_LINE}
            actions={
              <>
                {/* First, so the dialog opens with it focused: the destructive button never has the focus first. */}
                <Button onClick={() => setAsking(false)}>Cancel</Button>
                <Button
                  variant="destructive-solid"
                  loading={pending === 'delete'}
                  onClick={() => {
                    setAsking(false);
                    void onDelete();
                  }}
                >
                  Delete
                </Button>
              </>
            }
          />
        </>
      ) : null}
    </article>
  );
}

/** "Open", or "Handled Oct 16, 2026, 09:00 UTC by tom@example.com: Fixed" ("by" left out when nobody is named). */
function handledLine(report: ReportDetail): string {
  if (report.handledAt === null) return 'Open';
  const by = report.handledBy ? ` by ${report.handledBy.email}` : '';
  const resolution = report.resolution ? `: ${RESOLUTION_LABELS[report.resolution]}` : '';
  return `Handled ${TIME.format(new Date(report.handledAt))} UTC${by}${resolution}`;
}
