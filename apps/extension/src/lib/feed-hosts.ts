/** The feeds unAlgorithm runs on: their hosts (sender checks) and the match patterns for finding their tabs. */
export const FEED_HOSTS = ['www.linkedin.com', 'www.facebook.com'];
export const FEED_TAB_URLS = ['https://www.linkedin.com/*', 'https://www.facebook.com/*'];
/**
 * Set on the content scripts' world as a content script starts, so the background doesn't put a second copy on a tab
 * whose own copy already runs: the second one would stop the first, showing every hidden post until it folds them again.
 */
export const CONTENT_STARTED = '__unalgorithmContentStarted';
