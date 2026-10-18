/*
 * unAlgorithm fixture capture for LinkedIn. Paste into DevTools on your LinkedIn feed, scroll a little first.
 *
 * Copies anonymized HTML of the first N feed items to the clipboard:
 *  - every word is scrambled except LinkedIn's own UI labels (so detectors still see "Promoted", "Follow"...);
 *  - names, links, ids, images, videos, scripts and styles are removed or replaced with stable fakes;
 *  - elements the browser renders as blocks get data-ua-block, invisible ones data-ua-hidden, and labels
 *    referenced by aria-labelledby are copied into an appendix.
 * Paste the result into packages/platforms/fixtures/linkedin/<date>-<what>.html and run `pnpm fixtures:check`.
 * Nothing is sent anywhere.
 */
(async () => {
  const N = Number(prompt('How many feed items?', '30')) || 30;
  const KEEP =
    /^(promoted|sponsored|suggested|follow|following|join|request to join|more|see more|like|comment|repost|send|likes|commented|on|this|reposted|followed|by|celebrates|supports|loves|finds|insightful|feed|post|open|control|menu|for|hide|view|group|people|you|may|know|1st|2nd|3rd|edited|reaction|button|state|no|reaction)$/i;
  const words = new Map();
  const fake = (w) => {
    if (!words.has(w)) {
      let s = '';
      // Every letter and digit in any script (accents, Cyrillic, CJK, Arabic…), not just ASCII.
      for (const ch of w) s += /\p{Lu}/u.test(ch) ? 'X' : /\p{L}/u.test(ch) ? 'x' : /\p{N}/u.test(ch) ? '0' : ch;
      words.set(w, s);
    }
    return words.get(w);
  };
  const scramble = (text) =>
    KEEP.test(text.trim()) ? text : text.replace(/[\p{L}\p{N}]+/gu, (w) => (KEEP.test(w) ? w : fake(w)));
  const ids = new Map();
  const fakeId = (id) => {
    if (!ids.has(id)) ids.set(id, String(100000 + ids.size));
    return ids.get(id);
  };
  // Every path segment is rebuilt: LinkedIn's own route words stay, ids get stable fakes, and anything else (names
  // in profile slugs, post permalinks such as /posts/<name>_<title>-activity-<id>, article slugs, hashtags) is
  // scrambled. Query strings are dropped.
  const LI_ROUTES = new Set(
    'in company school showcase groups events posts pulse feed update hashtag newsletters jobs search video embed mynetwork products services learning'.split(
      ' ',
    ),
  );
  const cleanHref = (href) => {
    try {
      const u = new URL(href, location.origin);
      if (!/(^|\.)linkedin\.com$/.test(u.hostname)) return 'https://example.com/article';
      const segs = u.pathname
        .split('/')
        .filter(Boolean)
        .map((raw) => {
          const seg = decodeURIComponent(raw);
          if (LI_ROUTES.has(seg)) return seg;
          const urn = seg.match(/^urn:li:(\w+):(\d+)$/);
          if (urn) return `urn:li:${urn[1]}:${fakeId(urn[2])}`;
          if (/^\d+$/.test(seg)) return fakeId(seg);
          return fake(seg);
        });
      return `https://www.linkedin.com/${segs.join('/')}${segs.length && u.pathname.endsWith('/') ? '/' : ''}`;
    } catch {
      return '#';
    }
  };
  // LinkedIn's test ids are static names, except the comment list's, which ends with the card key.
  const cleanTestId = (v) => {
    const comments = v.match(/commentList(.*)$/);
    if (comments) return `x-commentList${comments[1] ? fakeId(comments[1]) : ''}`;
    return /^[a-z][a-zA-Z-]*$/.test(v) ? v : v.replace(/[A-Za-z0-9]{6,}/g, (w) => fakeId(w));
  };
  const ALLOWED = new Set([
    'role',
    'aria-label',
    'aria-hidden',
    'href',
    'dir',
    'componentkey',
    'data-testid',
    'data-urn',
    'data-id',
    'data-view-name',
    'class',
  ]);
  const feed = document.querySelector('[data-testid="mainFeed"]') || document.querySelector('main');
  if (!feed) return alert('No feed found. Open your LinkedIn feed first.');
  const external = new Set();
  const clone = (src) => {
    const out = src.cloneNode(false);
    if (src.nodeType === Node.TEXT_NODE) {
      out.nodeValue = scramble(src.nodeValue || '');
      return out;
    }
    if (src.nodeType !== Node.ELEMENT_NODE) return null;
    const tag = src.tagName.toLowerCase();
    if (['script', 'style', 'img', 'video', 'image', 'path', 'noscript', 'iframe'].includes(tag)) return null;
    for (const a of Array.from(out.attributes)) if (!ALLOWED.has(a.name)) out.removeAttribute(a.name);
    if (out.hasAttribute('href')) out.setAttribute('href', cleanHref(src.getAttribute('href')));
    if (out.hasAttribute('aria-label')) out.setAttribute('aria-label', scramble(src.getAttribute('aria-label')));
    if (out.hasAttribute('class'))
      out.setAttribute(
        'class',
        (src.getAttribute('class') || '')
          .split(/\s+/)
          .filter((c) => /^(update-components|feed-shared|social-details|comments-)/.test(c))
          .join(' '),
      );
    if (out.hasAttribute('componentkey'))
      out.setAttribute(
        'componentkey',
        (src.getAttribute('componentkey') || '').replace(/(update-card-focus)(.*)/, (_m, p, key) => `${p}${fakeId(key)}`),
      );
    if (out.hasAttribute('data-testid')) out.setAttribute('data-testid', cleanTestId(src.getAttribute('data-testid') || ''));
    for (const attr of ['data-urn', 'data-id'])
      if (out.hasAttribute(attr))
        out.setAttribute(
          attr,
          (src.getAttribute(attr) || '').replace(/(\d{6,})/g, (d) => fakeId(d)),
        );
    for (const attr of ['aria-labelledby', 'aria-describedby'])
      for (const id of (src.getAttribute(attr) || '').split(/\s+/).filter(Boolean)) external.add(id);
    const s = getComputedStyle(src);
    const r = src.getBoundingClientRect();
    if (
      s.display === 'none' ||
      s.visibility === 'hidden' ||
      Number(s.opacity) === 0 ||
      (r.width === 0 && r.height === 0 && src.childElementCount === 0)
    )
      out.setAttribute('data-ua-hidden', '');
    if (/^(block|flex|grid|list-item|table)/.test(s.display)) out.setAttribute('data-ua-block', '');
    if (tag === 'use') {
      const ref = src.getAttribute('href') || src.getAttribute('xlink:href');
      if (ref?.startsWith('#')) external.add(ref.slice(1));
    }
    for (const c of Array.from(src.childNodes)) {
      const cc = clone(c);
      if (cc) out.appendChild(cc);
    }
    return out;
  };
  const roots = Array.from(
    feed.querySelectorAll('[role="listitem"][componentkey^="update-card-focus"], [data-id^="urn:li:"], [data-urn^="urn:li:"]'),
  ).filter((el, _i, all) => !all.some((o) => o !== el && o.contains(el)));
  const items = roots.slice(0, N).map((el) => clone(el).outerHTML);
  const appendix = [...external]
    .map((id) => document.getElementById(id))
    .filter(Boolean)
    .map((el) => clone(el).outerHTML);
  const html = `<!-- captured ${new Date().toISOString().slice(0, 10)} lang=${document.documentElement.lang} -->
<main><div role="list" data-testid="mainFeed">
${items.join('\n')}
</div></main>
<div data-ua-external hidden>${appendix.join('\n')}</div>`;
  await navigator.clipboard.writeText(html);
  alert(`Copied ${items.length} anonymized feed items (${html.length.toLocaleString()} characters).`);
})();
