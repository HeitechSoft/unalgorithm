/**
 * The admin overview's figures (R38, R43), all from one read of the overview (`GET /v1/admin/overview`, CL4-05), which
 * the page asks for once and keeps (`useOverview`): today's tiles (posts, AI cost against the server's daily spend
 * limit, people, open problem reports), a warning while the spend breaker holds AI for everyone, the server's status
 * once it reports one (CL4-14: disk, database, recent errors, backups, open alerts) and the last 30 days as bars and a
 * table. Every figure is the server's and none of it holds content: counts, sizes, times and fixed codes.
 */
import { formatApproxCost, formatBytes, formatPrice } from '@unalgorithm/core';
import {
  ADMIN_REPORTS_PAGE_PATH,
  type AdminOverview,
  type AdminUsers,
  type BackupStatus,
  type OpsStatus,
} from '@unalgorithm/protocol';
import { Banner, ListGroup, ListRow } from '@unalgorithm/ui';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, adminOverview } from './api.ts';
import { Section, SectionLoading, StatTile, Status } from './ui.tsx';

const LOAD_FAILED = "Couldn't load usage.";
const BREAKER = "Today's AI spending limit is reached. AI resumes for everyone at 00:00 UTC.";
const NOT_WATCHED = "Backups aren't watched on this server.";
const NO_BACKUP = 'No backup has finished yet.';
/** Why a backup run failed, by the code the backup scripts or the server's reader write. */
const BACKUP_FAILURE: Record<NonNullable<BackupStatus['error']>, string> = {
  'no-key': 'no backup key',
  dump: 'the database dump failed',
  encrypt: 'encryption failed',
  write: "the file couldn't be written",
  copy: 'the copy failed',
  verify: "the copy didn't match",
  unreadable: "its status file can't be read",
};
const BACKUP_NAMES: Record<BackupStatus['kind'], string> = { local: 'Local backup', offsite: 'Offsite backup' };
const COUNT = new Intl.NumberFormat('en-US');
/** A usage day ("2026-10-15", a UTC day): "Oct 15". */
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** An instant in UTC, followed by " UTC" where it is shown: "Oct 15, 2026, 03:00". */
const TIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23', timeZone: 'UTC' });

/** Under a backup's name: "Last Oct 15, 2026, 03:00 UTC · 1.2 GB", or why it failed ("The copy failed"). */
export function backupLine(status: BackupStatus): string {
  if (!status.ok) {
    if (!status.error) return 'The last run failed';
    const reason = BACKUP_FAILURE[status.error];
    return `${reason.charAt(0).toUpperCase()}${reason.slice(1)}`;
  }
  const at = status.lastSuccessAt ?? status.finishedAt;
  return `Last ${at ? `${TIME.format(new Date(at))} UTC` : 'unknown'} · ${formatBytes(status.bytes)}`;
}

export type OverviewState = { name: 'loading' } | { name: 'failed' } | { name: 'loaded'; overview: AdminOverview };

/**
 * The overview, read once `ready` (the page's own data has loaded, so the session is an admin's), and again with
 * `load`. A 401 ends the page's session (`onSignedOut`, which must keep its identity).
 */
export function useOverview(ready: boolean, onSignedOut: () => void): { state: OverviewState; load(): Promise<void> } {
  const [state, setState] = useState<OverviewState>({ name: 'loading' });
  const load = useCallback(async () => {
    setState({ name: 'loading' });
    try {
      setState({ name: 'loaded', overview: await adminOverview() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setState({ name: 'failed' });
    }
  }, [onSignedOut]);
  useEffect(() => {
    if (ready) void load();
  }, [ready, load]);
  return { state, load };
}

/**
 * Today at a glance: posts, AI cost against the daily spend limit, the people and pending invites, and the open
 * problem reports while the server takes them. Then the spend breaker's warning, when it holds AI.
 */
export function OverviewStats({ overview, users }: { overview: OverviewState; users: AdminUsers }) {
  const people = (
    <StatTile
      label="People"
      value={COUNT.format(users.users.length)}
      detail={
        users.invites.length > 0
          ? `${COUNT.format(users.invites.length)} ${users.invites.length === 1 ? 'invite' : 'invites'} pending`
          : 'No invites pending'
      }
    />
  );
  if (overview.name !== 'loaded') return <div className="web-stats">{people}</div>;
  const { today, spendLimitMicros, breakerTripped, reports } = overview.overview;
  const share = spendLimitMicros > 0 ? today.costMicros / spendLimitMicros : 0;
  return (
    <>
      <div className="web-stats">
        <StatTile
          label="Posts today"
          value={COUNT.format(today.posts)}
          detail={`${COUNT.format(today.requests)} ${today.requests === 1 ? 'request' : 'requests'}`}
        />
        <StatTile
          label="AI cost today"
          value={formatPrice(today.costMicros)}
          meter={share}
          tone={breakerTripped ? 'danger' : share >= 0.8 ? 'warning' : 'accent'}
          detail={`of ${formatPrice(spendLimitMicros)} daily spend limit`}
        />
        {people}
        {reports?.enabled ? (
          <StatTile
            label="Open problem reports"
            value={COUNT.format(reports.open)}
            detail={`${COUNT.format(reports.last24h)} in the last 24 hours`}
            href={ADMIN_REPORTS_PAGE_PATH}
          />
        ) : null}
      </div>
      {breakerTripped ? <Banner tone="warning" title={BREAKER} /> : null}
    </>
  );
}

/** The server's status and the last 30 days, or why they couldn't load. */
export function AdminUsage({ overview: { state, load } }: { overview: { state: OverviewState; load(): Promise<void> } }) {
  if (state.name !== 'loaded') {
    return (
      <Section title="Usage" busy={state.name === 'loading'}>
        {state.name === 'failed' ? (
          <Banner tone="danger" title={LOAD_FAILED} action={{ label: 'Try again', onAction: () => void load() }} />
        ) : (
          <SectionLoading />
        )}
      </Section>
    );
  }
  const { ops, last30Days } = state.overview;
  return (
    <>
      {ops ? <ServerStatus ops={ops} /> : null}
      <Section title="Usage" description="Posts a day for the last 30 days (UTC).">
        <UsageChart days={last30Days} />
        <details className="web-disclosure">
          <summary>Show as a table</summary>
          <div className="web-table-card">
            <table className="web-table">
              <caption>Last 30 days (UTC)</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Posts</th>
                  <th scope="col">Requests</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {[...last30Days].reverse().map((day) => (
                  <tr key={day.day}>
                    <th scope="row">{DAY.format(new Date(day.day))}</th>
                    <td>{COUNT.format(day.posts)}</td>
                    <td>{COUNT.format(day.requests)}</td>
                    <td>{formatApproxCost(day.costMicros)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </Section>
    </>
  );
}

/** Posts a day as bars, oldest on the left; each bar names its day and count on hover. Screen readers read the table. */
function UsageChart({ days }: { days: AdminOverview['last30Days'] }) {
  const most = Math.max(1, ...days.map((d) => d.posts));
  const first = days[0];
  const last = days.at(-1);
  return (
    <div className="web-card web-chart" aria-hidden="true">
      <div className="web-chart-top">
        <span>{COUNT.format(most)}</span>
      </div>
      <div className="web-chart-bars">
        {days.map((day) => (
          <span
            key={day.day}
            className="web-chart-bar"
            title={`${DAY.format(new Date(day.day))}: ${COUNT.format(day.posts)} posts`}
          >
            <span style={{ height: `${Math.max(day.posts > 0 ? 2 : 0, (day.posts / most) * 100)}%` }} />
          </span>
        ))}
      </div>
      <div className="web-chart-axis">
        <span>{first ? DAY.format(new Date(first.day)) : null}</span>
        <span>{last ? DAY.format(new Date(last.day)) : null}</span>
      </div>
    </div>
  );
}

/** A figure at the end of a row. */
function figure(value: string) {
  return <span className="web-amount">{value}</span>;
}

function ServerStatus({ ops }: { ops: OpsStatus }) {
  const disk =
    ops.diskFreeBytes === null || ops.diskTotalBytes === null
      ? formatBytes(ops.diskFreeBytes)
      : `${formatBytes(ops.diskFreeBytes)} of ${formatBytes(ops.diskTotalBytes)}`;
  const healthy = ops.errors15m === 0 && ops.openAlerts.length === 0 && (ops.backups ?? []).every((b) => b.ok);
  return (
    <Section
      title="Server"
      actions={<Status tone={healthy ? 'success' : 'warning'}>{healthy ? 'Healthy' : 'Needs attention'}</Status>}
    >
      <ListGroup>
        <ListRow title="Disk free" control={figure(disk)} />
        <ListRow title="Database size" control={figure(formatBytes(ops.databaseBytes))} />
        <ListRow
          title={`${COUNT.format(ops.errors15m)} ${ops.errors15m === 1 ? 'error' : 'errors'} in the last 15 minutes`}
          control={<Status tone={ops.errors15m === 0 ? 'success' : 'danger'}>{ops.errors15m === 0 ? 'None' : 'Errors'}</Status>}
        />
        {ops.backups === null ? (
          <ListRow title={NOT_WATCHED} />
        ) : ops.backups.length === 0 ? (
          <ListRow title={NO_BACKUP} control={<Status tone="warning">None</Status>} />
        ) : (
          ops.backups.map((backup) => (
            <ListRow
              key={backup.kind}
              title={BACKUP_NAMES[backup.kind]}
              subtitle={backupLine(backup)}
              control={<Status tone={backup.ok ? 'success' : 'danger'}>{backup.ok ? 'OK' : 'Failed'}</Status>}
            />
          ))
        )}
        {ops.openAlerts.map((alert) => (
          <ListRow
            key={alert.key}
            title={alert.key}
            subtitle={`${alert.level} · since ${TIME.format(new Date(alert.openedAt))} UTC`}
            control={<Status tone={alert.level === 'critical' ? 'danger' : 'warning'}>Alert</Status>}
          />
        ))}
      </ListGroup>
    </Section>
  );
}
