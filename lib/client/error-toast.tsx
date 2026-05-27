'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Check, AlertCircle } from 'lucide-react';
import { copyToClipboard } from '@/lib/client/clipboard';

/** Scrollable code block with a hover-reveal Copy/Check button, rendered inside the toast description. */
function ErrorCodeBlock({ message, fullText }: { message: string; fullText: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void copyToClipboard(fullText).then((ok) => {
      if (ok) {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
        toast.success('Error copied', { duration: 2000 });
      }
      // If copy fails (e.g. plain HTTP context), fail silently — the error text
      // is already visible in the scrollable code block so the user can select it.
    });
  }

  return (
    <div className="group relative mt-1">
      <pre className="whitespace-pre-wrap break-all text-sm font-mono text-foreground max-h-[220px] overflow-y-auto rounded-md border border-border bg-muted p-3 pl-10 leading-relaxed">
        {message}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? 'Copied' : 'Copy error'}
        className="pointer-events-auto absolute top-2 left-2 p-1.5 rounded bg-background/80 backdrop-blur-sm opacity-0 group-hover:opacity-100 hover:bg-foreground/10 transition-opacity"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-foreground" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-foreground" />
        )}
      </button>
    </div>
  );
}

/**
 * Show a persistent, copyable error toast for server-side errors.
 *
 * The toast stays visible until the user manually dismisses it (duration: Infinity).
 * The description renders as a scrollable monospace code block with a hover-reveal
 * Copy button positioned inside it at the top-right corner.
 *
 * @param message  The error detail (e.g. the server error message).
 * @param options  Optional title override; defaults to "Something went wrong".
 */
export function showErrorToast(
  message: string,
  options?: { title?: string },
): void {
  const title = options?.title ?? 'Something went wrong';
  const fullText = `${title}\n${message}`;

  const titleNode = (
    <span className="inline-flex items-center gap-2">
      <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{title}</span>
    </span>
  );

  toast(titleNode, {
    description: <ErrorCodeBlock message={message} fullText={fullText} />,
    duration: Infinity,
    closeButton: true,
    dismissible: true,
    icon: null,
    classNames: {
      title: 'text-base font-semibold',
    },
  });
}
