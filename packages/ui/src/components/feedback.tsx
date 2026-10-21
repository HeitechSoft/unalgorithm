import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, CircleCheck, Info, type LucideIcon, Plus, TriangleAlert, X } from '../icons.ts';
import { Button, IconButton } from './controls.tsx';

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'ai';

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`ua-badge${tone === 'neutral' ? '' : ` ua-badge--${tone}`}`}>{children}</span>;
}

export interface ChipProps {
  label: string;
  icon?: LucideIcon;
  count?: number;
  selected?: boolean;
  onSelectedChange?(v: boolean): void;
  onClick?(): void;
  size?: 'sm' | 'md';
  ai?: boolean;
}

/** Toggle chip (aria-pressed) when `onSelectedChange` is given, a button with `onClick`, otherwise static. */
export function Chip({ label, icon: Icon, count, selected, onSelectedChange, onClick, size = 'md', ai }: ChipProps) {
  const classes = [
    'ua-pchip',
    size === 'sm' && 'ua-pchip--sm',
    ai && 'ua-pchip--ai',
    !onSelectedChange && !onClick && 'ua-pchip--static',
  ]
    .filter(Boolean)
    .join(' ');
  const content = (
    <>
      {Icon ? <Icon aria-hidden="true" /> : null}
      {label}
      {count !== undefined ? <span className="ua-pchip-count">{count}</span> : null}
    </>
  );
  if (onSelectedChange) {
    // A toggle shows its state, not only its colour: + to add it, a check once it's chosen. Without them an unchosen
    // topic reads as chosen.
    const State = selected ? Check : Plus;
    return (
      <button type="button" className={classes} aria-pressed={!!selected} onClick={() => onSelectedChange(!selected)}>
        {Icon ? null : <State aria-hidden="true" />}
        {content}
      </button>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={classes} onClick={onClick}>
        {content}
      </button>
    );
  }
  return <span className={classes}>{content}</span>;
}

const BANNER_ICON: Record<'info' | 'success' | 'warning' | 'danger', LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

export function Banner({
  tone = 'info',
  title,
  children,
  action,
  onDismiss,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  title: string;
  children?: ReactNode;
  action?: { label: string; onAction(): void };
  onDismiss?(): void;
}) {
  const Icon = BANNER_ICON[tone];
  return (
    <div className={`ua-banner ua-banner--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon aria-hidden="true" />
      <div className="ua-grow">
        <div className="ua-banner-title">{title}</div>
        {children ? <div className="ua-banner-body">{children}</div> : null}
        {action ? (
          <div className="ua-banner-actions">
            <Button
              size="sm"
              variant={tone === 'danger' || tone === 'warning' ? 'secondary' : 'tinted'}
              onClick={action.onAction}
            >
              {action.label}
            </Button>
          </div>
        ) : null}
      </div>
      {onDismiss ? <IconButton icon={X} label="Dismiss" onClick={onDismiss} /> : null}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  body?: ReactNode;
  action?: { label: string; onAction(): void };
}) {
  return (
    <div className="ua-empty">
      {Icon ? <Icon aria-hidden="true" /> : null}
      <div className="ua-empty-title">{title}</div>
      {body ? <div className="ua-empty-body">{body}</div> : null}
      {action ? (
        <Button variant="tinted" size="sm" onClick={action.onAction}>
          {action.label}
        </Button>
      ) : null}
    </div>
  );
}

export function ProgressBar({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="ua-progress" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: `${pct}%` }} />
    </div>
  );
}

export function StepperDots({ count, current, label = 'Setup progress' }: { count: number; current: number; label?: string }) {
  return (
    <div className="ua-dots" role="img" aria-label={`${label}: step ${current + 1} of ${count}`}>
      {Array.from({ length: count }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: dots are positional
        <span key={i} className="ua-dot" aria-current={i === current ? 'step' : undefined} />
      ))}
    </div>
  );
}

/** Native modal dialog (focus trap, Escape, inert background for free). Destructive actions never get default focus. */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
  alert,
  className,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  alert?: boolean;
  /** Added to the dialog's own class: a page's wider sheet. */
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={className ? `ua-dialog ${className}` : 'ua-dialog'}
      role={alert ? 'alertdialog' : 'dialog'}
      // Named by its title without an id, which two dialogs on one page (open or closed) would share.
      aria-label={title}
      onClose={() => onOpenChange(false)}
    >
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {children}
      {actions ? <div className="ua-dialog-actions">{actions}</div> : null}
    </dialog>
  );
}

interface ToastItem {
  id: number;
  title: string;
  action?: { label: string; onAction(): void };
}

const ToastContext = createContext<(t: Omit<ToastItem, 'id'>) => void>(() => undefined);

/** Toasts for extension pages ("Saved", "Copied", Undo). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const show = useCallback((t: Omit<ToastItem, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all.slice(-2), { ...t, id }]);
    window.setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.action ? 6000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="ua-page-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="ua-page-toast">
            <span>{t.title}</span>
            {t.action ? (
              <Button
                size="sm"
                variant="plain"
                onClick={() => {
                  t.action?.onAction();
                  setToasts((all) => all.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </Button>
            ) : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
