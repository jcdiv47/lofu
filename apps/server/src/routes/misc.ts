import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ApiError,
  Capabilities,
  Collection,
  CollectionWithCount,
  CreateCollection,
  ListTagsQuery,
  RenameTag,
  SearchQuery,
  SearchResult,
  Settings,
  Stats,
  SyncQuery,
  SyncResponse,
  TagChange,
  TagCount,
  TagName,
  UpdateCollection,
  UpdateSettings,
} from "@lofu/shared";
import { scopesOf } from "../auth.ts";
import type { AppContext } from "../context.ts";
import { syncSince } from "../store/sync.ts";
import { VERSION } from "../version.ts";
import { badRequest, body, IdParam, json, notFound } from "./util.ts";

const t = (...tags: string[]) => tags;

export function miscRoutes(app: OpenAPIHono, ctx: AppContext) {
  const { collections, bookmarks } = ctx;

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/search",
      operationId: "search",
      tags: t("search"),
      summary: "Full-text search; filters mirror the list endpoint",
      description:
        "Meilisearch answers word searches when it is configured; the database answers " +
        "queries of conditions only, and every query when Meilisearch isn't configured " +
        "(`engine` says which).",
      request: { query: SearchQuery },
      responses: {
        200: json(SearchResult, "Results"),
        400: badRequest,
        503: json(ApiError, "Search failed (code SEARCH_UNAVAILABLE)"),
      },
    }),
    async (c) => c.json(await ctx.searcher.search(c.req.valid("query")), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/tags",
      operationId: "listTags",
      tags: t("tags"),
      summary: "All tags with bookmark counts (the Trash's left out unless includeTrashed)",
      request: { query: ListTagsQuery },
      responses: { 200: json(z.array(TagCount), "Tags") },
    }),
    (c) => c.json(bookmarks.tagCounts(c.req.valid("query")), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/tags/rename",
      operationId: "renameTag",
      tags: t("tags"),
      summary: "Rename a tag on every bookmark (merges into `to` where it already exists)",
      request: body(RenameTag),
      responses: { 200: json(TagChange, "Bookmarks changed") },
    }),
    (c) => {
      const { from, to } = c.req.valid("json");
      return c.json({ updated: bookmarks.renameTag(from, to) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/tags/{name}",
      operationId: "deleteTag",
      tags: t("tags"),
      summary: "Remove a tag from every bookmark",
      request: { params: z.object({ name: TagName }) },
      responses: { 200: json(TagChange, "Bookmarks changed") },
    }),
    (c) => c.json({ updated: bookmarks.deleteTag(c.req.valid("param").name) }, 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/collections",
      operationId: "listCollections",
      tags: t("collections"),
      summary: "List collections (flat; build the tree from parentId), with bookmark counts",
      responses: { 200: json(z.array(CollectionWithCount), "Collections") },
    }),
    (c) => c.json(collections.list(), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/collections",
      operationId: "createCollection",
      tags: t("collections"),
      summary: "Create a collection",
      request: body(CreateCollection),
      responses: { 201: json(Collection, "Created") },
    }),
    (c) => c.json(collections.create(c.req.valid("json")), 201),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/collections/{id}",
      operationId: "getCollection",
      tags: t("collections"),
      summary: "Get a collection, with its bookmark count",
      request: { params: IdParam },
      responses: { 200: json(CollectionWithCount, "The collection"), 404: notFound },
    }),
    (c) => c.json(collections.getWithCount(c.req.valid("param").id), 200),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/collections/{id}",
      operationId: "updateCollection",
      tags: t("collections"),
      summary: "Rename, move or recolor a collection",
      request: { params: IdParam, ...body(UpdateCollection) },
      responses: { 200: json(Collection, "Updated"), 404: notFound },
    }),
    (c) => c.json(collections.update(c.req.valid("param").id, c.req.valid("json")), 200),
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/v1/collections/{id}",
      operationId: "deleteCollection",
      tags: t("collections"),
      summary: "Delete a collection; its bookmarks become unsorted",
      request: { params: IdParam },
      responses: { 204: { description: "Deleted" }, 404: notFound },
    }),
    (c) => {
      collections.delete(c.req.valid("param").id);
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/settings",
      operationId: "getSettings",
      tags: t("settings"),
      summary: "Settings shared by every client",
      responses: { 200: json(Settings, "Settings") },
    }),
    (c) => c.json(ctx.settings.get(), 200),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/settings",
      operationId: "updateSettings",
      tags: t("settings"),
      summary:
        "Change settings. A site added to skipDomains stops being read (its failed bookmarks " +
        "become skipped); one taken off is read again",
      request: body(UpdateSettings),
      responses: { 200: json(Settings, "Settings") },
    }),
    (c) => c.json(ctx.settings.update(c.req.valid("json")), 200),
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/sync",
      operationId: "sync",
      tags: t("sync"),
      summary: "Changes since a cursor (for offline clients)",
      request: { query: SyncQuery },
      responses: { 200: json(SyncResponse, "Changes") },
    }),
    (c) => {
      const { since, limit } = c.req.valid("query");
      return c.json(syncSince(ctx.db, ctx.images, since, limit), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/stats",
      operationId: "getStats",
      tags: t("meta"),
      summary: "Counts across the library",
      responses: { 200: json(Stats, "Counts") },
    }),
    (c) => {
      const s = bookmarks.stats();
      return c.json(s, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/capabilities",
      operationId: "getCapabilities",
      tags: t("meta"),
      summary: "What this server can do, and what the calling token may",
      responses: { 200: json(Capabilities, "Capabilities") },
    }),
    (c) =>
      c.json(
        {
          version: VERSION,
          commit: ctx.config.commit,
          search: ctx.searcher.engine,
          semanticSearch: ctx.searcher.semanticAvailable,
          browserExtraction: ctx.features.browser,
          pdfExtraction: ctx.features.pdf,
          scopes: [...scopesOf(c)],
        },
        200,
      ),
  );
}
