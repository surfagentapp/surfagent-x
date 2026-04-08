import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DAEMON_URL = process.env.SURFAGENT_DAEMON_URL ?? "http://127.0.0.1:7201";
const TOKEN_PATH = join(homedir(), ".surfagent", "daemon-token.txt");
const X_URL_RE = /https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i;

let cachedToken: string | null | undefined;

async function readDaemonError(path: string, res: Response): Promise<never> {
  const text = await res.text();
  if (res.status === 401) {
    throw new Error(
      `${path} failed (HTTP 401): Unauthorized. Check SURFAGENT_AUTH_TOKEN or ~/.surfagent/daemon-token.txt.`,
    );
  }
  throw new Error(`${path} failed (HTTP ${res.status}): ${text}`);
}

function getAuthToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;

  const envToken = process.env.SURFAGENT_AUTH_TOKEN?.trim();
  if (envToken) {
    cachedToken = envToken;
    return cachedToken;
  }

  try {
    const raw = readFileSync(TOKEN_PATH, "utf-8").trim();
    if (raw) {
      cachedToken = raw;
      return cachedToken;
    }
  } catch {
    // ignore missing token file
  }

  cachedToken = null;
  return cachedToken;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const token = getAuthToken();
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

async function daemonRequest<T>(path: string, init: RequestInit, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(`${DAEMON_URL}${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) await readDaemonError(path, res);

  return (await res.json()) as T;
}

export interface TabInfo {
  id: string;
  title: string;
  url: string;
  active?: boolean;
}

export async function listTabs(): Promise<TabInfo[]> {
  const data = await daemonRequest<{ ok: boolean; tabs?: TabInfo[]; error?: string }>("/browser/tabs", { method: "GET" }, 10_000);
  if (!data.ok) throw new Error(data.error ?? "Could not list tabs.");
  return data.tabs ?? [];
}

export async function navigateTab(url: string, tabId?: string): Promise<TabInfo> {
  const data = await daemonRequest<{ ok: boolean; tab?: TabInfo; error?: string }>(
    "/browser/navigate",
    {
      method: "POST",
      body: JSON.stringify(tabId ? { url, tabId } : { url }),
    },
    30_000,
  );
  if (!data.ok || !data.tab) throw new Error(data.error ?? "Navigate failed.");
  return data.tab;
}

export async function evaluate<T = unknown>(expression: string, tabId?: string): Promise<T> {
  const data = await daemonRequest<{ ok: boolean; result?: T; error?: string }>(
    "/browser/evaluate",
    {
      method: "POST",
      body: JSON.stringify(tabId ? { expression, tabId } : { expression }),
    },
    20_000,
  );
  if (!data.ok) throw new Error(data.error ?? "Evaluate failed.");
  return data.result as T;
}

export async function typeInto(selector: string, text: string, tabId?: string): Promise<void> {
  const data = await daemonRequest<{ ok: boolean; error?: string }>(
    "/browser/type",
    {
      method: "POST",
      body: JSON.stringify(tabId ? { selector, text, tabId } : { selector, text }),
    },
    20_000,
  );
  if (!data.ok) throw new Error(data.error ?? "Type failed.");
}

export async function pressKey(key: string, tabId?: string): Promise<void> {
  const data = await daemonRequest<{ ok: boolean; error?: string }>(
    "/browser/press",
    {
      method: "POST",
      body: JSON.stringify(tabId ? { key, tabId } : { key }),
    },
    15_000,
  );
  if (!data.ok) throw new Error(data.error ?? `Press key failed for ${key}.`);
}

export async function screenshot(tabId?: string): Promise<string> {
  const data = await daemonRequest<{ ok: boolean; image?: string; screenshot?: string; error?: string }>(
    "/browser/screenshot",
    {
      method: "POST",
      body: JSON.stringify(tabId ? { tabId } : {}),
    },
    20_000,
  );
  if (!data.ok) throw new Error(data.error ?? "Screenshot failed.");
  return data.image ?? data.screenshot ?? "";
}

export async function waitFor<T = unknown>(expression: string, timeoutMs = 10_000, pollMs = 250, tabId?: string): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await evaluate<T>(expression, tabId);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

export async function findXTab(): Promise<TabInfo | null> {
  const tabs = await listTabs();
  return tabs.find((tab) => X_URL_RE.test(tab.url)) ?? null;
}

export async function ensureXTab(path = "/home"): Promise<TabInfo> {
  const existing = await findXTab();
  const targetUrl = `https://x.com${path.startsWith("/") ? path : `/${path}`}`;
  if (existing) {
    await navigateTab(targetUrl, existing.id);
    return { ...existing, url: targetUrl };
  }
  return navigateTab(targetUrl);
}
