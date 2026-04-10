#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createXServer } from "./server.js";
import { runTaskCli } from "./task-runner.js";

async function main() {
  const [, , command, ...rest] = process.argv;
  if (command === "task") {
    const code = await runTaskCli(rest);
    process.exit(code);
  }

  const server = createXServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
