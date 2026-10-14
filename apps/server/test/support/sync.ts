import { expect } from 'vitest';
import type { Db } from '../../src/db/client.ts';
import { devices, user } from '../../src/db/schema.ts';
import { type SyncPrincipal, SyncRefusal } from '../../src/sync/spaces.ts';
import { DEV_EXTENSION_ID } from './sign-in.ts';

export const ALICE = 'alice-user-id';
export const BOB = 'bob-user-id';

export interface People {
  alice: SyncPrincipal;
  bob: SyncPrincipal;
}

/** Two accounts with a device each, inserted directly (sign-in is not under test here). */
export async function seedPeople(db: Db): Promise<People> {
  const now = new Date();
  await db
    .insert(user)
    .values([ALICE, BOB].map((id) => ({ id, name: '', email: `${id}@example.com`, createdAt: now, updatedAt: now })));
  const [a, b] = await db
    .insert(devices)
    .values([
      { userId: ALICE, clientId: DEV_EXTENSION_ID },
      { userId: BOB, clientId: DEV_EXTENSION_ID },
    ])
    .returning();
  if (!a || !b) throw new Error('The devices were not inserted.');
  return { alice: { userId: ALICE, deviceId: a.id }, bob: { userId: BOB, deviceId: b.id } };
}

/** The `SyncRefusal` a call threw; fails the test when it resolved or threw anything else. */
export async function refusal(call: Promise<unknown>): Promise<Pick<SyncRefusal, 'code' | 'status' | 'reason'>> {
  const err = await call.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SyncRefusal);
  const { code, status, reason } = err as SyncRefusal;
  return { code, status, reason };
}
