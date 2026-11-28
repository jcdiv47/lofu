import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ApiError,
  BatchBookmarks,
  BatchResult,
  Bookmark,
  BookmarkPage,
  BookmarkWithContent,
  CreateBookmark,
  CreateHighlight,
  GetBookmarkQuery,
  Highlight,
  HighlightPage,
  ListBookmarksQuery,
  ListHighlightsQuery,
  LookupBookmarks,
  LookupResult,
  RefetchBookmark,
  UpdateBookmark,
  UpdateHighlight,
  WaitQuery,
} from "@lofu/shared";
import type { Context } from "hono";
import { requireScope } from "../auth.ts";
import type { AppContext } from "../context.ts";
import { BadRequestError } from "../errors.ts";
import { FIGURE_SCHEME } from "../extract/figures.ts";
import { ARTICLE_IMAGE_WIDTH, markdownImages } from "../extract/images.ts";
import { resolveLink } from "../extract/links.ts";
import { markdownHeadings, sliceText } from "../extract/slice.ts";
import {
  badRequest,
  body,
  conflict,
  forbidden,
  IdParam,
  ifMatchSeq,
  json,
  notFound,
  optionalBody,
  waitMsOf,
} from "./util.ts";

const dec = new TextDecoder();
const BOOKMARKS = ["bookmarks"];
const HIGHLIGHTS = ["highlights"];

const HttpUrl = z
  .string()
  .min(1)
  .max(8192)
  .refine((u) => /^https?:\/\//i.test(u.trim()) && URL.canParse(u.trim()), {
    message: "must be an http(s) URL",
  });

const ContentQuery = z.object({
  format: z.enum(["html", "markdown", "text"]).default("html"),
  /** Start of the slice, in UTF-16 code units. */
  offset: z.coerce.number().int().min(0).optional(),
  /** At most this much (UTF-16 code units). */
  maxChars: z.coerce.number().int().min(1).optional(),
});

/** Weak (the same text goes out zstd-encoded or not): which content, as of when. */
const contentEtag = (extractedAt: number, format: string, slice: string) =>
  `W/"${extractedAt.toString(36)}-${format}${slice}"`;

function etagMatches(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => t.trim() === "*" || bare(t) === bare(etag));
}

export function bookmarkRoutes(app: OpenAPIHono, ctx: AppContext) {
  const { bookmarks, highlights } = ctx;

  /** Waits (when asked) for the bookmark's page to be read; the bookmark as it is then. */
  async function afterWait(id: string, ms: number) {
    if (ms > 0) await bookmarks.waitForExtraction(id, ms);
    return bookmarks.get(id);
  }

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/bookmarks",
      operationId: "createBookmark",
      tags: BOOKMARKS,
      summary: "Save a URL (idempotent on the normalized URL; short links are followed first)",
      description:
        "With `wait` or `waitMs`, answers once the page has been read (or failed), or when the " +
        "time is up, whichever is first; `contentStatus` says which.",
      request: { query: WaitQuery, ...body(CreateBookmark) },
      responses: {
        201: json(Bookmark, "Created (or revived from trash)"),
        200: json(Bookmark, "Already saved; provided fields merged"),
        400: badRequest,
        404: json(ApiError, "No such collection"),
      },
    }),
    async (c) => {
      const input = c.req.valid("json");
      const ms = waitMsOf(c.req.valid("query"));
      // A short link or wrapper becomes the page it leads to. Page HTML sent
      // along (the extension) already belongs to the page the browser is on.
      if (!input.html) input.url = await resolveLink(input.url);
      const { bookmark, created } = bookmarks.create(input);
      const out = ms > 0 ? await afterWait(bookmark.id, ms) : bookmark;
      return c.json(out, created ? 201 : 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/bookmarks",
      operationId: "listBookmarks",
      tags: BOOKMARKS,
      summary: "List bookmarks, newest first by default (keyset pagination)",
      request: { query: ListBookmarksQuery },
      responses: { 200: json(BookmarkPage, "A page of bookmarks"), 400: badRequest },
    }),
    (c) => c.json(bookmarks.list(c.req.valid("query")), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/bookmarks/lookup",
      operationId: "lookupBookmark",
      tags: BOOKMARKS,
      summary: "Find the bookmark for a URL (compared after unwrapping and normalization)",
      request: { query: z.object({ url: HttpUrl }) },
      responses: { 200: json(Bookmark, "The bookmark"), 400: badRequest, 404: notFound },
    }),
    (c) => c.json(bookmarks.findByUrl(c.req.valid("query").url), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/bookmarks/lookup",
      operationId: "lookupBookmarks",
      tags: BOOKMARKS,
      summary: "Find the bookmarks of many URLs at once (a read: needs only the read scope)",
      request: body(LookupBookmarks),
      responses: { 200: json(LookupResult, "Each URL's bookmark, or null"), 400: badRequest },
    }),
    (c) => c.json({ items: bookmarks.findManyByUrl(c.req.valid("json").urls) }, 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/bookmarks/batch",
      operationId: "batchBookmarks",
      tags: BOOKMARKS,
      summary: "Apply one patch to many bookmarks, or delete them, in one transaction",
      description:
        "Exactly one of `patch` and `delete: true`. Deleting needs the delete scope. Ids " +
        "without a live bookmark are skipped and listed in `missingIds`.",
      request: body(BatchBookmarks),
      responses: {
        200: json(BatchResult, "What changed"),
        400: badRequest,
        403: forbidden,
        404: json(ApiError, "No such collection"),
      },
    }),
    (c) => {
      const { ids, patch, delete: del } = c.req.valid("json");
      if ((patch !== undefined) === (del === true)) {
        throw new BadRequestError("give either patch or delete: true");
      }
      if (del) {
        requireScope(c, "delete");
        return c.json(bookmarks.batch(ids, { delete: true }), 200);
      }
      if (!patch || Object.keys(patch).length === 0) throw new BadRequestError("patch is empty");
      return c.json(bookmarks.batch(ids, { patch }), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/bookmarks/{id}",
      operationId: "getBookmark",
      tags: BOOKMARKS,
      summary: "Get a bookmark, optionally with its extracted content",
      description:
        "`contentOffset`/`contentMaxChars` return a slice of the content (with its total " +
        "length and, for Markdown, its headings). `include` picks what comes along: without " +
        "it, Markdown content comes with its images and formulas.",
      request: { params: IdParam, query: GetBookmarkQuery },
      responses: {
        200: json(BookmarkWithContent, "The bookmark"),
        400: badRequest,
        404: notFound,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { content: format, include, contentOffset, contentMaxChars } = c.req.valid("query");
      const b = bookmarks.get(id);
      const blob = format === "none" ? null : bookmarks.contentBlob(id, format);
      let content = blob ? dec.decode(Bun.zstdDecompressSync(blob)) : null;
      const withMedia = include === undefined || include.includes("media");
      const withHighlights = include?.includes("highlights") ?? false;

      let sliced = {};
      if (content !== null && (contentOffset !== undefined || contentMaxChars !== undefined)) {
        const s = sliceText(content, contentOffset ?? 0, contentMaxChars ?? content.length);
        sliced = {
          contentTotalChars: content.length,
          contentOffset: s.offset,
          contentHasMore: s.end < content.length,
          ...(format === "markdown" ? { headings: markdownHeadings(content) } : {}),
        };
        content = s.text;
      }

      let images = null;
      let formulas = null;
      if (content !== null && format === "markdown" && withMedia) {
        const md = content;
        formulas = await ctx.math.list(md);
        const sizes = bookmarks.imageSizes(id) ?? {};
        const figures = md.includes(FIGURE_SCHEME) ? bookmarks.figureSizes(id) : null;
        images = markdownImages(md).map((src) => {
          if (figures && src.startsWith(FIGURE_SCHEME)) {
            const hash = src.slice(FIGURE_SCHEME.length);
            const size = figures.get(hash);
            return {
              src,
              width: size?.[0] ?? null,
              height: size?.[1] ?? null,
              proxy: `/figures/${hash}`,
            };
          }
          return {
            src,
            width: sizes[src]?.[0] ?? null,
            height: sizes[src]?.[1] ?? null,
            proxy: ctx.images.path(src, ARTICLE_IMAGE_WIDTH),
          };
        });
      }
      const hl = withHighlights ? highlights.listFor(id) : undefined;
      return c.json(
        {
          ...b,
          content,
          contentFormat: format,
          images,
          formulas,
          highlightCount: hl?.length ?? bookmarks.highlightCount(id),
          ...(hl ? { highlights: hl } : {}),
          ...sliced,
        },
        200,
      );
    },
  );

  // Not a JSON route: streams the stored zstd blob as-is when the client
  // accepts zstd (zero server CPU), else decompresses. Documented below.
  app.get("/v1/bookmarks/:id/content", (c) => serveContent(c));

  function serveContent(c: Context) {
    const id = c.req.param("id") ?? "";
    const parsed = ContentQuery.safeParse(c.req.query());
    if (!parsed.success) {
      throw new BadRequestError("format must be html, markdown or text", parsed.error.issues);
    }
    const { format, offset, maxChars } = parsed.data;
    const b = bookmarks.get(id);
    const blob = bookmarks.contentBlob(id, format);
    if (!blob) {
      return c.json({ error: "content not extracted yet", code: "NOT_FOUND" }, 404);
    }
    const slicing = offset !== undefined || maxChars !== undefined;
    const extractedAt = b.extractedAt ? Date.parse(b.extractedAt) : null;
    const etag =
      extractedAt === null
        ? null
        : contentEtag(extractedAt, format, slicing ? `-${offset ?? 0}-${maxChars ?? ""}` : "");
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
    if (etag) headers.etag = etag;
    if (etag && etagMatches(c.req.header("if-none-match"), etag)) {
      return c.body(null, 304, {
        etag,
        vary: "accept-encoding",
        "cache-control": headers["cache-control"]!,
      });
    }
    if (slicing) {
      const text = dec.decode(Bun.zstdDecompressSync(blob));
      const s = sliceText(text, offset ?? 0, maxChars ?? text.length);
      headers["x-content-total-chars"] = String(text.length);
      headers["x-content-offset"] = String(s.offset);
      headers["x-content-has-more"] = String(s.end < text.length);
      return c.body(s.text, 200, headers);
    }
    if (/\bzstd\b/.test(c.req.header("accept-encoding") ?? "")) {
      headers["content-encoding"] = "zstd";
      return c.body(blob as Uint8Array<ArrayBuffer>, 200, headers);
    }
    return c.body(Bun.zstdDecompressSync(blob) as Uint8Array<ArrayBuffer>, 200, headers);
  }

  app.openAPIRegistry.registerPath({
    method: "get",
    path: "/v1/bookmarks/{id}/content",
    operationId: "getBookmarkContent",
    tags: BOOKMARKS,
    summary: "The extracted content as a document (zstd passed through when accepted)",
    description:
      "Sends the stored, zstd-compressed content untouched to a client that accepts zstd. " +
      "Has an ETag (If-None-Match gets 304). `offset`/`maxChars` return a slice, with " +
      "X-Content-Total-Chars, X-Content-Offset and X-Content-Has-More headers.",
    request: { params: IdParam, query: ContentQuery },
    responses: {
      200: {
        description: "The content",
        headers: {
          ETag: { schema: { type: "string" } },
          "X-Content-Total-Chars": { schema: { type: "integer" } },
          "X-Content-Offset": { schema: { type: "integer" } },
          "X-Content-Has-More": { schema: { type: "boolean" } },
        },
        content: {
          "text/html": { schema: z.string() },
          "text/markdown": { schema: z.string() },
          "text/plain": { schema: z.string() },
        },
      },
      304: { description: "Not modified (If-None-Match)" },
      400: badRequest,
      404: json(ApiError, "No such bookmark, or no content yet"),
    },
  });

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/bookmarks/{id}",
      operationId: "updateBookmark",
      tags: BOOKMARKS,
      summary: "Update a bookmark",
      description:
        "`addTags`/`removeTags` change the tags it has (not with `tags`). With `expectedSeq` " +
        '(or `If-Match: "<seq>"`), the update is refused with 409 SEQ_CONFLICT if the bookmark ' +
        "changed since.",
      request: { params: IdParam, ...body(UpdateBookmark) },
      responses: {
        200: json(Bookmark, "Updated"),
        400: badRequest,
        404: notFound,
        409: conflict,
      },
    }),
    (c) =>
      c.json(
        bookmarks.update(c.req.valid("param").id, c.req.valid("json"), {
          expectedSeq: ifMatchSeq(c),
        }),
        200,
      ),
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/bookmarks/{id}",
      operationId: "deleteBookmark",
      tags: BOOKMARKS,
      summary: "Delete a bookmark (and its highlights)",
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
      operationId: "refetchBookmark",
      tags: BOOKMARKS,
      summary: "Re-fetch and re-extract the page (its title, excerpt and cover too)",
      description:
        "An optional body `{ html }` gives the page as the client's browser has it (not " +
        "fetched then). With `wait`/`waitMs`, answers 200 once it's read, or 202 while it's " +
        "still pending. The title, excerpt and cover change only if the page is read.",
      request: { params: IdParam, query: WaitQuery, ...optionalBody(RefetchBookmark) },
      responses: {
        202: json(Bookmark, "Queued"),
        200: json(Bookmark, "Read (with wait)"),
        404: notFound,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const ms = waitMsOf(c.req.valid("query"));
      const queued = bookmarks.refetch(id, {
        html: (c.req.valid("json") as { html?: string } | undefined)?.html,
      });
      if (ms === 0) return c.json(queued, 202);
      const b = await afterWait(id, ms);
      return c.json(b, b.contentStatus === "pending" ? 202 : 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/bookmarks/{id}/highlights",
      operationId: "listBookmarkHighlights",
      tags: HIGHLIGHTS,
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
      operationId: "createHighlight",
      tags: HIGHLIGHTS,
      summary: "Add a highlight (idempotent on a client-given id)",
      request: { params: IdParam, ...body(CreateHighlight) },
      responses: {
        201: json(Highlight, "Created"),
        200: json(Highlight, "Already made with this id; unchanged"),
        404: notFound,
        409: json(ApiError, "The id belongs to another highlight"),
      },
    }),
    (c) => {
      const { highlight, created } = highlights.create(
        c.req.valid("param").id,
        c.req.valid("json"),
      );
      return created ? c.json(highlight, 201) : c.json(highlight, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/highlights",
      operationId: "listHighlights",
      tags: HIGHLIGHTS,
      summary:
        "Highlights across the library, newest first, with their bookmark (keyset pagination)",
      request: { query: ListHighlightsQuery },
      responses: { 200: json(HighlightPage, "A page of highlights"), 400: badRequest },
    }),
    (c) => c.json(highlights.list(c.req.valid("query")), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/highlights/{id}",
      operationId: "getHighlight",
      tags: HIGHLIGHTS,
      summary: "Get a highlight",
      request: { params: IdParam },
      responses: { 200: json(Highlight, "The highlight"), 404: notFound },
    }),
    (c) => c.json(highlights.get(c.req.valid("param").id), 200),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/highlights/{id}",
      operationId: "updateHighlight",
      tags: HIGHLIGHTS,
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
      operationId: "deleteHighlight",
      tags: HIGHLIGHTS,
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
