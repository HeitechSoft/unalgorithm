import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useId, useState } from 'react';
import { Eye, EyeOff, LoaderCircle, type LucideIcon } from '../icons.ts';

type Variant = 'primary' | 'secondary' | 'tinted' | 'plain' | 'destructive' | 'destructive-solid';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  trailingIcon?: LucideIcon;
  loading?: boolean;
  fullWidth?: boolean;
  type?: 'button' | 'submit';
  href?: string;
}

function cls(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

/** Capsule button. Primary for the one main action on a screen; plain for quiet actions. */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  trailingIcon: Trailing,
  loading,
  fullWidth,
  type = 'button',
  href,
  className,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  const classes = cls(
    'ua-button',
    `ua-button--${variant}`,
    size !== 'md' && `ua-button--${size}`,
    fullWidth && 'ua-button--full',
    className,
  );
  const content = (
    <>
      {loading ? <LoaderCircle className="ua-spin" aria-hidden="true" /> : Icon ? <Icon aria-hidden="true" /> : null}
      {children}
      {Trailing ? <Trailing aria-hidden="true" /> : null}
    </>
  );
  if (href) {
    return (
      <a className={classes} href={href} target="_blank" rel="noopener noreferrer">
        {content}
      </a>
    );
  }
  return (
    <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {content}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'children'> {
  icon: LucideIcon;
  label: string;
  pressed?: boolean;
}

export function IconButton({ icon: Icon, label, pressed, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={cls('ua-icon-button', className)}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...rest}
    >
      <Icon aria-hidden="true" />
    </button>
  );
}

export interface SwitchProps {
  checked: boolean;
  onCheckedChange(v: boolean): void;
  label: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
  id?: string;
  describedBy?: string;
}

/** iOS-style switch: a real `role="switch"` button, so it works with keyboards and screen readers. */
export function Switch({ checked, onCheckedChange, label, disabled, size = 'md', id, describedBy }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      className={cls('ua-switch', size === 'sm' && 'ua-switch--sm')}
      onClick={() => onCheckedChange(!checked)}
    />
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  value: T | null;
  onValueChange(v: T): void;
  label: string;
  options: readonly SegmentedOption<T>[];
  fullWidth?: boolean;
  /** Shown as an extra, unselectable segment when the value matches none (e.g. "Custom"). */
  customLabel?: string;
}

/** Radio group styled as a macOS segmented control; arrow keys move between segments. */
export function SegmentedControl<T extends string>({
  value,
  onValueChange,
  label,
  options,
  fullWidth,
  customLabel,
}: SegmentedControlProps<T>) {
  const name = useId();
  const isCustom = value === null || !options.some((o) => o.value === value);
  return (
    <div role="radiogroup" aria-label={label} className={cls('ua-segmented', fullWidth && 'ua-segmented--full')}>
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <label key={o.value}>
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={value === o.value}
              disabled={o.disabled}
              onChange={() => onValueChange(o.value)}
            />
            {Icon ? <Icon aria-hidden="true" /> : null}
            {o.label}
          </label>
        );
      })}
      {customLabel && isCustom ? (
        <label>
          <input type="radio" name={name} checked readOnly disabled />
          {customLabel}
        </label>
      ) : null}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label: string;
  labelHidden?: boolean;
  hint?: ReactNode;
  error?: string;
  trailing?: ReactNode;
  mono?: boolean;
}

export function TextField({ label, labelHidden, hint, error, trailing, mono, id, className, ...rest }: TextFieldProps) {
  const auto = useId();
  const fieldId = id ?? auto;
  const hintId = `${fieldId}-hint`;
  return (
    <div className={cls('ua-field', className)}>
      <label htmlFor={fieldId} className={labelHidden ? 'ua-vh' : 'ua-field-label'}>
        {label}
      </label>
      <div className="ua-input-wrap" data-invalid={error ? 'true' : undefined}>
        <input
          id={fieldId}
          className={cls('ua-input', mono && 'ua-input--mono')}
          aria-invalid={error ? true : undefined}
          aria-describedby={hint || error ? hintId : undefined}
          {...rest}
        />
        {trailing}
      </div>
      {error ? (
        <div id={hintId} className="ua-field-error">
          {error}
        </div>
      ) : hint ? (
        <div id={hintId} className="ua-field-hint">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

/** Masked field for API keys, with Show/Hide. Paste is always allowed. */
export function SecretField(props: Omit<TextFieldProps, 'type' | 'trailing'>) {
  const [shown, setShown] = useState(false);
  return (
    <TextField
      {...props}
      type={shown ? 'text' : 'password'}
      mono
      autoComplete="off"
      spellCheck={false}
      trailing={
        <IconButton icon={shown ? EyeOff : Eye} label={shown ? 'Hide key' : 'Show key'} onClick={() => setShown(!shown)} />
      }
    />
  );
}
