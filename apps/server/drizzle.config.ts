import { defineConfig } from 'drizzle-kit';

/** drizzle-kit settings for `db:generate`: the schema barrel in, SQL migrations and their journal out. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
