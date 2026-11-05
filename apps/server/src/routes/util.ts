import { z } from "@hono/zod-openapi";
import { ApiError } from "@lofu/shared";

export const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { "application/json": { schema } },
});

export const body = <T extends z.ZodType>(schema: T) => ({
  body: { required: true, content: { "application/json": { schema } } },
});

export const IdParam = z.object({ id: z.string() });
export const notFound = json(ApiError, "Not found");
