/**
 * The classify eval set: 30 labelled posts an AI route must classify well enough before a server uses it (R20). Every
 * text is invented for this file, never a real post with the names changed, and holds no names of real people or
 * companies, no links, handles, emails or phone numbers. A shared link names only a reserved example domain.
 *
 * Labels are what any careful reader would agree on: `high` posts are substantive and squarely on one of the profile's
 * interests, `low` posts are off-topic, about crypto (which the profile wants less of) or generic inspiration. Noise is
 * expected only where it is blatant; `notNoise` lists labels a post plainly does not deserve.
 */
import type { InterestProfile, NoiseLabel, PostForAI } from '@unalgorithm/protocol';

export interface EvalItem {
  /** 'e01' to 'e30', also the post's ref in the eval's requests. */
  id: string;
  post: Omit<PostForAI, 'ref'>;
  expect: { relevance: 'high' | 'low'; noise: NoiseLabel[]; notNoise: NoiseLabel[] };
}

/** The profile every eval post is classified against. */
export const EVAL_PROFILE: InterestProfile = {
  v: 1,
  interests: ['cloud costs', 'hiring', 'ai agents', 'local food'],
  lessOf: ['crypto'],
  about: '',
  examples: [],
};

type EvalPost = EvalItem['post'];

function linkedin(text: string, more: Partial<EvalPost> = {}): EvalPost {
  return { platform: 'linkedin', text, textComplete: true, authorKind: 'person', isReshare: false, media: 'none', ...more };
}

/** Facebook posts in the set are public: a server never sees any other kind (R23). */
function facebook(text: string, more: Partial<EvalPost> = {}): EvalPost {
  return { ...linkedin(text, more), platform: 'facebook', audience: 'public' };
}

/** The labels no substantive post deserves. */
const MANIPULATIVE: NoiseLabel[] = ['engagement-bait', 'rage-bait', 'clickbait'];

function high(notNoise: NoiseLabel[] = MANIPULATIVE): EvalItem['expect'] {
  return { relevance: 'high', noise: [], notNoise: [...notNoise] };
}

function low(noise: NoiseLabel[], notNoise: NoiseLabel[] = []): EvalItem['expect'] {
  return { relevance: 'low', noise, notNoise };
}

export const EVAL_SET: readonly EvalItem[] = [
  // High: substantive posts on the four interests.
  {
    id: 'e01',
    post: linkedin(
      'We cut our monthly cloud bill by 38 percent in one quarter. Three changes did most of the work: nightly batch jobs moved to spot instances, orphaned storage volumes that no team owned were deleted, and every team got a budget with an alert at 80 percent. The surprise was data transfer between regions, which turned out to be a fifth of the whole bill.',
    ),
    expect: high(),
  },
  {
    id: 'e02',
    post: linkedin(
      'A practical note on reserved capacity: commit only to the baseline you have actually run for six months, never to the peak. We kept on-demand pricing for the top 30 percent of our load and saved more this year than last year, when we over-committed and paid for reservations that sat unused.',
    ),
    expect: high(),
  },
  {
    id: 'e03',
    post: linkedin(
      'Our finance and engineering leads now review cloud spend together every week. Each service owner sees cost per thousand requests next to latency, so the trade-offs are visible before anyone asks for a bigger cluster. Writing up the template we use, since tagging discipline mattered far more than any cost tool we bought.',
      { authorKind: 'page', media: 'link', link: { domain: 'example.org', title: 'Cost per request as a team metric' } },
    ),
    expect: high(),
  },
  {
    id: 'e04',
    post: linkedin(
      'We changed how we hire junior engineers this year. Instead of a timed puzzle, candidates pair with one of our engineers for an hour on a small bug in a real codebase, and we pay them for that hour. Offer acceptance went up, and the notes from candidates we did not hire have been far kinder than before.',
    ),
    expect: high(),
  },
  {
    id: 'e05',
    post: linkedin(
      'Hiring managers: write the plan for the first ninety days before you write the job description. When we did it in that order, the list of requirements shrank from fourteen bullet points to five, and twice as many people applied who had never applied to us before.',
    ),
    expect: high(),
  },
  {
    id: 'e06',
    post: linkedin(
      'Six months after dropping degree requirements from our engineering roles, here is what changed. The applicant pool doubled, interview pass rates stayed the same, and new hires from bootcamps ramped up as quickly as everyone else. The hard part was retraining interviewers to stop asking where people went to school.',
    ),
    expect: high(),
  },
  {
    id: 'e07',
    post: linkedin(
      'For a month we put an AI agent in front of our internal ticket queue. For simple configuration bugs it drafts a fix plan and opens a pull request, and a person approves every change. It resolved about one ticket in five with no edits. Most failures were tickets that needed context from a meeting nobody had written down.',
    ),
    expect: high(),
  },
  {
    id: 'e08',
    post: linkedin(
      'Worth sharing for anyone evaluating AI agents: test the tools an agent calls, not only its final answer. Ours once passed every answer check while it quietly retried a failing lookup forty times. Logging each tool call with its cost and duration changed how we review agent runs.',
      { isReshare: true },
    ),
    expect: high(),
  },
  {
    id: 'e09',
    post: linkedin(
      'Lessons from six months of running coding agents in our build pipeline: give each agent a small sandbox, a time budget and an explicit list of commands it may run. Agents that could install packages freely broke builds in ways that took longer to debug than the original task. Slides from our internal talk attached.',
      { media: 'document' },
    ),
    expect: high(),
  },
  {
    id: 'e10',
    post: facebook(
      'From this Saturday the farmers market moves indoors for the winter. Twelve growers from within thirty miles will be there with squash, apples, goat cheese and fresh bread, and the bakery stall now takes orders ahead so you can skip the line. Bring your own bags.',
      { authorKind: 'page', media: 'image' },
    ),
    expect: high(),
  },
  {
    id: 'e11',
    post: facebook(
      'Tried the new community kitchen on the east side of town today. Every dish uses vegetables from farms in the valley, and the menu changes with whatever was harvested that week. The lentil soup with roasted carrots was the best thing I have eaten this month, and lunch for two came to under twenty dollars.',
      { media: 'image' },
    ),
    expect: high(),
  },
  {
    id: 'e12',
    post: linkedin(
      'Our school district now buys a third of its produce from farms within fifty miles. The cost per meal rose by eleven cents, the farms gained a buyer they can plan a whole year around, and plate waste dropped because children eat more of the fruit when it is fresh. The full report from the pilot year is out.',
      { media: 'link', link: { domain: 'example.net', title: 'Farm to school: results of the pilot year' } },
    ),
    expect: high(),
  },

  // Low: off-topic, crypto and generic inspiration, most of it noise.
  {
    id: 'e13',
    post: linkedin(
      'Our new token launches next week and early holders get a bonus allocation. The whitepaper explains how staking rewards grow your position every month. Join the presale list today, spots are limited.',
      { authorKind: 'page' },
    ),
    expect: low(['promotional']),
  },
  {
    id: 'e14',
    post: linkedin(
      'Crypto charts are lining up exactly like the last cycle. If you are not positioned before the next halving, you will be watching from the sidelines again. Not financial advice.',
    ),
    expect: low([]),
  },
  {
    id: 'e15',
    post: facebook('Type YES if you made it through this week. Share this with five friends who need a smile today.', {
      authorKind: 'page',
      media: 'image',
    }),
    expect: low(['engagement-bait'], ['promotional']),
  },
  {
    id: 'e16',
    post: linkedin(
      'Success is not about how many times you fall. It is about how many times you get back up. Keep going. Your future self will thank you.',
    ),
    expect: low(['low-effort'], ['promotional', 'rage-bait']),
  },
  {
    id: 'e17',
    post: linkedin(
      'I almost quit my job last Tuesday. What my manager said next changed everything, and it is not what you think.',
      {
        textComplete: false,
      },
    ),
    expect: low(['clickbait'], ['promotional']),
  },
  {
    id: 'e18',
    post: linkedin(
      'People who still work from home are lazy, and everyone knows it. Real professionals show up to the office. If this offends you, you are part of the problem.',
    ),
    expect: low(['rage-bait'], ['promotional']),
  },
  {
    id: 'e19',
    post: linkedin(
      'My five-week course on personal branding opens tomorrow. Learn the exact posting schedule that grew my audience, with templates and weekly live sessions. The early-bird price ends on Friday.',
    ),
    expect: low(['promotional'], ['rage-bait']),
  },
  {
    id: 'e20',
    post: facebook(
      'You will not believe what this old garden shed looked like after one weekend. Number seven made the whole family cry.',
      {
        authorKind: 'page',
        media: 'image',
      },
    ),
    expect: low(['clickbait'], ['rage-bait']),
  },
  {
    id: 'e21',
    post: linkedin(
      'Agree? The best leaders listen more than they speak. Comment YES if you agree and repost this to your network.',
    ),
    expect: low(['engagement-bait'], ['promotional']),
  },
  {
    id: 'e22',
    post: facebook(
      'Our neighborhood choir sings at the library on Sunday afternoon. We have been rehearsing old folk songs since the spring, and our youngest singer is nine years old.',
      { authorKind: 'group' },
    ),
    expect: low([], ['rage-bait', 'clickbait']),
  },
  {
    id: 'e23',
    post: linkedin(
      'A quick tip for spreadsheet users: freeze the header row before sorting a large table, and keep the raw data on its own sheet so your formulas never point at a moving target.',
    ),
    expect: low([], ['rage-bait', 'engagement-bait', 'clickbait']),
  },
  {
    id: 'e24',
    post: linkedin(
      'Our firm has opened a new tax advisory office in the harbor district. Book a consultation today to get your year-end planning done early.',
      { authorKind: 'page' },
    ),
    expect: low(['promotional'], ['rage-bait']),
  },
  {
    id: 'e25',
    post: linkedin(
      'Three reasons decentralized finance will replace banks within five years: no middlemen, open access and programmable money. The old system is already crumbling.',
    ),
    expect: low([]),
  },
  {
    id: 'e26',
    post: facebook('Be the reason someone smiles today. Kindness costs nothing. Good morning, everyone.', { media: 'image' }),
    expect: low(['low-effort'], ['promotional']),
  },
  {
    id: 'e27',
    post: linkedin(
      'Every manager who sends messages on a weekend is destroying their team and should be ashamed. This whole industry is broken, and nobody else has the courage to say it.',
    ),
    expect: low(['rage-bait'], ['promotional']),
  },
  {
    id: 'e28',
    post: linkedin(
      'Ten habits of highly successful people: wake up early, read every day, drink water, set goals, stay positive, exercise, network, say no, keep learning, never give up.',
    ),
    expect: low(['low-effort'], ['rage-bait']),
  },
  {
    id: 'e29',
    post: linkedin(
      'Notes from a weekend bookbinding workshop: use a bone folder for crisp folds, wax the thread before sewing the signatures, and let the glue cure under a stack of heavy books overnight.',
    ),
    expect: low([], ['rage-bait', 'engagement-bait']),
  },
  {
    id: 'e30',
    post: linkedin(
      'Drop your wallet address in the comments and I will send a free token to the first hundred people. Like and repost so others see this.',
    ),
    expect: low(['engagement-bait']),
  },
];
