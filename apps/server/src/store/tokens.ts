import type { Database } from "bun:sqlite";

const hash = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");

/**
 * API tokens. Tokens are 256-bit random values, so a plain SHA-256 is enough
 * (no slow KDF needed) and verification is a single indexed lookup. Verified
 * tokens are cached in memory and revalidated (and `last_used_at` written) at
 * most once a minute.
 */
export class TokenStore {
  private cache = new Map<string, { id: string; touchedAt: number }>();

  constructor(private db: Database) {}

  create(name: string): { id: string; token: string } {
    const id = Bun.randomUUIDv7();
    const token = `lofu_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}`;
    this.db
      .query("INSERT INTO api_tokens (id, name, hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, name, hash(token), Date.now());
    return { id, token };
  }

  list(): { id: string; name: string; created_at: number; last_used_at: number | null }[] {
    return this.db
      .query<{ id: string; name: string; created_at: number; last_used_at: number | null }, []>(
        "SELECT id, name, created_at, last_used_at FROM api_tokens ORDER BY created_at",
      )
      .all();
  }

  revoke(id: string): boolean {
    this.cache.clear();
    return this.db.query("DELETE FROM api_tokens WHERE id = ?").run(id).changes > 0;
  }

  verify(token: string): boolean {
    const h = hash(token);
    const now = Date.now();
    let entry = this.cache.get(h);
    if (!entry) {
      const row = this.db
        .query<{ id: string }, [string]>("SELECT id FROM api_tokens WHERE hash = ?")
        .get(h);
      if (!row) return false;
      entry = { id: row.id, touchedAt: 0 };
      this.cache.set(h, entry);
    }
    if (now - entry.touchedAt > 60_000) {
      // Doubles as revalidation: a token revoked by another process (admin CLI)
      // stops working within a minute.
      entry.touchedAt = now;
      const { changes } = this.db
        .query("UPDATE api_tokens SET last_used_at = ? WHERE id = ?")
        .run(now, entry.id);
      if (changes === 0) {
        this.cache.delete(h);
        return false;
      }
    }
    return true;
  }
}
