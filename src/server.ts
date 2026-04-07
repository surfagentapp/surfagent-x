import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDefinition } from "./types.js";
import { errorResult } from "./types.js";
import { healthTools } from "./tools/health.js";
import { navigationTools } from "./tools/navigation.js";
import { timelineTools } from "./tools/timeline.js";
import { actionTools } from "./tools/actions.js";
import { researchTools } from "./tools/research.js";

export const TOOL_SET: ToolDefinition[] = [
  ...healthTools,
  ...navigationTools,
  ...timelineTools,
  ...actionTools,
  ...researchTools,
];

function ensureUniqueNames(): void {
  const names = new Set<string>();
  for (const tool of TOOL_SET) {
    if (names.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }
}

export function createXServer(): Server {
  ensureUniqueNames();

  const server = new Server(
    { name: "surfagent-x", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_SET.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = TOOL_SET.find((t) => t.name === request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${request.params.name}` }],
      };
    }

    try {
      return await tool.handler(request.params.arguments ?? {});
    } catch (error) {
      return errorResult(error);
    }
  });

  return server;
}
