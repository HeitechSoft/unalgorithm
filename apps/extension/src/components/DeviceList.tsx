import type { AccountDevice } from '@unalgorithm/protocol';
import { Banner, Button, Dialog, ListGroup, ListRow, useToast } from '@unalgorithm/ui';
import { useEffect, useState } from 'react';
import { type BgError, type PublicServerAccount, sendToBackground } from '../lib/messages.ts';
import { accountPageUrl } from '../lib/server-label.ts';

const NO_ANSWER: BgError = { code: 'unknown', message: "unAlgorithm couldn't finish that. Reload this page and try again." };

const nameOf = (d: AccountDevice) => d.name ?? 'Unnamed device';

/**
 * The devices signed in to the account (R11), with a way to revoke a lost one, and the link to the server's account
 * page, where passkeys, the export and deleting the account live. The current device has no "Revoke": the card's
 * "Sign out" covers it. `onSignInAgain` runs from the click itself, as in `AccountSync`.
 */
export function DeviceList({
  account,
  onSignInAgain,
  onSignedOut,
}: {
  account: PublicServerAccount;
  onSignInAgain(): void;
  onSignedOut(): void;
}) {
  const toast = useToast();
  const [devices, setDevices] = useState<AccountDevice[]>([]);
  const [error, setError] = useState<BgError | null>(null);
  const [target, setTarget] = useState<AccountDevice | null>(null);
  const { title } = account.label;
  const manage = accountPageUrl(account.origin);

  useEffect(() => {
    let alive = true;
    sendToBackground({ type: 'serverDevices' })
      .then((res) => alive && (res.ok ? setDevices(res.devices) : setError(res.error)))
      .catch(() => alive && setError(NO_ANSWER));
    return () => {
      alive = false;
    };
  }, []);

  const revoke = (device: AccountDevice) => {
    setTarget(null);
    setError(null);
    sendToBackground({ type: 'serverRevokeDevice', deviceId: device.id })
      .then((res) => {
        if (!res.ok) return setError(res.error);
        setDevices((all) => all.filter((d) => d.id !== device.id));
        toast({ title: 'Revoked.' });
        if (res.signedOut) onSignedOut();
      })
      .catch(() => setError(NO_ANSWER));
  };

  return (
    <>
      <ListGroup
        header={`Devices signed in to ${title}`}
        footer={
          manage ? (
            <a href={manage} target="_blank" rel="noreferrer">
              Manage your account
            </a>
          ) : undefined
        }
      >
        {error ? (
          <Banner
            tone="warning"
            title={error.message}
            action={error.code === 'auth-required' ? { label: 'Sign in again', onAction: onSignInAgain } : undefined}
          />
        ) : null}
        {devices.map((d) => (
          <ListRow
            key={d.id}
            title={nameOf(d)}
            subtitle={
              d.current
                ? 'This computer'
                : `Last used ${d.lastUsedAt ? new Date(d.lastUsedAt).toLocaleDateString([], { dateStyle: 'medium' }) : 'not yet'}`
            }
            control={
              d.current ? undefined : (
                <Button size="sm" aria-label={`Revoke ${nameOf(d)}`} onClick={() => setTarget(d)}>
                  Revoke
                </Button>
              )
            }
          />
        ))}
      </ListGroup>
      <Dialog
        open={target !== null}
        onOpenChange={(open) => !open && setTarget(null)}
        alert
        title={`Revoke ${target ? nameOf(target) : 'this device'}?`}
        description={`It's signed out at once and has to sign in again to use ${title}.`}
        actions={
          <>
            <Button onClick={() => setTarget(null)} autoFocus>
              Cancel
            </Button>
            <Button variant="destructive-solid" onClick={() => target && revoke(target)}>
              Revoke
            </Button>
          </>
        }
      />
    </>
  );
}
