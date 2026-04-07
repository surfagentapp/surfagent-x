import type { ToolDefinition } from "../types.js";
import { asObject, asOptionalString, asString, textResult } from "../types.js";
import { createPost, getComposerState, likePost, navigateX, replyToPost, verifyTextVisible } from "../x.js";

function resolvePostUrl(input: Record<string, unknown>): string {
  const url = asOptionalString(input.url)?.trim();
  const username = asOptionalString(input.username)?.trim().replace(/^@+/, "");
  const postId = asOptionalString(input.postId)?.trim();
  if (url) return url;
  if (username && postId) return `https://x.com/${username}/status/${postId}`;
  throw new Error("Provide either url, or username + postId.");
}

export const actionTools: ToolDefinition[] = [
  {
    name: "x_get_composer_state",
    description: "Inspect the current X composer state, including whether the Post/Reply button is enabled.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => textResult(JSON.stringify(await getComposerState(), null, 2)),
  },
  {
    name: "x_create_post",
    description: "Create a new X post from the home composer with button-state verification before submit.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Post text to publish." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_create_post arguments");
      const text = asString(input.text, "text");
      return textResult(JSON.stringify(await createPost(text), null, 2));
    },
  },
  {
    name: "x_reply_to_post",
    description: "Reply to a specific post with pre-submit composer verification and post-submit visibility verification.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full post URL." },
        username: { type: "string", description: "Post author username if url is omitted." },
        postId: { type: "string", description: "Status ID if url is omitted." },
        text: { type: "string", description: "Reply text." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_reply_to_post arguments");
      const text = asString(input.text, "text");
      const postUrl = resolvePostUrl(input);
      return textResult(JSON.stringify(await replyToPost(postUrl, text), null, 2));
    },
  },
  {
    name: "x_like_post",
    description: "Like a specific X post and verify resulting button state.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Full post URL." },
        username: { type: "string", description: "Post author username if url is omitted." },
        postId: { type: "string", description: "Status ID if url is omitted." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_like_post arguments");
      const postUrl = resolvePostUrl(input);
      return textResult(JSON.stringify(await likePost(postUrl), null, 2));
    },
  },
  {
    name: "x_verify_text_visible",
    description: "Verify that a specific text snippet is visible on X. Scope can target body, article content, or the active composer.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text snippet to check." },
        scope: { type: "string", description: "Optional scope: body, article, or composer." },
      },
      required: ["text"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_verify_text_visible arguments");
      const text = asString(input.text, "text");
      const scope = (asOptionalString(input.scope) ?? "body").trim().toLowerCase();
      const normalizedScope = scope === "article" || scope === "composer" ? scope : "body";
      return textResult(JSON.stringify(await verifyTextVisible(text, undefined, normalizedScope), null, 2));
    },
  },
  {
    name: "x_recover",
    description: "Apply lightweight X recovery actions for common stuck states: composer, home, or target URL.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", description: "Recovery mode: composer, home, or url." },
        url: { type: "string", description: "Target URL if mode=url." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const input = asObject(args, "x_recover arguments");
      const mode = (asOptionalString(input.mode) ?? "home").trim().toLowerCase();
      if (mode === "home") {
        await navigateX("/home");
        return textResult(JSON.stringify({ ok: true, mode }, null, 2));
      }
      if (mode === "url") {
        const url = asString(input.url, "url");
        await navigateX(url);
        return textResult(JSON.stringify({ ok: true, mode, url }, null, 2));
      }
      if (mode === "composer") {
        await navigateX("/home");
        const state = await getComposerState();
        return textResult(JSON.stringify({ ok: true, mode, state }, null, 2));
      }
      throw new Error("Unsupported recovery mode. Use composer, home, or url.");
    },
  },
];
