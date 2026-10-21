/**
 * The admin overview's people (R38): a table row per account with its badges and numbers, and a sheet per person with
 * the rest of their figures, which sets the daily post cap, removes or restores access, and changes the role through
 * CL4-06's routes. After each change the page
 * asks for the list again, so the rows and the dialog show what the server now holds. The signed-in admin can't change
 * their own access or role (the server refuses that with 400 too).
 */
import { formatApproxCost } from '@unalgorithm/core';
import { type AdminUser, type AdminUsers as AdminUsersData, MAX_ADMIN_USERS, MAX_DAILY_POST_CAP } from '@unalgorithm/protocol';
import { Badge, Banner, Button, Dialog, TextField } from '@unalgorithm/ui';
import { useState } from 'react';
import { ApiError, setUserAccess, setUserCap, setUserRole } from './api.ts';
import { failureMessage } from './SignIn.tsx';
import { Facts, Section } from './ui.tsx';

const COUNT = new Intl.NumberFormat('en-US');
const CHANGE_FAILED = { 400: "That change isn't possible.", 404: 'This account no longer exists.' };
const OWN = "You can't change your own access or role.";
/** Days in UTC, as the server keeps them: "Oct 15, 2026". */
const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

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

/** "Server cap (1,000)" or "500 a day". */
function capLine(user: AdminUser, defaultCap: number): string {
  return user.dailyPostCap === null
    ? `Server cap (${COUNT.format(defaultCap)})`
    : `${COUNT.format(user.dailyPostCap)} ${user.dailyPostCap === 1 ? 'post' : 'posts'} a day`;
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
    <Section
      title="People"
      description={`${count(data.users.length, 'account', 'accounts')}. Open one to set its daily posts, access or role.`}
    >
      <div className="web-table-card">
        <table className="web-table web-people">
          <thead>
            <tr>
              <th scope="col">Account</th>
              <th scope="col">Today</th>
              <th scope="col">30 days</th>
              <th scope="col">AI cost</th>
              <th scope="col">
                <span className="ua-vh">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((user) => (
              <tr key={user.id}>
                <th scope="row">
                  <span className="web-person">
                    <span className="web-avatar" aria-hidden="true">
                      {user.email.charAt(0).toUpperCase()}
                    </span>
                    <span className="web-person-text">
                      <span className="web-person-email">{user.email}</span>
                      <span className="web-row-facts">
                        {user.role === 'admin' ? <Badge tone="accent">Admin</Badge> : null}
                        {user.access === 'removed' ? <Badge tone="danger">Removed</Badge> : null}
                        {user.dailyPostCap === null ? null : <Badge>{`Cap ${COUNT.format(user.dailyPostCap)}`}</Badge>}
                        <span>{count(user.activeDevices, 'device', 'devices')}</span>
                      </span>
                    </span>
                  </span>
                </th>
                <td>{COUNT.format(user.postsToday)}</td>
                <td>{COUNT.format(user.posts30Days)}</td>
                <td>{formatApproxCost(user.costMicros30Days)}</td>
                <td>
                  <Button size="sm" aria-label={`Manage ${user.email}`} onClick={() => onManage(user)}>
                    Manage
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.truncated ? <p className="ua-footnote">{`Showing the first ${COUNT.format(MAX_ADMIN_USERS)} accounts.`}</p> : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        className="web-sheet"
        title={selected?.email ?? 'Account'}
        actions={
          <Button variant="primary" onClick={() => setOpen(false)}>
            Done
          </Button>
        }
      >
        {error ? <Banner tone="danger" title={error} /> : null}
        {selected ? (
          <>
            <Facts
              items={[
                ['Role', selected.role === 'admin' ? 'Admin' : 'Regular user'],
                ['Access', selected.access === 'removed' ? 'Removed' : 'Can sign in'],
                ['Devices', COUNT.format(selected.activeDevices)],
                ['Posts today', COUNT.format(selected.postsToday)],
                ['Posts in 30 days', COUNT.format(selected.posts30Days)],
                ['AI cost in 30 days', formatApproxCost(selected.costMicros30Days)],
                ['Daily posts', capLine(selected, data.defaultDailyPostCap)],
                ['Joined', DATE.format(new Date(selected.createdAt))],
                ['Last active', selected.lastActiveAt ? DATE.format(new Date(selected.lastActiveAt)) : 'Not yet'],
              ]}
            />
            <section className="web-sheet-section">
              <h3>Daily posts</h3>
              <div className="web-inline-form">
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
                <Button variant="primary" disabled={busy || newCap === null} onClick={() => void onSetCap(selected, newCap)}>
                  Save cap
                </Button>
              </div>
              <div>
                <Button size="sm" variant="plain" disabled={busy} onClick={() => void onSetCap(selected, null)}>
                  {`Use the server's cap (${COUNT.format(data.defaultDailyPostCap)})`}
                </Button>
              </div>
            </section>
            <section className="web-sheet-section">
              <h3>Access</h3>
              {confirmRemove ? (
                <div className="web-confirm">
                  <p>{`${selected.email} is signed out on every device and can't sign in until you restore access.`}</p>
                  <div className="web-form-actions">
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
                </div>
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
            <section className="web-sheet-section">
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
              {own ? <p className="ua-footnote">{OWN}</p> : null}
            </section>
          </>
        ) : null}
      </Dialog>
    </Section>
  );
}
