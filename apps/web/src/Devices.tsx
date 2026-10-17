/**
 * The account page's Devices section (R11): the devices signed in to the account with the extension, each revocable
 * after a confirm dialog, so a lost laptop can be signed out from any browser. A revoked device has to sign in again;
 * the server marks it at once (CL3-12). The section stays the page's own: the extension lists devices with its own
 * component (CL3-22).
 */
import type { AccountDevice } from '@unalgorithm/protocol';
import { Banner, Button, Dialog, ListGroup, ListRow, useToast } from '@unalgorithm/ui';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, listDevices, revokeDevice } from './api.ts';
import { failureMessage } from './SignIn.tsx';

const LOAD_FAILED = "Couldn't load your devices.";
/** Days in the reader's time zone, written as Credits writes its days: "Oct 14, 2026". */
const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });

type State = { name: 'loading' } | { name: 'failed' } | { name: 'loaded'; devices: AccountDevice[] };

export interface DevicesProps {
  /** Called when the server no longer knows the session (401): the page goes back to sign-in. Keep it stable. */
  onSignedOut(): void;
}

export function Devices({ onSignedOut }: DevicesProps) {
  const [state, setState] = useState<State>({ name: 'loading' });
  /** The device the dialog asks about; kept after the dialog closes, so its title stays while it fades. */
  const [asking, setAsking] = useState<AccountDevice | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** The device being revoked: its button shows the spinner. */
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setState({ name: 'loading' });
    setError(null);
    try {
      setState({ name: 'loaded', devices: await listDevices() });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setState({ name: 'failed' });
    }
  }, [onSignedOut]);

  useEffect(() => {
    void load();
  }, [load]);

  function onAsk(device: AccountDevice) {
    setAsking(device);
    setConfirmOpen(true);
  }

  async function onRevoke() {
    const device = asking;
    setConfirmOpen(false);
    if (!device) return;
    setRevoking(device.id);
    setError(null);
    try {
      await revokeDevice(device.id);
      setState((s) => (s.name === 'loaded' ? { name: 'loaded', devices: s.devices.filter((d) => d.id !== device.id) } : s));
      toast({ title: 'Revoked.' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setError(failureMessage(err));
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="web-section" aria-busy={state.name === 'loading' || undefined}>
      {error ? <Banner tone="danger" title={error} /> : null}
      {state.name === 'failed' ? (
        <Banner tone="danger" title={LOAD_FAILED} action={{ label: 'Try again', onAction: () => void load() }} />
      ) : null}
      <ListGroup header="Devices signed in with unAlgorithm Feed">
        {state.name !== 'loaded' ? null : state.devices.length === 0 ? (
          <ListRow title={<span className="ua-secondary">No devices are signed in.</span>} />
        ) : (
          state.devices.map((device) => (
            <ListRow
              key={device.id}
              title={device.name ?? 'Unnamed device'}
              subtitle={`Signed in ${day(device.createdAt)} · Last used ${device.lastUsedAt ? day(device.lastUsedAt) : 'not yet'}`}
              control={
                <Button size="sm" loading={revoking === device.id} disabled={revoking !== null} onClick={() => onAsk(device)}>
                  Revoke
                </Button>
              }
            />
          ))
        )}
      </ListGroup>
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        alert
        title={`Revoke ${asking?.name ?? 'this device'}?`}
        description="It's signed out at once and has to sign in again to use this server."
        actions={
          <>
            {/* First, so the dialog opens with it focused: the destructive button never has the focus first. */}
            <Button onClick={() => setConfirmOpen(false)}>Cancel</Button>
            <Button variant="destructive-solid" onClick={() => void onRevoke()}>
              Revoke
            </Button>
          </>
        }
      />
    </div>
  );
}

function day(iso: string): string {
  return DAY.format(new Date(iso));
}
