import type { AIErrorCode, NormalizedUsage } from '@unalgorithm/protocol';

/** A failed AI call. Carries the tokens it still spent, so usage is recorded even on refusals and truncation. */
export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly usage: NormalizedUsage | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    code: AIErrorCode,
    message: string,
    opts: { usage?: NormalizedUsage; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'AIError';
    this.code = code;
    this.usage = opts.usage;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isAIError(e: unknown): e is AIError {
  return e instanceof AIError;
}

/** Errors worth retrying later (the same request may well succeed). */
export function isRetryable(code: AIErrorCode): boolean {
  return code === 'rate-limit' || code === 'overloaded' || code === 'network' || code === 'timeout';
}

/** Map an HTTP status (and response text) from any provider to our error codes. */
export function codeForStatus(status: number, body: string, host?: string): AIErrorCode {
  const text = body.toLowerCase();
  if (status === 401) return 'auth';
  if (status === 403) {
    const local = !!host && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host);
    return local ? 'origin-blocked' : 'permission';
  }
  if (status === 404) return 'model-not-found';
  if (status === 402 || /credit balance|insufficient_quota|billing/.test(text)) return 'quota';
  if (status === 429) return /quota/.test(text) ? 'quota' : 'rate-limit';
  if (status === 408) return 'timeout';
  if (status === 413 || /context length|context window|too many tokens/.test(text)) return 'context-overflow';
  if (status >= 500) return 'overloaded';
  if (status === 400) return 'bad-request';
  return 'unknown';
}

/**
 * Plain-language message for an error code, shown in the popup, side panel and settings, and sent by servers in their
 * error bodies. `provider` names who answered: the extension's label for a source, or a server's own INSTANCE_NAME. No
 * text here names a particular server: a self-hosted one must never tell people to sign in somewhere else.
 */
export function describeError(code: AIErrorCode, provider?: string): string {
  const name = provider || 'The AI provider';
  switch (code) {
    case 'no-key':
      return 'Add an API key in Settings → AI.';
    case 'auth':
      return `${name} didn't accept this key. Check that you copied all of it.`;
    case 'permission':
      return `${name} says this key can't use that model.`;
    case 'host-permission':
      return `unAlgorithm needs permission to reach ${provider || 'this AI server'}. Open Settings → AI and test it again.`;
    case 'origin-blocked':
      return 'The local server refused the request. For Ollama, set OLLAMA_ORIGINS=chrome-extension://* and restart it.';
    case 'model-not-found':
      return `${name} doesn't have that model. Pick another in Settings → AI.`;
    case 'rate-limit':
      return `${name} is rate limiting requests. unAlgorithm will try again shortly.`;
    case 'quota':
      return `Your ${name} account is out of credit or over its quota.`;
    case 'overloaded':
      return `${name} is busy right now. unAlgorithm will try again shortly.`;
    case 'refusal':
      return 'The AI declined to classify this post.';
    case 'truncated':
      return 'The AI ran out of room in its answer.';
    case 'timeout':
      return 'The AI took too long to answer.';
    case 'network':
      return "Couldn't reach the AI server. Check your connection.";
    case 'cap-reached':
      return "You've reached today's AI limit. Rules keep working; AI resumes tomorrow.";
    case 'not-available':
      return 'This AI option is not available on this computer.';
    case 'unsupported':
      return "This model can't produce the structured answers unAlgorithm needs.";
    case 'context-overflow':
      return 'The post was too long for this model.';
    case 'insufficient-credits':
      return `${provider ? `Your ${provider} balance is empty.` : 'Your balance on this AI server is empty.'} Add credit, or switch to on-device or your own key.`;
    case 'auth-required':
      return provider ? `Sign in to ${provider} again.` : 'Sign in to your AI server again.';
    case 'no-model':
      return 'Choose a model in Settings → AI.';
    case 'bad-request':
      return `${name} rejected the request.`;
    default:
      return 'Something went wrong with the AI request.';
  }
}
