import { SQLiteError } from "bun:sqlite";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { compress } from "hono/compress";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { grant, requireScope, scopeFor } from "./auth.ts";
import type { AppContext } from "./context.ts";
import { HttpError, readCapped } from "./errors.ts";
import { FIGURE_HASH } from "./extract/figures.ts";
import { bookmarkRoutes } from "./routes/bookmarks.ts";
import { importRoutes } from "./routes/imports.ts";
import { miscRoutes } from "./routes/misc.ts";
import { json } from "./routes/util.ts";
import { MeiliError } from "./search/meili.ts";
import { ALL_SCOPES } from "./store/tokens.ts";
import { VERSION } from "./version.ts";

export { VERSION };

/** The most a compressed upload may grow to once decoded. */
export const MAX_DECODED_BYTES = 32 * 1024 * 1024;

const fail = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 500 | 503,
  code: string,
  error: string,
  details?: unknown,
) => c.json({ error, code, ...(details === undefined ? {} : { details }) }, status);

export function createApp(ctx: AppContext) {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return fail(c, 400, "INVALID_REQUEST", "invalid request", result.error.issues);
      }
    },
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return fail(c, err.status, err.code, err.message, err.details);
    // Bad input found inside a store or parser (a cursor, a URL, a CSV).
    if (err instanceof RangeError) return fail(c, 400, "INVALID_REQUEST", err.message);
    if (err instanceof HTTPException) {
      const status = err.status === 413 ? 413 : err.status < 500 ? 400 : 500;
      const code =
        status === 413
          ? "PAYLOAD_TOO_LARGE"
          : status === 400
            ? "INVALID_REQUEST"
            : "INTERNAL_ERROR";
      return fail(c, status, code, err.message);
    }
    if (err instanceof SQLiteError && err.code?.startsWith("SQLITE_CONSTRAINT")) {
      const msg =
        err.code === "SQLITE_CONSTRAINT_FOREIGNKEY" ? "referenced item does not exist" : "conflict";
      return fail(c, 409, "CONFLICT", msg, err.message);
    }
    if (err instanceof MeiliError) {
      console.error(err);
      return fail(c, 503, "SEARCH_UNAVAILABLE", "search is unavailable");
    }
    console.error(err);
    return fail(c, 500, "INTERNAL_ERROR", "internal error");
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
      allowHeaders: [
        "authorization",
        "content-type",
        "content-encoding",
        "if-match",
        "if-none-match",
      ],
      exposeHeaders: ["etag", "x-content-total-chars", "x-content-offset", "x-content-has-more"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 86_400,
    }),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/health",
      operationId: "health",
      tags: ["meta"],
      summary: "Liveness, version, and whether Meilisearch answers (null: not configured)",
      security: [],
      responses: {
        200: json(
          z
            .object({
              ok: z.boolean(),
              version: z.string(),
              commit: z.string(),
              search: z.boolean().nullable(),
            })
            .meta({ id: "Health" }),
          "Up",
        ),
      },
    }),
    async (c) =>
      c.json(
        {
          ok: true,
          version: VERSION,
          commit: ctx.config.commit,
          search: ctx.searcher.engine === "meilisearch" ? await ctx.meiliHealthy() : null,
        },
        200,
      ),
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
  // pages of several MB); decode before any validator reads the body, up to
  // MAX_DECODED_BYTES (a small gzip can decode to gigabytes).
  app.use("/v1/*", async (c, next) => {
    const encoding = c.req.header("content-encoding")?.toLowerCase();
    const raw = c.req.raw;
    if (!raw.body) {
      // No body: a JSON content type alone mustn't read as malformed JSON
      // where the body is optional (refetch).
      if (raw.headers.has("content-type") && raw.method !== "GET" && raw.method !== "HEAD") {
        const headers = new Headers(raw.headers);
        headers.delete("content-type");
        c.req.raw = new Request(raw.url, { method: raw.method, headers });
      }
      return next();
    }
    if (!encoding || encoding === "identity") return next();
    if (encoding !== "gzip" && encoding !== "deflate") {
      return fail(c, 415, "UNSUPPORTED_MEDIA_TYPE", `unsupported content-encoding: ${encoding}`);
    }
    const decoded = await readCapped(
      raw.body.pipeThrough(new DecompressionStream(encoding)),
      MAX_DECODED_BYTES,
    );
    const headers = new Headers(raw.headers);
    headers.delete("content-encoding");
    headers.set("content-length", String(decoded.byteLength));
    c.req.raw = new Request(raw.url, { method: raw.method, headers, body: decoded });
    return next();
  });
  app.use("/v1/*", async (c, next) => {
    if (ctx.config.authDisabled) {
      grant(c, ALL_SCOPES);
      return next();
    }
    const header = c.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const scopes = token ? ctx.tokens.verify(token) : null;
    if (!scopes) return fail(c, 401, "UNAUTHORIZED", "unauthorized");
    grant(c, scopes);
    requireScope(c, scopeFor(c.req.method, c.req.path));
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
