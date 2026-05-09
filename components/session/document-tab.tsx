'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download } from 'lucide-react';
import { useSessionDoc } from '@/lib/client/hooks';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

interface DocumentTabProps {
  sessionId: string;
}

export function DocumentTab({ sessionId }: DocumentTabProps) {
  const { data, isLoading } = useSessionDoc(sessionId);

  function handleDownload() {
    const content = data?.content ?? '';
    const filename = `session-${sessionId.slice(0, 8)}.md`;
    const blob = new Blob([content], { type: 'text/markdown; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="select-none">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Document
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Managed by agents — read-only.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleDownload}
          disabled={!data?.content}
        >
          <Download />
          Download
        </Button>
      </div>

      {/* Doc content */}
      <ScrollArea className="flex-1 px-4 py-3">
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading document…</p>
        ) : data?.content || data?.title ? (
          <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
            {data.title && (
              <h1 className="text-2xl font-bold mb-3">{data.title}</h1>
            )}
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {data.content}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Document is empty — agents will populate this as the session progresses.
          </p>
        )}
      </ScrollArea>
    </div>
  );
}
