import type { FilterDecision, PostData } from '@unalgorithm/core';
import { noiseName } from '@unalgorithm/core';
import type { PlatformId } from '@unalgorithm/protocol';

export type WhyActionId =
  | 'show'
  | 'always-show-author'
  | 'stop-hiding'
  | 'unmute-topic'
  | 'not-bait'
  | 'want-like-this'
  | 'settings'
  | 'report';

export interface WhyModel {
  title: string;
  body: string;
  /** "What we saw": the evidence, in plain words. */
  saw?: string;
  footnote: string;
  actions: { id: WhyActionId; label: string }[];
}

const SITE: Record<PlatformId, string> = { linkedin: 'LinkedIn', facebook: 'Facebook' };

/** Plain-language explanation for a hidden post, with the quick fixes that make sense for that reason. */
export function whyCopy(d: FilterDecision, post: PostData | undefined, platform: PlatformId, preset: string): WhyModel {
  const site = SITE[platform];
  const who = post?.author.name;
  const author = who ?? 'this author';
  const always = who ? [{ id: 'always-show-author' as const, label: `Always show ${who}` }] : [];
  const rule = `Rule · ${preset[0]?.toUpperCase()}${preset.slice(1)} on ${site}`;
  switch (d.reason) {
    case 'sponsored':
      return {
        title: platform === 'facebook' ? 'Sponsored post' : 'Promoted post',
        body: `${who ?? 'An advertiser'} paid ${site} to show you this post.`,
        saw: `Labelled "${platform === 'facebook' ? 'Sponsored' : 'Promoted'}"`,
        footnote: rule,
        actions: [
          { id: 'show', label: 'Show this post' },
          { id: 'stop-hiding', label: 'Stop hiding ads' },
        ],
      };
    case 'suggested':
      return {
        title: `Suggested by ${site}`,
        body: `It's from ${author}, who you don't follow. ${site} adds suggestions to fill out your feed.`,
        saw: `Labelled "${post?.contextLine ?? 'Suggested'}"`,
        footnote: rule,
        actions: [
          { id: 'show', label: 'Show this post' },
          ...always,
          { id: 'stop-hiding', label: 'Stop hiding suggested posts' },
        ],
      };
    case 'network-activity':
      return {
        title: post?.contextLine ?? 'Activity from your network',
        body: `You don't follow ${author}. It's in your feed because someone you know reacted to it.`,
        ...(post?.contextLine ? { saw: `Header "${post.contextLine}"` } : {}),
        footnote: rule,
        actions: [
          { id: 'show', label: 'Show this post' },
          ...always,
          { id: 'stop-hiding', label: 'Stop hiding network activity' },
        ],
      };
    case 'reshare':
      return {
        title: 'A repost',
        body: 'Someone you follow reposted this. You asked to hide reposts.',
        ...(post?.contextLine ? { saw: `Header "${post.contextLine}"` } : {}),
        footnote: rule,
        actions: [
          { id: 'show', label: 'Show this post' },
          { id: 'stop-hiding', label: 'Stop hiding reposts' },
        ],
      };
    case 'unjoined-group':
      return {
        title: post?.group?.name ? `Posted in ${post.group.name}` : 'From a group',
        body: "You're not a member of this group.",
        saw: 'A Join button on the post',
        footnote: rule,
        actions: [
          { id: 'show', label: 'Show this post' },
          { id: 'stop-hiding', label: 'Stop hiding other groups' },
        ],
      };
    case 'reel':
      return {
        title: 'A Reel',
        body: 'Short videos are hidden in Calm.',
        footnote: rule,
        actions: [
          { id: 'show', label: 'Show this post' },
          { id: 'stop-hiding', label: 'Stop hiding Reels' },
        ],
      };
    case 'not-followed':
      return {
        title: `You don't follow ${author}`,
        body: 'This strength shows only people and pages you follow.',
        saw: `A Follow button next to ${author}`,
        footnote: rule,
        actions: [{ id: 'show', label: 'Show this post' }, ...always, { id: 'stop-hiding', label: "Show people I don't follow" }],
      };
    case 'module':
      return {
        title: d.module?.title ?? 'A feed panel',
        body: `A ${site} feature panel, not a post.`,
        footnote: rule,
        actions: [
          { id: 'show', label: 'Show this panel' },
          { id: 'stop-hiding', label: 'Stop hiding feed panels' },
        ],
      };
    case 'always-hide':
      return {
        title: `You hide posts from ${author}`,
        body: 'You added this author to Always hide.',
        footnote: 'Your exceptions',
        actions: [
          { id: 'show', label: 'Show this post' },
          { id: 'settings', label: 'Edit exceptions' },
        ],
      };
    case 'muted-keyword':
      return {
        title: 'Matches a topic you muted',
        body: d.topic
          ? `It mentions "${d.keyword}", which is in Less of: ${d.topic}.`
          : `It mentions "${d.keyword}", which you muted.`,
        saw: `Matched "${d.keyword}"`,
        footnote: 'Your interests',
        actions: [
          { id: 'show', label: 'Show this post' },
          ...(d.topic ? [{ id: 'unmute-topic' as const, label: `Unmute ${d.topic}` }] : []),
          { id: 'settings', label: 'Edit muted topics' },
        ],
      };
    case 'less-like-this':
      return {
        title: 'You asked for less like this',
        body: 'UnAlgorithm will show fewer posts like this one.',
        footnote: 'Your feedback',
        actions: [{ id: 'show', label: 'Show this post' }],
      };
    case 'noise': {
      const label = d.noise?.[0];
      const name = label ? noiseName(label) : 'Noise';
      const bodies: Record<string, string> = {
        'engagement-bait': 'It asks people to react or comment so it spreads further.',
        'rage-bait': 'It looks designed to provoke anger.',
        clickbait: 'It holds back the point to make you click.',
        promotional: 'It is mostly selling something.',
        'low-effort': 'It looks like generic or recycled filler.',
      };
      return {
        title: `Looks like ${name.toLowerCase()}`,
        body: (label && bodies[label]) ?? 'AI flagged it as noise.',
        saw: 'AI · can be wrong',
        footnote: 'AI filter',
        actions: [
          { id: 'show', label: 'Show this post' },
          { id: 'not-bait', label: `This isn't ${name.toLowerCase()}` },
          { id: 'stop-hiding', label: `Stop hiding ${name.toLowerCase()}` },
        ],
      };
    }
    case 'low-relevance':
      return {
        title: 'Probably off-topic for you',
        body: 'AI read this as unrelated to your interests.',
        saw: 'AI · can be wrong',
        footnote: 'AI filter',
        actions: [
          { id: 'show', label: 'Show this post' },
          { id: 'want-like-this', label: 'I want posts like this' },
          { id: 'stop-hiding', label: 'Stop hiding off-topic posts' },
        ],
      };
  }
}
