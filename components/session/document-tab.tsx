'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Download } from 'lucide-react';
import { markdownComponents } from '@/lib/markdown-components';
import { useSessionDoc } from '@/lib/client/hooks';
import { Button } from '@/components/ui/button';

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
    <div className="flex flex-col flex-1 min-h-0">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-border">
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
      <div className="flex-1 min-h-0 overflow-y-scroll overflow-x-hidden px-4 py-3">
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading document…</p>
        ) : data?.content || data?.title ? (
          <div className="max-w-none text-sm min-w-0">
            {data.title && (
              <h1 className="text-3xl font-bold tracking-tight mb-4 border-b border-border pb-2">{data.title}</h1>
            )}
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {data.content}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Document is empty — agents will populate this as the session progresses.
          </p>
        )}
      </div>
    </div>
  );
}
