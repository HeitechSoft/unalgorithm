/**
 * Test code only: the server as `src/index.ts` runs it, with the fictional fixture list, so an end-to-end run (P3-41)
 * can compare coverage. The image never holds it: the Dockerfile copies the server's `src` only.
 */
import { FIXTURE_LIST } from '@unalgorithm/outlets/testing';
import { main } from '../../src/index.ts';

await main({ outlets: FIXTURE_LIST });
