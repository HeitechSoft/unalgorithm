/*
 * unAlgorithm fixture capture for Facebook. Paste into DevTools on your Facebook home feed, scroll a little first.
 *
 * Copies anonymized HTML of the first N feed items to the clipboard:
 *  - every word is scrambled except Facebook's own UI labels (so detectors still see "Sponsored", "Follow"...) and
 *    relative ages ("2h", "about an hour ago", "Just now");
 *  - names, links, ids, images, videos, scripts and styles are removed or replaced with stable fakes;
 *  - elements the browser renders as blocks get data-ua-block, invisible ones data-ua-hidden (Facebook hides
 *    decoy letters inside labels), and labels referenced by aria-labelledby or <use href="#…"> are copied into an
 *    appendix;
 *  - items unAlgorithm folded away, and unAlgorithm's own elements, are left out: turn unAlgorithm off for Facebook
 *    to capture those items too.
 * Short header lines and labels that still have scrambled words are printed in the console (never copied): if one is
 * a label, add its words to KEEP. Paste the result into packages/platforms/fixtures/facebook/<date>-<what>.html and
 * run `pnpm fixtures:check`. Nothing is sent anywhere.
 */
(async () => {
  const N = Number(prompt('How many feed items?', '30')) || 30;
  /*
   * Facebook's own words, kept so detection still reads them. The capture-vocab test checks that every word of the
   * adapter's label patterns, panel titles, header sentences and ages is here.
   */
  const KEEP =
    /^(sponsored|ad|paid|partnership|with|suggested|for|you|post|posts|recommended|from|because|follow|following|like|viewed|join|group|groups|request|to|see|more|comment|share|send|reels?|and|short|videos?|people|may|know|stories|your|suggestions|in|pages|games|instant|marketplace|today|todays|s|picks|events|learn|shop|now|sign|up|commented|on|reacted|replied|was|tagged|mentioned|likes?|loves?|is|interested|answered|shared|this|a|an|memory|link|photo|event|public|friends|of|custom|only|me|add|friend|ago|about|just|yesterday|seconds?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|shop|learn|sign|up|book|download|get|offer|apply|install|contact|us|message|subscribe|watch|order|quote|directions|buy|tickets|menu|play|game|use|app|donate|listen)$/i;
  /** A relative age as one word ("2h", "3d"), kept so a post's age still reads as one. */
  const AGE = /^[0-9]{1,2} ?(s|m|h|d|w|mo|y|yr)$/i;
  /** A relative age in words, kept whole with its number ("9 hours ago"). */
  const AGE_PHRASE = /^[0-9]{1,2} (seconds?|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?) ago$/i;
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
  const scramble = (text) =>
    keep(text.trim()) || AGE_PHRASE.test(text.trim()) ? text : text.replace(/[\p{L}\p{N}]+/gu, (w) => (keep(w) ? w : fake(w)));
  const ids = new Map();
  const fakeId = (id) => {
    if (!ids.has(id)) ids.set(id, String(100000 + ids.size));
    return ids.get(id);
  };
  /** Element ids (and the aria-labelledby and <use> references to them) become stable opaque tokens. */
  const fakeToken = (id) => `id${fakeId(`#${id}`)}`;
  // Every path segment is rebuilt: Facebook's own route words stay, ids (numbers, pfbid…, a.123) get stable fakes,
  // and anything else (usernames, page names, hashtags) is scrambled, wherever it appears in the path.
  const FB_ROUTES = new Set(
    'groups posts permalink permalink.php story.php user reel reels videos video watch photo photo.php photos stories events hashtag profile.php ads about marketplace gaming pages media set share friends bookmarks notifications messages'.split(
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
    'aria-current',
    'href',
    'dir',
    'tabindex',
    'id',
    'data-ad-preview',
    'data-ad-comet-preview',
    'data-ad-rendering-role',
    'data-pagelet',
    'data-virtualized',
    'title',
    'width',
  ]);
  /** unAlgorithm's own marks on an item it folded away: such an item is skipped, it would capture as hidden. */
  const FOLDED = '[data-unalgo="hidden"], [data-unalgo="collapsed"], [data-unalgo-run="member"]';
  // Until 2026 the feed list was role="feed"; now it is the unlabelled block right after a screen-reader heading,
  // holding posts marked aria-posinset (the same rule as the adapter's heading-list strategy).
  const afterHeading = (el) => {
    let s = el.previousElementSibling;
    for (let i = 0; s && i < 3; i++, s = s.previousElementSibling) if (s.matches('h2, h3')) return true;
    return false;
  };
  const postList = () => {
    for (let el = document.querySelector('[role="main"] [aria-posinset]')?.parentElement; el; el = el.parentElement)
      if (afterHeading(el)) return el;
    return null;
  };
  const roleFeed = document.querySelector('[role="main"] [role="feed"]') || document.querySelector('[role="feed"]');
  const feed = roleFeed || postList();
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
    if (tag.startsWith('unalgo-')) return null;
    if (['script', 'style', 'img', 'video', 'image', 'path', 'noscript', 'iframe'].includes(tag)) return null;
    for (const a of Array.from(out.attributes)) if (!ALLOWED.has(a.name)) out.removeAttribute(a.name);
    if (out.hasAttribute('href') && tag !== 'use') out.setAttribute('href', cleanHref(src.getAttribute('href')));
    for (const attr of ['aria-label', 'title'])
      if (out.hasAttribute(attr)) out.setAttribute(attr, scramble(src.getAttribute(attr)));
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
      // Facebook draws "Ad" and post ages as a <use> of a <text> elsewhere in the page: keep the reference, under
      // the fake id, and copy the <text> into the appendix.
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
  const own = Array.from(feed.children).filter((el) => !el.tagName.toLowerCase().startsWith('unalgo-'));
  const folded = own.filter((el) => el.matches(FOLDED) || el.querySelector(FOLDED));
  const clones = own
    .filter((el) => !folded.includes(el))
    .slice(0, N)
    .map(clone);
  const rail = document.querySelector('[role="complementary"]');
  const railClone = rail ? clone(rail) : null;
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
  // hold a scrambled one ("Sponsored · Xxxx"), and scrambled labels from the appendix ("xxxxx xx xxxx xxx", an age).
  // One of them may be a label whose words KEEP lacks.
  const BODY = '[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]';
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
      `Short header lines and labels with scrambled words (is one a label KEEP lacks?):\n${[...suspects].slice(0, 30).join('\n')}`,
    );
  if (folded.length)
    console.log(`Left out ${folded.length} items unAlgorithm folded away. Turn unAlgorithm off for Facebook to capture them.`);

  const html = `<!-- captured ${new Date().toISOString().slice(0, 10)} lang=${document.documentElement.lang} -->
<div role="main">${roleFeed ? '<div role="feed">' : '<div><h3>Feed posts</h3><div aria-hidden="true"></div><div>'}
${clones.map((c) => c.outerHTML).join('\n')}
${roleFeed ? '</div>' : '</div></div>'}</div>
${railClone ? railClone.outerHTML : ''}
<div data-ua-external hidden>${appendix.map((c) => c.outerHTML).join('\n')}</div>`;
  await navigator.clipboard.writeText(html);
  alert(`Copied ${clones.length} anonymized feed items (${html.length.toLocaleString()} characters).`);
})();
