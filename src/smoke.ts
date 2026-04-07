import { TOOL_SET, createXServer } from "./server.js";

const EXPECTED_TOOLS = [
  "x_health_check",
  "x_open",
  "x_get_state",
  "x_open_home",
  "x_open_profile",
  "x_open_notifications",
  "x_open_search",
  "x_open_post",
  "x_get_timeline",
  "x_search_posts",
  "x_open_community",
  "x_search_communities",
  "x_search_profiles",
  "x_get_community_feed",
  "x_extract_community",
  "x_extract_post",
  "x_extract_profile",
  "x_get_profile_posts",
  "x_get_post_thread",
  "x_get_composer_state",
  "x_create_post",
  "x_reply_to_post",
  "x_like_post",
  "x_verify_text_visible",
  "x_recover",
  "x_research_topic",
  "x_map_community",
];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function main() {
  const toolNames = TOOL_SET.map((tool) => tool.name);
  const uniqueNames = new Set(toolNames);

  assert(toolNames.length === uniqueNames.size, "Duplicate tool names detected.");

  for (const name of EXPECTED_TOOLS) {
    assert(toolNames.includes(name), `Missing expected tool: ${name}`);
  }

  for (const tool of TOOL_SET) {
    assert(typeof tool.description === "string" && tool.description.trim().length > 0, `Tool ${tool.name} is missing a description.`);
    assert(tool.inputSchema?.type === "object", `Tool ${tool.name} must expose an object input schema.`);
    assert(typeof tool.handler === "function", `Tool ${tool.name} is missing a handler.`);
  }

  const server = createXServer();
  assert(!!server, "Failed to create MCP server instance.");

  console.log(JSON.stringify({
    ok: true,
    toolCount: toolNames.length,
    toolNames,
  }, null, 2));
}

main();
