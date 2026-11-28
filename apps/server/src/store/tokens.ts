import type { Database } from "bun:sqlite";
import { TokenScope } from "@lofu/shared";

const hash = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");

export const ALL_SCOPES: readonly TokenScope[] = TokenScope.options;

/** Scopes as stored (a JSON array); unknown names are dropped. */
function parseScopes(raw: string): TokenScope[] {
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return ALL_SCOPES.filter((s) => list.includes(s));
  } catch {
    return [];
  }
}

/** `read,write` as typed (admin CLI) to scopes; throws on an unknown one. */
export function scopesFrom(csv: string): TokenScope[] {
  const names = csv
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = names.filter((n) => !(ALL_SCOPES as readonly string[]).includes(n));
  if (bad.length || names.length === 0) {
    throw new RangeError(`scopes must be some of ${ALL_SCOPES.join(", ")}; got ${csv}`);
  }
  return ALL_SCOPES.filter((s) => names.includes(s));
}

export interface TokenInfo {
  id: string;
  name: string;
  scopes: TokenScope[];
  created_at: number;
  last_used_at: number | null;
}

/**
 * API tokens. Tokens are 256-bit random values, so a plain SHA-256 is enough
 * (no slow KDF needed) and verification is a single indexed lookup. Verified
 * tokens are cached in memory and revalidated (and `last_used_at` written) at
 * most once a minute; a change of scopes takes effect then too.
 */
export class TokenStore {
  private cache = new Map<string, { id: string; scopes: TokenScope[]; touchedAt: number }>();

  constructor(private db: Database) {}

  create(
    name: string,
    scopes: readonly TokenScope[] = ALL_SCOPES,
  ): { id: string; token: string; scopes: TokenScope[] } {
    const id = Bun.randomUUIDv7();
    const token = `lofu_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    const kept = ALL_SCOPES.filter((s) => scopes.includes(s));
    this.db
      .query("INSERT INTO api_tokens (id, name, hash, created_at, scopes) VALUES (?, ?, ?, ?, ?)")
      .run(id, name, hash(token), Date.now(), JSON.stringify(kept));
    return { id, token, scopes: kept };
  }

  list(): TokenInfo[] {
    return this.db
      .query<Omit<TokenInfo, "scopes"> & { scopes: string }, []>(
        "SELECT id, name, scopes, created_at, last_used_at FROM api_tokens ORDER BY created_at",
      )
      .all()
      .map((t) => ({ ...t, scopes: parseScopes(t.scopes) }));
  }

  revoke(id: string): boolean {
    this.cache.clear();
    return this.db.query("DELETE FROM api_tokens WHERE id = ?").run(id).changes > 0;
  }

  /** The token's scopes, or null when it isn't a token (or was revoked). */
  verify(token: string): TokenScope[] | null {
    const h = hash(token);
    const now = Date.now();
    let entry = this.cache.get(h);
    if (!entry) {
      const row = this.db
        .query<{ id: string; scopes: string }, [string]>(
          "SELECT id, scopes FROM api_tokens WHERE hash = ?",
        )
        .get(h);
      if (!row) return null;
      entry = { id: row.id, scopes: parseScopes(row.scopes), touchedAt: 0 };
      this.cache.set(h, entry);
    }
    if (now - entry.touchedAt > 60_000) {
      // Doubles as revalidation: a token revoked by another process (admin CLI)
      // stops working within a minute.
      entry.touchedAt = now;
      const row = this.db
        .query<{ scopes: string }, [number, string]>(
          "UPDATE api_tokens SET last_used_at = ? WHERE id = ? RETURNING scopes",
        )
        .get(now, entry.id);
      if (!row) {
        this.cache.delete(h);
        return null;
      }
      entry.scopes = parseScopes(row.scopes);
    }
    return entry.scopes;
  }
}
