import { createContext, type ReactNode, useContext, useId } from 'react';

const GroupContext = createContext<{ name: string; value: string | null; onChange(v: string): void } | null>(null);

/** Radio group of large cards (onboarding strength, AI source). Arrow keys move between cards. */
export function ChoiceCardGroup<T extends string>({
  value,
  onValueChange,
  label,
  children,
  columns,
}: {
  value: T | null;
  onValueChange(v: T): void;
  label: string;
  children: ReactNode;
  columns?: number;
}) {
  const name = useId();
  return (
    <GroupContext.Provider value={{ name, value, onChange: (v) => onValueChange(v as T) }}>
      <div
        role="radiogroup"
        aria-label={label}
        className="ua-choices"
        style={columns ? { gridTemplateColumns: `repeat(auto-fit, minmax(${columns > 2 ? 180 : 240}px, 1fr))` } : undefined}
      >
        {children}
      </div>
    </GroupContext.Provider>
  );
}

export function ChoiceCard({
  value,
  title,
  description,
  badge,
  media,
  disabled,
  children,
}: {
  value: string;
  title: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  media?: ReactNode;
  disabled?: boolean;
  /** Revealed when this card is selected. */
  children?: ReactNode;
}) {
  const g = useContext(GroupContext);
  if (!g) throw new Error('ChoiceCard must be inside ChoiceCardGroup');
  const checked = g.value === value;
  return (
    <div className="ua-choice">
      <label style={{ display: 'block', cursor: disabled ? 'default' : 'pointer' }}>
        <input
          className="ua-choice-input"
          type="radio"
          name={g.name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={() => g.onChange(value)}
        />
        {media}
        {badge && media ? <span style={{ display: 'block', marginBottom: 6 }}>{badge}</span> : null}
        <span className="ua-choice-head">
          <span className="ua-choice-title">{title}</span>
          {badge && !media ? badge : null}
          <span className="ua-choice-radio" aria-hidden="true" />
        </span>
        {description ? (
          <span className="ua-choice-desc" style={{ display: 'block' }}>
            {description}
          </span>
        ) : null}
      </label>
      {checked && children ? <div className="ua-choice-more">{children}</div> : null}
    </div>
  );
}
