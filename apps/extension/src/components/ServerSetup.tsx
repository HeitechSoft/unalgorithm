import type { AISourceConfig, Device } from '@unalgorithm/core';
import { CLOUD_BETA_DOCUMENTS, MAX_POST_CHARS, siteUrl } from '@unalgorithm/protocol';
import { Badge, Banner, Button, ListRow, TextField } from '@unalgorithm/ui';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { useAiStatus } from '../lib/hooks.ts';
import { type PublicServerAccount, sendToBackground } from '../lib/messages.ts';
import { isServerAt, PINNED_CLOUD_ORIGIN, recipientText, type ServerLabel } from '../lib/server-label.ts';
import { AccountSync } from './AccountSync.tsx';
import { BalancePill } from './BalancePill.tsx';
import { DeviceList } from './DeviceList.tsx';

declare global {
  interface ImportMetaEnv {
    /** `cloudEnabled()` in wxt.config.ts: true in builds made with `UA_CLOUD=1`, and in development and e2e builds. */
    readonly UA_CLOUD: boolean;
  }
}

/**
 * Whether this build offers the server card (R47a). Store builds don't until the Cloud beta notice, the beta terms and
 * the store disclosures are live; their manifest has no `identity` permission either.
 */
export const CLOUD_ENABLED: boolean = import.meta.env.UA_CLOUD === true;

const WHAT_IS_SENT = `What is sent: the text of posts that pass your filters (up to ${MAX_POST_CHARS.toLocaleString('en-US')} characters, emails and phone numbers masked), the kind of media and a shared link's site and title, whether the author is a person or a page, and your interests.`;
const NEVER_SENT = "Never sent: author names, profile links, comments, images, and Facebook posts that aren't public.";
const NO_PERMISSION = 'UnAlgorithm needs permission to open the sign-in window.';
const NO_ANSWER = "UnAlgorithm couldn't finish that. Reload this page and try again.";

type View =
  | { step: 'loading' }
  | { step: 'address' }
  /** Who receives posts from this server and what is sent, before anything is (R25). */
  | { step: 'consent'; origin: string; label: ServerLabel }
  | { step: 'account'; account: PublicServerAccount };

/**
 * Signing in to an UnAlgorithm server: its address, then who receives posts and what is sent, then an emailed code on
 * the server's own page. The background does the work (ADR 0005): this page never sees a token. Consent is asked before
 * the first sign-in to an origin; "Sign in again" (R26) and "Turn on" reuse the account's origin without asking again.
 */
export function ServerSetup({ device, onSaved }: { device: Device; onSaved?(cfg: AISourceConfig): void }) {
  // Counts sign-ins to a server that bills, so the balance is asked for again: "Sign in again" (R26), or a first sign-in
  // while AI already uses that server, leaves the source unchanged, and the status from before has no balance.
  const [billedSignIns, setBilledSignIns] = useState(0);
  // The balance for the account row (R31). The first message, in every view: `aiStatus` then goes out before
  // `serverAccount`, and the messages after that one stay exactly the sign-in steps (server-setup.test.tsx records
  // every message and checks them; its server doesn't bill, so no `aiStatus` follows the sign-in).
  const ai = useAiStatus(`${JSON.stringify(device.aiSource)} ${billedSignIns}`);
  const [view, setView] = useState<View>({ step: 'loading' });
  const [address, setAddress] = useState(PINNED_CLOUD_ORIGIN);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const moved = useRef(false);

  useEffect(() => {
    let live = true;
    sendToBackground({ type: 'serverAccount' })
      .then(({ account }) => live && setView(account ? { step: 'account', account } : { step: 'address' }))
      .catch(() => live && setView({ step: 'address' }));
    return () => {
      live = false;
    };
  }, []);

  /** Each step is a new element; once the person has moved between steps, it takes the focus so the keyboard follows. */
  const focusStep = useCallback((el: HTMLElement | null) => {
    if (el && moved.current) el.focus();
  }, []);

  const go = (next: View) => {
    moved.current = true;
    setError(null);
    setView(next);
  };

  /** One action at a time; its error replaces the last one. `task` starts in the same tick, so a permission prompt can. */
  const run = (task: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    task()
      .catch(() => setError(NO_ANSWER))
      .finally(() => {
        running.current = false;
        setBusy(false);
      });
  };

  const discover = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const found = await sendToBackground({ type: 'serverDiscover', baseUrl: address });
      if (!found.ok) return setError(found.error.message);
      go({ step: 'consent', origin: found.origin, label: found.label });
    });
  };

  // Called from a click: Chrome opens the permission prompt only before anything else is awaited.
  const signIn = (origin: string) =>
    run(async () => {
      const granted = await browser.permissions.request({ permissions: ['identity'] }).catch(() => false);
      if (!granted) return setError(NO_PERMISSION);
      const res = await sendToBackground({ type: 'serverSignIn', baseUrl: origin });
      if (!res.ok) return setError(res.error.message);
      go({ step: 'account', account: res.account });
      if (res.account.billing) setBilledSignIns((n) => n + 1);
      onSaved?.({ kind: 'server', baseUrl: res.account.origin });
    });

  const signOut = () =>
    run(async () => {
      await sendToBackground({ type: 'serverSignOut' });
      go({ step: 'address' });
    });

  // Signed in, but AI was switched to something else since: the account is still there, so no new sign-in.
  const turnOn = (origin: string) =>
    run(async () => {
      const config: AISourceConfig = { kind: 'server', baseUrl: origin };
      const res = await sendToBackground({ type: 'saveSource', config });
      if (!res.ok) return setError(res.error.message);
      onSaved?.(config);
    });

  const problem = error ? (
    <Banner tone="danger" title="That didn't work">
      {error}
    </Banner>
  ) : null;

  if (view.step === 'loading') return null;

  if (view.step === 'address') {
    return (
      <form key="address" ref={focusStep} tabIndex={-1} className="ua-stack" onSubmit={discover} noValidate>
        <TextField
          label="Server address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          mono
          inputMode="url"
          spellCheck={false}
          autoCapitalize="off"
        />
        {problem}
        <div>
          <Button type="submit" variant="primary" loading={busy}>
            Continue
          </Button>
        </div>
      </form>
    );
  }

  if (view.step === 'consent') {
    const { label, origin } = view;
    return (
      <div key={`consent:${origin}`} ref={focusStep} tabIndex={-1} className="ua-stack">
        <div>
          <div className="ua-hstack ua-wrap">
            <h4 className="ua-headline">{label.title}</h4>
            {label.isCloud ? <Badge>Invite only</Badge> : null}
          </div>
          {label.serverName ? <p className="ua-footnote">{label.serverName}</p> : null}
        </div>
        <p>{recipientText(label).text}</p>
        {label.isCloud ? <p className="ua-footnote">UnAlgorithm Cloud is invite-only during the beta.</p> : null}
        <p className="ua-footnote">{WHAT_IS_SENT}</p>
        <p className="ua-footnote">{NEVER_SENT}</p>
        {label.isCloud ? (
          // The beta's notice and terms on the website (R47a); a self-hosted server's operator has their own.
          <p className="ua-footnote ua-hstack ua-wrap">
            {CLOUD_BETA_DOCUMENTS.map((doc) => (
              <a key={doc.path} href={siteUrl(doc)} target="_blank" rel="noreferrer">
                {doc.linkText}
              </a>
            ))}
          </p>
        ) : null}
        {problem}
        <div className="ua-hstack ua-wrap">
          <Button variant="primary" loading={busy} onClick={() => signIn(origin)}>
            Sign in and turn on
          </Button>
          <Button variant="plain" disabled={busy} onClick={() => go({ step: 'address' })}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  const { account } = view;
  const off = !account.needsSignIn && !isServerAt(device.aiSource, account.origin);
  const balance = ai?.balance;
  const accountUrl = balance?.accountUrl;
  return (
    <div key={`account:${account.needsSignIn}`} ref={focusStep} tabIndex={-1} className="ua-stack">
      {account.needsSignIn ? (
        <Banner
          tone="warning"
          title={`Sign in to ${account.label.title} again.`}
          action={{ label: 'Sign in again', onAction: () => signIn(account.origin) }}
        />
      ) : null}
      {problem}
      <div className="ua-card">
        <ListRow
          title={account.needsSignIn ? account.email : `Signed in as ${account.email}`}
          subtitle={account.label.title}
          control={
            <Button size="sm" disabled={busy} onClick={signOut}>
              Sign out
            </Button>
          }
        />
        {balance ? (
          <div style={{ padding: '0 12px 10px' }}>
            <BalancePill
              balance={balance}
              onOpen={accountUrl ? () => void browser.tabs.create({ url: accountUrl }) : undefined}
            />
          </div>
        ) : null}
      </div>
      {off ? (
        <div>
          <Button variant="primary" loading={busy} onClick={() => turnOn(account.origin)}>
            Turn on
          </Button>
        </div>
      ) : null}
      {account.needsSignIn ? null : (
        // A new sign-in asks the server again for the sync status and the devices.
        <div key={account.signedInAt} className="ua-stack">
          <AccountSync account={account} onSignInAgain={() => signIn(account.origin)} />
          <DeviceList
            account={account}
            onSignInAgain={() => signIn(account.origin)}
            onSignedOut={() => go({ step: 'address' })}
          />
        </div>
      )}
    </div>
  );
}
