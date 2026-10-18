/** Every way an AI call can fail, shared by local sources and the (future) unAlgorithm server. */
export const AI_ERROR_CODES = [
  'no-key',
  'no-model',
  'auth',
  'permission',
  'host-permission',
  'origin-blocked',
  'model-not-found',
  'rate-limit',
  'quota',
  'overloaded',
  'refusal',
  'truncated',
  'bad-request',
  'context-overflow',
  'unsupported',
  'not-available',
  'timeout',
  'network',
  'cap-reached',
  'insufficient-credits',
  'auth-required',
  'unknown',
] as const;
export type AIErrorCode = (typeof AI_ERROR_CODES)[number];

/** Errors that won't fix themselves: pause AI until settings change instead of retrying. */
export const BLOCKING_AI_ERRORS: ReadonlySet<AIErrorCode> = new Set<AIErrorCode>([
  'no-key',
  'no-model',
  'auth',
  'permission',
  'host-permission',
  'origin-blocked',
  'model-not-found',
  'quota',
  'cap-reached',
  'bad-request',
  'unsupported',
  'not-available',
  'insufficient-credits',
  'auth-required',
]);

export interface WireError {
  code: AIErrorCode;
  message: string;
}
