const WEREAD_GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
const SKILL_VERSION = "1.0.4";
const DEFAULT_PROGRESS_LIMIT = 5;
const DEFAULT_MIN_READING_PROGRESS = 10;
const DEFAULT_PROGRESS_FILTER_LIMIT = 100;
const PROGRESS_FETCH_CONCURRENCY = 5;
const DEFAULT_CACHE_SECONDS = 300;

export interface Env {
  WEREAD_API_KEY: string;
  /** Optional bearer token for the blog. Leave unset for a public, origin-restricted API. */
  BLOG_TOKEN?: string;
  /** Comma-separated origins, for example: https://blog.example.com,http://localhost:3000 */
  ALLOWED_ORIGIN?: string;
  /** Set to true only if private shelf entries should be exposed. */
  INCLUDE_PRIVATE?: string;
  CACHE_TTL?: string;
  PROGRESS_LIMIT?: string;
  MIN_READING_PROGRESS?: string;
  PROGRESS_FILTER_LIMIT?: string;
}

type JsonObject = Record<string, unknown>;

interface GatewayPayload extends JsonObject {
  errcode?: number;
  errmsg?: string;
  upgrade_info?: JsonObject;
}

interface ProgressData {
  progress?: number;
  readingTimeSeconds?: number;
  lastReadAt?: string;
  finishTime?: string;
  isStartReading?: boolean;
}

interface PublicBook {
  kind: "book";
  bookId: string;
  title: string;
  author?: string;
  cover?: string;
  category?: string;
  deepLink?: string;
  status: "reading" | "finished";
  progress?: number;
  progressState?: "not-started" | "reading" | "finished";
  readingTimeSeconds?: number;
  lastReadAt?: string;
  finishTime?: string;
  updatedAt?: string;
  private: boolean;
}

interface PublicAlbum {
  kind: "audio";
  albumId: string;
  title: string;
  author?: string;
  cover?: string;
  trackCount?: number;
  /** This is the album's catalog completion state, not the user's listening progress. */
  catalogStatus: "complete" | "ongoing" | "unknown";
  lastListenedAt?: string;
  updatedAt?: string;
  private: boolean;
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: JsonObject,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

class UpgradeRequiredError extends HttpError {
  constructor(message: string, details: JsonObject) {
    super(503, message, details);
    this.name = "UpgradeRequiredError";
  }
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function asFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function isNonEmpty(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function formatShanghaiDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/** Converts WeRead Unix timestamps to the date-only format used by the skill. */
function dateOnly(value: unknown): string | undefined {
  const numberValue = asNumber(value);
  if (numberValue !== undefined) {
    const milliseconds = numberValue < 100_000_000_000 ? numberValue * 1000 : numberValue;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? undefined : formatShanghaiDate(date);
  }

  const stringValue = asString(value);
  if (!stringValue) return undefined;
  const date = new Date(stringValue);
  return Number.isNaN(date.getTime()) ? undefined : formatShanghaiDate(date);
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function parseProgressThreshold(value: string | null, fallback: number): number {
  const parsed = value === null ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new HttpError(400, "minProgress 必须是 0 到 100 之间的数字");
  }
  return parsed;
}

function getAllowedOrigin(request: Request, env: Env): string | undefined {
  const requestOrigin = request.headers.get("Origin");
  if (!requestOrigin) return undefined;

  const configured = (env.ALLOWED_ORIGIN ?? "*")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configured.includes("*")) return "*";
  return configured.includes(requestOrigin) ? requestOrigin : undefined;
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
  const origin = getAllowedOrigin(request, env);
  if (origin) headers.set("Access-Control-Allow-Origin", origin);
  return headers;
}

function jsonResponse(
  request: Request,
  env: Env,
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/json; charset=utf-8");
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function requireBlogToken(request: Request, env: Env): void {
  if (!env.BLOG_TOKEN) return;
  const authorization = request.headers.get("Authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = bearer ?? request.headers.get("X-Api-Key");
  if (!supplied || supplied !== env.BLOG_TOKEN) {
    throw new HttpError(401, "缺少或无效的博客访问令牌");
  }
}

async function gateway(
  apiName: string,
  env: Env,
  params: JsonObject = {},
): Promise<GatewayPayload> {
  if (!env.WEREAD_API_KEY) throw new HttpError(500, "Worker 未配置 WEREAD_API_KEY");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(WEREAD_GATEWAY, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.WEREAD_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ api_name: apiName, ...params, skill_version: SKILL_VERSION }),
      signal: controller.signal,
    });

    let payload: GatewayPayload;
    try {
      payload = asObject(await response.json()) as GatewayPayload;
    } catch {
      throw new HttpError(502, "微信读书接口返回了无法解析的响应");
    }

    if (!response.ok) {
      throw new HttpError(502, "微信读书接口暂时不可用", { upstreamStatus: response.status });
    }
    if (payload.upgrade_info) {
      const upgrade = asObject(payload.upgrade_info);
      throw new UpgradeRequiredError(
        asString(upgrade.message) ?? "微信读书 skill 需要升级后才能继续使用",
        { upgrade_info: upgrade },
      );
    }
    const errcode = asNumber(payload.errcode);
    if (errcode !== undefined && errcode !== 0) {
      throw new HttpError(502, asString(payload.errmsg) ?? "微信读书接口返回错误", {
        upstreamErrcode: errcode,
      });
    }
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new HttpError(504, "微信读书接口响应超时");
    }
    throw new HttpError(502, "微信读书接口暂时不可用");
  } finally {
    clearTimeout(timeout);
  }
}

function mapProgress(payload: GatewayPayload): ProgressData {
  const book = asObject(payload.book);
  const progress = asNumber(book.progress);
  const readingTimeSeconds = asNumber(book.recordReadingTime);
  const finishTime = dateOnly(book.finishTime);
  return {
    progress,
    readingTimeSeconds,
    lastReadAt: dateOnly(book.updateTime),
    finishTime,
    isStartReading: asFlag(book.isStartReading),
  };
}

function mapBook(raw: JsonObject, progress?: ProgressData): PublicBook | undefined {
  const bookId = asString(raw.bookId);
  const title = asString(raw.title);
  if (!bookId || !title) return undefined;

  const finishReading = asFlag(raw.finishReading);
  const completedByProgress = progress?.progress === 100 && Boolean(progress.finishTime);
  const finished = finishReading || completedByProgress;
  const progressState = completedByProgress
    ? "finished"
    : progress?.progress === 0 && !progress.isStartReading
      ? "not-started"
      : progress?.progress !== undefined
        ? "reading"
        : undefined;
  const privateBook = asFlag(raw.secret);
  const mapped: PublicBook = {
    kind: "book",
    bookId,
    title,
    author: asString(raw.author),
    cover: asString(raw.cover),
    category: asString(raw.category),
    deepLink: asString(raw.deepLink),
    status: finished ? "finished" : "reading",
    progress: progress?.progress,
    progressState,
    readingTimeSeconds: progress?.readingTimeSeconds,
    lastReadAt: progress?.lastReadAt ?? dateOnly(raw.readUpdateTime),
    finishTime: progress?.finishTime,
    updatedAt: dateOnly(raw.updateTime),
    private: privateBook,
  };
  return mapped;
}

function mapAlbum(raw: JsonObject): PublicAlbum | undefined {
  const info = asObject(raw.albumInfo);
  const extra = asObject(raw.albumInfoExtra);
  const albumId = asString(info.albumId);
  const title = asString(info.name);
  if (!albumId || !title) return undefined;

  const complete = asFlag(info.finish);
  return {
    kind: "audio",
    albumId,
    title,
    author: asString(info.authorName),
    cover: asString(info.cover),
    trackCount: asNumber(info.trackCount),
    catalogStatus: complete ? "complete" : info.finish === undefined ? "unknown" : "ongoing",
    lastListenedAt: dateOnly(extra.lectureReadUpdateTime),
    updatedAt: dateOnly(info.updateTime),
    private: asFlag(extra.secret),
  };
}

function sortByRecentRead(books: JsonObject[]): JsonObject[] {
  return books
    .filter((book) => asString(book.bookId))
    .sort((a, b) => (asNumber(b.readUpdateTime) ?? 0) - (asNumber(a.readUpdateTime) ?? 0));
}

async function enrichProgress(
  books: JsonObject[],
  env: Env,
): Promise<Map<string, ProgressData>> {
  const result = new Map<string, ProgressData>();
  let nextIndex = 0;

  async function consume(): Promise<void> {
    while (nextIndex < books.length) {
      const book = books[nextIndex++];
      const bookId = asString(book.bookId);
      if (!bookId) continue;
      try {
        const payload = await gateway("/book/getprogress", env, { bookId });
        result.set(bookId, mapProgress(payload));
      } catch {
        // A single stale/deleted book must not make the whole blog response fail.
      }
    }
  }

  const workerCount = Math.min(PROGRESS_FETCH_CONCURRENCY, books.length);
  await Promise.all(Array.from({ length: workerCount }, () => consume()));
  return result;
}

async function enrichRecentProgress(
  books: JsonObject[],
  env: Env,
  limit: number,
): Promise<Map<string, ProgressData>> {
  return enrichProgress(sortByRecentRead(books).slice(0, limit), env);
}

function cacheHeaders(env: Env): Record<string, string> {
  const seconds = parsePositiveInt(env.CACHE_TTL ?? null, DEFAULT_CACHE_SECONDS, 86_400);
  const visibility = env.BLOG_TOKEN ? "private" : "public";
  return {
    "Cache-Control": `${visibility}, max-age=${seconds}, s-maxage=${seconds}, stale-while-revalidate=60`,
  };
}

async function readingResponse(request: Request, env: Env): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const requestedStatus = query.get("status") ?? "all";
  if (!["all", "reading", "finished"].includes(requestedStatus)) {
    throw new HttpError(400, "status 只能是 all、reading 或 finished");
  }

  const includePrivate = env.INCLUDE_PRIVATE?.toLowerCase() === "true";
  const includeProgress = query.get("includeProgress") !== "0";
  const progressLimit = parsePositiveInt(
    query.get("progressLimit") ?? env.PROGRESS_LIMIT ?? null,
    DEFAULT_PROGRESS_LIMIT,
    5,
  );
  const minReadingProgress = parseProgressThreshold(
    query.get("minProgress") ?? env.MIN_READING_PROGRESS ?? null,
    DEFAULT_MIN_READING_PROGRESS,
  );
  const progressFilterEnabled = minReadingProgress > 0;
  const progressFilterLimit = parsePositiveInt(
    query.get("progressFilterLimit") ?? env.PROGRESS_FILTER_LIMIT ?? null,
    DEFAULT_PROGRESS_FILTER_LIMIT,
    500,
  );
  const limit = parsePositiveInt(query.get("limit"), 100, 500);

  const shelf = await gateway("/shelf/sync", env);
  const rawBooks = Array.isArray(shelf.books) ? shelf.books.map(asObject) : [];
  const rawAlbums = Array.isArray(shelf.albums) ? shelf.albums.map(asObject) : [];
  const visibleBooks = includePrivate ? rawBooks : rawBooks.filter((book) => !asFlag(book.secret));
  const visibleAlbums = includePrivate
    ? rawAlbums
    : rawAlbums.filter((album) => !asFlag(asObject(album.albumInfoExtra).secret));

  const unfinishedRawBooks = visibleBooks.filter((book) => !asFlag(book.finishReading));
  const progressTargets = progressFilterEnabled
    ? sortByRecentRead(unfinishedRawBooks).slice(0, progressFilterLimit)
    : [];
  const progressById = progressFilterEnabled
    ? await enrichProgress(progressTargets, env)
    : includeProgress
      ? await enrichRecentProgress(visibleBooks, env, progressLimit)
      : new Map<string, ProgressData>();

  const books = visibleBooks
    .map((book) => mapBook(book, progressById.get(asString(book.bookId) ?? "")))
    .filter((book): book is PublicBook => Boolean(book));
  const albums = visibleAlbums
    .map(mapAlbum)
    .filter((album): album is PublicAlbum => Boolean(album));
  const unfilteredReading = books.filter((book) => book.status === "reading");
  const reading = unfilteredReading
    .filter(
      (book) =>
        !progressFilterEnabled ||
        (book.progress !== undefined && book.progress >= minReadingProgress),
    )
    .slice(0, limit);
  const finished = books.filter((book) => book.status === "finished").slice(0, limit);

  const rawMp = shelf.mp;
  const hasArticleShelfEntry = isNonEmpty(rawMp);
  const rawShelfTotal = rawBooks.length + rawAlbums.length + (hasArticleShelfEntry ? 1 : 0);
  const visibleArticleCount = includePrivate && hasArticleShelfEntry ? 1 : 0;

  // `status` filters the two primary lists while keeping the counts as the full visible shelf totals.
  const responseReading = requestedStatus === "finished" ? [] : reading;
  const responseFinished = requestedStatus === "reading" ? [] : finished;
  const payload = {
    source: "weread",
    generatedAt: new Date().toISOString(),
    semantics: {
      reading: progressFilterEnabled
        ? `books with progress >= ${minReadingProgress}; progress checked for ${progressTargets.length}/${unfinishedRawBooks.length} unfinished books`
        : "books with finishReading != 1",
      finished: "books with finishReading == 1, or progress=100 with finishTime",
      audioCatalogStatus: "albums.finish describes whether the audio catalog is complete, not whether the user listened to it",
      privateEntriesIncluded: includePrivate,
    },
    counts: {
      shelfTotal: rawShelfTotal,
      visibleTotal: books.length + albums.length + visibleArticleCount,
      ebooks: books.length,
      audio: albums.length,
      articles: visibleArticleCount,
      shelfUnfinished: unfilteredReading.length,
      reading: reading.length,
      finished: finished.length,
    },
    reading: responseReading,
    finished: responseFinished,
    audio: albums.slice(0, limit),
    meta: {
      progressEnriched: progressById.size,
      progressLimit,
      progressFilter: {
        enabled: progressFilterEnabled,
        minProgress: progressFilterEnabled ? minReadingProgress : null,
        checked: progressTargets.length,
        total: unfinishedRawBooks.length,
        truncated: progressFilterEnabled && progressTargets.length < unfinishedRawBooks.length,
      },
      progressSource: "/book/getprogress",
      skillVersion: SKILL_VERSION,
    },
  };

  return jsonResponse(request, env, payload, 200, cacheHeaders(env));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const baseHeaders = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: baseHeaders });
    }
    if (request.method !== "GET") {
      return jsonResponse(request, env, { error: "method_not_allowed" }, 405, {
        Allow: "GET, OPTIONS",
        "Cache-Control": "no-store",
      });
    }

    try {
      requireBlogToken(request, env);
      if (url.pathname === "/health") {
        return jsonResponse(request, env, { ok: true, service: "weread-reading-api" }, 200, {
          "Cache-Control": "no-store",
        });
      }
      if (url.pathname === "/api/reading" || url.pathname === "/api/reading/") {
        return await readingResponse(request, env);
      }
      return jsonResponse(request, env, { error: "not_found" }, 404, { "Cache-Control": "no-store" });
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse(
          request,
          env,
          {
            error: error.name === "UpgradeRequiredError" ? "upgrade_required" : "weread_request_failed",
            message: error.message,
            ...(error.details ?? {}),
          },
          error.status,
          { "Cache-Control": "no-store" },
        );
      }
      return jsonResponse(request, env, { error: "internal_error", message: "阅读数据暂时无法获取，请稍后再试~" }, 500, {
        "Cache-Control": "no-store",
      });
    }
  },
};
