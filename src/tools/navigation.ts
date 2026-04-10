import type { ToolDefinition } from "../types.js";
import { asObject, asOptionalString, asString, textResult } from "../types.js";
import { navigateX, getXState, openXPath, waitForXReady } from "../x.js";

export const navigationTools: ToolDefinition[] = [
  {
    name: "x_get_state",
    description: "Get structured X page state for the current tab: route, page kind, selected tabs, composer state, and account info.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => textResult(JSON.stringify(await getXState(), null, 2)),
  },
  {
    name: "x_open_home",
    description: "Open the X home timeline and wait for a settled X page state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const tab = await openXPath("/home");
      await waitForXReady(tab.id);
      return textResult(JSON.stringify(await getXState(tab.id), null, 2));
    },
  },
  {
    name: "x_open_profile",
    description: "Open a profile by username.",
    inputSchema: {
      type: "object",
      properties: {
        username: { type: "string", description: "X username without @." },
      },
      required: ["username"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_open_profile arguments");
      const username = asString(input.username, "username").replace(/^@+/, "");
      const tab = await navigateX(`/${username}`);
      await waitForXReady(tab.id);
      return textResult(JSON.stringify(await getXState(tab.id), null, 2));
    },
  },
  {
    name: "x_open_notifications",
    description: "Open X notifications.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const tab = await navigateX("/notifications");
      await waitForXReady(tab.id);
      return textResult(JSON.stringify(await getXState(tab.id), null, 2));
    },
  },
  {
    name: "x_open_search",
    description: "Open X search, optionally prefilled with a query and live filter.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        mode: { type: "string", description: "Search mode: top, latest, people, media." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_open_search arguments");
      const query = asOptionalString(input.query)?.trim();
      const mode = asOptionalString(input.mode)?.trim().toLowerCase() ?? "latest";
      const f = ["top", "latest", "people", "media"].includes(mode) ? mode : "latest";
      const path = query ? `/search?q=${encodeURIComponent(query)}&src=typed_query&f=${encodeURIComponent(f)}` : "/explore";
      const tab = await navigateX(path);
      await waitForXReady(tab.id);
      return textResult(JSON.stringify(await getXState(tab.id), null, 2));
    },
  },
  {
    name: "x_open_post",
    description: "Open a specific X post by full URL or by username + status ID.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full X/Twitter post URL." },
        username: { type: "string", description: "Post author username if url is omitted." },
        postId: { type: "string", description: "Status/tweet ID if url is omitted." },
        tabId: { type: "string", description: "Optional existing X tab id to reuse instead of opening another tab." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_open_post arguments");
      const url = asOptionalString(input.url)?.trim();
      const username = asOptionalString(input.username)?.trim().replace(/^@+/, "");
      const postId = asOptionalString(input.postId)?.trim();
      if (!url && !(username && postId)) {
        throw new Error("Provide either url, or username + postId.");
      }
      const target = url ?? `https://x.com/${username}/status/${postId}`;
      const tabId = asOptionalString(input.tabId)?.trim();
      const tab = await navigateX(target, tabId);
      await waitForXReady(tab.id);
      return textResult(JSON.stringify(await getXState(tab.id), null, 2));
    },
  },
];
