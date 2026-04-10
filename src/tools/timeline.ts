import type { ToolDefinition } from "../types.js";
import { asObject, asOptionalNumber, asOptionalString, asString, textResult } from "../types.js";
import { extractCommunity, extractPost, extractProfile, getCommunityFeed, getPostThread, getProfilePosts, getTimelinePosts, getXState, navigateX, searchXCommunities, searchXPosts, searchXProfiles, waitForXReady } from "../x.js";

export const timelineTools: ToolDefinition[] = [
  {
    name: "x_get_timeline",
    description: "Extract the currently visible X timeline posts with author, text, status URL, and social action labels.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max number of visible posts to extract (1-20)." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_get_timeline arguments");
      const limit = Math.max(1, Math.min(20, asOptionalNumber(input.limit) ?? 10));
      return textResult(JSON.stringify(await getTimelinePosts(limit), null, 2));
    },
  },
  {
    name: "x_search_posts",
    description: "Search X posts and return extracted live results from the search timeline.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        limit: { type: "number", description: "Max number of posts to extract (1-20)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_search_posts arguments");
      const query = asString(input.query, "query");
      const limit = Math.max(1, Math.min(20, asOptionalNumber(input.limit) ?? 10));
      return textResult(JSON.stringify(await searchXPosts(query, limit), null, 2));
    },
  },
  {
    name: "x_open_community",
    description: "Open an X community URL directly. Useful because community navigation has its own weird composer behavior.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full x.com/i/communities/... URL." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_open_community arguments");
      const url = asString(input.url, "url");
      const tab = await navigateX(url);
      await waitForXReady(tab.id);
      return textResult(JSON.stringify(await getXState(tab.id), null, 2));
    },
  },
  {
    name: "x_search_communities",
    description: "Search X communities and return community cards/links discovered on the search surface.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Community search query." },
        limit: { type: "number", description: "Max number of communities to extract (1-20)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_search_communities arguments");
      const query = asString(input.query, "query");
      const limit = Math.max(1, Math.min(20, asOptionalNumber(input.limit) ?? 10));
      return textResult(JSON.stringify(await searchXCommunities(query, limit), null, 2));
    },
  },
  {
    name: "x_search_profiles",
    description: "Search X profiles and return discovered accounts with display names, handles, bios, and URLs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Profile search query." },
        limit: { type: "number", description: "Max number of profiles to extract (1-20)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_search_profiles arguments");
      const query = asString(input.query, "query");
      const limit = Math.max(1, Math.min(20, asOptionalNumber(input.limit) ?? 10));
      return textResult(JSON.stringify(await searchXProfiles(query, limit), null, 2));
    },
  },
  {
    name: "x_get_community_feed",
    description: "Extract visible posts from the current or specified X community feed.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Optional full X community URL to open first." },
        limit: { type: "number", description: "Max number of community posts to extract (1-30)." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_get_community_feed arguments");
      const url = asOptionalString(input.url)?.trim();
      const limit = Math.max(1, Math.min(30, asOptionalNumber(input.limit) ?? 10));
      return textResult(JSON.stringify(await getCommunityFeed(limit, url), null, 2));
    },
  },
  {
    name: "x_extract_community",
    description: "Open a community and return structured community metadata, including name, description, member/post hints, and join state when visible.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full X community URL." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_extract_community arguments");
      const url = asString(input.url, "url");
      return textResult(JSON.stringify(await extractCommunity(url), null, 2));
    },
  },
  {
    name: "x_extract_post",
    description: "Open a post and return a structured post record with author, text, media, and visible stats.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full X/Twitter post URL." },
        tabId: { type: "string", description: "Optional existing X tab id to reuse instead of opening another tab." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_extract_post arguments");
      const url = asString(input.url, "url");
      const tabId = asOptionalString(input.tabId)?.trim();
      return textResult(JSON.stringify(await extractPost(url, tabId), null, 2));
    },
  },
  {
    name: "x_extract_profile",
    description: "Open a profile and return a structured profile record with bio, stats, and pinned post when visible.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "X username without @." },
        tabId: { type: "string", description: "Optional existing X tab id to reuse instead of opening another tab." },
      },
      required: ["username"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_extract_profile arguments");
      const username = asString(input.username, "username").replace(/^@+/, "");
      const tabId = asOptionalString(input.tabId)?.trim();
      return textResult(JSON.stringify(await extractProfile(username, tabId), null, 2));
    },
  },
  {
    name: "x_get_profile_posts",
    description: "Open a profile and extract visible posts from that profile timeline.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "X username without @." },
        limit: { type: "number", description: "Max number of profile posts to extract (1-30)." },
        tabId: { type: "string", description: "Optional existing X tab id to reuse instead of opening another tab." },
      },
      required: ["username"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_get_profile_posts arguments");
      const username = asString(input.username, "username").replace(/^@+/, "");
      const limit = Math.max(1, Math.min(30, asOptionalNumber(input.limit) ?? 10));
      const tabId = asOptionalString(input.tabId)?.trim();
      return textResult(JSON.stringify(await getProfilePosts(username, limit, tabId), null, 2));
    },
  },
  {
    name: "x_get_post_thread",
    description: "Open a post and extract the visible thread/timeline around it as structured post rows.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full X/Twitter post URL." },
        limit: { type: "number", description: "Max number of posts to extract from the thread (1-50)." },
        tabId: { type: "string", description: "Optional existing X tab id to reuse instead of opening another tab." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_get_post_thread arguments");
      const url = asString(input.url, "url");
      const limit = Math.max(1, Math.min(50, asOptionalNumber(input.limit) ?? 20));
      const tabId = asOptionalString(input.tabId)?.trim();
      return textResult(JSON.stringify(await getPostThread(url, limit, tabId), null, 2));
    },
  },
];
