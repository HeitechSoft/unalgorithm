/**
 * Starter topics offered in onboarding and Settings → Interests, in one list where the person marks any topic More or
 * Less. Each ships a hand-picked English keyword list so "For you" highlights and muting work without any AI; with AI on,
 * the labels go to the model as the user's interests.
 */
export interface StarterTopic {
  id: string;
  label: string;
  group: 'work' | 'life' | 'less';
  keywords: string[];
}

export const STARTER_TOPICS: StarterTopic[] = [
  {
    id: 'ai-tech',
    label: 'AI & tech',
    group: 'work',
    keywords: [
      'AI',
      'artificial intelligence',
      'LLM',
      'machine learning',
      'ChatGPT',
      'Claude',
      'Gemini',
      'Copilot',
      'AI agents',
      'automation',
      'generative AI',
    ],
  },
  {
    id: 'software',
    label: 'Software development',
    group: 'work',
    keywords: [
      'software',
      'developer',
      'developers',
      'programming',
      'code',
      'coding',
      'TypeScript',
      'Python',
      'open source',
      'DevOps',
      'API',
    ],
  },
  {
    id: 'startups',
    label: 'Startups',
    group: 'work',
    keywords: ['startup', 'startups', 'founder', 'founders', 'seed round', 'venture capital', 'VC', 'pitch', 'accelerator'],
  },
  {
    id: 'small-business',
    label: 'Small business',
    group: 'work',
    keywords: ['small business', 'SMB', 'SME', 'SMEs', 'entrepreneur', 'local business', 'owner-operated'],
  },
  {
    id: 'leadership',
    label: 'Leadership',
    group: 'work',
    keywords: ['leadership', 'leaders', 'management', 'manager', 'managers', 'culture', 'team building', 'CEO'],
  },
  {
    id: 'careers',
    label: 'Careers & hiring',
    group: 'work',
    keywords: ['hiring', 'job', 'jobs', 'career', 'careers', 'recruiting', 'interview', 'resume', 'we are hiring'],
  },
  {
    id: 'marketing',
    label: 'Marketing & sales',
    group: 'work',
    keywords: ['marketing', 'sales', 'brand', 'branding', 'SEO', 'content marketing', 'B2B', 'customers', 'pipeline'],
  },
  {
    id: 'finance',
    label: 'Finance & economy',
    group: 'work',
    keywords: ['economy', 'inflation', 'interest rates', 'markets', 'finance', 'investing', 'GDP', 'recession', 'budget'],
  },
  {
    id: 'science-health',
    label: 'Science & health',
    group: 'life',
    keywords: ['science', 'research', 'study', 'health', 'medicine', 'medical', 'vaccine', 'nutrition', 'mental health'],
  },
  {
    id: 'climate',
    label: 'Climate & energy',
    group: 'life',
    keywords: ['climate', 'energy', 'solar', 'wind power', 'emissions', 'carbon', 'EV', 'electric vehicle', 'sustainability'],
  },
  {
    id: 'local',
    label: 'Local news & events',
    group: 'life',
    keywords: ['local', 'community', 'city council', 'event', 'events', 'meetup', 'neighbourhood', 'neighborhood'],
  },
  {
    id: 'family',
    label: 'Family & parenting',
    group: 'life',
    keywords: ['family', 'parenting', 'parents', 'kids', 'children', 'baby', 'school'],
  },
  {
    id: 'food',
    label: 'Food & cooking',
    group: 'life',
    keywords: ['food', 'recipe', 'recipes', 'cooking', 'baking', 'restaurant', 'dinner'],
  },
  {
    id: 'travel',
    label: 'Travel & outdoors',
    group: 'life',
    keywords: ['travel', 'trip', 'hiking', 'camping', 'outdoors', 'vacation', 'road trip'],
  },
  {
    id: 'sports',
    label: 'Sports & fitness',
    group: 'life',
    keywords: ['sports', 'game', 'fitness', 'workout', 'running', 'hockey', 'soccer', 'basketball', 'gym'],
  },
  {
    id: 'arts',
    label: 'Arts, books & film',
    group: 'life',
    keywords: ['art', 'artist', 'book', 'books', 'reading', 'film', 'movie', 'music', 'museum'],
  },
];

/**
 * Topics many people want less of, listed after `STARTER_TOPICS`. Any topic can be marked either way; marked Less, posts
 * that mention its keywords are hidden.
 */
export const STARTER_LESS_OF: StarterTopic[] = [
  {
    id: 'politics',
    label: 'Politics',
    group: 'less',
    keywords: [
      'election',
      'elections',
      'politics',
      'political',
      'Democrats',
      'Republicans',
      'Liberals',
      'Conservatives',
      'parliament',
      'congress',
      'senator',
      'prime minister',
      'president',
    ],
  },
  {
    id: 'celebrity',
    label: 'Celebrity news',
    group: 'less',
    keywords: ['celebrity', 'celebrities', 'Kardashian', 'red carpet', 'gossip', 'Hollywood'],
  },
  {
    id: 'crypto',
    label: 'Crypto & get-rich-quick',
    group: 'less',
    keywords: ['crypto', 'cryptocurrency', 'bitcoin', 'NFT', 'NFTs', 'memecoin', 'passive income', 'get rich'],
  },
  {
    id: 'motivational',
    label: 'Motivational quotes',
    group: 'less',
    keywords: ['motivation', 'motivational', 'hustle', 'grind', 'mindset', 'never give up'],
  },
  {
    id: 'humblebrags',
    label: 'Humblebrags',
    group: 'less',
    keywords: ['humbled', 'honored to announce', 'thrilled to announce', 'proud to share', 'excited to share'],
  },
  {
    id: 'outrage',
    label: 'Outrage & rage bait',
    group: 'less',
    keywords: ['outrageous', 'disgusting', 'unbelievable', 'shocking', 'boycott'],
  },
  {
    id: 'course-pitches',
    label: 'Course and coaching pitches',
    group: 'less',
    keywords: ['masterclass', 'my course', 'coaching program', 'DM me', 'link in bio', 'free webinar', 'enroll now'],
  },
];

export function starterTopic(id: string): StarterTopic | undefined {
  return [...STARTER_TOPICS, ...STARTER_LESS_OF].find((t) => t.id === id);
}
