/**
 * Problem reports (ADR 0009 §4): the pure helpers the extension's report page, its email fallback, the server and the
 * admin page share. They read codes, counts and enums only, never post text or names.
 */
export * from './describe.ts';
export * from './message.ts';
export * from './post.ts';
export * from './route.ts';
