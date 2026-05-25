'use client';

import { useState, useEffect } from 'react';

export interface TocEntry {
  slug: string;
  label: string;
}

export function TableOfContents({ entries }: { entries: TocEntry[] }) {
  const [activeSlug, setActiveSlug] = useState<string | null>(
    entries[0]?.slug ?? null,
  );

  useEffect(() => {
    const headings = Array.from(document.querySelectorAll<HTMLElement>('h2[id]'));
    if (headings.length === 0) return;

    const observer = new IntersectionObserver(
      (observedEntries) => {
        const intersecting = observedEntries.filter((e) => e.isIntersecting);
        if (intersecting.length === 0) return; // keep previous active slug
        // Pick the intersecting heading closest to the top of the viewport
        const topmost = intersecting.reduce((prev, curr) =>
          curr.boundingClientRect.top < prev.boundingClientRect.top ? curr : prev,
        );
        setActiveSlug((topmost.target as HTMLElement).id);
      },
      {
        // Active band: top ~30% of the viewport, offset 80px from top for the sticky header
        rootMargin: '-80px 0px -70% 0px',
      },
    );

    headings.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <nav aria-label="Version history table of contents" className="flex flex-col h-full">
      {/* Sidebar header */}
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3 px-2 select-none shrink-0">
        Versions
      </p>
      {/* Scrollable list — overflows independently of the page */}
      <div className="overflow-y-auto flex-1 min-h-0">
        <ul className="space-y-0.5">
          {entries.map((entry) => {
            const isActive = entry.slug === activeSlug;
            return (
              <li key={entry.slug}>
                <a
                  href={`#${entry.slug}`}
                  className={`block text-sm hover:bg-accent hover:text-accent-foreground transition-colors rounded-md px-2 py-1 font-mono ${
                    isActive
                      ? 'font-bold text-foreground'
                      : 'text-muted-foreground'
                  }`}
                >
                  {entry.label}
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
