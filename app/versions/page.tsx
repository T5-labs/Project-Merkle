import fs from 'node:fs/promises';
import path from 'node:path';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TableOfContents } from './table-of-contents';
import type { TocEntry } from './table-of-contents';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadVersionsMarkdown() {
  const filePath = path.join(process.cwd(), 'versions.md');
  return fs.readFile(filePath, 'utf-8');
}

/** Mirrors the id generation used in the ReactMarkdown h2 component below. */
function slugify(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Parse `## vX.Y.Z` headings from the raw markdown string. */
function parseToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const re = /^## (.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    const label = match[1].trim();
    entries.push({ slug: slugify(label), label });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Markdown renderer components (server component)
// ---------------------------------------------------------------------------

const mdComponents: React.ComponentProps<typeof ReactMarkdown>['components'] = {
  // Assign anchored IDs to h2 headings so TOC links work
  h2: ({ children, ...props }) => {
    const text = String(children);
    return (
      <h2
        id={slugify(text)}
        className="text-xl font-semibold mt-8 mb-3 pb-2 border-b border-border scroll-mt-6"
        {...props}
      >
        {children}
      </h2>
    );
  },
  h1: ({ children, ...props }) => (
    <h1 className="text-3xl font-bold mb-2 mt-0" {...props}>
      {children}
    </h1>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="text-base font-semibold mt-4 mb-1.5 text-foreground/90" {...props}>
      {children}
    </h3>
  ),
  p: ({ children, ...props }) => (
    <p className="text-sm leading-relaxed text-foreground/85 mb-3" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul className="list-disc list-outside pl-5 space-y-1 mb-3" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="list-decimal list-outside pl-5 space-y-1 mb-3" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="text-sm leading-relaxed text-foreground/85" {...props}>
      {children}
    </li>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-semibold text-foreground" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),
  code: ({ children, ...props }) => (
    <code
      className="text-xs font-mono bg-muted text-foreground/80 rounded px-1 py-0.5"
      {...props}
    >
      {children}
    </code>
  ),
  pre: ({ children, ...props }) => (
    <pre
      className="bg-muted rounded-lg p-4 overflow-x-auto text-xs font-mono mb-3"
      {...props}
    >
      {children}
    </pre>
  ),
  hr: (props) => <hr className="border-border my-6" {...props} />,
  a: ({ children, ...props }) => (
    <a
      className="text-foreground underline underline-offset-2 hover:text-foreground/70 transition-colors"
      {...props}
    >
      {children}
    </a>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="border-l-2 border-border pl-4 text-muted-foreground italic my-3"
      {...props}
    >
      {children}
    </blockquote>
  ),
};

// ---------------------------------------------------------------------------
// Page (server component)
// ---------------------------------------------------------------------------

export default async function VersionsPage() {
  const markdown = await loadVersionsMarkdown();
  const toc = parseToc(markdown);

  return (
    <div className="min-h-screen bg-background">
      {/* Body: two-column layout on lg+, single column on mobile */}
      <div className="max-w-6xl mx-auto w-full px-6 py-8 flex gap-8 items-start">
        {/* Sidebar TOC — left side, full-height panel, hidden on small screens.
            top = body py-8 (32px) = 8
            h   = 100vh - body py-8 top (32px) - body py-8 bottom (32px) = calc(100vh - 64px) */}
        <aside className="hidden lg:flex lg:flex-col w-48 xl:w-56 shrink-0 sticky top-8 h-[calc(100vh-64px)] gap-3">
          <Button asChild className="w-full">
            <Link href="/" className="flex items-center gap-1.5">
              <ArrowLeft className="h-4 w-4" />
              <span>Back to Dashboard</span>
            </Link>
          </Button>
          <div className="flex-1 min-h-0 rounded-xl border border-border bg-card text-card-foreground p-4 flex flex-col">
            <TableOfContents entries={toc} />
          </div>
        </aside>

        {/* Main content */}
        <main className="flex-1 min-w-0 rounded-xl border border-border bg-card text-card-foreground p-6 lg:p-8">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
            {markdown}
          </ReactMarkdown>
        </main>
      </div>
    </div>
  );
}
