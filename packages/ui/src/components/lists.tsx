import type { ReactNode } from 'react';
import { ChevronRight, ExternalLink, type LucideIcon } from '../icons.ts';

export type TileTint = 'lagoon' | 'blue' | 'indigo' | 'violet' | 'pink' | 'orange' | 'green' | 'gray' | 'slate';

export function Tile({ icon: Icon, tint = 'lagoon', size = 'md' }: { icon: LucideIcon; tint?: TileTint; size?: 'sm' | 'md' }) {
  return (
    <span className={`ua-tile ua-tile--${tint}${size === 'sm' ? ' ua-tile--sm' : ''}`} aria-hidden="true">
      <Icon />
    </span>
  );
}

/** An inset grouped list section (macOS System Settings / iOS Settings). */
export function ListGroup({
  header,
  description,
  footer,
  id,
  children,
}: {
  header?: ReactNode;
  /** Lines between the header and the list, such as what the list is for or a summary of it. */
  description?: ReactNode;
  footer?: ReactNode;
  id?: string;
  children: ReactNode;
}) {
  return (
    <section className="ua-group" id={id}>
      {header ? <h3 className="ua-group-header">{header}</h3> : null}
      {description ? <div className="ua-group-description">{description}</div> : null}
      <div className="ua-group-body">{children}</div>
      {footer ? <p className="ua-group-footer">{footer}</p> : null}
    </section>
  );
}

export interface ListRowProps {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: { icon: LucideIcon; tint?: TileTint };
  leading?: ReactNode;
  /** Switch, segmented control, select… */
  control?: ReactNode;
  accessory?: 'chevron' | 'external' | ReactNode;
  onSelect?(): void;
  href?: string;
  tone?: 'default' | 'destructive';
  id?: string;
  highlight?: boolean;
  /** Makes the row a group with this name, for a row whose controls all act on one thing (a topic's More and Less). */
  groupLabel?: string;
}

/** One row. With `onSelect` or `href` the whole row is the button or link. */
export function ListRow({
  title,
  subtitle,
  icon,
  leading,
  control,
  accessory,
  onSelect,
  href,
  tone,
  id,
  highlight,
  groupLabel,
}: ListRowProps) {
  const classes = [
    'ua-row',
    icon && 'ua-row--icon',
    (onSelect || href) && 'ua-row--action',
    tone === 'destructive' && 'ua-row--destructive',
    highlight && 'ua-row--highlight',
  ]
    .filter(Boolean)
    .join(' ');
  const acc =
    accessory === 'chevron' ? (
      <ChevronRight aria-hidden="true" />
    ) : accessory === 'external' ? (
      <ExternalLink aria-hidden="true" />
    ) : (
      accessory
    );
  const body = (
    <>
      {icon ? <Tile icon={icon.icon} tint={icon.tint} /> : null}
      {leading}
      <span className="ua-row-text">
        <span className="ua-row-title">{title}</span>
        {subtitle ? (
          <span className="ua-row-subtitle" style={{ display: 'block' }}>
            {subtitle}
          </span>
        ) : null}
      </span>
      {control}
      {acc ? <span className="ua-row-accessory">{acc}</span> : null}
    </>
  );
  if (href) {
    return (
      <a className={classes} href={href} target="_blank" rel="noopener noreferrer" id={id}>
        {body}
      </a>
    );
  }
  if (onSelect) {
    return (
      <button type="button" className={classes} onClick={onSelect} id={id}>
        {body}
      </button>
    );
  }
  return (
    <div className={classes} id={id} role={groupLabel ? 'group' : undefined} aria-label={groupLabel}>
      {body}
    </div>
  );
}
