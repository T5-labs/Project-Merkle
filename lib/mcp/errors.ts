/**
 * Structured error types for the MCP layer, matching the README error matrix.
 *
 * Usage in tool handlers:
 *   throw new MCPError('not_found', 'Session not found');
 *   throw new MCPError('conflict', 'Version mismatch', { currentVersion: 3 });
 *
 * The MCP SDK reports tool-level errors via CallToolResult: the handler returns
 * (or throws) and the SDK wraps the response with isError: true and a content
 * array containing a text item. To convert an MCPError into that shape, call
 * toMcpToolError(err) and return the result from your tool handler.
 *
 * The SDK does NOT provide an in-protocol error code mapping for tool errors —
 * those are protocol-level JSON-RPC errors reserved for transport/server faults.
 * Tool business logic errors are surfaced via isError: true in CallToolResult.
 * We encode our ErrorCode in the JSON text so callers can parse it.
 */

export type ErrorCode =
  | "bad_request"   // 400
  | "unauthorized"  // 401
  | "forbidden"     // 403
  | "not_found"     // 404
  | "conflict"      // 409
  | "rate_limited"  // 429
  | "internal";     // 500

export class MCPError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "MCPError";
  }
}

/**
 * Converts an MCPError into the CallToolResult shape the MCP SDK expects when
 * returning an error from a tool handler. The SDK expects:
 *   { content: [{ type: "text", text: "<string>" }], isError: true }
 *
 * We encode code + message + details as JSON text so MCP clients can parse the
 * structured error without screen-scraping the human-readable message.
 */
export function toMcpToolError(err: MCPError): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const payload = {
    error: {
      code: err.code,
      message: err.message,
      details: err.details ?? {},
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    isError: true,
  };
}

/**
 * Wraps any unknown thrown value — MCPError or otherwise — into a toMcpToolError
 * shape. Unexpected errors are logged to stderr and returned as "internal" errors
 * so internals (stack traces, query text) never leak to the client.
 */
export function toMcpToolErrorSafe(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  if (err instanceof MCPError) {
    return toMcpToolError(err);
  }
  // Unexpected error — log with context, return generic message
  console.error("[MCP] Unexpected tool error:", err);
  return toMcpToolError(
    new MCPError("internal", "An unexpected error occurred"),
  );
}
