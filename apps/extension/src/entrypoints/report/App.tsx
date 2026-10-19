import { cleanReportMessage, describeReport, REPORT_LINE_COPY } from '@unalgorithm/core';
import { MAX_CORRECTION_MESSAGE, PLATFORM_NAMES, type ProblemReport, supportMailto } from '@unalgorithm/protocol';
import { Banner, Button } from '@unalgorithm/ui';
import { type MouseEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { z } from 'zod';
import { REPORT_DATA } from '../../lib/data-consent.ts';
import { useConsent } from '../../lib/hooks.ts';
import { type ReportPageData, type ReportSendCode, sendToBackground } from '../../lib/messages.ts';
import { choiceRequired, choicesFor, singleChoice } from '../../lib/report-links.ts';
import type { ReportDraft } from '../../lib/storage.ts';
import { REPORT_COPY as C, type ResultCopy } from './copy.ts';

/**
 * The report page (ADR 0009 §2): the person answers a question or two, sees what will be sent in plain lines and as the
 * exact JSON body, and sends it with *Send report*, the only thing that sends a report. Or they email it from their own
 * email program, which the page only opens. The draft comes from the background, by the id in the address.
 */

/** What the person adds to a draft. */
export interface Answers {
  choices: readonly string[];
  /** A correction's words, as typed. */
  words: string;
  /** A correction's reply email, as typed. */
  email: string;
}

const NO_ANSWERS: Answers = { choices: [], words: '', email: '' };
const EmailSchema = z.email().max(254);

/**
 * The report as it will be sent: the draft plus the person's answers, in a fixed order so the preview, the exact body
 * and what the background checks are the same. Choices keep the question's order; a correction's words are cleaned
 * (`cleanReportMessage`), and the reply email is trimmed and left out when empty.
 */
export function composeReport(draft: ReportDraft, answers: Answers): ProblemReport {
  const { v, id, kind, from, private: inPrivate, env, page, health, detection, post, correction } = draft;
  const choices = choicesFor(draft).filter((c) => answers.choices.includes(c));
  const contact = answers.email.trim();
  return {
    v,
    id,
    kind,
    from,
    choices,
    ...(inPrivate ? { private: true as const } : {}),
    env,
    ...(page ? { page } : {}),
    ...(health ? { health } : {}),
    ...(detection ? { detection } : {}),
    ...(post ? { post } : {}),
    ...(correction
      ? { correction: { ...correction, message: cleanReportMessage(answers.words), ...(contact ? { contact } : {}) } }
      : {}),
  };
}

/** The body *Send report* posts and *Show exactly what's sent* shows, byte for byte. */
export function reportBody(report: ProblemReport): string {
  return JSON.stringify(report, null, 2);
}

/** The `mailto:` for *Email it instead*: the support address, and the same plain lines as the preview. */
export function reportMailto(report: ProblemReport, ref?: string): string {
  return supportMailto({ subject: C.mailSubject(ref), body: describeReport(report).join('\n') });
}

interface Problems {
  about?: string;
  choices?: string;
  words?: string;
  email?: string;
}

function problemsOf(draft: ReportDraft | undefined, answers: Answers, needsAbout: boolean): Problems {
  if (!draft) return needsAbout ? { about: C.errors.chooseOne } : {};
  const out: Problems = {};
  if (choiceRequired(draft) && !answers.choices.length)
    out.choices = singleChoice(draft.kind) ? C.errors.chooseOne : C.errors.chooseMany;
  if (draft.correction) {
    if (!cleanReportMessage(answers.words)) out.words = C.errors.words;
    if (answers.email.trim() && !EmailSchema.safeParse(answers.email.trim()).success) out.email = C.errors.email;
  }
  return out;
}

/** Closes this tab: its draft goes with it. */
function closeTab(): void {
  void browser.tabs
    .getCurrent()
    .then((tab) => (tab?.id !== undefined ? browser.tabs.remove(tab.id) : window.close()))
    .catch(() => window.close());
}

type Phase = { name: 'editing' } | { name: 'sending' } | { name: 'sent'; ref: string } | { name: 'failed'; code: ReportSendCode };

export function App() {
  const id = location.hash.replace(/^#/, '');
  /** undefined while loading; null once the draft is gone. */
  const [data, setData] = useState<ReportPageData | null>();
  const [about, setAbout] = useState<number | null>(null);
  const [answers, setAnswers] = useState<Answers>(NO_ANSWERS);
  const [problems, setProblems] = useState<Problems>({});
  const [phase, setPhase] = useState<Phase>({ name: 'editing' });
  const title = useRef<HTMLHeadingElement>(null);
  const result = useRef<HTMLHeadingElement>(null);
  const groups = useRef<Partial<Record<keyof Problems, HTMLElement | null>>>({});

  // Firefox only (always true elsewhere): technical data for any report, the person's words for a correction's text,
  // and personal identifiers for a reply email. Never asked for here; withdrawn or allowed, the page follows.
  const technical = useConsent(REPORT_DATA);
  const words = useConsent(['personalCommunications']);
  const reply = useConsent(['personallyIdentifyingInfo']);

  useEffect(() => {
    document.title = C.pageTitle;
    title.current?.focus();
    let alive = true;
    void sendToBackground({ type: 'reportDraft', id })
      .then(({ report }) => {
        if (!alive) return;
        setData(report);
        if (report?.state === 'sent' && report.ref) setPhase({ name: 'sent', ref: report.ref });
      })
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [id]);

  useEffect(() => {
    if (phase.name === 'sent' || phase.name === 'failed') result.current?.focus();
  }, [phase]);

  const drafts = data?.drafts ?? [];
  const needsAbout = drafts.length > 1;
  const draft = needsAbout ? (about === null ? undefined : drafts[about]) : drafts[0];
  const replyField = !!draft?.correction && reply !== false;
  // A reply email typed before Firefox's consent for it was withdrawn stays out, as the field does.
  const report = useMemo(
    () => (draft ? composeReport(draft, replyField ? answers : { ...answers, email: '' }) : undefined),
    [draft, answers, replyField],
  );
  const body = report ? reportBody(report) : '';
  const lines = useMemo(() => (report ? describeReport(report) : []), [report]);
  const blockedBy = technical === false ? C.firefoxTechnical : draft?.correction && words === false ? C.firefoxWords : undefined;
  const site = data?.opener ? PLATFORM_NAMES[data.opener.site] : undefined;

  /** An answer changed: what it fixed is no longer said, and a failed send's state gives way to the form. */
  const set = (patch: Partial<Answers>) => {
    setAnswers((a) => ({ ...a, ...patch }));
    setProblems((p) => ({
      ...p,
      ...('choices' in patch ? { choices: undefined } : {}),
      ...('words' in patch ? { words: undefined } : {}),
      ...('email' in patch ? { email: undefined } : {}),
    }));
    if (phase.name === 'failed') setPhase({ name: 'editing' });
  };

  /** Shows what's missing next to its group and moves the focus there; true when nothing is. */
  const check = (): boolean => {
    const found = problemsOf(draft, { ...answers, email: replyField ? answers.email : '' }, needsAbout);
    setProblems(found);
    const first = (['about', 'choices', 'words', 'email'] as const).find((k) => found[k]);
    if (!first) return true;
    groups.current[first]?.focus();
    return false;
  };

  const send = async () => {
    if (!check() || !report) return;
    setPhase({ name: 'sending' });
    const res = await sendToBackground({ type: 'sendReport', id, body }).catch(() => ({
      ok: false as const,
      code: 'refused' as const,
    }));
    setPhase(res.ok ? { name: 'sent', ref: res.ref } : { name: 'failed', code: res.code });
  };

  /** *Email it instead*: opens the person's email program, once the answers are complete. */
  const onEmail = (e: MouseEvent) => {
    if (!check()) e.preventDefault();
  };

  const back = () => {
    if (!data?.opener) return;
    void browser.tabs.update(data.opener.tabId, { active: true }).catch(() => undefined);
    closeTab();
  };

  let content: ReactNode;
  if (data === undefined) content = <p className="report-lead">{C.loading}</p>;
  else if (data === null) content = <p className="report-lead">{C.expired}</p>;
  else if (phase.name === 'sent') {
    const more = C.sent.more;
    content = (
      <section className="report-result" aria-labelledby="report-result">
        <h2 id="report-result" ref={result} tabIndex={-1}>
          {C.sent.title}
        </h2>
        <p>{draft?.kind === 'correction' ? C.sent.correctionBody : C.sent.body}</p>
        <p>
          {C.sent.reference} <strong className="report-ref">{phase.ref}</strong>
        </p>
        <p>
          {more.before}
          <a href={supportMailto({ subject: C.mailSubject(phase.ref) })}>{more.address}</a>
          {more.after}
        </p>
        <div className="report-actions">
          {site ? (
            <Button variant="primary" onClick={back}>
              {C.buttons.back(site)}
            </Button>
          ) : null}
          <Button variant={site ? 'secondary' : 'primary'} onClick={closeTab}>
            {C.buttons.close}
          </Button>
        </div>
      </section>
    );
  } else {
    const failed: ResultCopy | undefined = phase.name === 'failed' ? C.results[phase.code] : undefined;
    const mailto = report ? reportMailto(report) : undefined;
    content = (
      <form
        className="report-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!blockedBy) void send();
        }}
      >
        {needsAbout ? (
          <ChoiceGroup
            legend={C.about.legend}
            kind="radio"
            options={[
              { value: '0', label: C.about.linkedin },
              { value: '1', label: C.about.facebook },
              { value: '2', label: C.about.other },
            ]}
            selected={about === null ? [] : [String(about)]}
            onChange={(v) => {
              setAbout(Number(v[0]));
              setAnswers(NO_ANSWERS);
              setProblems({});
            }}
            error={problems.about}
            focusRef={(el) => {
              groups.current.about = el;
            }}
          />
        ) : null}
        {draft ? (
          <>
            {draft.private ? <p className="report-note">{C.privateWindow}</p> : null}
            <ChoiceGroup
              legend={needsAbout && draft.kind === 'other' ? C.questions.otherAfterSettings : C.questions[draft.kind]}
              kind={singleChoice(draft.kind) ? 'radio' : 'checkbox'}
              options={choicesFor(draft).map((c) => ({ value: c, label: REPORT_LINE_COPY.choices[c] ?? c }))}
              selected={answers.choices}
              onChange={(choices) => set({ choices })}
              error={problems.choices}
              focusRef={(el) => {
                groups.current.choices = el;
              }}
            />
            {draft.correction ? (
              <CorrectionFields answers={answers} set={set} problems={problems} replyField={replyField} groups={groups.current} />
            ) : null}
            <section className="report-preview" aria-labelledby="report-preview">
              <h2 id="report-preview">{C.preview.heading}</h2>
              <ul className="report-lines">
                {lines.map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines can repeat and the list is display-only
                  <li key={i}>{line}</li>
                ))}
              </ul>
              <details className="report-exact">
                <summary>{C.preview.exact}</summary>
                {/* Focusable: a long block a keyboard user must be able to scroll. */}
                <pre tabIndex={0} aria-label={C.preview.exactLabel}>
                  {body}
                </pre>
              </details>
              <p className="report-note">{draft.correction ? C.preview.neverSentCorrection : C.preview.neverSent}</p>
              <p className="report-note">
                {C.preview.destination}{' '}
                <a href={C.preview.privacyHref} target="_blank" rel="noopener noreferrer">
                  {C.preview.privacy}
                </a>
              </p>
            </section>
          </>
        ) : null}
        {blockedBy ? (
          <Banner tone="warning" title={blockedBy.title}>
            {blockedBy.body}
          </Banner>
        ) : null}
        {failed ? (
          <div className="report-failure" role="alert">
            <h2 ref={result} tabIndex={-1}>
              {failed.title}
            </h2>
            <p>{failed.body}</p>
          </div>
        ) : null}
        <div className="report-actions">
          {failed ? (
            <>
              {failed.actions.includes('retry') ? (
                <Button variant="primary" type="submit">
                  {C.buttons.tryAgain}
                </Button>
              ) : null}
              {failed.actions.includes('email') && mailto ? (
                <a className="ua-button ua-button--secondary" href={mailto} onClick={onEmail}>
                  {phase.name === 'failed' && phase.code === 'consent' ? C.buttons.emailThis : C.buttons.emailInstead}
                </a>
              ) : null}
              <Button
                variant={failed.actions.length === 1 && failed.actions[0] === 'close' ? 'primary' : 'secondary'}
                onClick={closeTab}
              >
                {failed.actions.includes('close') ? C.buttons.close : C.buttons.cancel}
              </Button>
            </>
          ) : (
            <>
              {blockedBy ? (
                <a
                  className="ua-button ua-button--primary"
                  href={mailto ?? supportMailto({ subject: C.mailSubject() })}
                  onClick={onEmail}
                >
                  {/* ADR 0009 §5: without technical data, "Email this report"; without consent for the words, "instead". */}
                  {blockedBy === C.firefoxWords ? C.buttons.emailInstead : C.buttons.emailThis}
                </a>
              ) : (
                <Button variant="primary" type="submit" loading={phase.name === 'sending'}>
                  {phase.name === 'sending' ? C.buttons.sending : C.buttons.send}
                </Button>
              )}
              <Button onClick={closeTab}>{C.buttons.cancel}</Button>
            </>
          )}
        </div>
      </form>
    );
  }

  return (
    <main className="report">
      <h1 ref={title} tabIndex={-1}>
        {C.title}
      </h1>
      {data && phase.name !== 'sent' ? <p className="report-lead">{C.lead}</p> : null}
      {content}
    </main>
  );
}

/** A question: checkboxes or radio buttons in a fieldset, with its error next to it. */
function ChoiceGroup({
  legend,
  kind,
  options,
  selected,
  onChange,
  error,
  focusRef,
}: {
  legend: string;
  kind: 'radio' | 'checkbox';
  options: { value: string; label: string }[];
  selected: readonly string[];
  onChange(next: string[]): void;
  error: string | undefined;
  /** The element to focus when the question is missing an answer: its first option. */
  focusRef(el: HTMLElement | null): void;
}) {
  const name = useId();
  const errorId = `${name}-error`;
  return (
    <fieldset className="report-group" aria-describedby={error ? errorId : undefined}>
      <legend className="report-legend">{legend}</legend>
      {error ? (
        <p id={errorId} className="ua-field-error report-error">
          {error}
        </p>
      ) : null}
      {options.map((o, i) => (
        <label key={o.value} className="report-option">
          <input
            ref={i === 0 ? focusRef : undefined}
            type={kind}
            name={name}
            value={o.value}
            checked={selected.includes(o.value)}
            aria-describedby={error ? errorId : undefined}
            onChange={(e) => {
              if (kind === 'radio') onChange([o.value]);
              else onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value));
            }}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** A correction's words (cleaned for the preview as they are typed, never in the field) and its optional reply email. */
function CorrectionFields({
  answers,
  set,
  problems,
  replyField,
  groups,
}: {
  answers: Answers;
  set(patch: Partial<Answers>): void;
  problems: Problems;
  replyField: boolean;
  groups: Partial<Record<keyof Problems, HTMLElement | null>>;
}) {
  const id = useId();
  return (
    <>
      <div className="ua-field report-field">
        <label htmlFor={`${id}-words`} className="ua-field-label">
          {C.words.label}
        </label>
        <textarea
          id={`${id}-words`}
          ref={(el) => {
            groups.words = el;
          }}
          className="ua-textarea"
          rows={6}
          maxLength={MAX_CORRECTION_MESSAGE}
          value={answers.words}
          aria-invalid={problems.words ? true : undefined}
          aria-describedby={`${id}-words-hint ${id}-words-count${problems.words ? ` ${id}-words-error` : ''}`}
          onChange={(e) => set({ words: e.target.value })}
        />
        {problems.words ? (
          <div id={`${id}-words-error`} className="ua-field-error">
            {problems.words}
          </div>
        ) : null}
        <div id={`${id}-words-count`} className="ua-field-hint report-counter">
          {C.words.counter(answers.words.length)}
        </div>
        <div id={`${id}-words-hint`} className="ua-field-hint">
          {C.words.hint}
        </div>
      </div>
      {replyField ? (
        <div className="ua-field report-field">
          <label htmlFor={`${id}-email`} className="ua-field-label">
            {C.email.label}
          </label>
          <div className="ua-input-wrap" data-invalid={problems.email ? 'true' : undefined}>
            <input
              id={`${id}-email`}
              ref={(el) => {
                groups.email = el;
              }}
              className="ua-input"
              type="email"
              autoComplete="email"
              value={answers.email}
              aria-invalid={problems.email ? true : undefined}
              aria-describedby={`${id}-email-hint`}
              onChange={(e) => set({ email: e.target.value })}
            />
          </div>
          <div id={`${id}-email-hint`} className={problems.email ? 'ua-field-error' : 'ua-field-hint'}>
            {problems.email ?? (answers.email.trim() ? C.email.hint : `${C.email.hint} ${C.email.without}`)}
          </div>
        </div>
      ) : (
        <p className="report-note">{C.email.noField}</p>
      )}
    </>
  );
}
