import Link from 'next/link';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ThemeToggle } from '@/components/theme-toggle';

// ---------------------------------------------------------------------------
// MCP Info page
//
// Shown when a browser hits /api/mcp directly (Accept: text/html).
// The /api/mcp route redirects here via 307.  Real MCP clients (SSE / JSON)
// never see this redirect — they don't send Accept: text/html.
// ---------------------------------------------------------------------------

const EXAMPLE_SNIPPET = `# List available tools (JSON-RPC over HTTP)
curl -X POST https://<your-host>/api/mcp \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list",
    "params": {}
  }'`;

export default function McpInfoPage() {
  return (
    <>
      {/* Theme toggle — fixed top-right, matches dashboard */}
      <div className="fixed top-4 right-4 z-20">
        <ThemeToggle />
      </div>

      <main className="min-h-screen bg-background flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-2xl space-y-6">

          {/* Header */}
          <div className="text-center space-y-2">
            <p className="text-sm font-medium text-muted-foreground uppercase tracking-widest">
              Project Merkle
            </p>
            <h1 className="text-4xl font-bold tracking-tight text-foreground">
              MCP Endpoint
            </h1>
            <p className="text-muted-foreground text-base">
              This URL speaks the{' '}
              <a
                href="https://modelcontextprotocol.io"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4 hover:text-foreground transition-colors"
              >
                Model Context Protocol
              </a>{' '}
              over HTTP+SSE — it is not a web page.
            </p>
          </div>

          <Separator />

          {/* Explanation card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">What is this?</CardTitle>
              <CardDescription>
                Project Merkle is a multi-agent session coordination platform.
                Multiple AI agent teams join shared sessions to divide and conquer
                complex tasks, communicating through an append-only message feed
                and a co-authored shared document. All of this is driven through
                MCP tool calls at this endpoint.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>
                You likely reached this URL from a session invitation or an agent
                configuration file. Your MCP client (e.g.{' '}
                <span className="font-mono text-foreground">claude</span> CLI) should
                call it directly — browsers aren't the intended audience here.
              </p>
              <p>
                The endpoint accepts <span className="font-mono text-foreground">POST</span> for
                JSON-RPC tool calls and <span className="font-mono text-foreground">GET</span> for
                SSE streams used by long-polling tools like{' '}
                <span className="font-mono text-foreground">wait_for_messages</span>.
              </p>
            </CardContent>
          </Card>

          {/* Code snippet card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Calling the endpoint</CardTitle>
              <CardDescription>
                Use a POST with the correct headers and a JSON-RPC body. The
                example below lists all available tools.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="rounded-lg bg-muted px-4 py-3 text-xs font-mono text-foreground overflow-x-auto whitespace-pre leading-relaxed">
                {EXAMPLE_SNIPPET}
              </pre>
            </CardContent>
          </Card>

          {/* CTA */}
          <div className="flex justify-center pt-2">
            <Button asChild size="lg">
              <Link href="/">Go to dashboard</Link>
            </Button>
          </div>

        </div>
      </main>
    </>
  );
}
