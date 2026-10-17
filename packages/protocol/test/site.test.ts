import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLOUD_BETA_DOCUMENTS,
  CLOUD_BETA_NOTICE,
  CLOUD_BETA_TERMS,
  CLOUD_FOOTER_LINKS,
  CORRECTIONS_PAGE,
  CREDITS_PAGE,
  EVALS_PAGE,
  FEATURE_NAMES,
  METHODOLOGY_DOCUMENTS,
  METHODOLOGY_PAGE,
  PRICING_FOOTER_LINK,
  PRICING_REDIRECT,
  PROMPTS_PAGE,
  STARTER_CREDIT,
  siteUrl,
  WEBSITE_ORIGIN,
} from '../src/index.ts';

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

/** P3-68: what a correction or an appeal must never carry, said the same way on the page and on both forms. */
const NEVER_SEND = "Use your own words: never the post, a screenshot of it, a link to it, or anyone's name.";
const CORRECTION_FORM_URL = 'https://github.com/HeitechSoft/unalgorithm/issues/new?template=correction.yml';
const APPEAL_FORM_URL = 'https://github.com/HeitechSoft/unalgorithm/issues/new?template=source_list_appeal.yml';

describe('site documents', () => {
  it('test_site_documents_match_their_sources', () => {
    expect(CLOUD_BETA_DOCUMENTS.map((doc) => doc.source)).toEqual(['CLOUD-BETA-NOTICE.md', 'CLOUD-BETA-TERMS.md']);
    for (const doc of CLOUD_BETA_DOCUMENTS) {
      expect(read(doc.source).split('\n')[0], doc.source).toBe(`# ${doc.title}`);
    }
    expect(read(CREDITS_PAGE.source).split('\n')[0]).toBe(`# ${CREDITS_PAGE.title}`);
    // P3-65: the generated prompts and evaluations pages (`pnpm docs:site`); P3-68: the methodology and corrections.
    for (const doc of [PROMPTS_PAGE, EVALS_PAGE, METHODOLOGY_PAGE, CORRECTIONS_PAGE]) {
      expect(existsSync(new URL(doc.source, REPO_ROOT)), doc.source).toBe(true);
      expect(read(doc.source).split('\n')[0], doc.source).toBe(`# ${doc.title}`);
    }
    for (const name of Object.values(FEATURE_NAMES)) expect(METHODOLOGY_PAGE.title).toContain(name);
    // Decision D109: the website footer's "How checks work" column (P3-70 appends the transparency reports).
    expect(METHODOLOGY_DOCUMENTS).toStrictEqual([METHODOLOGY_PAGE, PROMPTS_PAGE, EVALS_PAGE, CORRECTIONS_PAGE]);
  });

  it('test_corrections_page_required_wording', () => {
    const md = read(CORRECTIONS_PAGE.source);
    const text = flat(md);
    const headings = md.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual([
      '## What never to send',
      '## Ask for a correction',
      '## Source list appeals',
      '## Quarterly audit',
    ]);
    expect(text).toContain(NEVER_SEND);
    for (const phrase of [
      'never the post',
      CORRECTION_FORM_URL,
      APPEAL_FORM_URL,
      'hello@heitechsoft.com',
      'legal@heitechsoft.com',
      '5 business days',
      '30 days',
      '10 %',
      '12 months',
      'did not make',
    ]) {
      expect(text, phrase).toContain(phrase);
    }
    // Decision D86: corrections go to one address, appeals (which outlets may send) to the other.
    const section = (from: string, to?: string) => flat(md.slice(md.indexOf(from), to ? md.indexOf(to) : undefined));
    const corrections = section('## Ask for a correction', '## Source list appeals');
    expect(corrections).toContain('hello@heitechsoft.com');
    expect(corrections).toContain(CORRECTION_FORM_URL);
    const appeals = section('## Source list appeals', '## Quarterly audit');
    expect(appeals).toContain('legal@heitechsoft.com');
    expect(appeals).toContain(APPEAL_FORM_URL);
    expect(appeals).toContain('did not make the change');
    const audit = section('## Quarterly audit');
    for (const phrase of ['10 %', 'at least 10', '12 months', 'did not make them', 'transparency report']) {
      expect(audit, phrase).toContain(phrase);
    }
    expect(text).not.toMatch(/panel|registry/i);
  });

  it('test_site_urls', () => {
    expect(WEBSITE_ORIGIN).toBe('https://unalgorithmfeed.com');
    expect(CLOUD_BETA_DOCUMENTS.map(siteUrl)).toEqual([
      'https://unalgorithmfeed.com/cloud/beta-privacy',
      'https://unalgorithmfeed.com/cloud/beta-terms',
    ]);
    expect(CLOUD_BETA_DOCUMENTS.map((doc) => doc.linkText)).toEqual(['Beta privacy notice', 'Beta terms']);
    expect(siteUrl(CREDITS_PAGE)).toBe('https://unalgorithmfeed.com/credits');
    // Decision D83: the methodology's published pages.
    expect([PROMPTS_PAGE, EVALS_PAGE].map((doc) => [siteUrl(doc), doc.title, doc.linkText])).toEqual([
      ['https://unalgorithmfeed.com/methodology/prompts', 'Published prompts', 'Prompts'],
      ['https://unalgorithmfeed.com/methodology/evals', 'Evaluations and trust gates', 'Evaluations'],
    ]);
    expect([METHODOLOGY_PAGE, CORRECTIONS_PAGE].map((doc) => [siteUrl(doc), doc.title, doc.linkText])).toEqual([
      ['https://unalgorithmfeed.com/methodology', 'How Fact-check and UnEcho Chamber work', 'Methodology'],
      ['https://unalgorithmfeed.com/corrections', 'Corrections and appeals', 'Corrections and appeals'],
    ]);
  });

  it('test_footer_links_credits', () => {
    expect(CLOUD_FOOTER_LINKS.map((doc) => [doc.linkText, doc.path])).toEqual([
      ['Beta privacy notice', '/cloud/beta-privacy'],
      ['Beta terms', '/cloud/beta-terms'],
      ['How credits work', '/credits'],
    ]);
  });
});

describe('issue forms (P3-68)', () => {
  const form = (name: string) => read(`.github/ISSUE_TEMPLATE/${name}`);
  const ids = (yml: string) => [...yml.matchAll(/^\s+id: (\w+)$/gm)].map((m) => m[1]);
  /** A dropdown's options: the `- ` items under `options:` in the field whose id is `id`. */
  const options = (yml: string, id: string): string[] => {
    const start = yml.indexOf(`id: ${id}\n`);
    expect(start, id).toBeGreaterThan(-1);
    const end = yml.indexOf('\n  - type:', start);
    const field = yml.slice(start, end === -1 ? undefined : end);
    const list = field.slice(field.indexOf('options:\n'));
    return [...list.matchAll(/^ +- (.+)$/gm)].map((m) => (m[1] ?? '').replace(/^(["'])(.*)\1$/, '$2'));
  };

  it('test_issue_forms_warn_and_have_field_ids', () => {
    const correction = form('correction.yml');
    const appeal = form('source_list_appeal.yml');
    for (const [yml, label] of [
      [correction, 'correction'],
      [appeal, 'source-list-appeal'],
    ] as const) {
      expect(yml, label).toContain(NEVER_SEND);
      expect(yml.split('\n'), label).toContain(`labels: [${label}, triage]`);
    }
    expect(correction).toContain('https://unalgorithmfeed.com/corrections/');
    expect(appeal).toContain('Outlets may appeal by email instead: legal@heitechsoft.com.');

    expect(ids(correction)).toEqual(expect.arrayContaining(['feature', 'claim', 'version', 'prompt', 'list']));
    expect(options(correction, 'feature')).toStrictEqual(Object.values(FEATURE_NAMES));
    expect(options(correction, 'list')).toStrictEqual(["UnAlgorithm Cloud's list", 'My own list']);
    expect(ids(appeal)).toEqual(expect.arrayContaining(['outlet', 'what', 'version']));
    for (const yml of [correction, appeal]) expect(new Set(ids(yml)).size).toBe(ids(yml).length);
  });

  it('test_issue_config_links_corrections', () => {
    const config = form('config.yml');
    expect(config).toMatch(/^blank_issues_enabled: false$/m);
    expect(config).toContain('url: https://unalgorithmfeed.com/corrections/');
  });
});

describe('pricing (CL5-09)', () => {
  it('test_pricing_redirect_page_and_footer_link', () => {
    // /pricing is a prerendered page that leads to /credits: one pricing page, one source for every figure.
    expect(PRICING_REDIRECT).toEqual({ path: '/pricing', to: '/credits', linkText: 'Pricing and credits' });
    expect(PRICING_REDIRECT.to).toBe(CREDITS_PAGE.path);
    expect(PRICING_FOOTER_LINK).toEqual({ linkText: 'Pricing', path: '/credits' });
    expect(siteUrl(PRICING_FOOTER_LINK)).toBe(siteUrl(CREDITS_PAGE));
  });
});

describe('cloud beta documents', () => {
  it('test_beta_docs_required_phrases', () => {
    for (const phrase of ['privacy@heitechsoft.com', 'Anthropic', 'SMTP2GO', 'OVHcloud', "aren't public", 'Last updated:']) {
      expect(notice, phrase).toContain(phrase);
    }
    expect(flat(notice)).toContain('Privacy contact: Tom Heiber, HeitechSoft, privacy@heitechsoft.com');
    // P3-76: a person's own UnEcho Chamber list syncs with their settings, and is stored in their browser.
    expect(flat(notice)).toContain('own UnEcho Chamber source list');
    expect(flat(read('PRIVACY.md'))).toContain('your own UnEcho Chamber source list');
  });

  it('test_beta_notice_has_ten_sections', () => {
    const headings = notice.split('\n').filter((line) => line.startsWith('## '));
    expect(headings.map((line) => /^## (\d+)\. /.exec(line)?.[1])).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
  });

  it('test_beta_notice_logs_and_sessions_wording', () => {
    expect(flat(notice)).toContain(
      "Access logs and the server's own logs hold no post content, query strings or IP addresses. When a request fails, the web server's error log can record your IP address and the requested address; these logs are kept for 14 days (the host's log rotation). A sign-in page session stores your IP address and browser type and expires after one day; expired session records are deleted when you delete your account.",
    );
  });

  it('test_beta_notice_dates_anthropic_retention', () => {
    const section = flat(notice.slice(notice.indexOf('## 6.'), notice.indexOf('## 7.')));
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
    // Prices live only on "How credits work"; the terms mention credit only in their "Starter credit" section.
    const starter = terms.slice(terms.indexOf('## Starter credit'), terms.indexOf('## No availability promise'));
    expect(starter).toContain('## Starter credit');
    expect(flat(terms.replace(starter, ''))).not.toMatch(/\$|\bprice|\brefund|\bcredit/i);
  });

  it('test_beta_notice_lists_credit_records', () => {
    const stores = flat(notice.slice(notice.indexOf('## 3.'), notice.indexOf('## 4.')));
    expect(stores).toContain(
      'A credit ledger: each grant, each adjustment and, for each AI request, the number of posts, the model and the amount charged; never the posts.',
    );
    expect(stores).toContain(
      'To give the starter credit once per person we keep a keyed hash of your normalised email address (not the address), also after the account is deleted, so the same mailbox cannot claim it again.',
    );
    // CL3-24 (Reconciled 2026-10-13) replaces CL2-14's ledger-retention sentence: the Cloud's module erases a deleted
    // account's credit records except the keyed hash (CL3-28), as docs/privacy-model.md says. The notice must agree.
    expect(flat(read('docs/privacy-model.md'))).toContain(
      "erases the account's promotional credit records with the account, keeping only the keyed starter-credit hash",
    );
    expect(stores).toContain(
      'Ledger entries cannot be changed. When you delete your account, its credit records are erased with it, except the keyed hash of your email address that keeps the starter credit to one per mailbox. Buying credit is not available during the beta; how records of purchases are kept will be stated here before it is.',
    );
    expect(flat(notice)).not.toMatch(/stay after the account is deleted|except the credit ledger/);
    // Section 8: the download holds the credit ledger; deletion keeps only the keyed hash.
    const rights = flat(notice.slice(notice.indexOf('## 8.'), notice.indexOf('## 9.')));
    expect(rights).toContain("your credit ledger's entries");
    expect(rights).toContain('removes all of it at once, except the keyed hash of your email address described in section 3,');

    const text = flat(terms);
    expect(text).toContain(`Starter credit: see ${siteUrl(CREDITS_PAGE)}.`);
    expect(text).toContain(
      `It is promotional, has no cash value, expires after ${STARTER_CREDIT.expiresAfterDays} days and may be withheld or removed when it is abused.`,
    );
  });

  it('test_beta_notice_accounts_and_sync', () => {
    // CL3-24: sign-in methods, sync off until turned on, what never syncs, and self-service export and deletion.
    const section = flat(notice.slice(notice.indexOf('## 4. Accounts and sync'), notice.indexOf('## 5.')));
    expect(section).toContain('Sync is off until you turn it on');
    for (const never of ['API keys', 'endpoint tokens', 'refresh tokens', 'learned topics', 'votes']) {
      expect(section, never).toMatch(new RegExp(`Sync never carries [^.]*${never}`));
    }
    expect(section).toContain("Google knows you signed in to UnAlgorithm Cloud, under Google's own privacy policy");
    expect(flat(notice)).toContain('Google acts as a sign-in provider you choose, not as a processor of Cloud data.');
    const rights = flat(notice.slice(notice.indexOf('## 8.'), notice.indexOf('## 9.')));
    for (const text of [section, rights]) expect(text).toContain('`https://cloud.unalgorithm.app/account`');
    expect(rights).toContain('Deleting your account is immediate');
    expect(rights).not.toMatch(/by email during the beta|come in CL3/);
    expect(flat(notice.slice(notice.indexOf('## 3.'), notice.indexOf('## 4.')))).toContain('If you sign in with Google');
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

describe('feature names (P3-63)', () => {
  /** Every text file under `path` (a file or a directory), skipping dependencies, release history and changesets. */
  const textFiles = (path: string): string[] => {
    const url = new URL(path, REPO_ROOT);
    if (!existsSync(url)) return [];
    if (statSync(url).isFile()) {
      const bytes = readFileSync(url);
      return /(^|\/)CHANGELOG\.md$/.test(path) || bytes.includes(0) ? [] : [path];
    }
    return readdirSync(url)
      .filter((name) => name !== 'node_modules' && name !== '.changeset')
      .flatMap((name) => textFiles(`${path.replace(/\/$/, '')}/${name}`));
  };
  /** The directories directly inside `parent` (`apps`, `packages`). */
  const children = (parent: string): string[] =>
    readdirSync(new URL(`${parent}/`, REPO_ROOT)).filter((name) =>
      statSync(new URL(`${parent}/${name}`, REPO_ROOT)).isDirectory(),
    );
  const markdownUnder = (path: string): string[] => textFiles(path).filter((file) => file.endsWith('.md'));

  it('test_feature_names_unecho_chamber', () => {
    expect(FEATURE_NAMES).toStrictEqual({ factcheck: 'Fact-check', perspectives: 'UnEcho Chamber' });
    expect(Object.isFrozen(FEATURE_NAMES)).toBe(true);
  });

  it('test_old_feature_name_is_gone', () => {
    const roots = [
      ...children('apps').map((app) => `apps/${app}/src`),
      ...children('packages').flatMap((pkg) => [`packages/${pkg}/src`, `packages/${pkg}/eval`, `packages/${pkg}/README.md`]),
      'apps/server/.env.example',
      '.github',
      ...readdirSync(REPO_ROOT).filter((name) => name.endsWith('.md')),
    ];
    const files = [...roots.flatMap(textFiles), ...markdownUnder('docs')];
    expect(files.length).toBeGreaterThan(100);
    expect(files.filter((file) => /other\s+perspectives|reality\s+mode/i.test(read(file)))).toStrictEqual([]);
  });

  it('test_brand_doc_names_unecho_chamber', () => {
    const brand = flat(read('docs/brand.md'));
    const section = brand.slice(brand.indexOf('## Feature names'));
    expect(brand).toContain('## Feature names');
    for (const phrase of ['UnEcho Chamber', 'never a separate product', 'never shortened', '`perspectives`', 'FEATURE_NAMES']) {
      expect(section, phrase).toContain(phrase);
    }
  });
});
