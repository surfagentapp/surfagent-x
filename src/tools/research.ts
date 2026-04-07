import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolDefinition } from "../types.js";
import { asObject, asOptionalNumber, asOptionalString, asString, textResult } from "../types.js";
import { extractCommunity, extractPost, extractProfile, getCommunityFeed, getPostThread, getProfilePosts, navigateX, searchXCommunities, searchXPosts, searchXProfiles } from "../x.js";

type FailureClass =
  | "no_x_tab"
  | "navigation_timeout"
  | "not_logged_in"
  | "rate_limited"
  | "target_not_found"
  | "selector_drift"
  | "empty_result"
  | "unknown";

type RecoveryMode = "none" | "home" | "url";

type StepFailure = {
  attempt: number;
  error: string;
  failureClass: FailureClass;
  retriable: boolean;
  recoveryMode: RecoveryMode;
};

type RecoveryEvent = {
  attempt: number;
  mode: Exclude<RecoveryMode, "none">;
  ok: boolean;
  targetUrl?: string;
  error?: string;
};

type StepReceipt<T = unknown> = {
  step: string;
  ok: boolean;
  attempts: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  error?: string;
  failureClass?: FailureClass;
  retriable?: boolean;
  failures?: StepFailure[];
  recoveryEvents?: RecoveryEvent[];
  data?: T;
};

type RetryPolicy = {
  maxAttempts?: number;
  recoveryUrl?: string;
};

type SaveOptions = {
  save?: boolean;
  outputDir?: string;
};

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "run";
}

function getDefaultOutputDir() {
  return path.join(os.homedir(), ".surfagent", "receipts", "x-research");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function summarizeValue(value: unknown) {
  if (Array.isArray(value)) return { kind: "array", count: value.length };
  if (value && typeof value === "object") return { kind: "object", count: Object.keys(value as Record<string, unknown>).length };
  if (value === null || value === undefined) return { kind: "empty", count: 0 };
  return { kind: typeof value, count: 1 };
}

function buildRunSummaryMarkdown(kind: string, label: string, payload: Record<string, unknown>) {
  const summary = asRecord(payload.summary) ?? {};
  const outputs = asRecord(payload.outputs) ?? {};
  const lines = [
    `# X Research Run`,
    ``,
    `- Kind: ${kind}`,
    `- Label: ${label}`,
    `- OK: ${payload.ok === true ? "yes" : "no"}`,
    `- Total steps: ${summary.totalSteps ?? "n/a"}`,
    `- Successful steps: ${summary.successfulSteps ?? "n/a"}`,
    `- Failed steps: ${summary.failedSteps ?? "n/a"}`,
    `- Recovered retries: ${summary.recoveredRetries ?? "n/a"}`,
    ``,
    `## Outputs`,
  ];

  for (const [key, value] of Object.entries(outputs)) {
    const info = summarizeValue(value);
    lines.push(`- ${key}: ${info.kind} (${info.count})`);
  }

  const failureClasses = asRecord(summary.failureClasses);
  if (failureClasses && Object.keys(failureClasses).length) {
    lines.push(``, `## Failure classes`);
    for (const [key, value] of Object.entries(failureClasses)) {
      lines.push(`- ${key}: ${String(value)}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

async function maybePersistRun(kind: string, label: string, payload: unknown, options: SaveOptions) {
  if (!options.save) return null;
  const baseDir = options.outputDir?.trim() || getDefaultOutputDir();
  await mkdir(baseDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runSlug = `${timestamp}-${kind}-${slugify(label)}`;
  const runDir = path.join(baseDir, runSlug);
  await mkdir(runDir, { recursive: true });

  const files: string[] = [];
  const writeJson = async (name: string, value: unknown) => {
    const filePath = path.join(runDir, name);
    await writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
    files.push(name);
  };

  const payloadRecord = asRecord(payload) ?? { value: payload };
  await writeJson("bundle.json", payload);
  await writeJson("summary.json", {
    kind,
    label,
    ok: payloadRecord.ok ?? false,
    plan: payloadRecord.plan ?? null,
    summary: payloadRecord.summary ?? null,
  });

  if (Array.isArray(payloadRecord.receipts)) {
    await writeJson("receipts.json", payloadRecord.receipts);
  }

  const outputs = asRecord(payloadRecord.outputs);
  if (outputs) {
    for (const [key, value] of Object.entries(outputs)) {
      await writeJson(`${slugify(key)}.json`, value);
    }
  }

  const markdownName = "SUMMARY.md";
  await writeFile(path.join(runDir, markdownName), buildRunSummaryMarkdown(kind, label, payloadRecord), "utf8");
  files.push(markdownName);

  return {
    saved: true,
    dir: runDir,
    bundlePath: path.join(runDir, "bundle.json"),
    files,
  };
}

function classifyFailure(error: unknown): { failureClass: FailureClass; retriable: boolean; recoveryMode: RecoveryMode } {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();

  if (message.includes("no x tab found")) {
    return { failureClass: "no_x_tab", retriable: true, recoveryMode: "home" };
  }
  if (message.includes("timed out waiting for x to settle") || message.includes("loading") || message.includes("timeout")) {
    return { failureClass: "navigation_timeout", retriable: true, recoveryMode: "home" };
  }
  if (message.includes("login") || message.includes("sign in") || message.includes("logged out") || message.includes("auth")) {
    return { failureClass: "not_logged_in", retriable: false, recoveryMode: "none" };
  }
  if (message.includes("rate limit") || message.includes("try again later") || message.includes("too many requests")) {
    return { failureClass: "rate_limited", retriable: true, recoveryMode: "home" };
  }
  if (message.includes("post_not_found") || message.includes("target_post_not_found") || message.includes("not found")) {
    return { failureClass: "target_not_found", retriable: false, recoveryMode: "none" };
  }
  if (message.includes("selector") || message.includes("button_not_found") || message.includes("composer_not_found")) {
    return { failureClass: "selector_drift", retriable: true, recoveryMode: "home" };
  }
  if (message.includes("empty") || message.includes("no results")) {
    return { failureClass: "empty_result", retriable: false, recoveryMode: "none" };
  }
  return { failureClass: "unknown", retriable: true, recoveryMode: "home" };
}

async function attemptRecovery(mode: Exclude<RecoveryMode, "none">, recoveryUrl?: string): Promise<{ ok: boolean; error?: string; targetUrl?: string }> {
  try {
    if (mode === "url" && recoveryUrl) {
      await navigateX(recoveryUrl);
      return { ok: true, targetUrl: recoveryUrl };
    }
    await navigateX("/home");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ...(recoveryUrl ? { targetUrl: recoveryUrl } : {}),
    };
  }
}

async function withRetries<T>(step: string, fn: () => Promise<T>, policy: RetryPolicy = {}): Promise<StepReceipt<T>> {
  const maxAttempts = policy.maxAttempts ?? 2;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  let attempts = 0;
  let lastError: unknown;
  let lastClassification: { failureClass: FailureClass; retriable: boolean; recoveryMode: RecoveryMode } | null = null;
  const failures: StepFailure[] = [];
  const recoveryEvents: RecoveryEvent[] = [];

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const data = await fn();
      return {
        step,
        ok: true,
        attempts,
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startMs,
        ...(failures.length ? { failures } : {}),
        ...(recoveryEvents.length ? { recoveryEvents } : {}),
        data,
      };
    } catch (error) {
      lastError = error;
      lastClassification = classifyFailure(error);
      failures.push({
        attempt: attempts,
        error: error instanceof Error ? error.message : String(error),
        failureClass: lastClassification.failureClass,
        retriable: lastClassification.retriable,
        recoveryMode: lastClassification.recoveryMode,
      });

      const shouldRetry = attempts < maxAttempts && lastClassification.retriable;
      if (!shouldRetry) break;

      if (lastClassification.recoveryMode !== "none") {
        const resolvedMode = lastClassification.recoveryMode === "url" && !policy.recoveryUrl ? "home" : lastClassification.recoveryMode;
        const recovery = await attemptRecovery(resolvedMode as Exclude<RecoveryMode, "none">, policy.recoveryUrl);
        recoveryEvents.push({
          attempt: attempts,
          mode: resolvedMode as Exclude<RecoveryMode, "none">,
          ok: recovery.ok,
          ...(recovery.targetUrl ? { targetUrl: recovery.targetUrl } : {}),
          ...(recovery.error ? { error: recovery.error } : {}),
        });
      }
    }
  }

  return {
    step,
    ok: false,
    attempts,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
    error: lastError instanceof Error ? lastError.message : String(lastError),
    ...(lastClassification ? { failureClass: lastClassification.failureClass, retriable: lastClassification.retriable } : {}),
    ...(failures.length ? { failures } : {}),
    ...(recoveryEvents.length ? { recoveryEvents } : {}),
  };
}

function ensureArray<T>(value: unknown, key: string): T[] {
  if (!value || typeof value !== "object") return [];
  const arr = (value as Record<string, unknown>)[key];
  return Array.isArray(arr) ? (arr as T[]) : [];
}

function pluckPostUrls(searchResult: unknown, limit: number): string[] {
  const posts = ensureArray<Record<string, unknown>>(searchResult, "posts");
  const urls = posts.map((post) => typeof post.statusUrl === "string" ? post.statusUrl : null).filter((url): url is string => Boolean(url));
  return Array.from(new Set(urls)).slice(0, limit);
}

function pluckAuthors(searchResult: unknown, limit: number): string[] {
  const posts = ensureArray<Record<string, unknown>>(searchResult, "posts");
  const authors = posts.map((post) => typeof post.author === "string" ? post.author.replace(/^@+/, "") : null).filter((author): author is string => Boolean(author));
  return Array.from(new Set(authors)).slice(0, limit);
}

function pluckCommunityUrls(searchResult: unknown, limit: number): string[] {
  const communities = ensureArray<Record<string, unknown>>(searchResult, "communities");
  const urls = communities.map((community) => typeof community.url === "string" ? community.url : null).filter((url): url is string => Boolean(url));
  return Array.from(new Set(urls)).slice(0, limit);
}

function pluckProfileUsernames(searchResult: unknown, limit: number): string[] {
  const profiles = ensureArray<Record<string, unknown>>(searchResult, "profiles");
  const usernames = profiles
    .map((profile) => typeof profile.username === "string" ? profile.username.replace(/^@+/, "") : null)
    .filter((username): username is string => Boolean(username));
  return Array.from(new Set(usernames)).slice(0, limit);
}

function summarizeReceipts(receipts: StepReceipt[]) {
  const failureClasses = receipts
    .filter((receipt) => !receipt.ok && receipt.failureClass)
    .reduce<Record<string, number>>((acc, receipt) => {
      const key = receipt.failureClass as string;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

  return {
    totalSteps: receipts.length,
    successfulSteps: receipts.filter((receipt) => receipt.ok).length,
    failedSteps: receipts.filter((receipt) => !receipt.ok).length,
    recoveredRetries: receipts.reduce((acc, receipt) => acc + (receipt.recoveryEvents?.filter((event) => event.ok).length ?? 0), 0),
    failureClasses,
  };
}

async function researchTopic(query: string, postLimit: number, profileLimit: number, threadDepth: number, communityLimit: number, saveOptions: SaveOptions = {}) {
  const receipts: StepReceipt[] = [];

  const searchPostsReceipt = await withRetries("search_posts", () => searchXPosts(query, postLimit));
  receipts.push(searchPostsReceipt);
  const searchProfilesReceipt = await withRetries("search_profiles", () => searchXProfiles(query, profileLimit + 2));
  receipts.push(searchProfilesReceipt);
  const searchCommunitiesReceipt = await withRetries("search_communities", () => searchXCommunities(query, communityLimit));
  receipts.push(searchCommunitiesReceipt);

  const postUrls = searchPostsReceipt.ok ? pluckPostUrls(searchPostsReceipt.data, Math.min(3, postLimit)) : [];
  const postAuthors = searchPostsReceipt.ok ? pluckAuthors(searchPostsReceipt.data, profileLimit) : [];
  const searchedProfiles = searchProfilesReceipt.ok ? pluckProfileUsernames(searchProfilesReceipt.data, profileLimit + 2) : [];
  const authors = Array.from(new Set([...postAuthors, ...searchedProfiles])).slice(0, Math.max(profileLimit, 1));
  const communityUrls = searchCommunitiesReceipt.ok ? pluckCommunityUrls(searchCommunitiesReceipt.data, Math.min(2, communityLimit)) : [];

  const extractedPosts: StepReceipt[] = [];
  for (const url of postUrls) {
    const receipt = await withRetries(`extract_post:${url}`, () => extractPost(url), { recoveryUrl: url });
    receipts.push(receipt);
    extractedPosts.push(receipt);
  }

  const extractedThreads: StepReceipt[] = [];
  for (const url of postUrls.slice(0, Math.min(2, postUrls.length))) {
    const receipt = await withRetries(`extract_thread:${url}`, () => getPostThread(url, threadDepth), { recoveryUrl: url });
    receipts.push(receipt);
    extractedThreads.push(receipt);
  }

  const extractedProfiles: StepReceipt[] = [];
  for (const username of authors) {
    const receipt = await withRetries(`extract_profile:${username}`, () => extractProfile(username), { recoveryUrl: `https://x.com/${username.replace(/^@+/, "")}` });
    receipts.push(receipt);
    extractedProfiles.push(receipt);
  }

  const profileTimelines: StepReceipt[] = [];
  for (const username of authors.slice(0, Math.min(3, authors.length))) {
    const receipt = await withRetries(`profile_posts:${username}`, () => getProfilePosts(username, 8), { recoveryUrl: `https://x.com/${username.replace(/^@+/, "")}` });
    receipts.push(receipt);
    profileTimelines.push(receipt);
  }

  const extractedCommunities: StepReceipt[] = [];
  for (const url of communityUrls) {
    const receipt = await withRetries(`extract_community:${url}`, () => extractCommunity(url), { recoveryUrl: url });
    receipts.push(receipt);
    extractedCommunities.push(receipt);
  }

  const communityFeeds: StepReceipt[] = [];
  for (const url of communityUrls) {
    const receipt = await withRetries(`community_feed:${url}`, () => getCommunityFeed(8, url), { recoveryUrl: url });
    receipts.push(receipt);
    communityFeeds.push(receipt);
  }

  const result = {
    ok: receipts.some((receipt) => receipt.ok),
    query,
    plan: {
      searchedPosts: true,
      searchedProfiles: true,
      searchedCommunities: true,
      extractedTopPosts: postUrls.length,
      extractedProfiles: authors.length,
      extractedProfileTimelines: Math.min(3, authors.length),
      extractedThreads: Math.min(2, postUrls.length),
      sampledCommunities: communityUrls.length,
    },
    receipts,
    summary: summarizeReceipts(receipts),
    outputs: {
      postsSearch: searchPostsReceipt.data ?? null,
      profilesSearch: searchProfilesReceipt.data ?? null,
      communitiesSearch: searchCommunitiesReceipt.data ?? null,
      posts: extractedPosts.filter((receipt) => receipt.ok).map((receipt) => receipt.data),
      threads: extractedThreads.filter((receipt) => receipt.ok).map((receipt) => receipt.data),
      profiles: extractedProfiles.filter((receipt) => receipt.ok).map((receipt) => receipt.data),
      profilePosts: profileTimelines.filter((receipt) => receipt.ok).map((receipt) => receipt.data),
      communityDetails: extractedCommunities.filter((receipt) => receipt.ok).map((receipt) => receipt.data),
      communities: communityFeeds.filter((receipt) => receipt.ok).map((receipt) => receipt.data),
    },
  };
  return {
    ...result,
    persistence: await maybePersistRun("topic", query, result, saveOptions),
  };
}

async function mapCommunity(url: string, feedLimit: number, profileLimit: number, saveOptions: SaveOptions = {}) {
  const receipts: StepReceipt[] = [];
  const communityReceipt = await withRetries("extract_community", () => extractCommunity(url), { recoveryUrl: url });
  receipts.push(communityReceipt);
  const feedReceipt = await withRetries("community_feed", () => getCommunityFeed(feedLimit, url), { recoveryUrl: url });
  receipts.push(feedReceipt);

  const feedPosts = feedReceipt.ok ? ensureArray<Record<string, unknown>>(feedReceipt.data, "posts") : [];
  const authors = Array.from(new Set(feedPosts.map((post) => typeof post.author === "string" ? post.author : null).filter((author): author is string => Boolean(author)))).slice(0, profileLimit);

  const profileReceipts: StepReceipt[] = [];
  for (const username of authors) {
    const receipt = await withRetries(`community_profile:${username}`, () => extractProfile(username), { recoveryUrl: `https://x.com/${username.replace(/^@+/, "")}` });
    receipts.push(receipt);
    profileReceipts.push(receipt);
  }

  const result = {
    ok: feedReceipt.ok,
    url,
    receipts,
    summary: summarizeReceipts(receipts),
    outputs: {
      community: communityReceipt.data ?? null,
      feed: feedReceipt.data ?? null,
      memberProfiles: profileReceipts.filter((receipt) => receipt.ok).map((receipt) => receipt.data),
    },
  };
  return {
    ...result,
    persistence: await maybePersistRun("community", url, result, saveOptions),
  };
}

export const researchTools: ToolDefinition[] = [
  {
    name: "x_research_topic",
    description: "Run an autonomous X research pass for a topic, with retries, receipts, post/thread/profile extraction, and community sampling.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Topic or search query to research on X." },
        postLimit: { type: "number", description: "Initial search result extraction limit (1-20)." },
        profileLimit: { type: "number", description: "How many author profiles to extract from the search set (1-5)." },
        threadDepth: { type: "number", description: "Visible post count to extract per sampled thread (1-25)." },
        communityLimit: { type: "number", description: "How many matching communities to sample (1-5)." },
        save: { type: "boolean", description: "Save the full research bundle to disk under ~/.surfagent/receipts/x-research or a custom outputDir." },
        outputDir: { type: "string", description: "Optional output directory for saved research bundles." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_research_topic arguments");
      const query = asString(input.query, "query");
      const postLimit = Math.max(1, Math.min(20, asOptionalNumber(input.postLimit) ?? 8));
      const profileLimit = Math.max(1, Math.min(5, asOptionalNumber(input.profileLimit) ?? 3));
      const threadDepth = Math.max(1, Math.min(25, asOptionalNumber(input.threadDepth) ?? 12));
      const communityLimit = Math.max(1, Math.min(5, asOptionalNumber(input.communityLimit) ?? 2));
      const save = input.save === true;
      const outputDir = asOptionalString(input.outputDir);
      const saveOptions: SaveOptions = {
        save,
        ...(outputDir ? { outputDir } : {}),
      };
      return textResult(JSON.stringify(await researchTopic(query, postLimit, profileLimit, threadDepth, communityLimit, saveOptions), null, 2));
    },
  },
  {
    name: "x_map_community",
    description: "Run an autonomous community mapping pass: open a community, extract feed rows, and profile a sample of visible participants.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full X community URL." },
        feedLimit: { type: "number", description: "Max feed posts to inspect (1-20)." },
        profileLimit: { type: "number", description: "How many visible author profiles to sample (1-5)." },
        query: { type: "string", description: "Optional future lookup field. Currently ignored if url is supplied." },
        save: { type: "boolean", description: "Save the full community mapping bundle to disk under ~/.surfagent/receipts/x-research or a custom outputDir." },
        outputDir: { type: "string", description: "Optional output directory for saved community bundles." }
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_map_community arguments");
      const url = asString(input.url, "url");
      const feedLimit = Math.max(1, Math.min(20, asOptionalNumber(input.feedLimit) ?? 10));
      const profileLimit = Math.max(1, Math.min(5, asOptionalNumber(input.profileLimit) ?? 3));
      const save = input.save === true;
      const outputDir = asOptionalString(input.outputDir);
      const saveOptions: SaveOptions = {
        save,
        ...(outputDir ? { outputDir } : {}),
      };
      return textResult(JSON.stringify(await mapCommunity(url, feedLimit, profileLimit, saveOptions), null, 2));
    },
  },
];
