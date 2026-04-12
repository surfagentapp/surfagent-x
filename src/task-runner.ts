import { join } from "node:path";
import { tmpdir } from "node:os";
import { clickSelector, evaluate, pressKey, screenshot, typeInto } from "./connection.js";
import { followProfile, getComposerState, getXState, likePost, navigateX, replyToPost, repostPost, switchXAccount, verifyTextVisible, waitForXReady } from "./x.js";
import { createTaskRunnerRuntime, type ScreenshotArtifact, type TaskRunBase, type TaskStep } from "./task-runner-runtime.js";

export type XTaskKind = "engage-post" | "quote-post" | "reply-post" | "follow-profile" | "community-post" | "switch-account-and-act";

type TaskRun = TaskRunBase & {
  adapter: "x";
  task: XTaskKind;
  account: string;
  url: string;
  quoteText?: string;
  steps: TaskStep[];
  artifacts: ScreenshotArtifact[];
  screenshots: ScreenshotArtifact[];
  state?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
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

export type ReplyPostOptions = {
  account: string;
  url: string;
  text: string;
  like?: boolean;
};

export type FollowProfileOptions = {
  account: string;
  username: string;
};

export type CommunityPostOptions = {
  account: string;
  url: string;
  text: string;
  join?: boolean;
};

export type SwitchAccountAndActOptions = {
  account: string;
  action: "open-home" | "open-url" | "follow-profile";
  url?: string;
  username?: string;
};

const RUN_ROOT = process.env.SURFAGENT_RUN_DIR || join(tmpdir(), "surfagent-x-runs");

const runtime = createTaskRunnerRuntime({
  rootDir: RUN_ROOT,
  screenshot,
});

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
}

function extractHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/@([A-Za-z0-9_]{1,15})/);
  const handle = match?.[1];
  return handle ? handle.toLowerCase() : null;
}

async function captureRunScreenshot(run: TaskRun, tabId: string | undefined, label: string): Promise<ScreenshotArtifact | null> {
  return runtime.captureScreenshot(run, tabId, label);
}

async function overwriteRunManifest(run: TaskRun): Promise<string> {
  return runtime.writeRunManifest(run);
}

async function withStep<T>(run: TaskRun, name: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await runtime.withStep(run, name, fn);
  } catch (error) {
    run.ok = false;
    run.error = {
      code: inferErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
    await overwriteRunManifest(run);
    throw error;
  }
}

function inferErrorCode(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/switch.*account|active handle|active account/i.test(text)) return 'account_switch_failed';
  if (/composer/i.test(text)) return 'composer_not_ready';
  if (/timed out|timeout|waiting for x to settle/i.test(text)) return 'surface_not_ready';
  if (/community/i.test(text)) return 'community_action_failed';
  if (/follow/i.test(text)) return 'follow_failed';
  if (/reply/i.test(text)) return 'reply_failed';
  if (/quote/i.test(text)) return 'quote_failed';
  if (/like|repost/i.test(text)) return 'engagement_failed';
  return 'task_failed';
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

async function verifyTextOnCurrentSurface(text: string, tabId: string, run: TaskRun, label: string, scope: "body" | "article" | "composer" = "body") {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const verify = await verifyTextVisible(text, tabId, scope);
    if ((verify as Record<string, unknown>).visible === true) {
      await captureRunScreenshot(run, tabId, label);
      return verify;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Text did not become visible for verification. label=${label}`);
}

async function openCommunityComposer(tabId: string, run: TaskRun) {
  const openResult = await evaluate<Record<string, unknown>>(String.raw`(() => {
    const joinButton = [...document.querySelectorAll('[role="button"], button')].find((el) => /join/i.test((el.textContent || '').trim()));
    const composer = document.querySelector('[data-testid="tweetTextarea_0"]');
    if (composer) {
      return { ok: true, composerAlreadyOpen: true, joined: !joinButton };
    }
    const audienceButton = [...document.querySelectorAll('[role="button"], button, div[role="button"]')].find((el) => /what'?s happening|post|tweet|start a post|share/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')));
    if (!audienceButton) {
      return { ok: false, error: 'community_composer_trigger_missing', visibleButtons: [...document.querySelectorAll('[role="button"], button')].slice(0, 30).map((el) => (el.textContent || '').trim()).filter(Boolean) };
    }
    audienceButton.setAttribute('id', 'surfagent-x-community-compose-target');
    return { ok: true, composerAlreadyOpen: false, joined: !joinButton, triggerText: (audienceButton.textContent || '').trim(), triggerAria: audienceButton.getAttribute('aria-label') || null };
  })();`, tabId);
  if (openResult.ok !== true) {
    throw new Error(`Could not open community composer. Diagnostics: ${JSON.stringify(openResult)}`);
  }
  if (openResult.composerAlreadyOpen !== true) {
    await clickSelector('#surfagent-x-community-compose-target', tabId);
    await waitForComposer(tabId);
  }
  await captureRunScreenshot(run, tabId, 'community-composer-open');
  return openResult;
}

async function maybeJoinCommunity(tabId: string, run: TaskRun) {
  const result = await evaluate<Record<string, unknown>>(String.raw`(() => {
    const joined = [...document.querySelectorAll('[role="button"], button')].some((el) => /joined/i.test((el.textContent || '').trim()));
    if (joined) return { ok: true, action: 'noop', joined: true };
    const btn = [...document.querySelectorAll('[role="button"], button')].find((el) => /join/i.test((el.textContent || '').trim()));
    if (!btn) return { ok: false, error: 'community_join_button_missing' };
    btn.setAttribute('id', 'surfagent-x-community-join-target');
    return { ok: true, action: 'join', joined: false, text: (btn.textContent || '').trim() };
  })();`, tabId);
  if (result.ok !== true) {
    throw new Error(`Could not determine community join state. Diagnostics: ${JSON.stringify(result)}`);
  }
  if (result.action === 'join') {
    await clickSelector('#surfagent-x-community-join-target', tabId);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await captureRunScreenshot(run, tabId, 'community-after-join');
  }
  return result;
}

async function submitComposer(tabId: string, submitId: string, label: string, run: TaskRun) {
  const taggedSubmit = await evaluate<Record<string, unknown>>(String.raw`(() => {
    const btn = [...document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]')].find((el) => {
      const text = (el.textContent || '').trim();
      return (text === 'Post' || text === 'Reply') && !(el as HTMLButtonElement).disabled;
    });
    if (!btn) return { ok: false, error: 'submit_button_missing' };
    btn.setAttribute('id', '${submitId}');
    return { ok: true, text: (btn.textContent || '').trim(), testid: btn.getAttribute('data-testid') };
  })();`, tabId);
  if (taggedSubmit.ok !== true) {
    throw new Error(`Could not tag submit button. Diagnostics: ${JSON.stringify(taggedSubmit)}`);
  }
  await captureRunScreenshot(run, tabId, `${label}-before-submit`);
  await clickSelector(`#${submitId}`, tabId);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await captureRunScreenshot(run, tabId, `${label}-after-submit`);
  return taggedSubmit;
}

export async function runEngagePostTask(options: EngagePostOptions): Promise<TaskRun> {
  const artifacts: ScreenshotArtifact[] = [];
  const run: TaskRun = {
    ok: true,
    adapter: "x",
    task: "engage-post",
    runId: runtime.makeRunId(`${slug(options.account)}-engage-post`),
    account: options.account,
    url: options.url,
    steps: [],
    artifacts,
    screenshots: artifacts,
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
    run.error = {
      code: inferErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
    await overwriteRunManifest(run);
    throw error;
  }
}

export async function runQuotePostTask(options: QuotePostOptions): Promise<TaskRun> {
  const artifacts: ScreenshotArtifact[] = [];
  const run: TaskRun = {
    ok: true,
    adapter: "x",
    task: "quote-post",
    runId: runtime.makeRunId(`${slug(options.account)}-quote-post`),
    account: options.account,
    url: options.url,
    quoteText: options.text,
    steps: [],
    artifacts,
    screenshots: artifacts,
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
    run.error = {
      code: inferErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
    await overwriteRunManifest(run);
    throw error;
  }
}

export async function runReplyPostTask(options: ReplyPostOptions): Promise<TaskRun> {
  const artifacts: ScreenshotArtifact[] = [];
  const run: TaskRun = {
    ok: true,
    adapter: 'x',
    task: 'reply-post',
    runId: runtime.makeRunId(`${slug(options.account)}-reply-post`),
    account: options.account,
    url: options.url,
    quoteText: options.text,
    steps: [],
    artifacts,
    screenshots: artifacts,
  };

  try {
    const switched = await withStep(run, 'switch-account', async () => ensureHomeAndSwitch(options.account, run));
    await withStep(run, 'open-target-post', async () => {
      await navigateX(options.url, switched.tabId);
      await waitForXReady(switched.tabId, { pageKind: 'post' });
      await captureRunScreenshot(run, switched.tabId, 'reply-target-post-before-actions');
      return await getXState(switched.tabId);
    });

    let likeResult: unknown = { skipped: true };
    if (options.like === true) {
      likeResult = await withStep(run, 'like-post', async () => likePost(options.url, switched.tabId));
    }

    const replyResult = await withStep(run, 'reply-post', async () => replyToPost(options.url, options.text, switched.tabId));
    const verify = await withStep(run, 'verify-reply-visible', async () => verifyTextOnCurrentSurface(options.text, switched.tabId, run, 'reply-verified-on-post', 'article'));
    run.state = { switched, likeResult, replyResult, verify };
    await overwriteRunManifest(run);
    return run;
  } catch (error) {
    run.ok = false;
    run.error = {
      code: inferErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
    await overwriteRunManifest(run);
    throw error;
  }
}

export async function runFollowProfileTask(options: FollowProfileOptions): Promise<TaskRun> {
  const artifacts: ScreenshotArtifact[] = [];
  const run: TaskRun = {
    ok: true,
    adapter: 'x',
    task: 'follow-profile',
    runId: runtime.makeRunId(`${slug(options.account)}-follow-profile`),
    account: options.account,
    url: `https://x.com/${options.username.replace(/^@+/, '')}`,
    steps: [],
    artifacts,
    screenshots: artifacts,
  };

  try {
    const switched = await withStep(run, 'switch-account', async () => ensureHomeAndSwitch(options.account, run));
    const followResult = await withStep(run, 'follow-profile', async () => {
      await navigateX(`/${options.username.replace(/^@+/, '')}`, switched.tabId);
      await waitForXReady(switched.tabId, { pageKind: 'profile' });
      await captureRunScreenshot(run, switched.tabId, 'follow-profile-before-action');
      return await followProfile(options.username, switched.tabId);
    });
    const finalState = await withStep(run, 'verify-follow-state', async () => {
      await captureRunScreenshot(run, switched.tabId, 'follow-profile-after-action');
      return await getXState(switched.tabId);
    });
    run.state = { switched, followResult, finalState };
    await overwriteRunManifest(run);
    return run;
  } catch (error) {
    run.ok = false;
    run.error = {
      code: inferErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
    await overwriteRunManifest(run);
    throw error;
  }
}

export async function runCommunityPostTask(options: CommunityPostOptions): Promise<TaskRun> {
  const artifacts: ScreenshotArtifact[] = [];
  const run: TaskRun = {
    ok: true,
    adapter: 'x',
    task: 'community-post',
    runId: runtime.makeRunId(`${slug(options.account)}-community-post`),
    account: options.account,
    url: options.url,
    quoteText: options.text,
    steps: [],
    artifacts,
    screenshots: artifacts,
  };

  try {
    const switched = await withStep(run, 'switch-account', async () => ensureHomeAndSwitch(options.account, run));
    await withStep(run, 'open-community', async () => {
      await navigateX(options.url, switched.tabId);
      await waitForXReady(switched.tabId, { pageKind: 'community' });
      await captureRunScreenshot(run, switched.tabId, 'community-before-actions');
      return await getXState(switched.tabId);
    });

    let joinResult: unknown = { skipped: true };
    if (options.join !== false) {
      joinResult = await withStep(run, 'ensure-community-membership', async () => maybeJoinCommunity(switched.tabId, run));
    }

    const composerOpen = await withStep(run, 'open-community-composer', async () => openCommunityComposer(switched.tabId, run));
    const composer = await withStep(run, 'fill-community-composer', async () => fillComposerWithRecovery(options.text, switched.tabId, run, 'post'));
    const submitResult = await withStep(run, 'submit-community-post', async () => submitComposer(switched.tabId, 'surfagent-x-community-submit', 'community-post', run));
    const verify = await withStep(run, 'verify-community-post-visible', async () => verifyTextOnCurrentSurface(options.text, switched.tabId, run, 'community-post-verified', 'body'));

    run.state = { switched, joinResult, composerOpen, composer, submitResult, verify };
    await overwriteRunManifest(run);
    return run;
  } catch (error) {
    run.ok = false;
    run.error = {
      code: inferErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
    await overwriteRunManifest(run);
    throw error;
  }
}

export async function runSwitchAccountAndActTask(options: SwitchAccountAndActOptions): Promise<TaskRun> {
  const artifacts: ScreenshotArtifact[] = [];
  const run: TaskRun = {
    ok: true,
    adapter: 'x',
    task: 'switch-account-and-act',
    runId: runtime.makeRunId(`${slug(options.account)}-switch-account-and-act`),
    account: options.account,
    url: options.url ?? (options.username ? `https://x.com/${options.username.replace(/^@+/, '')}` : 'https://x.com/home'),
    steps: [],
    artifacts,
    screenshots: artifacts,
  };

  try {
    const switched = await withStep(run, 'switch-account', async () => ensureHomeAndSwitch(options.account, run));
    let actionResult: unknown;
    if (options.action === 'open-home') {
      actionResult = await withStep(run, 'open-home', async () => {
        await navigateX('/home', switched.tabId);
        await waitForXReady(switched.tabId, { pageKind: 'home', pathIncludes: '/home' });
        await captureRunScreenshot(run, switched.tabId, 'switch-account-open-home');
        return await getXState(switched.tabId);
      });
    } else if (options.action === 'open-url') {
      if (!options.url) throw new Error('switch-account-and-act action=open-url requires url');
      actionResult = await withStep(run, 'open-url', async () => {
        await navigateX(options.url!, switched.tabId);
        await waitForXReady(switched.tabId, {});
        await captureRunScreenshot(run, switched.tabId, 'switch-account-open-url');
        return await getXState(switched.tabId);
      });
    } else if (options.action === 'follow-profile') {
      if (!options.username) throw new Error('switch-account-and-act action=follow-profile requires username');
      actionResult = await withStep(run, 'follow-profile', async () => {
        await navigateX(`/${options.username!.replace(/^@+/, '')}`, switched.tabId);
        await waitForXReady(switched.tabId, { pageKind: 'profile' });
        await captureRunScreenshot(run, switched.tabId, 'switch-account-follow-before');
        return await followProfile(options.username!, switched.tabId);
      });
      await withStep(run, 'verify-follow-surface', async () => {
        await captureRunScreenshot(run, switched.tabId, 'switch-account-follow-after');
        return await getXState(switched.tabId);
      });
    } else {
      throw new Error(`Unsupported switch-account-and-act action: ${options.action}`);
    }

    run.state = { switched, actionResult };
    await overwriteRunManifest(run);
    return run;
  } catch (error) {
    run.ok = false;
    run.error = {
      code: inferErrorCode(error),
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
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
    'Usage:',
    '  surfagent-x task engage-post --account <handle> --url <post-url> [--no-like] [--repost]',
    '  surfagent-x task quote-post --account <handle> --url <post-url> --text <quote-text> [--no-like]',
    '  surfagent-x task reply-post --account <handle> --url <post-url> --text <reply-text> [--like]',
    '  surfagent-x task follow-profile --account <handle> --username <target-handle>',
    '  surfagent-x task community-post --account <handle> --url <community-url> --text <post-text> [--no-join]',
    '  surfagent-x task switch-account-and-act --account <handle> --action <open-home|open-url|follow-profile> [--url <url>] [--username <target-handle>]',
  ].join('\n');
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

  if (task === 'quote-post') {
    const account = String(parsed.flags.account ?? '').trim();
    const url = String(parsed.flags.url ?? '').trim();
    const text = String(parsed.flags.text ?? '').trim();
    if (!account || !url || !text) {
      console.error(usage());
      return 1;
    }
    const run = await runQuotePostTask({
      account,
      url,
      text,
      like: parsed.flags['no-like'] === true ? false : true,
    });
    console.log(JSON.stringify(run, null, 2));
    return 0;
  }

  if (task === 'reply-post') {
    const account = String(parsed.flags.account ?? '').trim();
    const url = String(parsed.flags.url ?? '').trim();
    const text = String(parsed.flags.text ?? '').trim();
    if (!account || !url || !text) {
      console.error(usage());
      return 1;
    }
    const run = await runReplyPostTask({
      account,
      url,
      text,
      like: parsed.flags.like === true,
    });
    console.log(JSON.stringify(run, null, 2));
    return 0;
  }

  if (task === 'follow-profile') {
    const account = String(parsed.flags.account ?? '').trim();
    const username = String(parsed.flags.username ?? '').trim();
    if (!account || !username) {
      console.error(usage());
      return 1;
    }
    const run = await runFollowProfileTask({ account, username });
    console.log(JSON.stringify(run, null, 2));
    return 0;
  }

  if (task === 'community-post') {
    const account = String(parsed.flags.account ?? '').trim();
    const url = String(parsed.flags.url ?? '').trim();
    const text = String(parsed.flags.text ?? '').trim();
    if (!account || !url || !text) {
      console.error(usage());
      return 1;
    }
    const run = await runCommunityPostTask({ account, url, text, join: parsed.flags['no-join'] === true ? false : true });
    console.log(JSON.stringify(run, null, 2));
    return 0;
  }

  if (task === 'switch-account-and-act') {
    const account = String(parsed.flags.account ?? '').trim();
    const action = String(parsed.flags.action ?? '').trim() as SwitchAccountAndActOptions['action'];
    const url = String(parsed.flags.url ?? '').trim() || undefined;
    const username = String(parsed.flags.username ?? '').trim() || undefined;
    if (!account || !action) {
      console.error(usage());
      return 1;
    }
    const run = await runSwitchAccountAndActTask({
      account,
      action,
      ...(url ? { url } : {}),
      ...(username ? { username } : {}),
    });
    console.log(JSON.stringify(run, null, 2));
    return 0;
  }

  console.error(usage());
  return 1;
}
