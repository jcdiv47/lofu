import type { TokenScope } from "@lofu/shared";
import type { Context } from "hono";
import { ForbiddenError } from "./errors.ts";

/** The scopes of the request's token, set by the /v1 auth middleware (app.ts). */
const granted = new WeakMap<object, readonly TokenScope[]>();

export function grant(c: Context, scopes: readonly TokenScope[]): void {
  granted.set(c, scopes);
}

export function scopesOf(c: Context): readonly TokenScope[] {
  return granted.get(c) ?? [];
}

export function requireScope(c: Context, scope: TokenScope): void {
  if (!scopesOf(c).includes(scope)) {
    throw new ForbiddenError(`this token lacks the "${scope}" scope`);
  }
}

/**
 * The scope a /v1 request needs, by method and path: reading for GET (and
 * the lookup of URLs, a POST only for its body); deleting for DELETE (a
 * batch delete is checked by its route); `admin` for settings and imports;
 * writing for the rest.
 */
export function scopeFor(method: string, path: string): TokenScope {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return "read";
  if (m === "POST" && path === "/v1/bookmarks/lookup") return "read";
  if (m === "DELETE") return "delete";
  if ((m === "PATCH" && path === "/v1/settings") || path.startsWith("/v1/import/")) return "admin";
  return "write";
}
