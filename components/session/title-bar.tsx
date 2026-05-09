'use client';

import { type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';

interface TitleBarProps {
  title: string;
  description: string;
  sessionClosed: boolean;
  centerSlot?: ReactNode;
}

export function TitleBar({ title, description, sessionClosed, centerSlot }: TitleBarProps) {
  return (
    <div className="px-6 py-4 border-b border-border">
      <div className="flex items-center gap-4">
        {/* Left: title + closed badge + description */}
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

        {/* Center: optional tab list or other content */}
        {centerSlot && (
          <div className="flex items-center justify-center shrink-0">
            {centerSlot}
          </div>
        )}

        {/* Right: flex spacer to balance center alignment */}
        <div className="flex-1" />
      </div>
    </div>
  );
}
