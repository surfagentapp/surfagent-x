import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clickSelector, evaluate, pressKey, screenshot, typeInto } from "./connection.js";
import { getComposerState, getXState, likePost, navigateX, repostPost, switchXAccount, verifyTextVisible, waitForXReady } from "./x.js";

export type XTaskKind = "engage-post" | "quote-post";

type TaskStepStatus = "started" | "completed" | "failed";

type TaskStep = {
  name: string;
  status: TaskStepStatus;
  startedAt: string;
  finishedAt?: string;
  details?: unknown;
};

type ScreenshotArtifact = {
  label: string;
  path: string;
  takenAt: string;
};

type TaskRun = {
  ok: boolean;
  task: XTaskKind;
  runId: string;
  account: string;
  url: string;
  quoteText?: string;
  steps: TaskStep[];
  screenshots: ScreenshotArtifact[];
  state?: unknown;
  error?: string;
};

export type EngagePostOptions = {
  account: string;
  url: string;
  like?: boolean;
  repost?: boolean;
};

export type QuotePostOptions = {
  account: string;
  url: string;
  text: string;
  like?: boolean;
};

const RUN_ROOT = process.env.SURFAGENT_RUN_DIR || join(tmpdir(), "surfagent-x-runs");

function isoNow(): string {
  return new Date().toISOString();
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
}

function cleanBase64Image(input: string): string {
  const value = input.trim();
  const comma = value.indexOf(",");
  return value.startsWith("data:") && comma >= 0 ? value.slice(comma + 1) : value;
}

function extractHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/@([A-Za-z0-9_]{1,15})/);
  const handle = match?.[1];
  return handle ? handle.toLowerCase() : null;
}

async function ensureRunDir(runId: string): Promise<string> {
  const dir = join(RUN_ROOT, runId);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeRunFile(runId: string, filename: string, content: string | Buffer, encoding?: BufferEncoding): Promise<string> {
  const dir = await ensureRunDir(runId);
  const fullPath = join(dir, filename);
  if (typeof content === "string") {
    await writeFile(fullPath, content, encoding ?? "utf8");
  } else {
    await writeFile(fullPath, content);
  }
  return fullPath;
}

async function captureRunScreenshot(run: TaskRun, tabId: string | undefined, label: string): Promise<ScreenshotArtifact> {
  const image = await screenshot(tabId);
  const payload = cleanBase64Image(image);
  const safeLabel = slug(label);
  const path = await writeRunFile(run.runId, `${String(run.screenshots.length + 1).padStart(2, "0")}-${safeLabel}.png`, Buffer.from(payload, "base64"));
  const artifact = { label, path, takenAt: isoNow() };
  run.screenshots.push(artifact);
  return artifact;
}

async function overwriteRunManifest(run: TaskRun): Promise<string> {
  return writeRunFile(run.runId, "run.json", JSON.stringify(run, null, 2));
}

async function withStep<T>(run: TaskRun, name: string, fn: () => Promise<T>): Promise<T> {
  const step: TaskStep = { name, status: "started", startedAt: isoNow() };
  run.steps.push(step);
  await overwriteRunManifest(run);
  try {
    const result = await fn();
    step.status = "completed";
    step.finishedAt = isoNow();
    step.details = result;
    await overwriteRunManifest(run);
    return result;
  } catch (error) {
    step.status = "failed";
    step.finishedAt = isoNow();
    step.details = error instanceof Error ? error.message : String(error);
    run.ok = false;
    run.error = error instanceof Error ? error.message : String(error);
    await overwriteRunManifest(run);
    throw error;
  }
}

async function ensureHomeAndSwitch(account: string, run: TaskRun): Promise<{ tabId: string; state: unknown; activeHandle: string | null }> {
  const homeTab = await navigateX("/home");
  await waitForXReady(homeTab.id, { pageKind: "home", pathIncludes: "/home" });
  await captureRunScreenshot(run, homeTab.id, "home-before-switch");
  const result = await switchXAccount(account, homeTab.id);
  await captureRunScreenshot(run, homeTab.id, "home-after-switch");
  const state = await getXState(homeTab.id);
  const activeHandle = extractHandle((state as Record<string, unknown>).activeAccount);
  return { tabId: homeTab.id, state, activeHandle };
}

async function tagAndClick(tabId: string, tagId: string, expression: string, label: string): Promise<unknown> {
  const tagged = await evaluate<Record<string, unknown>>(expression, tabId);
  if (tagged.ok !== true) {
    throw new Error(`${label} failed during tagging. Diagnostics: ${JSON.stringify(tagged)}`);
  }
  await clickSelector(`#${tagId}`, tabId);
  return tagged;
}

async function waitForComposer(tabId: string): Promise<unknown> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const state = await getComposerState(tabId);
    if (state.present) return state;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Timed out waiting for the X composer to appear.");
}

async function fillComposerWithRecovery(text: string, tabId: string, run: TaskRun, mode: "quote" | "post") {
  await typeInto('[data-testid="tweetTextarea_0"]', text, tabId);
  let state = await getComposerState(tabId);
  await captureRunScreenshot(run, tabId, `${mode}-composer-after-fill`);

  if (state.present && state.hasText && !state.buttonEnabled && !state.charLimitErrorVisible) {
    await pressKey("Control+A", tabId).catch(() => undefined);
    await pressKey("Backspace", tabId).catch(() => undefined);
    await typeInto('[data-testid="tweetTextarea_0"]', text, tabId);
    state = await getComposerState(tabId);
    await captureRunScreenshot(run, tabId, `${mode}-composer-after-recovery`);
  }

  if (!state.present || !state.hasText) {
    throw new Error(`Composer did not retain typed text. Diagnostics: ${JSON.stringify(state)}`);
  }
  if (!state.buttonEnabled) {
    throw new Error(`Composer text is present but submit is disabled. Diagnostics: ${JSON.stringify(state)}`);
  }

  return state;
}

async function verifyQuoteVisible(handle: string | null, text: string, tabId: string, run: TaskRun) {
  if (!handle) {
    throw new Error("Could not determine active handle for quote verification.");
  }
  await navigateX(`/${handle}`, tabId);
  await waitForXReady(tabId, { pageKind: "profile" });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const verify = await verifyTextVisible(text, tabId, "body");
    if ((verify as Record<string, unknown>).visible === true) {
      await captureRunScreenshot(run, tabId, "quote-verified-on-profile");
      return verify;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Quote text did not become visible on @${handle}'s profile.`);
}

export async function runEngagePostTask(options: EngagePostOptions): Promise<TaskRun> {
  const run: TaskRun = {
    ok: true,
    task: "engage-post",
    runId: `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${slug(options.account)}-engage-post`,
    account: options.account,
    url: options.url,
    steps: [],
    screenshots: [],
  };

  try {
    const switched = await withStep(run, "switch-account", async () => ensureHomeAndSwitch(options.account, run));
    await withStep(run, "open-target-post", async () => {
      await navigateX(options.url, switched.tabId);
      await waitForXReady(switched.tabId, { pageKind: "post" });
      await captureRunScreenshot(run, switched.tabId, "target-post-before-actions");
      return await getXState(switched.tabId);
    });

    let likeResult: unknown = { skipped: true };
    if (options.like !== false) {
      likeResult = await withStep(run, "like-post", async () => likePost(options.url, switched.tabId));
    }

    let repostResult: unknown = { skipped: true };
    if (options.repost === true) {
      repostResult = await withStep(run, "repost-post", async () => repostPost(options.url, switched.tabId));
    }

    const finalState = await withStep(run, "verify-post-state", async () => {
      await navigateX(options.url, switched.tabId);
      await waitForXReady(switched.tabId, { pageKind: "post" });
      await captureRunScreenshot(run, switched.tabId, "target-post-after-actions");
      return await getXState(switched.tabId);
    });

    run.state = { switched, likeResult, repostResult, finalState };
    await overwriteRunManifest(run);
    return run;
  } catch (error) {
    run.ok = false;
    run.error = error instanceof Error ? error.message : String(error);
    await overwriteRunManifest(run);
    throw error;
  }
}

export async function runQuotePostTask(options: QuotePostOptions): Promise<TaskRun> {
  const run: TaskRun = {
    ok: true,
    task: "quote-post",
    runId: `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${slug(options.account)}-quote-post`,
    account: options.account,
    url: options.url,
    quoteText: options.text,
    steps: [],
    screenshots: [],
  };

  try {
    const switched = await withStep(run, "switch-account", async () => ensureHomeAndSwitch(options.account, run));

    await withStep(run, "open-target-post", async () => {
      await navigateX(options.url, switched.tabId);
      await waitForXReady(switched.tabId, { pageKind: "post" });
      await captureRunScreenshot(run, switched.tabId, "quote-target-post-before-actions");
      return await getXState(switched.tabId);
    });

    let likeResult: unknown = { skipped: true };
    if (options.like !== false) {
      likeResult = await withStep(run, "like-post", async () => likePost(options.url, switched.tabId));
    }

    const openQuote = await withStep(run, "open-quote-composer", async () => {
      const taggedRetweet = await tagAndClick(
        switched.tabId,
        "surfagent-x-retweet-target",
        String.raw`(() => {
          const article = [...document.querySelectorAll('article[data-testid="tweet"]')].find((a) => (a.innerText || a.textContent || '').includes('clawhub.ai')) || document.querySelector('article[data-testid="tweet"]');
          const btn = article?.querySelector('[data-testid="retweet"], [data-testid="unretweet"]');
          if (!btn) return { ok: false, error: 'retweet_button_missing' };
          btn.setAttribute('id', 'surfagent-x-retweet-target');
          return { ok: true, testid: btn.getAttribute('data-testid'), text: (btn.textContent || '').trim() };
        })();`,
        "retweet button",
      );
      await new Promise((resolve) => setTimeout(resolve, 900));
      const taggedQuote = await tagAndClick(
        switched.tabId,
        "surfagent-x-quote-target",
        String.raw`(() => {
          const items = [...document.querySelectorAll('[role="menuitem"]')];
          const quote = items.find((el) => /quote/i.test((el.innerText || el.textContent || '').trim()));
          if (!quote) return { ok: false, error: 'quote_menu_item_missing', items: items.map((el) => (el.innerText || el.textContent || '').trim()) };
          quote.setAttribute('id', 'surfagent-x-quote-target');
          return { ok: true, text: (quote.innerText || quote.textContent || '').trim(), items: items.map((el) => (el.innerText || el.textContent || '').trim()) };
        })();`,
        "quote menu item",
      );
      await waitForComposer(switched.tabId);
      await captureRunScreenshot(run, switched.tabId, "quote-composer-open");
      return { taggedRetweet, taggedQuote };
    });

    const composer = await withStep(run, "fill-quote-composer", async () => fillComposerWithRecovery(options.text, switched.tabId, run, "quote"));

    const submitResult = await withStep(run, "submit-quote", async () => {
      await captureRunScreenshot(run, switched.tabId, "quote-before-submit");
      const taggedSubmit = await evaluate<Record<string, unknown>>(String.raw`(() => {
        const btn = [...document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]')].find((el) => {
          const text = (el.textContent || '').trim();
          return text === 'Post' && !el.disabled;
        });
        if (!btn) return { ok: false, error: 'quote_submit_missing' };
        btn.setAttribute('id', 'surfagent-x-quote-submit');
        return { ok: true, text: (btn.textContent || '').trim(), testid: btn.getAttribute('data-testid') };
      })();`, switched.tabId);
      if (taggedSubmit.ok !== true) {
        throw new Error(`Could not tag quote submit button. Diagnostics: ${JSON.stringify(taggedSubmit)}`);
      }
      await clickSelector('#surfagent-x-quote-submit', switched.tabId);
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await captureRunScreenshot(run, switched.tabId, "quote-after-submit");
      return taggedSubmit;
    });

    const verify = await withStep(run, "verify-quote-visible", async () => verifyQuoteVisible(switched.activeHandle, options.text, switched.tabId, run));

    run.state = { switched, likeResult, openQuote, composer, submitResult, verify };
    await overwriteRunManifest(run);
    return run;
  } catch (error) {
    run.ok = false;
    run.error = error instanceof Error ? error.message : String(error);
    await overwriteRunManifest(run);
    throw error;
  }
}

function parseFlagMap(argv: string[]): { _: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i += 1;
  }
  return { _: positional, flags };
}

function usage(): string {
  return [
    "Usage:",
    "  surfagent-x task engage-post --account <handle> --url <post-url> [--no-like] [--repost]",
    "  surfagent-x task quote-post --account <handle> --url <post-url> --text <quote-text> [--no-like]",
  ].join("\n");
}

export async function runTaskCli(argv: string[]): Promise<number> {
  const parsed = parseFlagMap(argv);
  const [task] = parsed._;
  if (!task || task === "help" || parsed.flags.help === true) {
    console.log(usage());
    return 0;
  }

  if (task === "engage-post") {
    const account = String(parsed.flags.account ?? "").trim();
    const url = String(parsed.flags.url ?? "").trim();
    if (!account || !url) {
      console.error(usage());
      return 1;
    }
    const run = await runEngagePostTask({
      account,
      url,
      like: parsed.flags["no-like"] === true ? false : true,
      repost: parsed.flags.repost === true,
    });
    console.log(JSON.stringify(run, null, 2));
    return 0;
  }

  if (task === "quote-post") {
    const account = String(parsed.flags.account ?? "").trim();
    const url = String(parsed.flags.url ?? "").trim();
    const text = String(parsed.flags.text ?? "").trim();
    if (!account || !url || !text) {
      console.error(usage());
      return 1;
    }
    const run = await runQuotePostTask({
      account,
      url,
      text,
      like: parsed.flags["no-like"] === true ? false : true,
    });
    console.log(JSON.stringify(run, null, 2));
    return 0;
  }

  console.error(usage());
  return 1;
}
