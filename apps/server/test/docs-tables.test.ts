import { readFileSync } from 'node:fs';
import { getTableName, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as authSchema from '../src/db/auth-schema.ts';
import * as schema from '../src/db/schema.ts';

/**
 * The docs follow the schema (CL4-20): every table the server's Drizzle schema defines is listed in `docs/ARCHITECTURE.md`'s
 * `### Database` table, and the privacy model names the tables CL4 added. The table names come from the schema, never
 * typed twice.
 */
const REPO_ROOT = new URL('../../../', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, REPO_ROOT), 'utf8');

/**
 * Tables a later ticket adds before that ticket documents them, each with a comment naming the ticket. Empty when CL4-20
 * merged; it only shrinks: a name here that the docs already list fails the test.
 */
const NOT_YET_DOCUMENTED = new Set<string>([]);

/** Every table name the server's schema files export. */
function schemaTables(): string[] {
  const exported: unknown[] = [...Object.values(schema), ...Object.values(authSchema)];
  const names = exported.filter((value): value is PgTable => is(value, PgTable)).map((table) => getTableName(table));
  return [...new Set(names)].sort();
}

/** A heading's section: the lines after `heading` up to the next heading of its level or higher. */
function sectionOf(markdown: string, heading: string): string {
  const lines = markdown.split(/\r?\n/);
  const start = lines.indexOf(heading);
  expect(start, `heading "${heading}"`).toBeGreaterThanOrEqual(0);
  const level = heading.indexOf(' ');
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const match = /^(#+) /.exec(line);
    return match?.[1] !== undefined && match[1].length <= level;
  });
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

describe('tables', () => {
  it('test_architecture_lists_every_table', () => {
    const database = sectionOf(read('docs/ARCHITECTURE.md'), '### Database');
    const tables = schemaTables();
    // The schema is read: the server has at least the CL1 tables and the CL4 ones.
    expect(tables).toEqual(expect.arrayContaining(['user', 'devices', 'signup_invites', 'setup_tokens', 'ops_alerts']));
    const listed = (name: string): boolean => database.includes(`\`${name}\``);
    expect(
      tables.filter((name) => !NOT_YET_DOCUMENTED.has(name) && !listed(name)),
      'tables missing from ### Database',
    ).toEqual([]);
    expect([...NOT_YET_DOCUMENTED].filter(listed), 'documented: remove from NOT_YET_DOCUMENTED').toEqual([]);
    expect(
      [...NOT_YET_DOCUMENTED].filter((name) => !tables.includes(name)),
      'not in the schema',
    ).toEqual([]);
  });

  it('test_privacy_model_names_cl4_tables', () => {
    const stores = sectionOf(read('docs/privacy-model.md'), '## What a server stores');
    for (const name of ['signup_invites', 'setup_tokens', 'ops_alerts']) expect(stores).toContain(`\`${name}\``);
  });
});

describe('trademarks', () => {
  it('test_trademarks_allows_unmodified_server', () => {
    const youMay = sectionOf(read('TRADEMARKS.md'), '## You may').replace(/\s+/g, ' ');
    expect(youMay).toContain(
      'Run the unmodified unAlgorithm server (`apps/server`) for yourself or your organization, under a name of your own ' +
        '(`INSTANCE_NAME`). Don\'t call your server "unAlgorithm Cloud": that name is only HeitechSoft\'s hosted service ' +
        'at cloud.unalgorithm.app.',
    );
  });
});
