import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, ImportReport } from "@lofu/shared";
import type { AppContext } from "../context.ts";
import { importRaindropCsv } from "../importers/raindrop.ts";
import { json } from "./util.ts";

export function importRoutes(app: OpenAPIHono, ctx: AppContext) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/import/raindrop",
      summary: "Import a Raindrop.io CSV export (idempotent)",
      description:
        "Body is the CSV file as-is. Bookmarks are created synchronously; page fetching and extraction run in the background at bulk priority.",
      request: {
        body: { required: true, content: { "text/csv": { schema: z.string() } } },
      },
      responses: {
        200: json(ImportReport, "Import summary"),
        400: json(ApiError, "Not a Raindrop CSV export"),
      },
    }),
    async (c) => c.json(importRaindropCsv(await c.req.text(), ctx), 200),
  );
}
