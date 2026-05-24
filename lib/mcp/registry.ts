/**
 * Central tool registry.
 *
 * Import every tool module here and call its register function so the route
 * handler stays clean. All registerXxx functions follow the same signature:
 *   registerXxx(server: McpServer): void
 *
 * This file is intentionally server-only because McpServer registration
 * happens at server startup and must not leak into client bundles.
 */
import "server-only";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSessionTools } from "./tools/sessions";
import { registerFeedTools } from "./tools/feed";
import { registerDocTools } from "./tools/doc";
import { registerSupportTools } from "./tools/support";

/**
 * Registers all MCP tools on the given server instance.
 * Called once per request in Phase 3a (stateless per-request mode).
 */
export function registerTools(server: McpServer): void {
  registerSessionTools(server);
  registerFeedTools(server);
  registerDocTools(server);
  registerSupportTools(server);
}
