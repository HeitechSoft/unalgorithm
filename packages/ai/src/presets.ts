import type { CompatPreset } from '@unalgorithm/core';

/** Providers you can paste a key for. Gemini, OpenRouter and Groq go through the OpenAI-compatible client. */
export type KeyProvider = 'anthropic' | 'openai' | 'gemini' | 'openrouter' | 'groq';

export interface ProviderInfo {
  id: KeyProvider;
  label: string;
  origin: string;
  keyUrl: string;
  keyPrefix: RegExp;
  freeTier?: boolean;
  steps: string[];
}

export const KEY_PROVIDERS: Record<KeyProvider, ProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    origin: 'https://api.anthropic.com',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPrefix: /^sk-ant-/,
    steps: [
      'Sign in to the Anthropic Console.',
      'Add a few dollars of credit under Billing.',
      'Open API keys and choose Create key.',
      'Copy the key and paste it here.',
    ],
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    origin: 'https://api.openai.com',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPrefix: /^sk-(?!ant-|or-)/,
    steps: [
      'Sign in to the OpenAI platform.',
      'Add credit under Billing.',
      'Open API keys and create a new secret key.',
      'Copy the key and paste it here.',
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    origin: 'https://generativelanguage.googleapis.com',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyPrefix: /^AIza/,
    freeTier: true,
    steps: ['Sign in to Google AI Studio.', 'Choose Get API key, then Create API key.', 'Copy the key and paste it here.'],
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    origin: 'https://openrouter.ai',
    keyUrl: 'https://openrouter.ai/keys',
    keyPrefix: /^sk-or-/,
    freeTier: true,
    steps: ['Sign in to OpenRouter.', 'Open Keys and create a key.', 'Copy the key and paste it here.'],
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    origin: 'https://api.groq.com',
    keyUrl: 'https://console.groq.com/keys',
    keyPrefix: /^gsk_/,
    freeTier: true,
    steps: ['Sign in to the Groq console.', 'Open API Keys and create a key.', 'Copy the key and paste it here.'],
  },
};

/** Recognize which provider a pasted key belongs to. */
export function detectProvider(key: string): KeyProvider | undefined {
  const k = key.trim();
  for (const p of ['anthropic', 'openrouter', 'groq', 'gemini', 'openai'] as const) {
    if (KEY_PROVIDERS[p].keyPrefix.test(k)) return p;
  }
  return undefined;
}

export interface CompatPresetInfo {
  id: CompatPreset;
  label: string;
  baseUrl: string;
  auth: 'none' | 'bearer';
  local: boolean;
  help?: string;
}

export const COMPAT_PRESET_INFO: Record<CompatPreset, CompatPresetInfo> = {
  ollama: {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    auth: 'none',
    local: true,
    help: 'If the test is refused, start Ollama with OLLAMA_ORIGINS=chrome-extension://*,moz-extension://* so it accepts requests from extensions.',
  },
  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    auth: 'none',
    local: true,
    help: 'Start the local server in LM Studio and turn on CORS in its server settings.',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    auth: 'bearer',
    local: false,
  },
  openrouter: { id: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', auth: 'bearer', local: false },
  groq: { id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', auth: 'bearer', local: false },
  'heitech-private': {
    id: 'heitech-private',
    label: 'HeitechSoft Private AI',
    baseUrl: 'https://',
    auth: 'bearer',
    local: false,
    help: 'Use the address and token from your HeitechSoft Private AI welcome email.',
  },
  custom: {
    id: 'custom',
    label: 'Other OpenAI-compatible server',
    baseUrl: 'http://localhost:8000/v1',
    auth: 'none',
    local: true,
  },
};

/** The permission pattern for an endpoint (ports are not part of match patterns). */
export function originPattern(baseUrl: string): string {
  const u = new URL(baseUrl);
  return `${u.protocol}//${u.hostname}/*`;
}
