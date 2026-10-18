import { useId } from 'react';

/** The unAlgorithm mark: a Lagoon tile with a "U" holding a single dot, the post that is for you. */
export function Logo({ size = 28, title }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={title ? 'img' : undefined} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0.6" y2="1">
          <stop offset="0" stopColor="#14B8A6" />
          <stop offset="1" stopColor="#0B7A75" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#g${id})`} />
      <rect x="0.5" y="0.5" width="63" height="63" rx="14.5" fill="none" stroke="#fff" strokeOpacity=".18" />
      <path d="M20 17v16a12 12 0 0 0 24 0V17" fill="none" stroke="#fff" strokeWidth="6.5" strokeLinecap="round" />
      <circle cx="32" cy="32" r="5" fill="#D0F3EE" />
    </svg>
  );
}

/** "unAlgorithm" set in two weights: un in Lagoon, Algorithm in ink. */
export function Wordmark({ size = 17 }: { size?: number }) {
  return (
    <span style={{ font: `600 ${size}px/1 var(--ua-font-display)`, letterSpacing: '-0.02em', whiteSpace: 'nowrap' }}>
      <span style={{ color: 'var(--ua-accent)', fontWeight: 700 }}>un</span>
      <span style={{ color: 'var(--ua-text)' }}>Algorithm</span>
    </span>
  );
}

export function Lockup({ size = 28 }: { size?: number }) {
  return (
    <span className="ua-hstack" style={{ gap: 8 }}>
      <Logo size={size} />
      <Wordmark size={Math.round(size * 0.62)} />
    </span>
  );
}
