/**
 * The admin page's usage (R38, R43): today's posts, requests and AI cost against the server's daily spend limit, with a
 * warning while the spend breaker holds AI for everyone, the last 30 days newest first, and, once the server reports its
 * status (CL4-14), disk, database, recent errors, backups and open alerts. Every figure is the server's
 * (`GET /v1/admin/overview`, CL4-05) and none of it holds content: counts, sizes, times and fixed codes. The section
 * loads the overview itself, as the account page's Credits does.
 */
import { formatApproxCost, formatPrice } from '@unalgorithm/core';
import type { AdminOverview, BackupStatus, OpsStatus } from '@unalgorithm/protocol';
import { Banner, ListGroup, ListRow } from '@unalgorithm/ui';
import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError, adminOverview } from './api.ts';

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
const COUNT = new Intl.NumberFormat('en-US');
const GIGABYTES = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
/** A usage day ("2026-10-15", a UTC day): "Oct 15". */
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** An instant in UTC, followed by " UTC" where it is shown: "Oct 15, 2026, 03:00". */
const TIME = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23', timeZone: 'UTC' });

/**
 * A size in decimal units: GB with one decimal from 1 GB, else whole MB, so 48,000,000 bytes reads "48 MB" rather than
 * "0.0 GB"; "unknown" when the server could not read it.
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  const megabytes = Math.round(bytes / 1e6);
  return megabytes < 1000 ? `${megabytes} MB` : `${GIGABYTES.format(bytes / 1e9)} GB`;
}

/** "local backup: last Oct 15, 2026, 03:00 UTC, 1.2 GB", or "offsite backup failed: the copy failed". */
export function backupLine(status: BackupStatus): string {
  if (!status.ok) {
    return status.error ? `${status.kind} backup failed: ${BACKUP_FAILURE[status.error]}` : `${status.kind} backup failed`;
  }
  const at = status.lastSuccessAt ?? status.finishedAt;
  const when = at ? `${TIME.format(new Date(at))} UTC` : 'unknown';
  return `${status.kind} backup: last ${when}, ${formatBytes(status.bytes)}`;
}

type State = { name: 'loading' } | { name: 'failed' } | { name: 'loaded'; overview: AdminOverview };

export interface AdminUsageProps {
  /** Called when the server no longer knows the session (401): the page goes back to sign-in. Keep it stable. */
  onSignedOut(): void;
}

export function AdminUsage({ onSignedOut }: AdminUsageProps) {
  const [state, setState] = useState<State>({ name: 'loading' });
  const headingId = useId();

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
    void load();
  }, [load]);

  return (
    <section className="web-section" aria-labelledby={headingId} aria-busy={state.name === 'loading' || undefined}>
      <h2 id={headingId}>Usage</h2>
      {state.name === 'failed' ? (
        <Banner tone="danger" title={LOAD_FAILED} action={{ label: 'Try again', onAction: () => void load() }} />
      ) : null}
      {state.name === 'loaded' ? <UsageDetails overview={state.overview} /> : null}
    </section>
  );
}

/** A figure at the end of a row. */
function figure(value: string) {
  return <span className="web-amount">{value}</span>;
}

function UsageDetails({ overview: { today, last30Days, spendLimitMicros, breakerTripped, ops } }: { overview: AdminOverview }) {
  return (
    <>
      {breakerTripped ? <Banner tone="warning" title={BREAKER} /> : null}
      <ListGroup header="Today">
        <ListRow title="Posts" control={figure(COUNT.format(today.posts))} />
        <ListRow title="Requests" control={figure(COUNT.format(today.requests))} />
        <ListRow title="AI cost" control={figure(formatApproxCost(today.costMicros))} />
        <ListRow title="Daily spend limit" control={figure(formatPrice(spendLimitMicros))} />
      </ListGroup>
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
      {ops ? <ServerStatus ops={ops} /> : null}
    </>
  );
}

function ServerStatus({ ops }: { ops: OpsStatus }) {
  const disk =
    ops.diskFreeBytes === null || ops.diskTotalBytes === null
      ? formatBytes(ops.diskFreeBytes)
      : `${formatBytes(ops.diskFreeBytes)} of ${formatBytes(ops.diskTotalBytes)}`;
  return (
    <ListGroup header="Server">
      <ListRow title="Disk free" control={figure(disk)} />
      <ListRow title="Database size" control={figure(formatBytes(ops.databaseBytes))} />
      <ListRow title={`${COUNT.format(ops.errors15m)} ${ops.errors15m === 1 ? 'error' : 'errors'} in the last 15 minutes`} />
      {ops.backups === null ? (
        <ListRow title={NOT_WATCHED} />
      ) : ops.backups.length === 0 ? (
        <ListRow title={NO_BACKUP} />
      ) : (
        ops.backups.map((backup) => <ListRow key={backup.kind} title={backupLine(backup)} />)
      )}
      {ops.openAlerts.map((alert) => (
        <ListRow
          key={alert.key}
          title={alert.key}
          subtitle={`${alert.level} · since ${TIME.format(new Date(alert.openedAt))} UTC`}
        />
      ))}
    </ListGroup>
  );
}
