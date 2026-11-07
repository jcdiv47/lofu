import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import {
  ApiError,
  Collection,
  CreateCollection,
  RenameTag,
  SearchQuery,
  SearchResult,
  SyncQuery,
  SyncResponse,
  TagChange,
  TagCount,
  TagName,
  UpdateCollection,
} from "@lofu/shared";
import type { AppContext } from "../context.ts";
import { syncSince } from "../store/sync.ts";
import { body, IdParam, json, notFound } from "./util.ts";

export function miscRoutes(app: OpenAPIHono, ctx: AppContext) {
  const { collections, bookmarks } = ctx;

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/search",
      summary: "Full-text search (Meilisearch); filters mirror the list endpoint",
      request: { query: SearchQuery },
      responses: {
        200: json(SearchResult, "Results"),
        503: json(ApiError, "Search is not configured"),
      },
    }),
    async (c) => {
      if (!ctx.searcher) return c.json({ error: "search is not configured (set MEILI_URL)" }, 503);
      return c.json(await ctx.searcher.search(c.req.valid("query")), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/v1/tags",
      summary: "All tags with bookmark counts",
      responses: { 200: json(z.array(TagCount), "Tags") },
    }),
    (c) => c.json(bookmarks.tagCounts(), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/tags/rename",
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
      summary: "List collections (flat; build the tree from parentId)",
      responses: { 200: json(z.array(Collection), "Collections") },
    }),
    (c) => c.json(collections.list(), 200),
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/v1/collections",
      summary: "Create a collection",
      request: body(CreateCollection),
      responses: { 201: json(Collection, "Created") },
    }),
    (c) => c.json(collections.create(c.req.valid("json")), 201),
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/v1/collections/{id}",
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
      path: "/v1/sync",
      summary: "Changes since a cursor (for offline clients)",
      request: { query: SyncQuery },
      responses: { 200: json(SyncResponse, "Changes") },
    }),
    (c) => {
      const { since, limit } = c.req.valid("query");
      return c.json(syncSince(ctx.db, ctx.images, since, limit), 200);
    },
  );
}
