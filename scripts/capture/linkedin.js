/*
 * unAlgorithm fixture capture for LinkedIn. Paste into DevTools on your LinkedIn feed, scroll a little first.
 *
 * Copies anonymized HTML of the first N children of the feed list (posts, panels, the composer, in page order) to the
 * clipboard:
 *  - every word is scrambled except LinkedIn's own UI labels (so detectors still see "Promoted", "Follow"...) and
 *    relative ages ("3h", "Edited", "Just now");
 *  - names, links, ids, images, videos, scripts and styles are removed or replaced with stable fakes;
 *  - elements the browser renders as blocks get data-ua-block, invisible ones data-ua-hidden, and labels
 *    referenced by aria-labelledby or <use href="#…"> are copied into an appendix;
 *  - items unAlgorithm folded away, and unAlgorithm's own elements, are left out: turn unAlgorithm off for LinkedIn
 *    to capture those items too.
 * Short header lines that still have scrambled words are printed in the console (never copied): if one is a label,
 * add its words to KEEP. Paste the result into packages/platforms/fixtures/linkedin/<date>-<what>.html and run
 * `pnpm fixtures:check`. Nothing is sent anywhere.
 */
(async () => {
  const N = Number(prompt('How many feed items?', '30')) || 30;
  /*
   * LinkedIn's own words, kept so detection still reads them. The capture-vocab test checks that every word of the
   * adapter's label patterns, panel titles, header sentences and ages is here.
   */
  const KEEP =
    /^(promoted|sponsored|partnership|by|with|to|as|at|in|from|on|suggested|recommended|popular|based|your|profile|activity|follow|following|followers?|followed|join|request|more|see|like|likes|loves?|celebrates?|supports?|reacted|commented|replied|was|mentioned|tagged|contributed|voted|finds?|insightful|funny|curious|interesting|love|follows|is|comment|repost|reposted|send|this|feed|post|open|control|menu|for|hide|view|group|people|you|may|know|be|interested|jobs?|pages?|groups|newsletters?|add|today|s|puzzles?|games?|play|the|linkedin|who|hiring|1st|2nd|3rd|edited|just|now|yesterday|reaction|button|state|no)$/i;
  /** A relative age as one word ("3h", "2d", "1mo"): kept, so a post's age still reads as one. */
  const AGE = /^[0-9]{1,2} ?(s|m|h|d|w|mo|y|yr)$/i;
  const keep = (w) => KEEP.test(w) || AGE.test(w);
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
  const scramble = (text) => (keep(text.trim()) ? text : text.replace(/[\p{L}\p{N}]+/gu, (w) => (keep(w) ? w : fake(w))));
  const ids = new Map();
  const fakeId = (id) => {
    if (!ids.has(id)) ids.set(id, String(100000 + ids.size));
    return ids.get(id);
  };
  /** Element ids (and the aria-labelledby and <use> references to them) become stable opaque tokens. */
  const fakeToken = (id) => `id${fakeId(`#${id}`)}`;
  // Every path segment is rebuilt: LinkedIn's own route words stay, ids get stable fakes, and anything else (names
  // in profile slugs, post permalinks such as /posts/<name>_<title>-activity-<id>, article slugs, hashtags) is
  // scrambled. Query strings are dropped.
  const LI_ROUTES = new Set(
    'in company school showcase groups events posts pulse feed update hashtag newsletters jobs search video embed mynetwork messaging notifications products services learning'.split(
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
  /**
   * Component keys are opaque, but the 2026 layout also puts base64 keys and raw URNs into them: only the card key's
   * prefix and its feed sort suffix stay, everything else becomes a stable fake number.
   */
  const cleanComponentKey = (v) => {
    const card = v.match(/^(update-card-focus)(.*?)(FeedType_[A-Z_]+)?$/);
    if (card) return `${card[1]}${fakeId(card[2])}${card[3] ?? ''}`;
    return `k${fakeId(v)}`;
  };
  /** LinkedIn's test ids: the static ones the adapter reads stay, the comment list keeps its name, the rest are fakes. */
  const STATIC_TEST_IDS = /^(mainFeed|expandable-text-box|expandable-text-button)$/;
  const cleanTestId = (v) => {
    if (STATIC_TEST_IDS.test(v)) return v;
    const comments = v.match(/commentList(.*)$/);
    if (comments) return `x-commentList${comments[1] ? fakeId(comments[1]) : ''}`;
    return `t${fakeId(v)}`;
  };
  const ALLOWED = new Set([
    'role',
    'aria-label',
    'aria-hidden',
    'aria-labelledby',
    'aria-describedby',
    'href',
    'id',
    'dir',
    'componentkey',
    'data-testid',
    'data-urn',
    'data-id',
    'data-view-name',
    'data-sdui-screen',
    'class',
  ]);
  /** unAlgorithm's own marks on an item it folded away: such an item is skipped, it would capture as hidden. */
  const FOLDED = '[data-unalgo="hidden"], [data-unalgo="collapsed"], [data-unalgo-run="member"]';
  const list = document.querySelector('[data-testid="mainFeed"]');
  const feed = list || document.querySelector('main');
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
    if (tag.startsWith('unalgo-')) return null;
    if (['script', 'style', 'img', 'video', 'image', 'path', 'noscript', 'iframe'].includes(tag)) return null;
    for (const a of Array.from(out.attributes)) if (!ALLOWED.has(a.name)) out.removeAttribute(a.name);
    if (out.hasAttribute('href') && tag !== 'use') out.setAttribute('href', cleanHref(src.getAttribute('href')));
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
      out.setAttribute('componentkey', cleanComponentKey(src.getAttribute('componentkey') || ''));
    if (out.hasAttribute('data-testid')) out.setAttribute('data-testid', cleanTestId(src.getAttribute('data-testid') || ''));
    for (const attr of ['data-urn', 'data-id'])
      if (out.hasAttribute(attr))
        out.setAttribute(
          attr,
          (src.getAttribute(attr) || '').replace(/(\d{6,})/g, (d) => fakeId(d)),
        );
    if (out.hasAttribute('id')) out.setAttribute('id', fakeToken(src.getAttribute('id') || ''));
    for (const attr of ['aria-labelledby', 'aria-describedby']) {
      const refs = (src.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
      for (const id of refs) external.add(id);
      if (refs.length) out.setAttribute(attr, refs.map(fakeToken).join(' '));
    }
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
      // An icon or label drawn from a <symbol> or <text> elsewhere: keep the reference, under the fake id.
      const ref = src.getAttribute('href') || src.getAttribute('xlink:href');
      out.removeAttribute('href');
      if (ref?.startsWith('#')) {
        external.add(ref.slice(1));
        out.setAttribute('href', `#${fakeToken(ref.slice(1))}`);
      }
    }
    for (const c of Array.from(src.childNodes)) {
      const cc = clone(c);
      if (cc) out.appendChild(cc);
    }
    return out;
  };
  // With the feed list, every child in page order (the composer and the sort control too); otherwise the posts.
  const roots = list
    ? Array.from(list.children)
    : Array.from(
        feed.querySelectorAll(
          '[role="listitem"][componentkey^="update-card-focus"], [data-id^="urn:li:"], [data-urn^="urn:li:"]',
        ),
      ).filter((el, _i, all) => !all.some((o) => o !== el && o.contains(el)));
  const own = roots.filter((el) => !el.tagName.toLowerCase().startsWith('unalgo-'));
  const folded = own.filter((el) => el.matches(FOLDED) || el.querySelector(FOLDED));
  const clones = own
    .filter((el) => !folded.includes(el))
    .slice(0, N)
    .map(clone);
  // Labels the items point at; cloning one can find more references, which are looked up in turn.
  const appendix = [];
  const copied = new Set();
  let pending = [...external];
  while (pending.length) {
    for (const id of pending) {
      copied.add(id);
      const el = document.getElementById(id);
      if (el) appendix.push(clone(el));
    }
    pending = [...external].filter((id) => !copied.has(id));
  }

  // For the maintainer, in the console only: short lines above a post's text that start with a kept word and still
  // hold a scrambled one ("Promoted • Xxxxxxxxxxx xxxx"), and scrambled labels from the appendix. One of them may be a
  // label whose words KEEP lacks.
  const BODY = '[data-testid="expandable-text-box"], .update-components-text, [data-view-name="feed-commentary"]';
  const scrambled = (w) => /^[xX][xX0]*$/.test(w);
  const suspects = new Set();
  const look = (root, untilBody) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (untilBody && n.parentElement?.closest(BODY)) break;
      const line = (n.nodeValue || '').trim();
      const ws = line.match(/[\p{L}\p{N}]+/gu) || [];
      if (!line || line.length > 40 || !ws.some(scrambled)) continue;
      if (!untilBody || (ws[0] && !scrambled(ws[0]) && !/^\d/.test(ws[0]))) suspects.add(line);
    }
  };
  for (const c of clones) look(c, true);
  for (const c of appendix) look(c, false);
  if (suspects.size)
    console.log(
      `Short header lines with scrambled words (is one a label KEEP lacks?):\n${[...suspects].slice(0, 30).join('\n')}`,
    );
  if (folded.length)
    console.log(`Left out ${folded.length} items unAlgorithm folded away. Turn unAlgorithm off for LinkedIn to capture them.`);

  const html = `<!-- captured ${new Date().toISOString().slice(0, 10)} lang=${document.documentElement.lang} -->
<main><div role="list" data-testid="mainFeed">
${clones.map((c) => c.outerHTML).join('\n')}
</div></main>
<div data-ua-external hidden>${appendix.map((c) => c.outerHTML).join('\n')}</div>`;
  await navigator.clipboard.writeText(html);
  alert(`Copied ${clones.length} anonymized feed items (${html.length.toLocaleString()} characters).`);
})();
