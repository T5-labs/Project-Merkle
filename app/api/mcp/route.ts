// Tell Next.js this route is fully dynamic — never statically pre-evaluate it
// at build time. Required because the route reads DATABASE_URL at runtime and
// would fail the build with "DATABASE_URL environment variable is not set"
// if Next.js attempted to call it during static generation.
export const dynamic = 'force-dynamic';

// Explicitly pin the Node.js runtime: the `postgres` package uses Node APIs
// (net.Socket, crypto, etc.) that are not available on the Edge runtime.
export const runtime = 'nodejs';

/**
 * Next.js App Router Route Handler that hosts the MCP server.
 *
 * Transport: WebStandardStreamableHTTPServerTransport (SDK v1.29.0).
 * This transport uses Web Standard APIs (Request/Response/ReadableStream),
 * making it the correct choice for Next.js Route Handlers — unlike the Node.js
 * StreamableHTTPServerTransport wrapper which requires IncomingMessage/ServerResponse.
 *
 * Stateless mode (sessionIdGenerator: undefined):
 *   A new McpServer + transport is created per request. This is safe for our
 *   12 stateless tools because all state lives in Postgres. No in-memory
 *   session mapping to worry about. The README notes tools are stateless:
 *   "all state lives in the DB."
 *
 * POST — handles JSON-RPC tool calls (standard MCP request/response).
 * GET  — handles SSE streams (used by the MCP protocol for server-initiated
 *         messages and long-poll patterns like wait_for_messages).
 * DELETE — handled transparently by the SDK transport (session teardown).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerTools } from "@/lib/mcp/registry";

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Builds a fresh McpServer with all tools registered.
 * Called once per request in stateless mode.
 */
function buildServer(): McpServer {
  const server = new McpServer({
    name: "project-merkle",
    version: "0.0.1",
  });
  registerTools(server);
  return server;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * Handles both POST (JSON-RPC tool calls) and GET (SSE streams).
 * The WebStandard transport's handleRequest() dispatches on method internally.
 */
async function handleMcpRequest(req: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless: no sessionIdGenerator — each request is independent.
    // The SDK will not issue Mcp-Session-Id headers or validate session state.
    sessionIdGenerator: undefined,
    // Return JSON responses for non-streaming calls where possible.
    enableJsonResponse: true,
  });

  const server = buildServer();

  // connect() wires the server to the transport and starts the protocol loop.
  await server.connect(transport);

  // handleRequest() reads the request body, dispatches the JSON-RPC message,
  // and returns a Response (streaming SSE for GET, JSON for POST tool calls).
  return transport.handleRequest(req);
}

export async function POST(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}

export async function GET(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}

// DELETE is handled by the transport if issued; expose it so Next.js doesn't 405.
export async function DELETE(req: Request): Promise<Response> {
  return handleMcpRequest(req);
}
