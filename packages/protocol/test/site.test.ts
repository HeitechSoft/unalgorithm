import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLOUD_BETA_DOCUMENTS, CLOUD_BETA_NOTICE, CLOUD_BETA_TERMS, siteUrl, WEBSITE_ORIGIN } from '../src/index.ts';

/**
 * The Cloud beta notice and terms (CL1-30, R47a): the website renders them from these files at these paths, with its own
 * drift check; these tests keep the exported data true to the files and the files' required wording in place. Whether
 * the wording is right in law is the review checklist's job, not a test's.
 */
const REPO_ROOT = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, REPO_ROOT), 'utf8').replace(/\r\n/g, '\n');
/** The text with every run of whitespace made one space, so line wrapping never matters. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

const notice = read(CLOUD_BETA_NOTICE.source);
const terms = read(CLOUD_BETA_TERMS.source);

describe('site documents', () => {
  it('test_site_documents_match_their_sources', () => {
    expect(CLOUD_BETA_DOCUMENTS.map((doc) => doc.source)).toEqual(['CLOUD-BETA-NOTICE.md', 'CLOUD-BETA-TERMS.md']);
    for (const doc of CLOUD_BETA_DOCUMENTS) {
      expect(read(doc.source).split('\n')[0], doc.source).toBe(`# ${doc.title}`);
    }
  });

  it('test_site_urls', () => {
    expect(WEBSITE_ORIGIN).toBe('https://unalgorithmfeed.com');
    expect(CLOUD_BETA_DOCUMENTS.map(siteUrl)).toEqual([
      'https://unalgorithmfeed.com/cloud/beta-privacy',
      'https://unalgorithmfeed.com/cloud/beta-terms',
    ]);
    expect(CLOUD_BETA_DOCUMENTS.map((doc) => doc.linkText)).toEqual(['Beta privacy notice', 'Beta terms']);
  });
});

describe('cloud beta documents', () => {
  it('test_beta_docs_required_phrases', () => {
    for (const phrase of ['privacy@heitechsoft.com', 'Anthropic', 'SMTP2GO', 'OVHcloud', "aren't public", 'Last updated:']) {
      expect(notice, phrase).toContain(phrase);
    }
    expect(flat(notice)).toContain('Privacy contact: Tom Heiber, HeitechSoft, privacy@heitechsoft.com');
  });

  it('test_beta_notice_has_nine_sections', () => {
    const headings = notice.split('\n').filter((line) => line.startsWith('## '));
    expect(headings.map((line) => /^## (\d)\. /.exec(line)?.[1])).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });

  it('test_beta_notice_logs_and_sessions_wording', () => {
    expect(flat(notice)).toContain(
      "Access logs and the server's own logs hold no post content, query strings or IP addresses. When a request fails, the web server's error log can record your IP address and the requested address; these logs are kept for 14 days (the host's log rotation). A sign-in page session stores your IP address and browser type and expires after one day; expired session records are deleted when you ask us to delete your account.",
    );
  });

  it('test_beta_notice_dates_anthropic_retention', () => {
    const section = flat(notice.slice(notice.indexOf('## 5.'), notice.indexOf('## 6.')));
    expect(section).toMatch(/As of \d{1,2} \w+ \d{4}, Anthropic's published retention/);
    expect(section).toContain('https://privacy.claude.com/');
  });

  it('test_beta_terms_cover_required_topics', () => {
    const text = flat(terms);
    for (const topic of [
      'invite-only',
      'withdraw an invitation',
      'The beta is free',
      'daily limits',
      'No availability promise',
      'may be reset',
      'No automated or bulk use of the API',
      'extract the prompts',
      "other people's accounts",
      'AI results can be wrong',
      'AGPL-3.0',
      'laws of Ontario',
    ]) {
      expect(text, topic).toContain(topic);
    }
    expect(text).not.toMatch(/\$|\bprice|\brefund|\bcredit/i);
  });

  it('test_beta_docs_names_and_retention_claims', () => {
    for (const [name, text] of [
      ['notice', notice],
      ['terms', terms],
    ] as const) {
      // The first "UnAlgorithm Cloud" says which service it is; no "zero retention" promise before an agreement exists.
      const first = text.split('\n\n').find((paragraph) => !paragraph.startsWith('#') && paragraph.includes('UnAlgorithm Cloud'));
      expect(first && flat(first), name).toContain('`cloud.unalgorithm.app`');
      expect(text, name).not.toMatch(/zero[\s-]+(data[\s-]+)?retention/i);
      // No placeholder left for review to fill.
      expect(text, name).not.toMatch(/<[A-Z]+>|\bTODO\b|\bTBD\b/);
      expect(text, name).toMatch(/^Last updated: \d{1,2} \w+ \d{4}$/m);
    }
  });
});
