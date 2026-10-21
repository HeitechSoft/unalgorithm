/**
 * The portal's own building blocks, on top of `@unalgorithm/ui` (docs/design/portal.md, *Components*): a titled
 * section, a card, a stat tile, a status dot, a list's "add" row, a back button and a section's spinner.
 */
import { ChevronLeft, ChevronRight, ExternalLink, LoaderCircle, type LucideIcon, Plus } from '@unalgorithm/ui';
import { type ReactNode, type Ref, useId } from 'react';

/**
 * A part of a page: its heading (`h2`), an optional line under it and actions on its trailing edge, then its content.
 * `busy` marks it as loading and shows a spinner in place of content that hasn't come yet.
 */
export function Section({
  title,
  description,
  actions,
  busy,
  headingRef,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  busy?: boolean;
  /** A heading that takes the focus when a view returns to it. */
  headingRef?: Ref<HTMLHeadingElement>;
  className?: string;
  children?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      className={className ? `web-section ${className}` : 'web-section'}
      aria-labelledby={headingId}
      aria-busy={busy || undefined}
    >
      <div className="web-section-head">
        <div className="web-section-title">
          <h2 id={headingId} ref={headingRef} tabIndex={headingRef ? -1 : undefined}>
            {title}
          </h2>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="web-section-actions">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Where a section's content will be while its first answer is on its way. */
export function SectionLoading() {
  return (
    <div className="web-section-loading">
      <LoaderCircle className="ua-spin" aria-hidden="true" />
    </div>
  );
}

/** A raised surface for content that isn't a list: a balance, a form, a chart. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `web-card ${className}` : 'web-card'}>{children}</div>;
}

/**
 * A dashboard tile: a label, one large figure and at most one line of context; `meter` (0 to 1) adds a bar under it,
 * in the tone's colour.
 */
export function StatTile({
  label,
  value,
  detail,
  meter,
  tone = 'accent',
  href,
}: {
  label: string;
  value: string;
  detail?: ReactNode;
  meter?: number;
  tone?: 'accent' | 'warning' | 'danger';
  href?: string;
}) {
  const body = (
    <>
      <span className="web-stat-label">{label}</span>
      <span className="web-stat-value">{value}</span>
      {meter === undefined ? null : (
        <span className={`web-meter web-meter--${tone}`} aria-hidden="true">
          <span style={{ width: `${Math.round(Math.min(1, Math.max(0, meter)) * 100)}%` }} />
        </span>
      )}
      {detail ? <span className="web-stat-detail">{detail}</span> : null}
    </>
  );
  return href ? (
    <a className="web-stat web-stat--link" href={href}>
      {body}
    </a>
  ) : (
    <div className="web-stat">{body}</div>
  );
}

/** A state as a coloured dot and its word: never colour alone. */
export function Status({ tone, children }: { tone: 'success' | 'warning' | 'danger' | 'neutral'; children: ReactNode }) {
  return (
    <span className={`web-status-dot web-status-dot--${tone}`}>
      <span aria-hidden="true" />
      {children}
    </span>
  );
}

/**
 * A list's last row that adds to it, in accent colour with a plus ("Add a passkey"). Its own class, not `ua-row`: it
 * is an action at the end of the list, not one of the list's things.
 */
export function AddRow({
  label,
  accessibleLabel,
  onSelect,
  disabled,
  loading,
  icon: Icon = Plus,
}: {
  label: string;
  /** The name a screen reader says, when the label alone doesn't say what it acts on ("Edit the starter credit"). */
  accessibleLabel?: string;
  onSelect(): void;
  disabled?: boolean;
  loading?: boolean;
  icon?: LucideIcon;
}) {
  return (
    <button
      type="button"
      className="web-add-row"
      aria-label={accessibleLabel}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={onSelect}
    >
      {loading ? <LoaderCircle className="ua-spin" aria-hidden="true" /> : <Icon aria-hidden="true" />}
      <span>{label}</span>
    </button>
  );
}

/**
 * A row that is a link: to a page of this server (opens in place, with a chevron) or, with `external`, to another site
 * (a new tab, with the external-link icon).
 */
export function LinkRow({
  title,
  subtitle,
  href,
  external,
}: {
  title: string;
  subtitle?: string;
  href: string;
  external?: boolean;
}) {
  const Accessory = external ? ExternalLink : ChevronRight;
  return (
    <a className="ua-row ua-row--action" href={href} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}>
      <span className="ua-row-text">
        <span className="ua-row-title">{title}</span>
        {subtitle ? <span className="ua-row-subtitle web-block">{subtitle}</span> : null}
      </span>
      <span className="ua-row-accessory">
        <Accessory aria-hidden="true" />
      </span>
    </a>
  );
}

/** "Back" above a view's heading, saying where it goes. */
export function BackButton({ label, onBack }: { label: string; onBack(): void }) {
  return (
    <button type="button" className="web-back" onClick={onBack}>
      <ChevronLeft aria-hidden="true" />
      {label}
    </button>
  );
}

/** A label and its value, as a row of facts lists them. */
export function Facts({ items }: { items: readonly (readonly [label: string, value: ReactNode])[] }) {
  return (
    <dl className="web-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
