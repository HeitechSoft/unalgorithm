/**
 * Fictional feed cards in the structure of LinkedIn's 2026 feed markup: hashed class names, no URNs, each card a
 * [role=listitem] keyed "update-card-focus<opaque id>", a screen-reader "Feed post" heading, author in
 * "Open control menu for post by …", text in [data-testid=expandable-text-box], counts inside the action buttons.
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
