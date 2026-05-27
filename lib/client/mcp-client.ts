/**
 * Thin MCP client for the web UI.
 *
 * Endpoint URL:
 *   Defaults to `/api/mcp` (relative, same-origin). Override by setting the
 *   NEXT_PUBLIC_MCP_URL environment variable at build time. This matches the
 *   README's dynamic-URL contract — agents read the URL from their config;
 *   the web UI reads it from the Next.js public env namespace.
 *
 *   Example: NEXT_PUBLIC_MCP_URL=https://your-host.fly.dev/api/mcp
 *
 * Long-poll / wait_for_messages:
 *   `wait_for_messages` holds the connection open server-side for up to 30s.
 *   From the client's perspective it is a plain JSON-RPC call — just with a
 *   longer-than-usual response time. Use `mcpCall` directly and pass an
 *   AbortSignal with a 35-second timeout. No streaming complexity is needed
 *   because the MCP SDK's HTTP transport buffers the full response before
 *   returning it; the SSE framing is handled at the transport layer, not here.
 */

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Generates a UUID v4 string compatible with both secure contexts (HTTPS) and
 * insecure contexts (plain HTTP). `crypto.randomUUID()` is only available in
 * secure contexts (HTTPS / localhost), so we fall back to `crypto.getRandomValues()`
 * — which works everywhere — when `randomUUID` is unavailable.
 */
function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback: build a UUID v4 from random bytes via getRandomValues().
  // Template: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  // - 'x' positions: any random hex nibble (0–f)
  // - 'y' positions: must be 8, 9, a, or b  →  (r & 0x3) | 0x8
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 0x0f;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Wire shape returned by every MCP tool call over JSON-RPC. */
interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/** Structured error payload encoded in the text field when isError is true. */
interface McpErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/** Error thrown when the MCP layer returns isError: true. */
export class MCPClientError extends Error {
  public readonly code: string;
  public readonly details: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "MCPClientError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Core call
// ---------------------------------------------------------------------------

const DEFAULT_MCP_URL = "/api/mcp";

/**
 * Resolves the MCP endpoint URL.
 * Uses NEXT_PUBLIC_MCP_URL if set, otherwise falls back to /api/mcp.
 */
function getMcpUrl(): string {
  return process.env.NEXT_PUBLIC_MCP_URL ?? DEFAULT_MCP_URL;
}

/**
 * Sends a JSON-RPC tools/call request to the MCP endpoint.
 *
 * @param toolName  - The MCP tool name (e.g. "create_session").
 * @param args      - Tool input parameters.
 * @param teamId    - Optional X-Team-ID header for authenticated tools.
 * @param signal    - Optional AbortSignal (use with a 35s timeout for wait_for_messages).
 * @returns         - The parsed result from the tool's text content field.
 * @throws MCPClientError when the tool returns isError: true.
 * @throws Error on transport-level failures (non-2xx HTTP, network errors, etc.).
 */
export async function mcpCall<TResult>(
  toolName: string,
  args: object,
  teamId?: string | null,
  signal?: AbortSignal,
): Promise<TResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  if (teamId) {
    headers["X-Team-ID"] = teamId;
  }

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: generateUUID(),
    method: "tools/call",
    params: {
      name: toolName,
      arguments: args,
    },
  });

  let response: Response;
  try {
    response = await fetch(getMcpUrl(), {
      method: "POST",
      headers,
      body,
      signal,
    });
  } catch (err) {
    // Network / abort errors
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new MCPClientError("timeout", `MCP call to ${toolName} timed out`);
    }
    throw new Error(
      `MCP transport error calling ${toolName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `MCP HTTP error calling ${toolName}: ${response.status} ${response.statusText}`,
    );
  }

  // The SDK's JSON-RPC response wraps the CallToolResult in a standard envelope.
  // Shape: { jsonrpc: "2.0", id: ..., result: McpToolResult }
  const envelope = (await response.json()) as {
    jsonrpc: string;
    id: unknown;
    result?: McpToolResult;
    error?: { code: number; message: string };
  };

  if (envelope.error) {
    throw new Error(
      `MCP JSON-RPC error calling ${toolName}: ${envelope.error.message}`,
    );
  }

  const toolResult = envelope.result;
  if (!toolResult) {
    throw new Error(`MCP response for ${toolName} missing result`);
  }

  const textItem = toolResult.content.find((c) => c.type === "text");
  if (!textItem) {
    throw new Error(`MCP result for ${toolName} has no text content`);
  }

  if (toolResult.isError) {
    // First, try to parse the structured JSON error payload produced by toMcpToolError.
    // If parsing fails it means the MCP SDK caught the thrown MCPError and serialised
    // only error.message as plain text (the SDK's createToolError path). In that case
    // we do a best-effort code inference from the plain-text message so callers can
    // still distinguish not_found / unauthorized / etc. without a code field.
    let payload: McpErrorPayload;
    try {
      payload = JSON.parse(textItem.text) as McpErrorPayload;
    } catch {
      // Plain-text error from SDK — infer code from message text.
      const text = textItem.text.toLowerCase();
      let code = "internal";
      if (text.includes("not found")) code = "not_found";
      else if (text.includes("unauthorized") || text.includes("missing or invalid")) code = "unauthorized";
      else if (text.includes("forbidden") || text.includes("closed")) code = "forbidden";
      else if (text.includes("conflict") || text.includes("version mismatch")) code = "conflict";
      else if (text.includes("bad request") || text.includes("invalid")) code = "bad_request";
      throw new MCPClientError(code, textItem.text);
    }
    throw new MCPClientError(
      payload.error.code,
      payload.error.message,
      payload.error.details,
    );
  }

  return JSON.parse(textItem.text) as TResult;
}
