/**
 * Fictional feed cards in the structure of LinkedIn's 2026 feed markup: hashed class names, no URNs, each card a
 * [role=listitem] keyed "update-card-focus<opaque id>", a screen-reader "Feed post" heading, author in
 * "Open control menu for post by …", text in [data-testid=expandable-text-box], counts inside the action buttons.
 *
 * The "For you" feed (/feed/foryou/, 2026-10; see the captures 2026-10-foryou-*.html) is the same markup with small
 * changes: each card key ends with the feed's sort ("…FeedType_MAIN_FEED_RELEVANCE"), the card sits in one more
 * div[componentkey] wrapper, the text box is a span inside a p, and the feed list also holds items that are not cards
 * (the "Start a post" box, the "Sort by" control, a "New posts" button). Ads can run as a person's post, labelled
 * "Promoted • Partnership with LinkedIn", and people you follow without being connected show "• Following" in place
 * of the degree.
 *
 * Every name, headline, group, company, post text and count here is invented. Never paste real feed content into
 * these builders; capture real layouts with scripts/capture/linkedin.js, which scrambles all text.
 */

function card(key: string, inner: string) {
  return `<div data-lazy-mount-id="${key}"><div data-display-contents="true"><div>
  <div role="listitem" componentkey="update-card-focus${key}" class="e0sle3 e0suf">
    <div data-display-contents="true"><div class="e0skq4">
      <h2>Feed post</h2>
      ${inner}
    </div></div>
    <div class="e0sgrid"></div>
  </div></div></div></div>`;
}

function header(before: string, who: string, after: string, slug: string) {
  return `<div class="e0shdr"><p><span>${before}<a href="https://www.linkedin.com/in/${slug}/" aria-label="View ${who}’s profile">${who}</a>${after}</span></p></div>`;
}

function actor(o: {
  name: string;
  slug: string;
  kind?: 'in' | 'company';
  degree?: string;
  badge?: string;
  sub: string;
  age: string;
  follow?: boolean;
  extra?: string;
}) {
  const kind = o.kind ?? 'in';
  const label = `${o.name}${o.badge ? ` ${o.badge}` : ''}${o.degree ? ` ${o.degree}` : ''}`;
  const view = kind === 'in' ? `View ${o.name}’s profile` : `View company: ${o.name}`;
  return `<div class="e0sactor">
    <a href="https://www.linkedin.com/${kind}/${o.slug}/" aria-label="${view}"><svg aria-label="${view}"></svg></a>
    <div aria-label="${label}">
      <a href="https://www.linkedin.com/${kind}/${o.slug}/"><p>${o.name}</p></a>
      ${o.degree ? `<p>• ${o.degree}</p>` : ''}
      <p>${o.sub}</p>
      ${o.extra ? `<p>${o.extra}</p>` : ''}
      <p>${o.age}</p>
    </div>
    ${o.follow ? `<button type="button" aria-label="Follow ${o.name}"><span><span>Follow</span></span></button>` : ''}
    <button aria-label="Open control menu for post by ${o.name}"></button>
    <button aria-label="Hide post by ${o.name}"></button>
  </div>`;
}

function body(text: string) {
  // As on the live site: the full text is in the DOM (clamped with CSS) and the "… more" button sits inside the box.
  return `<div data-testid="expandable-text-box"><span>${text}</span><button data-testid="expandable-text-button">… more</button></div>`;
}

function actions(r: string, c: string, s: string) {
  return `<div class="e0sbar">
    <button aria-label="Reaction button state: no reaction"><span><span>${r}</span></span></button>
    <button aria-label="Open reactions menu"></button>
    <button aria-label="Comment"><span><span>${c}</span></span></button>
    <button aria-label="Repost"><span><span>${s}</span></span></button>
    <a href="https://www.linkedin.com/" aria-label="Send">Send</a>
  </div>`;
}

export const FOLLOWED_BY_POST = card(
  'AAAkeyFollowedBy01',
  header('Followed by ', 'Pat Morgan', '', 'pat-morgan') +
    actor({
      name: 'Riley Quinn',
      slug: 'riley-quinn',
      degree: '2nd',
      badge: 'Premium Profile',
      sub: 'Founder @ Example Labs',
      extra: 'Visit my website',
      age: '22h • Edited •',
      follow: true,
    }) +
    body('Small teams can ship fast. Here is how we cut our release cycle from a month to a week.') +
    actions('214', '31', '9'),
);

export const PROMOTED_FOLLOWS_PAGE = card(
  'BBBkeyPromoted0002',
  header('', 'Sam Lee', ' follows this page', 'sam-lee') +
    actor({
      name: 'Northwind Analytics',
      slug: 'northwind-analytics',
      kind: 'company',
      sub: '12,400 followers',
      age: 'Promoted',
    }) +
    body('Turn spreadsheets into dashboards in minutes. Start a free trial today.') +
    actions('23', '4', '1'),
);

export const LIKES_GROUP_POST = card(
  'CCCkeyGroupPost003',
  header('', 'Casey Brooks', ' likes this', 'casey-brooks') +
    `<div class="e0sactor">
      <a href="https://www.linkedin.com/groups/123/" aria-label="View group: Example Woodworking Club"><p>Example Woodworking Club</p></a>
      <div aria-label="Jordan Blake Verified Profile 2nd"><p>Jordan Blake • 2nd</p></div>
      <p>Oct 5 •</p>
      <button aria-label="Join group">Join</button>
      <button aria-label="Open control menu for post by Jordan Blake"></button>
    </div>` +
    body('Finished my first walnut side table this weekend. Feedback welcome.') +
    actions('86', '12', '3'),
);

/** A 1st-degree connection posting (their own post, reshared) into a group. No header line. */
function groupPost(key: string, joined: boolean) {
  return card(
    key,
    `<div class="e0sactor">
      <a href="https://www.linkedin.com/groups/9876/" aria-label="View group: Example Product Guild"><p>Example Product Guild</p></a>
      <div aria-label="Avery Stone Verified Profile 1st"><p>Avery Stone • 1st</p></div>
      <p>Just now •</p>
      ${joined ? '' : '<button aria-label="Join Example Product Guild"><span>Join</span></button>'}
      <button aria-label="Open control menu for post by Avery Stone"></button>
    </div>` +
      body('Our team tried no-meeting Wednesdays for a quarter. Here is what changed.') +
      `<div>${actor({ name: 'Avery Stone', slug: 'avery-stone', degree: '1st', sub: 'Product Manager', age: '7h •' })}${body(
        'Writing things down replaced most of the meetings we dropped.',
      )}</div>` +
      actions('5', '1', '0'),
  );
}
export const UNJOINED_GROUP_POST = groupPost('HHHkeyGroupNotIn01', false);
export const JOINED_GROUP_POST = groupPost('IIIkeyGroupJoined1', true);

export const HIRING_PROMO = card(
  'DDDkeyHiringPromo4',
  `<div><p>See who's hiring</p><p>Alex, find a company that needs your skills</p><a href="/jobs/">Search jobs</a></div>`,
);

export const FIRST_DEGREE_POST = card(
  'EEEkeyFirstDegree5',
  actor({
    name: 'Morgan Ellis',
    slug: 'morgan-ellis',
    degree: '1st',
    badge: 'Verified Profile',
    sub: 'HR Director at Northwind Clinics',
    age: 'Yesterday •',
  }) +
    body('Which HR task would you automate first if you had an AI assistant for a month?') +
    actions('27', '11', '2'),
);

export const COMPANY_NOT_FOLLOWED = card(
  'FFFkeyCompanyNF006',
  actor({
    name: 'Example Robotics',
    slug: 'example-robotics',
    kind: 'company',
    sub: 'Visit website',
    age: 'Oct 6 •',
    follow: true,
  }) +
    body('Our warehouse robot can now restack returned parcels on its own. Demo video inside.') +
    actions('58', '6', '4'),
);

/** An ad run as a person's post on the "For you" feed: no age, "Promoted • Partnership with LinkedIn" instead. */
export const PARTNERSHIP_AD = card(
  'JJJkeyPartnerAd01FeedType_MAIN_FEED_RELEVANCE',
  actor({
    name: 'Dana Whitfield',
    slug: 'dana-whitfield',
    degree: '3rd+',
    badge: 'Verified Profile',
    sub: 'Growth Advisor | Example Consulting',
    age: '<span>Promoted • Partnership with<span> </span><a href="https://www.linkedin.com/company/linkedin/posts/" aria-label="View company: LinkedIn"><strong>LinkedIn</strong></a></span>',
    follow: true,
  }) +
    body('Three questions to ask before you hire your first salesperson. A short guide for founders.') +
    actions('41', '7', '3'),
);

/** Someone you follow without being connected: "• Following" where the degree would be, and no Follow button. */
export const FOLLOWING_POST = card(
  'KKKkeyFollowing01FeedType_MAIN_FEED_RELEVANCE',
  actor({
    name: 'Jamie Okafor',
    slug: 'jamie-okafor',
    degree: 'Following',
    badge: 'Verified Profile',
    sub: 'Author, Example Press',
    age: '3d •',
  }) +
    body('Notes from a week of writing without a phone in the room: shorter drafts, fewer rewrites.') +
    actions('132', '18', '6'),
);

function comment(author: string, degree: string, text: string) {
  return `<div><div data-display-contents="true">
    <a href="https://www.linkedin.com/in/${author.toLowerCase().replace(/\W+/g, '-')}/"><p>${author} ${degree}</p></a>
    <button aria-label="View more options for ${/s$/.test(author) ? `${author}’` : `${author}’s`} comment."></button>
    ${body(text)}
    <button aria-label="Open reactions menu"></button><button aria-label="Reply">Reply</button>
  </div></div>`;
}

/** A post whose comment section is open: comments are flat items in a "commentList", as in the live markup. */
export const POST_WITH_COMMENTS = card(
  'GGGkeyWithComments',
  actor({
    name: 'Morgan Ellis',
    slug: 'morgan-ellis',
    degree: '1st',
    badge: 'Verified Profile',
    sub: 'HR Director at Northwind Clinics',
    age: '5h •',
  }) +
    body('We moved our onboarding forms online and cut the paperwork from three days to one. What should we automate next?') +
    actions('27', '11', '2') +
    `<div data-testid="EgsIgMC33-commentListGGGkeyWithComments" data-component-type="LazyColumn">
      <div></div>
      ${comment('Pat Lee', '• 2nd', 'Benefits enrolment took us the most time after onboarding. Automating it saved a day a month.')}
      <div><button>See previous replies</button></div>
      ${comment('Sam Rivera', '• 3rd+', 'Pat Lee agreed. Reminders to managers were the easy win for us.')}
      ${comment('Chris Novak', '• 2nd', 'Same here, and payroll changes came next.')}
      <div></div>
    </div>
    <div aria-label="Text editor for creating comment" role="textbox" contenteditable="true" class="tiptap ProseMirror"></div>`,
);

export function feed2026(...cards: string[]): string {
  return `<main><section aria-label="Primary content"><div role="list" data-testid="mainFeed">
    <div role="listitem"><div aria-label="Start a post">Start a post</div></div>
    ${cards.join('\n')}
    <div class="load-more-marker"></div>
  </div></section></main>`;
}

/** LinkedIn's global navigation as a signed-in member sees it: links to My Network, Messaging and Notifications. */
const MEMBER_NAV = `<header><nav aria-label="Primary Navigation"><ul>
  <li><a href="https://www.linkedin.com/feed/">Home</a></li>
  <li><a href="https://www.linkedin.com/mynetwork/">My Network</a></li>
  <li><a href="https://www.linkedin.com/jobs/">Jobs</a></li>
  <li><a href="https://www.linkedin.com/messaging/">Messaging</a></li>
  <li><a href="https://www.linkedin.com/notifications/">Notifications</a></li>
</ul></nav></header>`;

/** The guest navigation of LinkedIn's public pages: articles, people, learning and jobs, then join or sign in. */
const GUEST_NAV = `<header><nav><ul>
  <li><a href="https://www.linkedin.com/pulse/topics/home/">Articles</a></li>
  <li><a href="https://www.linkedin.com/pub/dir/">People</a></li>
  <li><a href="https://www.linkedin.com/learning/">Learning</a></li>
  <li><a href="https://www.linkedin.com/jobs/">Jobs</a></li>
</ul><a href="https://www.linkedin.com/signup/">Join now</a><a href="https://www.linkedin.com/login/">Sign in</a></nav></header>`;

/** A page body inside the signed-in shell. */
export const signedInShell = (main: string) => `${MEMBER_NAV}${main}`;
/** A page body inside the logged-out shell (the guest home page, a sign-in or consent page). */
export const guestShell = (main: string) => `${GUEST_NAV}${main}`;

/** A member's profile: sections and a short activity list, no feed list and no main-feed card keys. */
export const PROFILE_PAGE = `<main><section><h1>Morgan Ellis</h1><p>HR Director at Northwind Clinics</p>
  <a href="https://www.linkedin.com/messaging/compose/">Message</a></section>
  <section><h2>About</h2><p>Twenty years in people operations.</p></section>
  <section><h2>Activity</h2><ul><li>${FIRST_DEGREE_POST}</li></ul></section></main>`;
