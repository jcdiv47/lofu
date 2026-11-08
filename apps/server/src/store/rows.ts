import type { Bookmark, BookmarkType, Collection, ContentStatus, Highlight } from "@lofu/shared";
import type { ImageProxy } from "../extract/images.ts";

export interface BookmarkRow {
  id: string;
  url: string;
  url_key: string;
  title: string;
  title_locked: number;
  excerpt: string | null;
  note: string | null;
  cover_url: string | null;
  favicon_url: string | null;
  domain: string;
  type: string;
  tags: string;
  collection_id: string | null;
  favorite: number;
  archived: number;
  read_progress: number;
  word_count: number | null;
  lang: string | null;
  author: string | null;
  published_at: string | null;
  content_status: string;
  content_error: string | null;
  sort: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  seq: number;
}

export interface CollectionRow {
  id: string;
  name: string;
  parent_id: string | null;
  sort: number;
  color: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  seq: number;
}

export interface HighlightRow {
  id: string;
  bookmark_id: string;
  quote: string;
  prefix: string;
  suffix: string;
  note: string | null;
  color: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  seq: number;
}

const iso = (ms: number) => new Date(ms).toISOString();
const isoOrNull = (ms: number | null) => (ms === null ? null : iso(ms));

/** `images` signs the cover's proxy path (`coverProxy` is computed, not stored). */
export function toBookmark(r: BookmarkRow, images: ImageProxy): Bookmark {
  return {
    id: r.id,
    url: r.url,
    title: r.title,
    excerpt: r.excerpt,
    note: r.note,
    coverUrl: r.cover_url,
    coverProxy: images.coverPath(r.cover_url, r.url),
    faviconUrl: r.favicon_url,
    domain: r.domain,
    type: r.type as BookmarkType,
    tags: JSON.parse(r.tags) as string[],
    collectionId: r.collection_id,
    favorite: r.favorite === 1,
    archived: r.archived === 1,
    readProgress: r.read_progress,
    wordCount: r.word_count,
    lang: r.lang,
    author: r.author,
    publishedAt: r.published_at,
    contentStatus: r.content_status as ContentStatus,
    contentError: r.content_error,
    sort: r.sort,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    deletedAt: isoOrNull(r.deleted_at),
    seq: r.seq,
  };
}

export function toCollection(r: CollectionRow): Collection {
  return {
    id: r.id,
    name: r.name,
    parentId: r.parent_id,
    sort: r.sort,
    color: r.color,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    deletedAt: isoOrNull(r.deleted_at),
    seq: r.seq,
  };
}

export function toHighlight(r: HighlightRow): Highlight {
  return {
    id: r.id,
    bookmarkId: r.bookmark_id,
    quote: r.quote,
    prefix: r.prefix,
    suffix: r.suffix,
    note: r.note,
    color: r.color,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    deletedAt: isoOrNull(r.deleted_at),
    seq: r.seq,
  };
}
