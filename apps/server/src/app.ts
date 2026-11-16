import { SQLiteError } from "bun:sqlite";
import { OpenAPIHono } from "@hono/zod-openapi";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import type { AppContext } from "./context.ts";
import { FIGURE_HASH } from "./extract/figures.ts";
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

  // Browser extensions (and LOFU_CORS_ORIGINS, e.g. the web reader's dev
  // server) call the API from their own origin. Allowing them is safe: every
  // /v1 request still needs a bearer token (no cookies are used).
  const EXTENSION_ORIGIN = /^(chrome|moz|safari-web)-extension:\/\/[\w.-]+$/;
  app.use(
    "*",
    cors({
      origin: (origin) =>
        EXTENSION_ORIGIN.test(origin) || ctx.config.corsOrigins.includes(origin) ? origin : null,
      allowHeaders: ["authorization", "content-type", "content-encoding"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 86_400,
    }),
  );

  app.get("/health", async (c) =>
    c.json({ ok: true, version: VERSION, search: ctx.searcher ? await ctx.meiliHealthy() : null }),
  );

  // Article images for readers' <img>, which can't send a token: the URL's
  // signature is the authorization (extract/images.ts).
  app.get("/img/:sig", (c) =>
    ctx.images.serve(c.req.param("sig"), c.req.query("u"), c.req.query("w")),
  );

  // Formulas drawn as pictures, signed the same way (extract/mathPictures.ts).
  app.get("/math/:sig", (c) =>
    ctx.math.serve(c.req.param("sig"), c.req.query("t"), c.req.query("c"), c.req.query("i")),
  );

  // Figures taken out of saved articles (extract/figures.ts). The path is a
  // hash of the picture: only someone who has the page knows it.
  app.get("/figures/:hash", (c) => {
    const hash = c.req.param("hash");
    const svg = FIGURE_HASH.test(hash) ? ctx.bookmarks.figure(hash) : null;
    if (svg === null) return c.json({ error: "no such figure" }, 404);
    return new Response(svg, {
      headers: {
        "content-type": "image/svg+xml",
        // Content-addressed: a picture never changes under its path.
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        // An SVG opened on its own must not run scripts on the server's origin.
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
        "cross-origin-resource-policy": "cross-origin",
      },
    });
  });

  app.use("/v1/*", compress({ threshold: 2048 }));
  // Clients may gzip large uploads (the browser extension sends rendered
  // pages of several MB); decode before any validator reads the body.
  app.use("/v1/*", async (c, next) => {
    const encoding = c.req.header("content-encoding")?.toLowerCase();
    if (!encoding || encoding === "identity" || !c.req.raw.body) return next();
    if (encoding !== "gzip" && encoding !== "deflate") {
      return c.json({ error: `unsupported content-encoding: ${encoding}` }, 415);
    }
    const headers = new Headers(c.req.raw.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    c.req.raw = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body.pipeThrough(new DecompressionStream(encoding)),
      duplex: "half",
    } as RequestInit);
    return next();
  });
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
