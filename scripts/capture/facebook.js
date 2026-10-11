/*
 * UnAlgorithm fixture capture for Facebook. Paste into DevTools on your Facebook home feed, scroll a little first.
 *
 * Copies anonymized HTML of the first N feed items to the clipboard:
 *  - every word is scrambled except Facebook's own UI labels (so detectors still see "Sponsored", "Follow"...);
 *  - names, links, ids, images, videos, scripts and styles are removed or replaced with stable fakes;
 *  - elements the browser renders as blocks get data-ua-block, invisible ones data-ua-hidden (Facebook hides
 *    decoy letters inside labels), and labels referenced by aria-labelledby are copied into an appendix.
 * Paste the result into packages/platforms/fixtures/facebook/<date>-<what>.html and run `pnpm fixtures:check`.
 * Nothing is sent anywhere.
 */
(async () => {
  const N = Number(prompt('How many feed items?', '30')) || 30;
  const KEEP =
    /^(sponsored|paid partnership|suggested for you|suggested post|follow|following|join|join group|see more|like|comment|share|send|reels( and short videos)?|people you may know|suggested groups|stories|learn more|shop now|sign up|commented on|reacted to|shared|this|a|post|public|friends|shared with|add friend)$/i;
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
  // Every path segment is rebuilt: Facebook's own route words stay, ids (numbers, pfbid…, a.123) get stable fakes,
  // and anything else (usernames, page names, hashtags) is scrambled, wherever it appears in the path.
  const FB_ROUTES = new Set(
    'groups posts permalink permalink.php story.php user reel reels videos video watch photo photo.php photos stories events hashtag profile.php ads about marketplace gaming pages media set share'.split(
      ' ',
    ),
  );
  const cleanHref = (href) => {
    try {
      const u = new URL(href, location.origin);
      if (u.hostname === 'l.facebook.com' || u.pathname === '/l.php')
        return `https://l.facebook.com/l.php?u=${encodeURIComponent('https://example.com/article')}`;
      if (!/(^|\.)facebook\.com$/.test(u.hostname)) return 'https://example.com/article';
      let segs = u.pathname
        .split('/')
        .filter(Boolean)
        .map((raw) => {
          const seg = decodeURIComponent(raw);
          if (FB_ROUTES.has(seg.toLowerCase())) return seg;
          if (/^(\d+|pfbid\w+|[a-z]\.\d+(\.\d+)*)$/i.test(seg)) return fakeId(seg);
          return fake(seg);
        });
      if (segs[0] === 'ads') segs = ['ads', 'about'];
      const keep = ['story_fbid', 'id', 'fbid', 'set'];
      const q = keep.filter((k) => u.searchParams.has(k)).map((k) => `${k}=${fakeId(u.searchParams.get(k))}`);
      const slash = segs.length && u.pathname.endsWith('/') ? '/' : '';
      return `https://www.facebook.com/${segs.join('/')}${slash}${q.length ? `?${q.join('&')}` : ''}`;
    } catch {
      return '#';
    }
  };
  const ALLOWED = new Set([
    'role',
    'aria-label',
    'aria-labelledby',
    'aria-describedby',
    'aria-posinset',
    'aria-hidden',
    'href',
    'dir',
    'tabindex',
    'id',
    'data-ad-preview',
    'data-ad-comet-preview',
    'data-ad-rendering-role',
    'data-pagelet',
    'width',
  ]);
  const feed = document.querySelector('[role="main"] [role="feed"]') || document.querySelector('[role="feed"]');
  if (!feed) return alert('No feed found. Open your Facebook home feed first.');
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
  const items = Array.from(feed.children)
    .slice(0, N)
    .map((el) => clone(el).outerHTML);
  const appendix = [...external]
    .map((id) => document.getElementById(id))
    .filter(Boolean)
    .map((el) => clone(el).outerHTML);
  const rail = document.querySelector('[role="complementary"]');
  const html = `<!-- captured ${new Date().toISOString().slice(0, 10)} lang=${document.documentElement.lang} -->
<div role="main"><div role="feed">
${items.join('\n')}
</div></div>
${rail ? clone(rail).outerHTML : ''}
<div data-ua-external hidden>${appendix.join('\n')}</div>`;
  await navigator.clipboard.writeText(html);
  alert(`Copied ${items.length} anonymized feed items (${html.length.toLocaleString()} characters).`);
})();
