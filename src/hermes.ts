const DEFAULT_HERMES_BASE_URL = "https://xquik.com";
const HERMES_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function firstEnv(names: string[], fallback = ""): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return fallback;
}

function clampLimit(limit: number): number {
  return Math.max(1, Math.min(100, Math.floor(limit)));
}

function textField(source: JsonRecord, names: string[]): string {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== null) return String(value);
  }
  return "";
}

function numberField(source: JsonRecord, names: string[]): number {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return 0;
}

function metricField(source: JsonRecord, metrics: JsonRecord, names: string[]): number {
  return numberField(metrics, names) || numberField(source, names);
}

function findItems(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((item): item is JsonRecord => item !== null);
  const record = asRecord(value);
  if (!record) return [];

  for (const key of ["data", "tweets", "results", "items"]) {
    const child = record[key];
    if (Array.isArray(child)) return child.map(asRecord).filter((item): item is JsonRecord => item !== null);
    const nested = asRecord(child);
    if (nested) {
      const items = findItems(nested);
      if (items.length) return items;
    }
  }

  return [];
}

function getAuthorHandle(tweet: JsonRecord): string {
  const author = tweet.author ?? tweet.user ?? tweet.creator;
  if (typeof author === "string") return author.replace(/^@+/, "");
  const authorRecord = asRecord(author);
  if (authorRecord) {
    return textField(authorRecord, ["username", "screen_name", "handle"]).replace(/^@+/, "");
  }
  return textField(tweet, ["username", "author_username", "screen_name"]).replace(/^@+/, "");
}

function formatMetricLabel(count: number, label: string): string | null {
  return count > 0 ? `${count} ${label}` : null;
}

function normalizeHermesPost(tweet: JsonRecord, index: number): JsonRecord {
  const metrics = asRecord(tweet.public_metrics ?? tweet.metrics) ?? {};
  const authorRecord = asRecord(tweet.author ?? tweet.user ?? tweet.creator) ?? {};
  const authorMetrics = asRecord(authorRecord.public_metrics ?? authorRecord.metrics) ?? {};
  const author = getAuthorHandle(tweet) || null;
  const postId = textField(tweet, ["id", "tweet_id", "tweetId", "rest_id"]) || null;
  const url = textField(tweet, ["url"]) || (author && postId ? `https://x.com/${author}/status/${postId}` : null);
  const replies = metricField(tweet, metrics, ["reply_count", "replies"]);
  const reposts = metricField(tweet, metrics, ["retweet_count", "retweets", "reposts"]);
  const likes = metricField(tweet, metrics, ["like_count", "likes", "favorite_count"]);

  return {
    index,
    postId,
    url,
    statusUrl: url,
    author,
    text: textField(tweet, ["text", "full_text", "fullText", "content"]),
    reply: formatMetricLabel(replies, "replies"),
    repost: formatMetricLabel(reposts, "reposts"),
    like: formatMetricLabel(likes, "likes"),
    liked: false,
    media: [],
    metrics: {
      replies,
      reposts,
      likes,
      impressions: metricField(tweet, metrics, ["impression_count", "impressions", "views"]),
      authorFollowers: (
        metricField(tweet, metrics, ["author_followers", "followers_count", "followers"])
        || metricField(authorRecord, authorMetrics, ["followers_count", "followers"])
      ),
    },
    diagnostics: {
      source: "hermes-tweet",
      createdAt: textField(tweet, ["created_at", "createdAt"]) || null,
      conversationId: textField(tweet, ["conversation_id", "conversationId"]) || null,
    },
  };
}

export function shouldUseHermesSearchBackend(): boolean {
  const backend = firstEnv(["SURFAGENT_X_READ_BACKEND", "HERMES_TWEET_READ_BACKEND"]).toLowerCase();
  return backend === "hermes" || backend === "hermes-tweet" || backend === "xquik";
}

export function buildHermesHeaders(apiKey = firstEnv(["HERMES_TWEET_API_KEY", "XQUIK_API_KEY"])): Record<string, string> {
  if (!apiKey) {
    throw new Error("Hermes Tweet search backend is enabled but HERMES_TWEET_API_KEY or XQUIK_API_KEY is not configured.");
  }
  if (apiKey.startsWith("xq_")) return { "x-api-key": apiKey };
  return { Authorization: `Bearer ${apiKey}` };
}

export function normalizeHermesSearchPayload(payload: unknown, query: string, limit: number): JsonRecord {
  const max = clampLimit(limit);
  const posts = findItems(payload).slice(0, max).map((tweet, index) => normalizeHermesPost(tweet, index));
  return {
    ok: true,
    count: posts.length,
    posts,
    diagnostics: {
      source: "hermes-tweet",
      query,
      limit: max,
    },
  };
}

export async function searchHermesPosts(query: string, limit = 10): Promise<JsonRecord> {
  const baseUrl = firstEnv(["HERMES_TWEET_BASE_URL", "XQUIK_BASE_URL"], DEFAULT_HERMES_BASE_URL);
  const url = new URL("/api/v1/x/tweets/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(clampLimit(limit)));

  const response = await fetch(url, {
    method: "GET",
    headers: buildHermesHeaders(),
    signal: AbortSignal.timeout(HERMES_TIMEOUT_MS),
  });

  const text = await response.text();
  let payload: unknown = { text };
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { text };
    }
  }

  if (!response.ok) {
    throw new Error(`Hermes Tweet search failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }

  return normalizeHermesSearchPayload(payload, query, limit);
}
