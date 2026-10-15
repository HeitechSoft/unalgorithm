/** Matches `buildUserPrompt`'s fenced posts: the id and the text of each. */
const POST_TAG = /<post_\w+ id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/post_/g;

/** The fenced posts of a classification user turn, in order. Test code only; no Node imports, so it runs anywhere. */
export function fencedPosts(userText: string): { id: string; text: string }[] {
  return [...userText.matchAll(POST_TAG)].map(([, id = '', text = '']) => ({ id, text }));
}
