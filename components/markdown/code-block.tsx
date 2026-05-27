'use client';

import { useRef, useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { copyToClipboard } from '@/lib/client/clipboard';

interface CodeBlockProps extends React.HTMLAttributes<HTMLPreElement> {
  children?: React.ReactNode;
}

export function CodeBlock({ children, ...props }: CodeBlockProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const text = preRef.current?.innerText ?? '';
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success('Code copied', { description: 'Pasted to your clipboard' });
    } else {
      toast.error("Couldn't copy code", {
        description: 'Copy failed — please select and copy the text manually.',
      });
    }
  }

  return (
    <div className="relative group my-4">
      <pre
        ref={preRef}
        className="bg-muted rounded-md p-4 overflow-x-auto text-sm font-mono"
        {...props}
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : 'Copy code'}
        className="absolute top-2 right-2 p-1.5 rounded opacity-60 hover:opacity-100 hover:bg-foreground/10 transition-opacity"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}
