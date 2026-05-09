'use client';

import { Badge } from '@/components/ui/badge';

interface TitleBarProps {
  title: string;
  description: string;
  sessionClosed: boolean;
}

export function TitleBar({ title, description, sessionClosed }: TitleBarProps) {
  return (
    <div className="px-6 py-4 border-b border-border">
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight truncate">{title}</h1>
            {sessionClosed && (
              <Badge variant="secondary" className="shrink-0">
                Session closed
              </Badge>
            )}
          </div>
          {description && (
            <p className="mt-1 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
      </div>
    </div>
  );
}
