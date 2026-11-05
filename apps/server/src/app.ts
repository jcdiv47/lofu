import { SQLiteError } from "bun:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { compress } from "hono/compress";
import type { AppContext } from "./context.ts";
import { bookmarkRoutes } from "./routes/bookmarks.ts";
import { importRoutes } from "./routes/imports.ts";
import { miscRoutes } from "./routes/misc.ts";
import { NotFoundError } from "./store/bookmarks.ts";

export const VERSION = "0.1.0";

export function createApp(ctx: AppContext) {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid request", details: result.error.issues }, 400);
      }
    },
  });

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof RangeError || err instanceof TypeError) {
      // TypeError: e.g. new URL() on a malformed URL inside a store.
      return c.json({ error: err.message }, 400);
    }
    if (err instanceof SQLiteError && err.code?.startsWith("SQLITE_CONSTRAINT")) {
      const msg =
        err.code === "SQLITE_CONSTRAINT_FOREIGNKEY" ? "referenced item does not exist" : "conflict";
      return c.json({ error: msg, details: err.message }, 409);
    }
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", async (c) =>
    c.json({ ok: true, version: VERSION, search: ctx.searcher ? await ctx.meiliHealthy() : null }),
  );

  app.use("/v1/*", compress({ threshold: 2048 }));
  app.use("/v1/*", async (c, next) => {
    if (ctx.config.authDisabled) return next();
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!token || !ctx.tokens.verify(token)) return c.json({ error: "unauthorized" }, 401);
    return next();
  });

  bookmarkRoutes(app, ctx);
  miscRoutes(app, ctx);
  importRoutes(app, ctx);

  app.openAPIRegistry.registerComponent("securitySchemes", "bearer", {
    type: "http",
    scheme: "bearer",
  });
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "lofu",
      version: VERSION,
      description: "Self-hosted bookmarks & read-later API",
    },
    security: [{ bearer: [] }],
  });

  return app;
}
