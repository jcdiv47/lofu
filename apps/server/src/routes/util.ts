import { z } from "@hono/zod-openapi";
import { ApiError } from "@lofu/shared";
import type { Context } from "hono";
import { BadRequestError } from "../errors.ts";

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

export const body = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { "application/json": { schema } } },
});

/** A body that may be left out (or empty). */
export const optionalBody = <T extends z.ZodType>(schema: T) => ({
  body: { required: false, content: { "application/json": { schema } } },
});

export const IdParam = z.object({ id: z.string() });
export const notFound = json(ApiError, "Not found");
export const badRequest = json(ApiError, "Invalid request");
export const conflict = json(ApiError, "Conflict");
export const forbidden = json(ApiError, "The token lacks the scope this needs");

/** How long a request asks to wait for extraction (`wait`, `waitMs`), in ms. */
export function waitMsOf(q: { wait?: boolean | undefined; waitMs?: number | undefined }): number {
  if (q.waitMs !== undefined) return q.waitMs;
  return q.wait ? 10_000 : 0;
}

/** An `If-Match` header's seq (`"12"`, `W/"12"` or `12`), or undefined. */
export function ifMatchSeq(c: Context): number | undefined {
  const h = c.req.header("if-match")?.trim();
  if (!h) return undefined;
  const m = /^(?:W\/)?"?(\d+)"?$/.exec(h);
  if (!m) throw new BadRequestError('If-Match must be a bookmark seq, as in If-Match: "12"');
  return Number(m[1]);
}
