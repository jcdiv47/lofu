import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  Bookmark,
  BookmarkPage,
  BookmarkWithContent,
  ContentFormat,
  CreateBookmark,
  CreateHighlight,
  Highlight,
  ListBookmarksQuery,
  UpdateBookmark,
  UpdateHighlight,
} from "@lofu/shared";
import type { AppContext } from "../context.ts";
import { ARTICLE_IMAGE_WIDTH, markdownImages } from "../extract/images.ts";
import { resolveLink } from "../extract/links.ts";
import { body, IdParam, json, notFound } from "./util.ts";

const dec = new TextDecoder();

export function bookmarkRoutes(app: OpenAPIHono, ctx: AppContext) {
  const { bookmarks, highlights } = ctx;

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/bookmarks",
      summary: "Save a URL (idempotent on the normalized URL; short links are followed first)",
      request: body(CreateBookmark),
      responses: {
        201: json(Bookmark, "Created (or revived from trash)"),
        200: json(Bookmark, "Already saved; provided fields merged"),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      // A short link or wrapper becomes the page it leads to. Page HTML sent
      // along (the extension) already belongs to the page the browser is on.
      if (!input.html) input.url = await resolveLink(input.url);
      const { bookmark, created } = bookmarks.create(input);
      return c.json(bookmark, created ? 201 : 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/bookmarks",
      summary: "List bookmarks, newest first (keyset pagination)",
      request: { query: ListBookmarksQuery },
      responses: { 200: json(BookmarkPage, "A page of bookmarks") },
    }),
    (c) => c.json(bookmarks.list(c.req.valid("query")), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/bookmarks/lookup",
      summary: "Find the bookmark for a URL (compared after normalization)",
      request: { query: z.object({ url: z.string().min(1) }) },
      responses: { 200: json(Bookmark, "The bookmark"), 404: notFound },
    }),
    (c) => c.json(bookmarks.findByUrl(c.req.valid("query").url), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/bookmarks/{id}",
      summary: "Get a bookmark, optionally with its extracted content",
      request: {
        params: IdParam,
        query: z.object({ content: ContentFormat.default("none") }),
      },
      responses: { 200: json(BookmarkWithContent, "The bookmark"), 404: notFound },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { content: format } = c.req.valid("query");
      const b = bookmarks.get(id);
      const blob = format === "none" ? null : bookmarks.contentBlob(id, format);
      const content = blob ? dec.decode(Bun.zstdDecompressSync(blob)) : null;
      let images = null;
      let formulas = null;
      if (content !== null && format === "markdown") {
        formulas = await ctx.math.list(content);
        const sizes = bookmarks.imageSizes(id) ?? {};
        images = markdownImages(content).map((src) => ({
          src,
          width: sizes[src]?.[0] ?? null,
          height: sizes[src]?.[1] ?? null,
          proxy: ctx.images.path(src, ARTICLE_IMAGE_WIDTH),
        }));
      }
      return c.json({ ...b, content, contentFormat: format, images, formulas }, 200);
    },
  );

  // Not part of the JSON API surface: streams the stored zstd blob as-is when
  // the client accepts zstd (zero server CPU), else decompresses.
  app.get("/v1/bookmarks/:id/content", (c) => {
    const id = c.req.param("id");
    const format = c.req.query("format") ?? "html";
    if (format !== "html" && format !== "markdown" && format !== "text") {
      return c.json({ error: "format must be html, markdown or text" }, 400);
    }
    bookmarks.get(id);
    const blob = bookmarks.contentBlob(id, format);
    if (!blob) return c.json({ error: "content not extracted yet" }, 404);
    const type =
      format === "html" ? "text/html" : format === "markdown" ? "text/markdown" : "text/plain";
    const headers: Record<string, string> = {
      "content-type": `${type}; charset=utf-8`,
      vary: "accept-encoding",
      "cache-control": "private, no-cache",
      // The page's own HTML, served from the API's origin: opened as a
      // document it must not run scripts or load anything there.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    };
    if (/\bzstd\b/.test(c.req.header("accept-encoding") ?? "")) {
      headers["content-encoding"] = "zstd";
      return c.body(blob as Uint8Array<ArrayBuffer>, 200, headers);
    }
    return c.body(Bun.zstdDecompressSync(blob) as Uint8Array<ArrayBuffer>, 200, headers);
  });

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/bookmarks/{id}",
      summary: "Update a bookmark",
      request: { params: IdParam, ...body(UpdateBookmark) },
      responses: { 200: json(Bookmark, "Updated"), 404: notFound },
    }),
    (c) => c.json(bookmarks.update(c.req.valid("param").id, c.req.valid("json")), 200),
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/bookmarks/{id}",
      summary: "Delete a bookmark",
      request: { params: IdParam },
      responses: { 204: { description: "Deleted" }, 404: notFound },
    }),
    (c) => {
      bookmarks.delete(c.req.valid("param").id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/bookmarks/{id}/refetch",
      summary: "Re-fetch and re-extract the page (its title, excerpt and cover too)",
      request: { params: IdParam },
      responses: { 202: json(Bookmark, "Queued"), 404: notFound },
    }),
    (c) => c.json(bookmarks.refetch(c.req.valid("param").id), 202),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/bookmarks/{id}/highlights",
      summary: "List highlights of a bookmark",
      request: { params: IdParam },
      responses: { 200: json(z.array(Highlight), "Highlights"), 404: notFound },
    }),
    (c) => c.json(highlights.listFor(c.req.valid("param").id), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/bookmarks/{id}/highlights",
      summary: "Add a highlight",
      request: { params: IdParam, ...body(CreateHighlight) },
      responses: { 201: json(Highlight, "Created"), 404: notFound },
    }),
    (c) => c.json(highlights.create(c.req.valid("param").id, c.req.valid("json")), 201),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/highlights/{id}",
      summary: "Update a highlight's note or color",
      request: { params: IdParam, ...body(UpdateHighlight) },
      responses: { 200: json(Highlight, "Updated"), 404: notFound },
    }),
    (c) => c.json(highlights.update(c.req.valid("param").id, c.req.valid("json")), 200),
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/highlights/{id}",
      summary: "Delete a highlight",
      request: { params: IdParam },
      responses: { 204: { description: "Deleted" }, 404: notFound },
    }),
    (c) => {
      highlights.delete(c.req.valid("param").id);
      return c.body(null, 204);
    },
  );
}
