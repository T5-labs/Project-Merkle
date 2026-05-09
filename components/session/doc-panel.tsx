'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSessionDoc } from '@/lib/client/hooks';
import { ScrollArea } from '@/components/ui/scroll-area';

interface DocPanelProps {
  sessionId: string;
  sessionClosed: boolean;
}

export function DocPanel({ sessionId, sessionClosed: _sessionClosed }: DocPanelProps) {
  const { data } = useSessionDoc(sessionId);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border select-none">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Document
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Managed by agents — read-only.
        </p>
      </div>

      {/* Doc content */}
      <ScrollArea className="flex-1 px-4 py-3">
        {data ? (
          <div className="prose prose-sm dark:prose-invert max-w-none text-sm">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {data.content || '*No content yet.*'}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Loading document…</p>
        )}
      </ScrollArea>
    </div>
  );
}
