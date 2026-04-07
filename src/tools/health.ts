import type { ToolDefinition } from "../types.js";
import { textResult } from "../types.js";
import { ensureXTab, findXTab } from "../connection.js";
import { getXState, waitForXReady } from "../x.js";

export const healthTools: ToolDefinition[] = [
  {
    name: "x_health_check",
    description: "Check whether X is open in SurfAgent, identify current X page state, and report composer/account readiness.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const existing = await findXTab();
      if (!existing) {
        return textResult(JSON.stringify({
          status: "not_found",
          message: "No X tab is open in SurfAgent.",
          hint: "Use x_open to open X first.",
        }, null, 2));
      }

      await waitForXReady(existing.id);
      const state = await getXState(existing.id);
      return textResult(JSON.stringify({ status: "connected", tabId: existing.id, ...state }, null, 2));
    },
  },
  {
    name: "x_open",
    description: "Open X in SurfAgent. Optionally choose a starting section such as home, notifications, search, or a profile path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional X path like /home, /notifications, /search?q=..., or /username." },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const path = typeof (args as { path?: unknown })?.path === "string" ? String((args as { path?: unknown }).path) : "/home";
      const tab = await ensureXTab(path);
      await waitForXReady(tab.id);
      const state = await getXState(tab.id);
      return textResult(JSON.stringify({ status: "opened", tabId: tab.id, ...state }, null, 2));
    },
  },
];
