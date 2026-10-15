import { Banner, Button, Dialog, ListGroup, ListRow, Switch, useToast } from '@unalgorithm/ui';
import { useEffect, useRef, useState } from 'react';
import { type PublicServerAccount, type SyncStatus, sendToBackground } from '../lib/messages.ts';
import { syncStateItem } from '../lib/storage.ts';

const SWITCH = 'Sync settings between your computers';
const NO_ANSWER = "UnAlgorithm couldn't finish that. Reload this page and try again.";
/** "Synced just now" turns into "Synced 1 minute ago" without a new status. */
const TICK_MS = 30_000;

/** When the last sync finished, in words: just now, minutes ago, or the time (with the day once it isn't today). */
export function syncedText(lastSyncAt: number | null, now: number): string {
  if (lastSyncAt === null) return 'Not synced yet.';
  const minutes = Math.floor((now - lastSyncAt) / 60_000);
  if (minutes < 1) return 'Synced just now';
  if (minutes < 60) return `Synced ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const at = new Date(lastSyncAt);
  const today = at.toDateString() === new Date(now).toDateString();
  return `Synced at ${today ? at.toLocaleTimeString([], { timeStyle: 'short' }) : at.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
}

/**
 * The "Sync settings" switch on the server card (R15, R17): turning it on first says what is synced and what never
 * leaves this computer; then a one-line status, or what is wrong and what to do. The background does the work.
 * `onSignInAgain` is the card's click-only sign-in: it runs from the click itself, so Chrome can show its permission
 * prompt.
 */
export function AccountSync({ account, onSignInAgain }: { account: PublicServerAccount; onSignInAgain(): void }) {
  const toast = useToast();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  /** The value asked for while the background turns sync on or off. */
  const [pending, setPending] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  const [, tick] = useState(0);
  const running = useRef(false);
  const { title } = account.label;

  useEffect(() => {
    let alive = true;
    const refresh = () =>
      void sendToBackground({ type: 'syncStatus' })
        .then((s) => alive && setStatus(s))
        .catch(() => undefined);
    refresh();
    const unwatch = syncStateItem.watch(refresh);
    const timer = window.setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => {
      alive = false;
      unwatch();
      window.clearInterval(timer);
    };
  }, []);

  /** One request at a time; the switch stays focusable meanwhile (a disabled button drops the keyboard focus). */
  const apply = (request: () => Promise<SyncStatus>, asked: boolean | null = null) => {
    if (running.current) return;
    running.current = true;
    setPending(asked);
    request()
      .then(setStatus)
      .catch(() => toast({ title: NO_ANSWER }))
      .finally(() => {
        running.current = false;
        setPending(null);
      });
  };
  const setEnabled = (enabled: boolean) => apply(() => sendToBackground({ type: 'syncSetEnabled', enabled }), enabled);

  if (!status) return null;

  const problem = status.state === 'problem' && status.message ? status.message : null;
  const footnote =
    pending === true || status.state === 'syncing'
      ? 'Syncing…'
      : pending === false || (!status.enabled && !problem)
        ? 'Your settings stay on this computer.'
        : status.state === 'ok'
          ? syncedText(status.lastSyncAt, Date.now())
          : undefined;

  return (
    <>
      <ListGroup header="Sync" footer={footnote}>
        <ListRow
          title={SWITCH}
          control={
            <Switch
              label={SWITCH}
              checked={pending ?? status.enabled}
              onCheckedChange={(on) => (on ? setAsking(true) : setEnabled(false))}
            />
          }
        />
      </ListGroup>
      {problem ? (
        <Banner
          tone="warning"
          title={problem}
          action={
            status.problem === 'auth'
              ? { label: 'Sign in again', onAction: onSignInAgain }
              : { label: 'Try again', onAction: () => apply(() => sendToBackground({ type: 'syncNow' })) }
          }
        />
      ) : null}
      <Dialog
        open={asking}
        onOpenChange={setAsking}
        alert
        title="Turn on sync?"
        description={`Your settings, interests and exceptions, including the names of people you always show or hide, are saved on ${title} and kept the same on every computer where you sign in and turn on sync. API keys and sign-in tokens never leave this computer. What UnAlgorithm learned from your feedback stays on this computer too.`}
        actions={
          <>
            <Button onClick={() => setAsking(false)} autoFocus>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setAsking(false);
                setEnabled(true);
              }}
            >
              Turn on sync
            </Button>
          </>
        }
      />
    </>
  );
}
