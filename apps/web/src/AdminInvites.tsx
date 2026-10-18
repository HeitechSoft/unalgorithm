/**
 * The admin page's invites (R38): an admin invites a family member's address through CL4-06's routes, and the invited
 * address may then create an account. The server sends no email, so the page gives the admin the sentence to pass on:
 * it names the extension and this server's address, never the server's own name, so it is right on any server. Under it
 * a line for the admin: until store builds offer servers (docs/release.md, *Before a store build carries the Cloud
 * card*), the person needs a build that offers servers; the release that passes that gate in every store removes it.
 * The pending invites come from the accounts list the page keeps, asked for again after each change.
 */
import { type AdminUsers, InviteRequestSchema } from '@unalgorithm/protocol';
import { Banner, Button, ListGroup, ListRow, TextField } from '@unalgorithm/ui';
import { type FormEvent, useId, useState } from 'react';
import { ApiError, addInvite, removeInvite } from './api.ts';
import { failureMessage } from './SignIn.tsx';

const HAS_ACCOUNT = 'This address already has an account.';
/** Dates in UTC, as the server keeps them: "Oct 15, 2026". */
const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
const INVITING = 'invite';

export interface AdminInvitesProps {
  /** The pending invites of the accounts list the page keeps (`GET /v1/admin/users`), newest first. */
  invites: AdminUsers['invites'];
  /** Asks for the accounts list again; rejects with the `ApiError` when that fails. */
  reload(): Promise<void>;
  /** The server no longer knows the session (401): the page goes back to sign-in. */
  onSignedOut(): void;
}

export function AdminInvites({ invites, reload, onSignedOut }: AdminInvitesProps) {
  const headingId = useId();
  const [email, setEmail] = useState('');
  /** The address invited last on this page, as the server keeps it. */
  const [invited, setInvited] = useState<string | null>(null);
  /** `INVITING`, or the address whose invite is being removed. */
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const typed = email.trim();
  const valid = InviteRequestSchema.shape.email.safeParse(typed).success;
  // The address to pass on: the one invited last here while it is still invited, else the newest invite.
  const passOn = invites.find((i) => i.email === invited)?.email ?? invites[0]?.email ?? null;

  /** One change and the list again; a failure is said above the form, and a 401 ends the page's session. */
  async function change(key: string, action: () => Promise<void>, byStatus: Partial<Record<number, string>> = {}) {
    setPending(key);
    setError(null);
    try {
      await action();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setError(failureMessage(err, byStatus));
    } finally {
      setPending(null);
    }
  }

  async function onInvite(e: FormEvent) {
    e.preventDefault();
    if (!valid || pending !== null) return;
    await change(
      INVITING,
      async () => {
        await addInvite(typed);
        setEmail('');
        setInvited(typed.toLowerCase());
        await reload();
      },
      { 400: HAS_ACCOUNT },
    );
  }

  return (
    <section className="web-section" aria-labelledby={headingId}>
      <h2 id={headingId}>Invites</h2>
      {error ? <Banner tone="danger" title={error} /> : null}
      <ListGroup>
        <form className="web-form ua-stack" onSubmit={onInvite}>
          <TextField
            label="Email address"
            type="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Button type="submit" variant="primary" fullWidth loading={pending === INVITING} disabled={!valid || pending !== null}>
            Invite
          </Button>
        </form>
      </ListGroup>
      {passOn ? (
        <div className="web-notes">
          <p>
            {`Tell ${passOn}: install unAlgorithm Feed, open Settings, then AI, choose a server, enter ${window.location.origin}, and sign in with this address.`}
          </p>
          <p className="ua-footnote">
            Until the store versions of unAlgorithm Feed offer servers, they need a build that does, with its id in EXTENSION_IDS.
          </p>
        </div>
      ) : null}
      {invites.length > 0 ? (
        <ListGroup header="Pending invites">
          {invites.map((invite) => (
            <ListRow
              key={invite.email}
              title={invite.email}
              subtitle={`Invited ${DATE.format(new Date(invite.createdAt))}`}
              control={
                <Button
                  size="sm"
                  aria-label={`Remove ${invite.email}`}
                  loading={pending === invite.email}
                  disabled={pending !== null}
                  onClick={() =>
                    void change(invite.email, async () => {
                      await removeInvite(invite.email);
                      await reload();
                    })
                  }
                >
                  Remove
                </Button>
              }
            />
          ))}
        </ListGroup>
      ) : null}
    </section>
  );
}
