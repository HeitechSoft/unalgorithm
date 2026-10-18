/**
 * The source control page every server serves at `/admin/sources` (P3-74, decisions D93–D95, D101): an admin adds, edits
 * and removes the server's outlets, and imports the candidate list into an empty list, through P3-73's routes, which
 * check every change again. A change is published as soon as it is saved and listed with who made it. The page shows
 * the list's balance, table and history as the public page does (`SourceList.tsx`), and its session flow is the admin
 * page's (`useAdminSession`). A lean comes only from what an admin types here, never from the page itself.
 */
import { domainFromInput, outletIdFromName } from '@unalgorithm/outlets';
import {
  ADMIN_SOURCES_PAGE_PATH,
  BUCKET_LABELS,
  LEAN_BUCKETS,
  type LeanBucket,
  MAX_OUTLET_DOMAINS,
  MAX_OUTLET_EVIDENCE,
  type OfficialOutlet,
  OUTLET_COUNTRIES,
  OUTLETS_PAGE_PATH,
  type OutletInput,
  OutletInputSchema,
} from '@unalgorithm/protocol';
import { Banner, Button, ListGroup, TextField } from '@unalgorithm/ui';
import { type FormEvent, useId, useState } from 'react';
import { AdminGate, useAdminSession } from './Admin.tsx';
import { ApiError, adminOutlets, changeOutlet, importCandidates } from './api.ts';
import { Page } from './Page.tsx';
import { failureMessage } from './SignIn.tsx';
import { ChangeList, COUNTRY_LABELS, OutletTable, SourceListBalance } from './SourceList.tsx';

const TITLE = 'Source list';
const INTRO =
  'Changes are published as soon as you save them. A lean needs at least one piece of evidence. Every change is listed ' +
  'below and on the public page.';
const IMPORT_LINE = 'Adds the candidate outlets with their names, web addresses and country, and no leans.';
const CHANGED = 'The list changed since you opened it.';
const GONE = 'That outlet is no longer on the list.';
const EVIDENCE_REASON = 'A lean needs at least one piece of evidence with an https link.';
/** Why "Save" is disabled, by the first field (in the form's order) that isn't ready. */
const REASONS: Readonly<Record<string, string>> = {
  name: 'An outlet needs a name.',
  id: 'An id is 2 to 40 lowercase letters, digits or hyphens.',
  domains: 'An outlet needs at least one web address.',
  lean: EVIDENCE_REASON,
};
const NOTE_REASON = 'Each piece of evidence needs a note of at most 280 characters.';

type Country = OfficialOutlet['country'];
/** What the page says above the form after a refused change; `reload` adds "Reload". */
type Notice = { title: string; reload?: boolean };

export function AdminSources() {
  const session = useAdminSession(TITLE, adminOutlets);
  const { info, heading, step, reload, sessionEnded } = session;
  const headingId = useId();
  /** The open form: empty to add an outlet, or filled with the one being edited. */
  const [form, setForm] = useState<{ initial?: OfficialOutlet } | null>(null);
  /** The outlet whose removal is being confirmed. */
  const [removing, setRemoving] = useState<string | null>(null);
  /** The request in flight: 'import', 'save' or 'remove'. */
  const [pending, setPending] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  if (step.name !== 'loaded' || !info) {
    return <AdminGate session={session} intro={INTRO} returnTo={ADMIN_SOURCES_PAGE_PATH} />;
  }
  const { list, changes } = step.data;
  const idle = pending === null && form === null && removing === null;

  /** The list and its history again; true when they came. A 401 ends the page's session. */
  async function refresh(): Promise<boolean> {
    try {
      await reload();
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) sessionEnded();
      else setNotice({ title: failureMessage(err) });
      return false;
    }
  }

  /** One change, then the list again. A refusal is said above the form, which stays open unless the outlet is gone. */
  async function send(key: string, action: () => Promise<unknown>) {
    setPending(key);
    setNotice(null);
    try {
      await action();
      setForm(null);
      setRemoving(null);
      await refresh();
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setRemoving(null);
      if (status === 401) {
        setForm(null);
        sessionEnded();
        return;
      }
      // The server's 400 names the rule the change would break and the outlet; a 404 or a 409 is said in the page's words.
      const serverMessage = err instanceof ApiError ? err.serverMessage : undefined;
      setNotice({ title: failureMessage(err, { 400: serverMessage, 404: GONE, 409: CHANGED }), reload: status === 409 });
      if (status === 404) {
        setForm(null);
        await refresh();
      }
    } finally {
      setPending(null);
    }
  }

  function save(outlet: OutletInput) {
    const action = form?.initial ? 'edit' : 'add';
    void send('save', () => changeOutlet({ action, baseVersion: list.version, outlet }));
  }

  async function onReload() {
    if (await refresh()) setNotice(null);
  }

  return (
    <Page info={info} heading={heading} intro={INTRO} wide>
      <div className="web-notes web-status">
        <p>
          Version {list.version} · <a href={OUTLETS_PAGE_PATH}>Public page</a>
        </p>
      </div>
      <SourceListBalance outlets={list.outlets} />
      <section className="web-section" aria-labelledby={headingId}>
        <h2 id={headingId}>Outlets</h2>
        {notice ? (
          <Banner
            tone="danger"
            title={notice.title}
            action={notice.reload ? { label: 'Reload', onAction: () => void onReload() } : undefined}
          />
        ) : null}
        {list.outlets.length === 0 ? (
          <div className="web-section-actions">
            <Button
              variant="primary"
              loading={pending === 'import'}
              disabled={!idle}
              onClick={() => void send('import', importCandidates)}
            >
              Import the candidate list
            </Button>
            <p className="web-status">{IMPORT_LINE}</p>
          </div>
        ) : null}
        {form ? (
          <OutletForm
            key={form.initial?.id ?? ''}
            initial={form.initial}
            busy={pending === 'save'}
            onSubmit={save}
            onCancel={() => {
              setForm(null);
              setNotice(null);
            }}
          />
        ) : (
          <div>
            <Button
              disabled={!idle}
              onClick={() => {
                setNotice(null);
                setForm({});
              }}
            >
              Add an outlet
            </Button>
          </div>
        )}
        <OutletTable
          outlets={list.outlets}
          actions={(outlet) =>
            removing === outlet.id ? (
              <div className="ua-stack">
                <p>{`Remove ${outlet.name}? It leaves the published list now.`}</p>
                <div className="ua-hstack ua-wrap">
                  {/* Focused when the question appears: the destructive button never has the focus first. */}
                  <Button size="sm" autoFocus disabled={pending !== null} onClick={() => setRemoving(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive-solid"
                    loading={pending === 'remove'}
                    disabled={pending !== null}
                    onClick={() =>
                      void send('remove', () => changeOutlet({ action: 'remove', baseVersion: list.version, id: outlet.id }))
                    }
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ) : (
              <div className="ua-hstack ua-wrap">
                <Button
                  size="sm"
                  aria-label={`Edit ${outlet.name}`}
                  disabled={!idle}
                  onClick={() => {
                    setNotice(null);
                    setForm({ initial: outlet });
                  }}
                >
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  aria-label={`Remove ${outlet.name}`}
                  disabled={!idle}
                  onClick={() => {
                    setNotice(null);
                    setRemoving(outlet.id);
                  }}
                >
                  Remove
                </Button>
              </div>
            )
          }
        />
      </section>
      <ChangeList changes={changes} showBy />
    </Page>
  );
}

/** One piece of evidence as typed; `key` keeps a row's fields while rows are added. */
type EvidenceRow = { key: number; url: string; note: string };
let rowKeys = 0;
const evidenceRow = (e: { url: string; note: string } = { url: '', note: '' }): EvidenceRow => ({ key: rowKeys++, ...e });

/** Why the typed outlet can't be sent: the first field, in the form's order, that the schema refuses. */
function blockedReason(issues: readonly { path: readonly PropertyKey[] }[]): string | null {
  for (const field of ['name', 'id', 'domains', 'lean']) {
    const found = issues.filter((i) => i.path[0] === field);
    if (found.length === 0) continue;
    if (field === 'lean' && found.every((i) => i.path.at(-1) === 'note')) return NOTE_REASON;
    return REASONS[field] ?? null;
  }
  return null;
}

/**
 * An outlet to add (`initial` unset) or edit. The id follows the name while adding, until typed by hand, and is
 * read-only when editing (decision D93). "Save" stays disabled until `OutletInputSchema` accepts what is typed, so a
 * request that would fail is never sent; the server checks it all again.
 */
function OutletForm({
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  initial?: OfficialOutlet;
  busy: boolean;
  onSubmit(outlet: OutletInput): void;
  onCancel(): void;
}) {
  const fieldId = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [id, setId] = useState(initial?.id ?? '');
  const [idTyped, setIdTyped] = useState(false);
  const [addresses, setAddresses] = useState(initial?.domains.join('\n') ?? '');
  /** The web addresses' error waits until the field is left: a half-typed address isn't one yet. */
  const [addressesLeft, setAddressesLeft] = useState(false);
  const [country, setCountry] = useState<Country>(initial?.country ?? 'US');
  const [bucket, setBucket] = useState<LeanBucket | ''>(initial?.lean?.bucket ?? '');
  const [evidence, setEvidence] = useState<EvidenceRow[]>(() =>
    initial?.lean ? initial.lean.evidence.map((e) => evidenceRow(e)) : [evidenceRow()],
  );

  // Comma- or newline-separated; each entry read as a web address, the same one given twice kept once.
  const entries = addresses
    .split(/[,\n]/)
    .map((e) => e.trim())
    .filter(Boolean);
  const notAddresses = entries.filter((e) => domainFromInput(e) === null);
  const domains = [...new Set(entries.map(domainFromInput).filter((d) => d !== null))];
  const addressError = addressesLeft && notAddresses.length > 0 ? `Not a web address: ${notAddresses.join(', ')}` : undefined;
  // Rows left empty are not evidence.
  const lean =
    bucket === ''
      ? null
      : {
          bucket,
          evidence: evidence
            .filter((e) => e.url.trim() || e.note.trim())
            .map((e) => ({ url: e.url.trim(), note: e.note.trim() })),
        };
  const parsed = OutletInputSchema.safeParse({ id, name, domains, country, lean });
  const ready = parsed.success && notAddresses.length === 0;
  const reason = ready
    ? null
    : notAddresses.length > 0
      ? 'Check the web addresses.'
      : domains.length > MAX_OUTLET_DOMAINS
        ? `An outlet has at most ${MAX_OUTLET_DOMAINS} web addresses.`
        : parsed.success
          ? null
          : blockedReason(parsed.error.issues);

  function onName(value: string) {
    setName(value);
    if (!initial && !idTyped) setId(outletIdFromName(value));
  }

  function setRow(key: number, change: Partial<EvidenceRow>) {
    setEvidence((rows) => rows.map((r) => (r.key === key ? { ...r, ...change } : r)));
  }

  function onSave(e: FormEvent) {
    e.preventDefault();
    if (busy || !ready || !parsed.success) return;
    onSubmit(parsed.data);
  }

  return (
    <ListGroup header={initial ? `Edit ${initial.name}` : 'Add an outlet'}>
      <form className="web-form ua-stack" noValidate onSubmit={onSave}>
        <TextField label="Name" autoFocus autoComplete="off" value={name} onChange={(e) => onName(e.target.value)} />
        <TextField
          label="Id"
          mono
          autoComplete="off"
          spellCheck={false}
          readOnly={initial !== undefined}
          hint={
            initial
              ? "An outlet's id never changes: links to it and appeals use it."
              : 'Made from the name. It never changes once added: links to it and appeals use it.'
          }
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setIdTyped(true);
          }}
        />
        <div className="ua-field">
          <label htmlFor={`${fieldId}-addresses`} className="ua-field-label">
            Web addresses
          </label>
          <textarea
            id={`${fieldId}-addresses`}
            className="ua-textarea"
            rows={2}
            spellCheck={false}
            autoCapitalize="none"
            aria-invalid={addressError ? true : undefined}
            aria-describedby={`${fieldId}-addresses-hint`}
            value={addresses}
            onChange={(e) => setAddresses(e.target.value)}
            onBlur={() => setAddressesLeft(true)}
          />
          <div id={`${fieldId}-addresses-hint`} className={addressError ? 'ua-field-error' : 'ua-field-hint'}>
            {addressError ?? 'One per line, or separated by commas.'}
          </div>
        </div>
        <div className="ua-field">
          <label htmlFor={`${fieldId}-country`} className="ua-field-label">
            Country
          </label>
          <select
            id={`${fieldId}-country`}
            className="ua-select"
            value={country}
            onChange={(e) => setCountry(e.target.value as Country)}
          >
            {OUTLET_COUNTRIES.map((c) => (
              <option key={c} value={c}>
                {COUNTRY_LABELS[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="ua-field">
          <label htmlFor={`${fieldId}-lean`} className="ua-field-label">
            Lean
          </label>
          <select
            id={`${fieldId}-lean`}
            className="ua-select"
            value={bucket}
            onChange={(e) => setBucket(e.target.value as LeanBucket | '')}
          >
            <option value="">No lean</option>
            {LEAN_BUCKETS.map((b) => (
              <option key={b} value={b}>
                {BUCKET_LABELS[b]}
              </option>
            ))}
          </select>
        </div>
        {bucket === '' ? null : (
          <>
            {evidence.map((row, i) => (
              <div key={row.key} className="ua-stack">
                <TextField
                  label={`Evidence ${i + 1} link`}
                  type="url"
                  inputMode="url"
                  autoComplete="off"
                  value={row.url}
                  onChange={(e) => setRow(row.key, { url: e.target.value })}
                />
                <TextField
                  label={`Evidence ${i + 1} note`}
                  autoComplete="off"
                  value={row.note}
                  onChange={(e) => setRow(row.key, { note: e.target.value })}
                />
              </div>
            ))}
            {evidence.length < MAX_OUTLET_EVIDENCE ? (
              <div>
                <Button size="sm" onClick={() => setEvidence((rows) => [...rows, evidenceRow()])}>
                  Add evidence
                </Button>
              </div>
            ) : null}
          </>
        )}
        <div className="ua-hstack ua-wrap">
          <Button
            type="submit"
            variant="primary"
            loading={busy}
            disabled={busy || !ready}
            aria-describedby={reason ? `${fieldId}-reason` : undefined}
          >
            Save
          </Button>
          <Button disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        </div>
        {reason ? (
          <p id={`${fieldId}-reason`} className="ua-footnote">
            {reason}
          </p>
        ) : null}
      </form>
    </ListGroup>
  );
}
