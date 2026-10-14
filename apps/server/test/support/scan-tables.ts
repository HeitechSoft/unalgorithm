import { sql } from 'drizzle-orm';
import type { DbHandle } from '../../src/db/client.ts';
import { queryRows } from './db.ts';

/**
 * Every base table of the `public` and `drizzle` schemas, read whole: `schema.table` to all its rows as JSON. Every
 * table is read, so a new one is covered by itself. The canary (CL1-22) looks for its marker in it; the account
 * deletion test (CL3-15) for the deleted account's id and address.
 */
export async function scanAllTables(h: DbHandle): Promise<Map<string, string>> {
  const tables = await queryRows(
    h,
    sql`select table_schema, table_name from information_schema.tables
        where table_schema in ('public', 'drizzle') and table_type = 'BASE TABLE'`,
  );
  const scanned = new Map<string, string>();
  for (const { table_schema, table_name } of tables) {
    const [schema, table] = [String(table_schema), String(table_name)];
    // Quoted and schema-qualified: an unquoted `user` is the SQL keyword, the current role, not Better Auth's table.
    const rows = await queryRows(h, sql`select * from ${sql.identifier(schema)}.${sql.identifier(table)}`);
    const json = JSON.stringify(rows, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
    scanned.set(`${schema}.${table}`, json);
  }
  return scanned;
}
