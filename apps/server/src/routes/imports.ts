import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ApiError, ImportReport } from "@lofu/shared";
import type { AppContext } from "../context.ts";
import { PayloadTooLargeError, readCapped } from "../errors.ts";
import { importRaindropCsv } from "../importers/raindrop.ts";
import { forbidden, json } from "./util.ts";

/** The largest CSV an import takes. */
export const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

export function importRoutes(app: OpenAPIHono, ctx: AppContext) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/import/raindrop",
      operationId: "importRaindrop",
      tags: ["import"],
      summary: "Import a Raindrop.io CSV export (idempotent; needs the admin scope)",
      description:
        "Body is the CSV file as-is (at most 50 MiB). Bookmarks are created synchronously; page fetching and extraction run in the background at bulk priority.",
      request: {
        body: { required: true, content: { "text/csv": { schema: z.string() } } },
      },
      responses: {
        200: json(ImportReport, "Import summary"),
        400: json(ApiError, "Not a Raindrop CSV export"),
        403: forbidden,
        413: json(ApiError, "Over 50 MiB"),
      },
    }),
    async (c) => {
      const length = Number(c.req.header("content-length") ?? 0);
      if (length > MAX_IMPORT_BYTES) {
        throw new PayloadTooLargeError(`an import is at most ${MAX_IMPORT_BYTES} bytes`);
      }
      const raw = c.req.raw.body
        ? await readCapped(c.req.raw.body, MAX_IMPORT_BYTES)
        : new Uint8Array();
      return c.json(importRaindropCsv(new TextDecoder().decode(raw), ctx), 200);
    },
  );
}
