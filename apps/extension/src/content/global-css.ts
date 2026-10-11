import { luminance } from '@unalgorithm/platforms';

export const GLOBAL_STYLE_ID = 'unalgo-global';

export interface HostTheme {
  scheme: 'light' | 'dark';
  ink?: string;
  paper?: string;
  font?: string;
}

/** Sample the host page's card background, text color and font so our UI blends in without copying its brand. */
export function sampleHostTheme(doc: Document, sample: Element | null, fallback: 'light' | 'dark'): HostTheme {
  const view = doc.defaultView;
  if (!view) return { scheme: fallback };
  let paper: string | undefined;
  for (let el: Element | null = sample; el; el = el.parentElement) {
    const bg = view.getComputedStyle(el).backgroundColor;
    if (bg && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(bg)) {
      paper = bg;
      break;
    }
  }
  const ink = sample ? view.getComputedStyle(sample).color : undefined;
  const font = doc.body ? view.getComputedStyle(doc.body).fontFamily : undefined;
  const l = paper ? luminance(paper) : undefined;
  const scheme = l === undefined ? fallback : l < 0.4 ? 'dark' : 'light';
  return { scheme, ...(ink ? { ink } : {}), ...(paper ? { paper } : {}), ...(font ? { font } : {}) };
}

/**
 * The only CSS we put on the host page itself: attribute rules on post roots, plus theme variables that
 * cascade into every shadow root. Removed when UnAlgorithm stops on the page.
 */
export function globalCss(t: HostTheme): string {
  const ring = t.scheme === 'dark' ? 'rgb(60 207 192 / .75)' : 'rgb(11 122 117 / .7)';
  const glow = t.scheme === 'dark' ? 'rgb(60 207 192 / .14)' : 'rgb(11 122 117 / .1)';
  const vars = [
    `--ua-scheme: ${t.scheme};`,
    t.ink ? `--ua-host-ink: ${t.ink};` : '',
    t.paper ? `--ua-host-paper: ${t.paper};` : '',
    t.font ? `--ua-host-font: ${t.font};` : '',
  ].join(' ');
  return `
[data-unalgo="hidden"], [data-unalgo-run="member"] { display: none !important; }
[data-unalgo="collapsed"] > :not(unalgo-post) { display: none !important; }
[data-unalgo="dimmed"] > :not(unalgo-post) { opacity: .38; filter: saturate(.5); transition: opacity 200ms, filter 200ms; }
[data-unalgo="dimmed"]:is(:hover, :focus-within) > :not(unalgo-post) { opacity: 1; filter: none; }
[data-unalgo="revealed"] > :not(unalgo-post) { animation: unalgo-in 180ms cubic-bezier(.16,1,.3,1); }
[data-unalgo-pick] { box-shadow: 0 0 0 2px ${ring}, 0 6px 20px ${glow} !important; border-radius: 8px; transition: box-shadow 400ms; }
[data-unalgo-flash] { outline: 3px solid ${ring} !important; outline-offset: 2px; transition: outline-color 1.2s; }
@keyframes unalgo-in { from { opacity: 0 } }
@media (prefers-reduced-motion: reduce) { [data-unalgo] > * { animation: none !important; transition: none !important; } }
unalgo-post { display: block; }
unalgo-post, unalgo-layer { ${vars} }
`;
}
