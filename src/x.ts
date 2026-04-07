import { ensureXTab, evaluate, findXTab, navigateTab, typeInto } from "./connection.js";

export type XPageKind =
  | "home"
  | "post"
  | "profile"
  | "search"
  | "notifications"
  | "community"
  | "compose"
  | "unknown";

export type XReadyExpectation = {
  pathIncludes?: string;
  urlIncludes?: string;
  postId?: string;
  pageKind?: XPageKind;
};

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_WAIT_POLL_MS = 300;

export async function openXPath(path: string) {
  return ensureXTab(path);
}

export async function requireXTab() {
  const tab = await findXTab();
  if (!tab) {
    throw new Error("No X tab found. Use x_open first.");
  }
  return tab;
}

export async function navigateX(urlOrPath: string) {
  const tab = await requireXTab().catch(() => null);
  const url = normalizeXUrl(urlOrPath);
  return navigateTab(url, tab?.id);
}

export async function getXState(tabId?: string) {
  const raw = await evaluate<string>(buildStateExpression(), tabId);
  return parseJsonResult(raw);
}

export async function waitForXReady(tabId?: string, expected: XReadyExpectation = {}) {
  const deadline = Date.now() + DEFAULT_WAIT_TIMEOUT_MS;
  let stableCount = 0;
  let lastFingerprint = "";

  while (Date.now() < deadline) {
    const raw = await evaluate<string>(buildReadyExpression(expected), tabId);
    const state = parseJsonResult(raw) as Record<string, unknown>;
    const ready = state.ready === true && state.routeMatches === true;
    const fingerprint = String(state.fingerprint ?? "");

    if (ready) {
      stableCount = fingerprint === lastFingerprint ? stableCount + 1 : 1;
      if (stableCount >= 2) return state;
    } else {
      stableCount = 0;
    }

    lastFingerprint = fingerprint;
    await sleep(DEFAULT_WAIT_POLL_MS);
  }

  throw new Error(`Timed out waiting for X to settle${describeExpectation(expected)}.`);
}

export async function getTimelinePosts(limit = 10, tabId?: string) {
  const raw = await evaluate<string>(buildTimelineExtractionExpression(limit), tabId);
  return parseJsonResult(raw);
}

export async function searchXPosts(query: string, limit = 10) {
  const path = `/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
  const tab = await openXPath(path);
  await waitForXReady(tab.id, { pathIncludes: "/search", pageKind: "search" });
  await sleep(1200);
  return getTimelinePosts(limit, tab.id);
}

export async function searchXCommunities(query: string, limit = 10) {
  const path = `/search?q=${encodeURIComponent(query)}&src=typed_query&f=communities`;
  const tab = await openXPath(path);
  await waitForXReady(tab.id, { pathIncludes: "/search", pageKind: "search" });
  await sleep(1500);
  const raw = await evaluate<string>(buildCommunitySearchExpression(limit), tab.id);
  return parseJsonResult(raw);
}

export async function searchXProfiles(query: string, limit = 10) {
  const path = `/search?q=${encodeURIComponent(query)}&src=typed_query`;
  const tab = await openXPath(path);
  await waitForXReady(tab.id, { pathIncludes: "/search", pageKind: "search" });
  await evaluate<string>(buildSearchTabSelectionExpression("People"), tab.id).catch(() => null);
  await sleep(1500);
  const raw = await evaluate<string>(buildProfileSearchExpression(limit), tab.id);
  return parseJsonResult(raw);
}

export async function getCommunityFeed(limit = 10, communityUrl?: string) {
  const tab = communityUrl ? await navigateX(communityUrl) : await requireXTab();
  await waitForXReady(tab.id, communityUrl ? { pageKind: 'community' } : {});
  await sleep(1200);
  const raw = await evaluate<string>(buildCommunityFeedExpression(limit), tab.id);
  return parseJsonResult(raw);
}

export async function extractCommunity(communityUrl: string) {
  const tab = await navigateX(communityUrl);
  await waitForXReady(tab.id, { pageKind: 'community' });
  await sleep(1200);
  const raw = await evaluate<string>(buildCommunityExtractionExpression(), tab.id);
  return parseJsonResult(raw);
}

export async function extractPost(postUrl: string) {
  const postId = parsePostIdFromUrl(postUrl);
  const tab = await navigateX(postUrl);
  await waitForXReady(tab.id, postId ? { postId, pageKind: 'post' } : { pageKind: 'post' });
  await sleep(1200);
  const raw = await evaluate<string>(buildPostExtractionExpression(postId), tab.id);
  return parseJsonResult(raw);
}

export async function extractProfile(username: string) {
  const cleanUsername = username.replace(/^@+/, '');
  const tab = await navigateX(`/${cleanUsername}`);
  await waitForXReady(tab.id, { pageKind: 'profile' });
  await sleep(1200);
  const raw = await evaluate<string>(buildProfileExtractionExpression(), tab.id);
  return parseJsonResult(raw);
}

export async function getProfilePosts(username: string, limit = 10) {
  const cleanUsername = username.replace(/^@+/, '');
  const tab = await navigateX(`/${cleanUsername}`);
  await waitForXReady(tab.id, { pageKind: 'profile' });
  await sleep(1200);
  const raw = await evaluate<string>(buildProfilePostsExpression(cleanUsername, limit), tab.id);
  return parseJsonResult(raw);
}

export async function getPostThread(postUrl: string, limit = 20) {
  const postId = parsePostIdFromUrl(postUrl);
  const tab = await navigateX(postUrl);
  await waitForXReady(tab.id, postId ? { postId, pageKind: 'post' } : { pageKind: 'post' });
  await sleep(1500);
  const raw = await evaluate<string>(buildThreadExtractionExpression(postId, limit), tab.id);
  return parseJsonResult(raw);
}

export async function createPost(text: string, tabId?: string) {
  const tab = tabId ? { id: tabId } : await openXPath("/home");
  await waitForXReady(tab.id, { pathIncludes: "/home", pageKind: "home" });
  await focusHomeComposer(tab.id);
  await typeInto('[data-testid="tweetTextarea_0"]', text, tab.id);
  const beforeSubmit = await getComposerState(tab.id);
  if (!beforeSubmit.present || !beforeSubmit.hasText) {
    throw new Error("Composer did not retain the typed text. X likely ignored the input.");
  }
  if (!beforeSubmit.buttonEnabled) {
    throw new Error("Composer has text, but the Post button is still disabled.");
  }
  const clickResult = await clickButtonByTestId(["tweetButtonInline", "tweetButton"], tab.id, ["Post"]);
  if ((clickResult as Record<string, unknown>).ok !== true) {
    throw new Error("Failed to click the Post button.");
  }
  await sleep(2500);
  const afterSubmitState = await getComposerState(tab.id);
  const verify = await verifyTextVisible(text, tab.id, "article");
  return {
    submitted: true,
    composerStateBeforeSubmit: beforeSubmit,
    clickResult,
    composerStateAfterSubmit: afterSubmitState,
    verify,
  };
}

export async function replyToPost(postUrl: string, text: string) {
  const postId = parsePostIdFromUrl(postUrl);
  const tab = await navigateX(postUrl);
  await waitForXReady(tab.id, postId ? { postId, pageKind: "post" } : { pageKind: "post" });
  await waitForPostAction(tab.id, postId, "reply");
  const openReply = await evaluate<string>(buildTargetedActionExpression(postId, "reply", true), tab.id);
  const openReplyResult = parseJsonResult(openReply);
  if ((openReplyResult as Record<string, unknown>).ok !== true) {
    throw new Error("Reply button was not found on the target post.");
  }
  await sleep(1500);
  await typeInto('[data-testid="tweetTextarea_0"]', text, tab.id);
  const composer = await getComposerState(tab.id);
  if (!composer.present || !composer.hasText) {
    throw new Error("Reply composer did not retain the typed text.");
  }
  if (!composer.buttonEnabled) {
    throw new Error("Reply composer is open, but the Reply button is still disabled.");
  }
  const clickResult = await clickButtonByTestId(["tweetButton", "tweetButtonInline"], tab.id, ["Reply", "Post"]);
  if ((clickResult as Record<string, unknown>).ok !== true) {
    throw new Error("Failed to click the Reply button.");
  }
  await sleep(2500);
  const verify = await verifyTextVisible(text, tab.id, "article");
  return { submitted: true, postId, openReplyResult, composer, clickResult, verify };
}

export async function likePost(postUrl: string) {
  const postId = parsePostIdFromUrl(postUrl);
  const tab = await navigateX(postUrl);
  await waitForXReady(tab.id, postId ? { postId, pageKind: "post" } : { pageKind: "post" });
  await waitForPostAction(tab.id, postId, "like");
  const raw = await evaluate<string>(buildTargetedActionExpression(postId, "like", true), tab.id);
  const result = parseJsonResult(raw);
  if ((result as Record<string, unknown>).ok !== true) {
    throw new Error("Like button was not found on the target post.");
  }
  await sleep(1200);
  const verify = await evaluate<string>(buildTargetedActionExpression(postId, "like_state", false), tab.id);
  return { ...result, verify: parseJsonResult(verify), postId };
}

export async function getComposerState(tabId?: string) {
  const raw = await evaluate<string>(String.raw`(() => {
    const textarea = document.querySelector('[data-testid="tweetTextarea_0"]');
    const text = textarea ? ((textarea.textContent || textarea.innerText || '').trim()) : '';
    const buttons = [...document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]')];
    const candidates = buttons.map(btn => ({
      text: (btn.textContent || '').trim(),
      disabled: !!btn.disabled,
      testid: btn.getAttribute('data-testid')
    }));
    const target = candidates.find(btn => ['Post', 'Reply'].includes(btn.text)) || null;
    return JSON.stringify({
      ok: true,
      present: !!textarea,
      text: text || null,
      textLength: text.length,
      hasText: text.length > 0,
      buttonText: target ? target.text : null,
      buttonEnabled: target ? !target.disabled : false,
      buttonTestId: target ? target.testid : null,
      buttonCandidates: candidates,
    });
  })();`, tabId);
  return parseJsonResult(raw);
}

export async function focusHomeComposer(tabId?: string) {
  const raw = await evaluate<string>(String.raw`(() => {
    const clickEl = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach((type) => {
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, buttons: type.includes('down') ? 1 : 0, pointerId: 1, pointerType: 'mouse' }));
      });
      return true;
    };
    const composer = document.querySelector('[data-testid="tweetTextarea_0"]');
    if (composer) {
      composer.focus();
      return JSON.stringify({ ok: true, mode: 'existing' });
    }
    const launcher = document.querySelector('[data-testid="SideNav_NewTweet_Button"], a[data-testid="SideNav_NewTweet_Button"]');
    if (launcher) {
      clickEl(launcher);
      return JSON.stringify({ ok: true, mode: 'launcher' });
    }
    return JSON.stringify({ ok: false, error: 'composer_not_found' });
  })();`, tabId);
  const result = parseJsonResult(raw);
  if ((result as Record<string, unknown>).ok !== true) {
    throw new Error("Could not focus or open the X composer.");
  }
  await sleep(600);
  return result;
}

export async function clickButtonByTestId(testIds: string[], tabId?: string, allowedText: string[] = []) {
  const expr = String.raw`(() => {
    const clickEl = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach((type) => {
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, buttons: type.includes('down') ? 1 : 0, pointerId: 1, pointerType: 'mouse' }));
      });
      return true;
    };
    const candidates = ${JSON.stringify(testIds)}.flatMap((testId) => [...document.querySelectorAll('[data-testid="' + testId + '"]')]);
    const btn = candidates.find((candidate) => {
      const txt = (candidate.textContent || '').trim();
      if (${JSON.stringify(allowedText)}.length === 0) return !candidate.disabled;
      return !candidate.disabled && ${JSON.stringify(allowedText)}.includes(txt);
    }) || null;
    if (!btn) return JSON.stringify({ ok: false, error: 'button_not_found_or_disabled' });
    clickEl(btn);
    return JSON.stringify({ ok: true, text: (btn.textContent || '').trim(), testid: btn.getAttribute('data-testid') });
  })();`;
  return parseJsonResult(await evaluate<string>(expr, tabId));
}

export async function verifyTextVisible(text: string, tabId?: string, scope: "body" | "article" | "composer" = "body") {
  const needle = JSON.stringify(text.trim());
  const raw = await evaluate<string>(String.raw`(() => {
    const needle = ${needle};
    const haystacks = (() => {
      if (${JSON.stringify(scope)} === 'article') {
        return [...document.querySelectorAll('article[data-testid="tweet"]')].map(el => (el.innerText || el.textContent || '').trim());
      }
      if (${JSON.stringify(scope)} === 'composer') {
        const composer = document.querySelector('[data-testid="tweetTextarea_0"]');
        return [composer ? ((composer.innerText || composer.textContent || '').trim()) : ''];
      }
      return [document.body?.innerText || ''];
    })();
    const visible = haystacks.some(value => value.includes(needle));
    return JSON.stringify({ ok: true, visible, needle, scope: ${JSON.stringify(scope)} });
  })();`, tabId);
  return parseJsonResult(raw);
}

function buildStateExpression() {
  return String.raw`(() => {
    const url = location.href;
    const path = location.pathname;
    const title = document.title;
    const selectedTabs = [...document.querySelectorAll('[role="tab"][aria-selected="true"]')].map(el => (el.textContent || '').trim()).filter(Boolean);
    const primaryColumn = document.querySelector('[data-testid="primaryColumn"]');
    const main = document.querySelector('main[role="main"]');
    const composer = document.querySelector('[data-testid="tweetTextarea_0"]');
    const composerText = composer ? ((composer.textContent || composer.innerText || '').trim()) : null;
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const postButton = [...document.querySelectorAll('[data-testid="tweetButtonInline"], [data-testid="tweetButton"]')]
      .map(el => ({
        text: (el.textContent || '').trim(),
        disabled: !!el.disabled,
        testid: el.getAttribute('data-testid')
      }))
      .find(btn => btn.text === 'Post' || btn.text === 'Reply') || null;
    const pageKind = (() => {
      if (path === '/home') return 'home';
      if (/\/status\/\d+/.test(path)) return 'post';
      if (path.startsWith('/search')) return 'search';
      if (path.startsWith('/notifications')) return 'notifications';
      if (path.startsWith('/compose')) return 'compose';
      if (path.startsWith('/i/communities') || selectedTabs.some(t => /community/i.test(t))) return 'community';
      if (/^\/[A-Za-z0-9_]{1,15}$/.test(path)) return 'profile';
      return 'unknown';
    })();
    const activeAccount = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]')?.textContent?.trim() || null;
    return JSON.stringify({
      ok: true,
      url,
      path,
      title,
      pageKind,
      selectedTabs,
      activeAccount,
      mainPresent: !!main,
      primaryColumnPresent: !!primaryColumn,
      articleCount: articles.length,
      composerPresent: !!composer,
      composerText,
      postButton,
    });
  })();`;
}

function buildReadyExpression(expected: XReadyExpectation) {
  return String.raw`(() => {
    const url = location.href;
    const path = location.pathname;
    const title = document.title || '';
    const hostOk = /(^|\.)((x)|(twitter))\.com$/i.test(location.hostname);
    const mainPresent = !!document.querySelector('main[role="main"]');
    const primaryColumnPresent = !!document.querySelector('[data-testid="primaryColumn"]');
    const articleCount = document.querySelectorAll('article[data-testid="tweet"]').length;
    const composerPresent = !!document.querySelector('[data-testid="tweetTextarea_0"]');
    const pageKind = (() => {
      if (path === '/home') return 'home';
      if (/\/status\/\d+/.test(path)) return 'post';
      if (path.startsWith('/search')) return 'search';
      if (path.startsWith('/notifications')) return 'notifications';
      if (path.startsWith('/compose')) return 'compose';
      if (path.startsWith('/i/communities')) return 'community';
      if (/^\/[A-Za-z0-9_]{1,15}$/.test(path)) return 'profile';
      return 'unknown';
    })();
    const expected = ${JSON.stringify(expected)};
    const routeMatches = [
      !expected.pathIncludes || path.includes(expected.pathIncludes),
      !expected.urlIncludes || url.includes(expected.urlIncludes),
      !expected.pageKind || pageKind === expected.pageKind,
      !expected.postId || (path.includes('/status/' + expected.postId) || !!document.querySelector('a[href*="/status/' + String(expected.postId).replace(/"/g, '') + '"]')),
    ].every(Boolean);
    const ready = hostOk && mainPresent && (primaryColumnPresent || composerPresent || articleCount > 0) && !/loading/i.test(title);
    return JSON.stringify({
      ok: true,
      ready,
      routeMatches,
      url,
      path,
      title,
      pageKind,
      articleCount,
      composerPresent,
      fingerprint: [url, title, pageKind, articleCount, composerPresent ? '1' : '0', primaryColumnPresent ? '1' : '0'].join('|'),
    });
  })();`;
}

function buildSharedExtractionHelpers() {
  return String.raw`
    const pickText = (root, selectors) => {
      for (const selector of selectors) {
        const nodes = [...root.querySelectorAll(selector)];
        const text = nodes.map(el => (el.innerText || el.textContent || '').trim()).filter(Boolean).join('\n').trim();
        if (text) return text;
      }
      return '';
    };
    const getStatusHref = (root) => {
      return [...root.querySelectorAll('a[href*="/status/"]')]
        .map(a => a.getAttribute('href') || '')
        .find(href => /\/status\/\d+/.test(href)) || null;
    };
    const getAuthorHref = (root) => {
      return [...root.querySelectorAll('a[href^="/"]')]
        .map(a => a.getAttribute('href') || '')
        .find(href => /^\/[A-Za-z0-9_]{1,15}$/.test(href)) || null;
    };
    const parsePost = (article, index = 0) => {
      const statusHref = getStatusHref(article);
      const authorHref = getAuthorHref(article);
      const likeButton = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
      const media = [...article.querySelectorAll('img[src], video[src], video source[src]')]
        .map(el => el.getAttribute('src') || '')
        .filter(Boolean);
      return {
        index,
        postId: statusHref?.match(/\/status\/(\d+)/)?.[1] || null,
        url: statusHref ? new URL(statusHref, location.origin).toString() : null,
        author: authorHref ? authorHref.replace(/^\//, '') : null,
        text: pickText(article, ['[data-testid="tweetText"]', '[lang]', 'div[dir="auto"]']),
        reply: article.querySelector('[data-testid="reply"]')?.getAttribute('aria-label') || null,
        repost: article.querySelector('[data-testid="retweet"], [data-testid="unretweet"]')?.getAttribute('aria-label') || null,
        like: likeButton?.getAttribute('aria-label') || null,
        liked: likeButton?.getAttribute('data-testid') === 'unlike',
        media,
      };
    };
    const diagnostics = () => ({
      url: location.href,
      path: location.pathname,
      title: document.title || null,
      articleCount: document.querySelectorAll('article[data-testid="tweet"]').length,
      primaryColumnPresent: !!document.querySelector('[data-testid="primaryColumn"]'),
    });
  `;
}

function buildTimelineExtractionExpression(limit: number) {
  return String.raw`(() => {
    ${buildSharedExtractionHelpers()}
    const posts = [...document.querySelectorAll('article[data-testid="tweet"]')]
      .slice(0, ${Math.max(1, Math.min(limit, 20))})
      .map((article, index) => parsePost(article, index))
      .filter(post => post.text || post.url);
    return JSON.stringify({ ok: true, count: posts.length, posts, diagnostics: diagnostics() });
  })();`;
}

function buildCommunitySearchExpression(limit: number) {
  return String.raw`(() => {
    const links = [...document.querySelectorAll('a[href*="/i/communities/"]')];
    const seen = new Set();
    const communities = [];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!href || seen.has(href)) continue;
      seen.add(href);
      const card = link.closest('section, article, div') || link;
      const text = (card.innerText || link.textContent || '').trim();
      const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
      communities.push({
        index: communities.length,
        url: new URL(href, location.origin).toString(),
        communityId: href.match(/\/i\/communities\/(\d+)/)?.[1] || null,
        name: lines[0] || link.textContent?.trim() || null,
        description: lines.slice(1).join(' ').trim() || null,
        rawText: text || null,
      });
      if (communities.length >= ${Math.max(1, Math.min(limit, 20))}) break;
    }
    return JSON.stringify({ ok: true, count: communities.length, communities, diagnostics: { url: location.href, title: document.title || null } });
  })();`;
}

function buildProfileSearchExpression(limit: number) {
  return String.raw`(() => {
    const root = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main[role="main"]') || document;
    const reserved = new Set(['home','explore','notifications','messages','bookmarks','premium','communities','articles','i','search','compose','settings']);
    const links = [...root.querySelectorAll('a[href^="/"]')];
    const seen = new Set();
    const profiles = [];
    for (const link of links) {
      const href = link.getAttribute('href') || '';
      if (!/^\/[A-Za-z0-9_]{1,15}$/.test(href) || seen.has(href)) continue;
      const username = href.replace(/^\//, '');
      if (reserved.has(username.toLowerCase())) continue;
      const card = link.closest('article, section, div[data-testid="cellInnerDiv"], div[role="link"], div') || link;
      const text = (card.innerText || link.textContent || '').trim();
      if (!text || text.length < 3) continue;
      const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
      const hasHandleEvidence = text.includes('@' + username) || !!card.querySelector('[data-testid="User-Name"]');
      if (!hasHandleEvidence) continue;
      seen.add(href);
      const handleLine = lines.find(line => line.includes('@' + username)) || '@' + username;
      const displayName = lines.find(line => line && !line.includes('@' + username) && line !== 'Follow' && line !== 'Following') || link.textContent?.trim() || username;
      const bio = lines.filter(line => line !== displayName && line !== handleLine && line !== 'Follow' && line !== 'Following').slice(0, 3).join(' ').trim() || null;
      profiles.push({
        index: profiles.length,
        url: new URL(href, location.origin).toString(),
        username,
        displayName,
        handle: handleLine,
        bio,
        rawText: text,
      });
      if (profiles.length >= ${Math.max(1, Math.min(limit, 20))}) break;
    }
    return JSON.stringify({ ok: true, count: profiles.length, profiles, diagnostics: { url: location.href, title: document.title || null } });
  })();`;
}

function buildSearchTabSelectionExpression(tabLabel: string) {
  return String.raw`(() => {
    const label = ${JSON.stringify(tabLabel)}.toLowerCase();
    const clickEl = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach((type) => {
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, buttons: type.includes('down') ? 1 : 0, pointerId: 1, pointerType: 'mouse' }));
      });
      return true;
    };
    const tabs = [...document.querySelectorAll('[role="tab"], a[role="tab"]')];
    const target = tabs.find(el => ((el.textContent || '').trim().toLowerCase() === label)) || null;
    if (!target) return JSON.stringify({ ok: false, error: 'search_tab_not_found', requested: ${JSON.stringify(tabLabel)} });
    clickEl(target);
    return JSON.stringify({ ok: true, selected: (target.textContent || '').trim() });
  })();`;
}

function buildCommunityFeedExpression(limit: number) {
  return String.raw`(() => {
    ${buildSharedExtractionHelpers()}
    const communityHref = [...document.querySelectorAll('a[href*="/i/communities/"]')].map(a => a.getAttribute('href') || '').find(Boolean) || null;
    const posts = [...document.querySelectorAll('article[data-testid="tweet"]')]
      .slice(0, ${Math.max(1, Math.min(limit, 30))})
      .map((article, index) => ({ ...parsePost(article, index), communityUrl: communityHref ? new URL(communityHref, location.origin).toString() : null }))
      .filter(post => post.text || post.url);
    return JSON.stringify({ ok: true, count: posts.length, posts, diagnostics: diagnostics() });
  })();`;
}

function buildCommunityExtractionExpression() {
  return String.raw`(() => {
    ${buildSharedExtractionHelpers()}
    const path = location.pathname;
    const communityId = path.match(/\/i\/communities\/(\d+)/)?.[1] || null;
    const clean = (text) => (text || '').replace(/To view keyboard shortcuts, press question mark/gi, '').replace(/View keyboard shortcuts/gi, '').replace(/\s+/g, ' ').trim();
    const pageTitle = clean((document.title || '').replace(/\s*\/\s*X$/i, '').replace(/\s*Community$/i, ''));
    const headings = [...document.querySelectorAll('h1, h2, [role="heading"]')]
      .map(el => clean(el.textContent || ''))
      .filter(Boolean)
      .filter(text => text.length < 120 && !/^home$|^explore$|^notifications$/i.test(text));
    const pageText = document.body?.innerText || '';
    const lines = pageText.split(/\n+/).map(line => clean(line)).filter(Boolean);
    const statsLineCandidates = lines.filter(line => /members?/i.test(line) || /^\d[\d.,KMkm\s]*Posts?$/i.test(line));
    const memberCount = statsLineCandidates.find(line => /members?/i.test(line)) || null;
    const postCount = statsLineCandidates.find(line => /^\d[\d.,KMkm\s]*Posts?$/i.test(line)) || null;
    const name = headings.find(text => /community/i.test(pageTitle) ? text.toLowerCase() === pageTitle.toLowerCase() : true) || pageTitle || null;
    const tagline = headings.find(text => text !== name && text.length < 80) || null;
    const descriptionCandidates = lines.filter(line => line.length > 12 && line.length < 280 && line !== name && line !== tagline && !/members?|posts?|click to join|join(ed)?$/i.test(line));
    const description = descriptionCandidates[0] || null;
    const joinButton = [...document.querySelectorAll('div[role="button"], button')]
      .map(el => ({ text: clean(el.textContent || ''), disabled: !!el.getAttribute('disabled') || !!el.getAttribute('aria-disabled') }))
      .find(btn => /join|joined|request/i.test(btn.text)) || null;
    return JSON.stringify({
      ok: true,
      community: {
        communityId,
        url: location.href,
        name,
        tagline,
        description,
        memberCount,
        postCount,
        joinState: joinButton ? { label: joinButton.text, disabled: joinButton.disabled } : null,
      },
      diagnostics: diagnostics(),
    });
  })();`;
}

function buildPostExtractionExpression(postId: string | null) {
  return String.raw`(() => {
    ${buildSharedExtractionHelpers()}
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const article = articles.find(candidate => {
      const href = getStatusHref(candidate);
      return ${JSON.stringify(postId)} ? !!href && href.includes('/status/' + ${JSON.stringify(postId)}) : !!href;
    }) || articles[0] || null;
    if (!article) return JSON.stringify({ ok: false, error: 'post_not_found', diagnostics: diagnostics() });
    const post = parsePost(article, 0);
    const authorBlock = article.querySelector('[data-testid="User-Name"]');
    const timeHref = article.querySelector('time')?.closest('a')?.getAttribute('href') || null;
    const articleChildren = [...article.querySelectorAll('article[data-testid="tweet"]')];
    const quoted = articleChildren.find(candidate => candidate !== article) || null;
    return JSON.stringify({
      ok: true,
      post: {
        ...post,
        author: {
          handle: post.author,
          displayName: authorBlock?.textContent?.trim() || null,
        },
        timestamp: timeHref ? new URL(timeHref, location.origin).toString() : null,
        stats: {
          replies: post.reply,
          reposts: post.repost,
          likes: post.like,
          views: [...article.querySelectorAll('a[href$="/analytics"]')].map(a => a.textContent?.trim() || '').find(Boolean) || null,
        },
        quotedPost: quoted ? parsePost(quoted, 1) : null,
      },
      diagnostics: diagnostics(),
    });
  })();`;
}

function buildProfileExtractionExpression() {
  return String.raw`(() => {
    ${buildSharedExtractionHelpers()}
    const path = location.pathname;
    const handle = path.replace(/^\//, '').split('/')[0] || null;
    const statsLinks = [...document.querySelectorAll('a[href$="/verified_followers"], a[href$="/followers"], a[href$="/following"]')];
    const getMetric = (suffix) => {
      const link = statsLinks.find(a => (a.getAttribute('href') || '').endsWith(suffix));
      return link ? (link.textContent || '').trim() : null;
    };
    const spans = [...document.querySelectorAll('span')].map(el => (el.textContent || '').trim()).filter(Boolean);
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const pinned = articles.find(article => /Pinned/i.test(article.innerText || '')) || null;
    const websiteCandidates = [...document.querySelectorAll('a[href^="http"]')]
      .map(a => a.getAttribute('href') || '')
      .filter(href => href && !/https?:\/\/(?:www\.)?(?:x|twitter)\.com/i.test(href));
    return JSON.stringify({
      ok: true,
      profile: {
        handle,
        displayName: document.querySelector('[data-testid="UserName"]')?.textContent?.split('@')[0]?.trim() || null,
        bio: document.querySelector('[data-testid="UserDescription"]')?.textContent?.trim() || null,
        followers: getMetric('/followers'),
        following: getMetric('/following'),
        verifiedFollowers: getMetric('/verified_followers'),
        verifiedType: document.querySelector('[data-testid="icon-verified"]') ? 'verified' : null,
        joinedAt: spans.find(text => /^Joined /i.test(text)) || null,
        location: document.querySelector('[data-testid="UserLocation"]')?.textContent?.trim() || null,
        website: websiteCandidates[0] || null,
        pinnedPost: pinned ? parsePost(pinned, 0) : null,
      },
      diagnostics: diagnostics(),
    });
  })();`;
}

function buildProfilePostsExpression(username: string, limit: number) {
  return String.raw`(() => {
    ${buildSharedExtractionHelpers()}
    const posts = [...document.querySelectorAll('article[data-testid="tweet"]')]
      .slice(0, ${Math.max(1, Math.min(limit, 30))})
      .map((article, index) => ({ ...parsePost(article, index), profileUsername: ${JSON.stringify(username)} }))
      .filter(post => post.text || post.url);
    return JSON.stringify({ ok: true, count: posts.length, posts, diagnostics: diagnostics() });
  })();`;
}

function buildThreadExtractionExpression(postId: string | null, limit: number) {
  return String.raw`(() => {
    ${buildSharedExtractionHelpers()}
    const posts = [...document.querySelectorAll('article[data-testid="tweet"]')]
      .slice(0, ${Math.max(1, Math.min(limit, 50))})
      .map((article, index) => {
        const post = parsePost(article, index);
        return {
          ...post,
          isTarget: ${JSON.stringify(postId)} ? !!post.url && post.url.includes('/status/' + ${JSON.stringify(postId)}) : index === 0,
        };
      })
      .filter(post => post.text || post.url);
    return JSON.stringify({ ok: true, count: posts.length, posts, diagnostics: diagnostics() });
  })();`;
}

function buildTargetedActionExpression(postId: string | null, action: "reply" | "like" | "like_state", click = false) {
  return String.raw`(() => {
    const clickEl = (el) => {
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach((type) => {
        el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, button: 0, buttons: type.includes('down') ? 1 : 0, pointerId: 1, pointerType: 'mouse' }));
      });
      return true;
    };
    const targetPostId = ${JSON.stringify(postId)};
    const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const article = articles.find((candidate) => {
      const hrefs = [...candidate.querySelectorAll('a[href*="/status/"]')].map(a => a.getAttribute('href') || '');
      if (!targetPostId) return hrefs.length > 0;
      return hrefs.some(href => href.includes('/status/' + targetPostId));
    }) || null;
    if (!article) return JSON.stringify({ ok: false, error: 'target_post_not_found', postId: targetPostId });

    if (${JSON.stringify(action)} === 'reply') {
      const btn = article.querySelector('[data-testid="reply"]');
      if (!btn) return JSON.stringify({ ok: false, error: 'reply_button_not_found', postId: targetPostId });
      if (${click ? "true" : "false"}) clickEl(btn);
      return JSON.stringify({ ok: true, action: 'reply', postId: targetPostId, ariaLabel: btn.getAttribute('aria-label') || null });
    }

    if (${JSON.stringify(action)} === 'like') {
      const btn = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
      if (!btn) return JSON.stringify({ ok: false, error: 'like_button_not_found', postId: targetPostId });
      const before = btn.getAttribute('aria-label') || null;
      const beforeTestId = btn.getAttribute('data-testid') || null;
      if (${click ? "true" : "false"}) clickEl(btn);
      return JSON.stringify({ ok: true, action: 'like', postId: targetPostId, before, beforeTestId });
    }

    const btn = article.querySelector('[data-testid="like"], [data-testid="unlike"]');
    return JSON.stringify({
      ok: !!btn,
      action: 'like_state',
      postId: targetPostId,
      ariaLabel: btn ? (btn.getAttribute('aria-label') || null) : null,
      testId: btn ? (btn.getAttribute('data-testid') || null) : null,
    });
  })();`;
}

async function waitForPostAction(tabId: string | undefined, postId: string | null, action: "reply" | "like") {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const raw = await evaluate<string>(buildTargetedActionExpression(postId, action, false), tabId);
    const result = parseJsonResult(raw) as Record<string, unknown>;
    if (result.ok === true) return result;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${action} control on the target post.`);
}

function parsePostIdFromUrl(url: string) {
  return url.match(/\/status\/(\d+)/)?.[1] ?? null;
}

function normalizeXUrl(urlOrPath: string) {
  return /^https?:\/\//i.test(urlOrPath)
    ? urlOrPath
    : `https://x.com${urlOrPath.startsWith("/") ? urlOrPath : `/${urlOrPath}`}`;
}

function describeExpectation(expected: XReadyExpectation) {
  const parts = [expected.pathIncludes, expected.urlIncludes, expected.postId, expected.pageKind].filter(Boolean);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

function parseJsonResult(raw: unknown) {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }
  return raw;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
