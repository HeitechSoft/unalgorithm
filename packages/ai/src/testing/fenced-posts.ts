/*
 * Readers for the fenced blocks of the prompts (`<post_NONCE id="p1">\n…\n</post_NONCE>` and the like). Test code
 * only; no Node imports, so it runs anywhere. They scan with indexOf rather than a backtracking regex, so a hostile
 * user turn (say, thousands of unterminated `<post_x` tags) takes linear time.
 */

/** A word character, as `\w` matches it. */
function isWord(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 // _
  );
}

/** The index after the word characters at `from`, or -1 when there are none. */
function afterWord(text: string, from: number): number {
  let i = from;
  while (i < text.length && isWord(text.charCodeAt(i))) i++;
  return i > from ? i : -1;
}

/** The index after the ASCII digits at `from`, or -1 when there are none. */
function afterDigits(text: string, from: number): number {
  let i = from;
  while (i < text.length && text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57) i++;
  return i > from ? i : -1;
}

/**
 * Each `<NAME_x…>\nBODY\n</NAME_` block, in order: its attributes (the text between the tag name and the `>`) and its
 * body. The same blocks as `/<NAME_\w+([^>]*)>\n([\s\S]*?)\n<\/NAME_/g` would match.
 */
export function fencedBlocks(text: string, name: string): { attrs: string; body: string }[] {
  const open = `<${name}_`;
  const close = `\n</${name}_`;
  const blocks: { attrs: string; body: string }[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(open, from);
    if (start < 0) break;
    from = start + 1;
    const nameEnd = afterWord(text, start + open.length);
    if (nameEnd < 0) continue;
    // Every later tag would find this `>` or a later one, and no closing tag after it: nothing more to match.
    const gt = text.indexOf('>', nameEnd);
    if (gt < 0) break;
    if (text[gt + 1] !== '\n') continue;
    const end = text.indexOf(close, gt + 2);
    if (end < 0) break;
    blocks.push({ attrs: text.slice(nameEnd, gt), body: text.slice(gt + 2, end) });
    from = end + close.length;
  }
  return blocks;
}

/**
 * Each `<source_x id="sN"…>` tag followed by a newline: the id and the first line of its text. The same tags as
 * `/<source_\w+ id="(s\d+)"[^>]*>\n([^\n]*)/g` would match.
 */
export function fencedSourceLines(text: string): { id: string; line: string }[] {
  const open = '<source_';
  const sources: { id: string; line: string }[] = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(open, from);
    if (start < 0) break;
    from = start + 1;
    const nameEnd = afterWord(text, start + open.length);
    if (nameEnd < 0 || !text.startsWith(' id="s', nameEnd)) continue;
    const digitsEnd = afterDigits(text, nameEnd + 6);
    if (digitsEnd < 0 || text[digitsEnd] !== '"') continue;
    const gt = text.indexOf('>', digitsEnd + 1);
    if (gt < 0) break;
    if (text[gt + 1] !== '\n') continue;
    const lineEnd = text.indexOf('\n', gt + 2);
    const end = lineEnd < 0 ? text.length : lineEnd;
    sources.push({ id: text.slice(nameEnd + 5, digitsEnd), line: text.slice(gt + 2, end) });
    from = end;
  }
  return sources;
}

/** The fenced posts of a classification user turn, in order: the id and the text of each (`buildUserPrompt`'s tags). */
export function fencedPosts(userText: string): { id: string; text: string }[] {
  const posts: { id: string; text: string }[] = [];
  const open = '<post_';
  const close = '\n</post_';
  let from = 0;
  for (;;) {
    const start = userText.indexOf(open, from);
    if (start < 0) break;
    from = start + 1;
    const nameEnd = afterWord(userText, start + open.length);
    if (nameEnd < 0 || !userText.startsWith(' id="', nameEnd)) continue;
    const idStart = nameEnd + 5;
    const idEnd = userText.indexOf('"', idStart);
    if (idEnd < 0) break;
    if (idEnd === idStart) continue;
    const gt = userText.indexOf('>', idEnd + 1);
    if (gt < 0) break;
    if (userText[gt + 1] !== '\n') continue;
    const end = userText.indexOf(close, gt + 2);
    if (end < 0) break;
    posts.push({ id: userText.slice(idStart, idEnd), text: userText.slice(gt + 2, end) });
    from = end + close.length;
  }
  return posts;
}
