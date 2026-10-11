/** Defaults and per-model request rules. Opus/Fable are never defaults: classification is high-volume and simple. */

export const ANTHROPIC_DEFAULT_MODEL = 'claude-haiku-5-5';

/** Smallest-first preference lists, checked against what the endpoint actually offers. */
export const OPENAI_PREFERENCES = ['gpt-5-nano', 'gpt-5-mini', 'gpt-4.1-nano', 'gpt-4.1-mini', 'gpt-4o-mini'];

export const COMPAT_PREFERENCES: Record<string, string[]> = {
  ollama: ['llama3.2:3b', 'llama3.2', 'qwen2.5:7b', 'qwen2.5', 'gemma3:4b', 'gemma3', 'llama3.1:8b', 'mistral'],
  lmstudio: ['llama-3.2-3b-instruct', 'qwen2.5-7b-instruct', 'gemma-3-4b-it'],
  gemini: ['gemini-flash-lite-latest', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash'],
  openrouter: ['meta-llama/llama-3.1-8b-instruct', 'google/gemini-2.5-flash-lite', 'openai/gpt-4.1-nano'],
  groq: ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile'],
};

/** Expensive models get a confirmation before being used for every post in the feed. */
export function isExpensiveModel(model: string): boolean {
  return /opus|fable|mythos|gpt-5(?!-(?:nano|mini))|o\d|gpt-4\.1(?!-(?:nano|mini))/i.test(model);
}

/** Anthropic: which models accept `thinking: {type: 'disabled'}` at low effort (Opus/Sonnet 5.5 and Fable reject it). */
export function anthropicCanDisableThinking(model: string): boolean {
  return !/opus-5-5|sonnet-5-5|fable|mythos/.test(model);
}

/** Pick the first preferred model the endpoint lists, else the first listed one. */
export function pickModel(available: readonly string[], preferences: readonly string[]): string | undefined {
  const lower = available.map((m) => m.toLowerCase());
  for (const p of preferences) {
    const exact = lower.indexOf(p.toLowerCase());
    if (exact >= 0) return available[exact];
  }
  for (const p of preferences) {
    const partial = lower.findIndex((m) => m.includes(p.toLowerCase()));
    if (partial >= 0) return available[partial];
  }
  return available[0];
}

export function modelLabel(model: string): string {
  const known: Record<string, string> = {
    'claude-haiku-5-5': 'Claude Haiku 5.5',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5',
    'claude-opus-5-5': 'Claude Opus 5.5',
  };
  return known[model] ?? model;
}
