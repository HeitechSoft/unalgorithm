/**
 * Hand-built feed items modelled on LinkedIn's feed markup (2024–2026 class names). All names, organizations,
 * places and text are invented. `data-ua-block` marks elements that render as blocks, so the test innerText
 * polyfill splits lines the way Chrome does. Extend with anonymized captures from the live feed
 * (see scripts/capture/linkedin.js and docs/fixtures.md).
 */

function actor(opts: { name: string; href: string; degree?: string; headline?: string; sub: string; follow?: boolean }) {
  return `
  <div class="update-components-actor" data-ua-block>
    <a class="update-components-actor__meta-link" href="${opts.href}?miniProfileUrn=abc">
      <span class="update-components-actor__title" data-ua-block>
        <span dir="ltr"><span aria-hidden="true">${opts.name}</span><span class="visually-hidden">${opts.name}</span></span>
        ${opts.degree ? `<span class="update-components-actor__supplementary-actor-info"><span aria-hidden="true"> • ${opts.degree}</span></span>` : ''}
      </span>
      ${opts.headline ? `<span class="update-components-actor__description" data-ua-block><span aria-hidden="true">${opts.headline}</span></span>` : ''}
      <span class="update-components-actor__sub-description" data-ua-block><span aria-hidden="true">${opts.sub}</span></span>
    </a>
    ${opts.follow ? `<button class="update-components-actor__follow-button" aria-label="Follow ${opts.name}"><span>Follow</span></button>` : ''}
  </div>`;
}

function social(opts: { reactions?: string; comments?: string; reposts?: string }) {
  return `
  <div class="social-details-social-counts" data-ua-block>
    ${opts.reactions ? `<span class="social-details-social-counts__reactions-count">${opts.reactions}</span>` : ''}
    ${opts.comments ? `<button aria-label="${opts.comments} comments on post"><span>${opts.comments} comments</span></button>` : ''}
    ${opts.reposts ? `<button aria-label="${opts.reposts} reposts of post"><span>${opts.reposts} reposts</span></button>` : ''}
  </div>
  <div class="feed-shared-social-action-bar" data-ua-block>
    <button aria-label="React Like"><span>Like</span></button>
    <button aria-label="Comment"><span>Comment</span></button>
    <button aria-label="Repost" class="social-reshare-button"><span>Repost</span></button>
    <button aria-label="Send in a private message"><span>Send</span></button>
  </div>`;
}

function post(urn: string, inner: string) {
  return `<div data-id="${urn}" class="feed-item"><div class="feed-shared-update-v2" data-urn="${urn}">${inner}</div></div>`;
}

function text(t: string) {
  return `<div class="update-components-text" data-ua-block><span dir="ltr">${t}</span></div>`;
}

export const NORMAL_POST = post(
  'urn:li:activity:7001',
  actor({
    name: 'Priya Shah',
    href: 'https://www.linkedin.com/in/priyashah',
    degree: '1st',
    headline: 'COO at Maple Manufacturing',
    sub: '3h • Edited •',
  }) +
    text(
      'We rolled out an AI assistant to our 40-person shop floor team.<br>Biggest lesson: start with the boring paperwork, not the shiny stuff. What did your first AI win look like?',
    ) +
    social({ reactions: '128', comments: '14', reposts: '3' }),
);

export const PROMOTED_POST = post(
  'urn:li:activity:7002',
  actor({
    name: 'Acme Cloud',
    href: 'https://www.linkedin.com/company/acme-cloud/',
    headline: '45,210 followers',
    sub: 'Promoted',
    follow: true,
  }) +
    text('Cut your cloud bill by 40%. Book a demo today.') +
    social({ reactions: '12' }),
);

export const SUGGESTED_POST = post(
  'urn:li:activity:7003',
  `<div class="update-components-header" data-ua-block><span class="update-components-header__text-view">Suggested</span></div>` +
    actor({
      name: 'Gary Hustle',
      href: 'https://www.linkedin.com/in/garyhustle',
      degree: '3rd+',
      headline: 'Growth hacker',
      sub: '1d •',
      follow: true,
    }) +
    text('10 morning habits of billionaires. Number 7 will shock you.') +
    social({ reactions: '9,431', comments: '1.2K' }),
);

export const ACTIVITY_POST = post(
  'urn:li:activity:7004',
  `<div class="update-components-header" data-ua-block><span class="update-components-header__text-view"><a href="https://www.linkedin.com/in/janedoe">Jane Doe</a> likes this</span></div>` +
    actor({
      name: 'Sam Lee',
      href: 'https://www.linkedin.com/in/samlee',
      degree: '2nd',
      headline: 'VP People at Northwind',
      sub: '5h •',
      follow: true,
    }) +
    text('Hybrid work is here to stay. Here is how we redesigned onboarding for remote hires.') +
    social({ reactions: '57', comments: '6' }),
);

export const ACTIVITY_FOLLOWED_AUTHOR = post(
  'urn:li:activity:7005',
  `<div class="update-components-header" data-ua-block><span class="update-components-header__text-view"><a href="https://www.linkedin.com/in/janedoe">Jane Doe</a> commented on this</span></div>` +
    actor({
      name: 'Maria Lopez',
      href: 'https://www.linkedin.com/in/marialopez',
      degree: '1st',
      headline: 'HR Director',
      sub: '8h •',
    }) +
    text('What is the one HR process you would automate first?') +
    social({ reactions: '21', comments: '9' }),
);

export const CONNECTION_REPOST = post(
  'urn:li:activity:7006',
  `<div class="update-components-header" data-ua-block><span class="update-components-header__text-view"><a href="https://www.linkedin.com/in/janedoe">Jane Doe</a> reposted this</span></div>` +
    actor({
      name: 'Tech Weekly',
      href: 'https://www.linkedin.com/company/tech-weekly/',
      headline: '12,000 followers',
      sub: '2d •',
      follow: true,
    }) +
    text('The state of AI adoption in small businesses, 2026 edition.') +
    social({ reactions: '340', comments: '22' }),
);

export const EVENT_POST = post(
  'urn:li:activity:7007',
  actor({
    name: 'Example Tech Association',
    href: 'https://www.linkedin.com/company/example-tech-association/',
    headline: '8,900 followers',
    sub: '6h •',
  }) +
    text(
      'Join us for AI in Practice: a hands-on evening for small business leaders. Thursday Oct 22, 6:30pm at the Example Innovation Hub, Springfield. Register below.',
    ) +
    `<div class="update-components-event" data-ua-block>
       <a href="https://www.linkedin.com/events/7243000000000000001/?trk=feed"><span data-ua-block>AI in Practice: Small Business Night</span></a>
       <span data-ua-block>Thu, Oct 22, 2026, 6:30 PM EDT</span>
       <span data-ua-block>Example Innovation Hub, Springfield</span>
       <button><span>View</span></button>
     </div>` +
    social({ reactions: '44', comments: '3' }),
);

export const PYMK_MODULE = `<div class="feed-module" data-ua-block>
  <h2>People you may know</h2>
  <div data-ua-block>From your job title</div>
  <ul><li>Alex Kim <button aria-label="Invite Alex Kim to connect">Connect</button></li></ul>
</div>`;

export const NEW_LAYOUT_POST = `<div data-view-name="feed-full-update">
  <div data-ua-block><a href="https://www.linkedin.com/in/newlayout"><span data-ua-block>Robin Chen</span></a></div>
  <div data-ua-block>• 2nd</div>
  <div data-ua-block>Founder, Example Robotics</div>
  <div data-ua-block>4h •</div>
  <div data-ua-block>Hiring our first ML engineer in Springfield. The hardest part so far has been writing a job description that doesn't scare off generalists.</div>
  <a href="/feed/update/urn:li:activity:7010/">permalink</a>
  <div data-ua-block><button aria-label="Comment"><span>Comment</span></button></div>
</div>`;

export function feedHtml(...items: string[]): string {
  return `<main><div class="scaffold-finite-scroll__content">${items.join('\n')}</div></main>`;
}
