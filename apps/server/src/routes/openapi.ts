/** Small helpers for `createRoute` declarations, shared by every `/v1` route module. */
import { ServerErrorSchema } from '@unalgorithm/protocol';

/** A JSON body or response of this schema, in the `content` form `@hono/zod-openapi` expects. */
export const json = <T>(schema: T) => ({ 'application/json': { schema } });

/** A non-2xx answer: the `WireError` body every `/v1` route answers with. */
export const errorResponse = (description: string) => ({ description, content: json(ServerErrorSchema) });
