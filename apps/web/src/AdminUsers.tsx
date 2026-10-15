/**
 * The admin page's accounts (R38): a row per account with its badges and numbers, and a dialog per person that sets the
 * daily post cap, removes or restores access, and changes the role through CL4-06's routes. After each change the page
 * asks for the list again, so the rows and the dialog show what the server now holds. The signed-in admin can't change
 * their own access or role (the server refuses that with 400 too).
 */
import { formatApproxCost } from '@unalgorithm/core';
import { type AdminUser, type AdminUsers as AdminUsersData, MAX_ADMIN_USERS, MAX_DAILY_POST_CAP } from '@unalgorithm/protocol';
import { Badge, Banner, Button, Dialog, ListGroup, ListRow, TextField } from '@unalgorithm/ui';
import { useState } from 'react';
import { ApiError, setUserAccess, setUserCap, setUserRole } from './api.ts';
import { failureMessage } from './SignIn.tsx';

const COUNT = new Intl.NumberFormat('en-US');
const CHANGE_FAILED = { 400: "That change isn't possible.", 404: 'This account no longer exists.' };
const OWN = "You can't change your own access or role.";

export interface AdminUsersProps {
  /** The accounts as `GET /v1/admin/users` answered; the page keeps them. */
  data: AdminUsersData;
  /** The signed-in admin's address: their own row can't change its access or role. */
  email: string;
  /** Asks for the accounts again; rejects with the `ApiError` when that fails. */
  reload(): Promise<void>;
  /** The server no longer knows the session (401): the page goes back to sign-in. */
  onSignedOut(): void;
}

function count(n: number, one: string, many: string): string {
  return `${COUNT.format(n)} ${n === 1 ? one : many}`;
}

/** "2 devices · 120 posts today · 2,400 in 30 days · about 18¢ · cap 500". */
function numbers(user: AdminUser, defaultCap: number): string {
  return [
    count(user.activeDevices, 'device', 'devices'),
    count(user.postsToday, 'post today', 'posts today'),
    `${COUNT.format(user.posts30Days)} in 30 days`,
    formatApproxCost(user.costMicros30Days),
    user.dailyPostCap === null ? `server cap ${COUNT.format(defaultCap)}` : `cap ${COUNT.format(user.dailyPostCap)}`,
  ].join(' · ');
}

/** The typed cap: a whole number from 0 to the largest the server stores, else null. */
function typedCap(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const cap = Number(value);
  return cap <= MAX_DAILY_POST_CAP ? cap : null;
}

export function AdminUsers({ data, email, reload, onSignedOut }: AdminUsersProps) {
  const [open, setOpen] = useState(false);
  /** The account the dialog is about as it was when opened; the rows' newer copy wins while the list has it. */
  const [opened, setOpened] = useState<AdminUser | null>(null);
  const [cap, setCap] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = data.users.find((u) => u.id === opened?.id) ?? opened;
  const own = selected !== null && selected.email.toLowerCase() === email.toLowerCase();
  const newCap = typedCap(cap);

  function onManage(user: AdminUser) {
    setOpened(user);
    setCap(user.dailyPostCap === null ? '' : String(user.dailyPostCap));
    setConfirmRemove(false);
    setError(null);
    setOpen(true);
  }

  /** One change, then the list again; a failure of either is said in the dialog, and a 401 ends the page's session. */
  async function change(action: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError(null);
    setConfirmRemove(false);
    try {
      await action();
      await reload();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
      else setError(failureMessage(err, CHANGE_FAILED));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function onSetCap(user: AdminUser, value: number | null) {
    if (await change(() => setUserCap(user.id, value))) setCap(value === null ? '' : String(value));
  }

  return (
    <div className="web-section">
      <ListGroup
        header="Accounts"
        footer={data.truncated ? `Showing the first ${COUNT.format(MAX_ADMIN_USERS)} accounts.` : undefined}
      >
        {data.users.map((user) => (
          <ListRow
            key={user.id}
            title={user.email}
            subtitle={
              <span className="web-user-facts">
                {user.role === 'admin' ? <Badge tone="accent">Admin</Badge> : null}
                {user.access === 'removed' ? <Badge tone="danger">Removed</Badge> : null}
                <span>{numbers(user, data.defaultDailyPostCap)}</span>
              </span>
            }
            control={
              <Button size="sm" aria-label={`Manage ${user.email}`} onClick={() => onManage(user)}>
                Manage
              </Button>
            }
          />
        ))}
      </ListGroup>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={selected?.email ?? 'Account'}
        actions={<Button onClick={() => setOpen(false)}>Done</Button>}
      >
        {error ? <Banner tone="danger" title={error} /> : null}
        {selected ? (
          <>
            <section className="web-dialog-section">
              <h3>Daily posts</h3>
              <TextField
                label="Daily posts"
                labelHidden
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_DAILY_POST_CAP}
                step={1}
                value={cap}
                onChange={(e) => setCap(e.target.value)}
              />
              <div className="ua-hstack ua-wrap">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || newCap === null}
                  onClick={() => void onSetCap(selected, newCap)}
                >
                  Save cap
                </Button>
                <Button size="sm" variant="plain" disabled={busy} onClick={() => void onSetCap(selected, null)}>
                  {`Use the server's cap (${COUNT.format(data.defaultDailyPostCap)})`}
                </Button>
              </div>
            </section>
            <section className="web-dialog-section">
              <h3>Access</h3>
              {confirmRemove ? (
                <>
                  <p>{`${selected.email} is signed out on every device and can't sign in until you restore access.`}</p>
                  <div className="ua-hstack ua-wrap">
                    {/* Focused when the question appears: the destructive button never has the focus first. */}
                    <Button size="sm" autoFocus onClick={() => setConfirmRemove(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive-solid"
                      disabled={busy}
                      onClick={() => void change(() => setUserAccess(selected.id, 'removed'))}
                    >
                      Remove access
                    </Button>
                  </div>
                </>
              ) : selected.access === 'removed' ? (
                <div>
                  <Button
                    size="sm"
                    disabled={busy || own}
                    onClick={() => void change(() => setUserAccess(selected.id, 'active'))}
                  >
                    Restore access
                  </Button>
                </div>
              ) : (
                <div>
                  <Button size="sm" variant="destructive" disabled={busy || own} onClick={() => setConfirmRemove(true)}>
                    Remove access
                  </Button>
                </div>
              )}
            </section>
            <section className="web-dialog-section">
              <h3>Role</h3>
              <div>
                <Button
                  size="sm"
                  disabled={busy || own}
                  onClick={() => void change(() => setUserRole(selected.id, selected.role === 'admin' ? 'user' : 'admin'))}
                >
                  {selected.role === 'admin' ? 'Make regular user' : 'Make admin'}
                </Button>
              </div>
              {own ? <p>{OWN}</p> : null}
            </section>
          </>
        ) : null}
      </Dialog>
    </div>
  );
}
