'use client';

import { useEffect, useRef, useState, KeyboardEvent } from 'react';
import {
  useMessageStream,
  usePostMessage,
  useParticipants,
  type MessageRow,
  type ParticipantRow,
} from '@/lib/client/hooks';
import { getTeamId } from '@/lib/client/team-id';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { VisuallyHidden } from 'radix-ui';
import { HelpCircle } from 'lucide-react';
import type { Attachment } from '@/db/schema';

interface FeedPanelProps {
  sessionId: string;
  sessionClosed: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function getTeamName(
  teamId: string | null,
  participants: ParticipantRow[],
): string {
  if (!teamId) return 'System';
  const found = participants.find((p) => p.team_id === teamId);
  return found ? found.team_name : 'Unknown';
}

// ---------------------------------------------------------------------------
// System message renderer
// ---------------------------------------------------------------------------

function SystemMessage({ content }: { content: unknown }) {
  const c = content as Record<string, unknown>;
  const event = c.event as string | undefined;

  let text = '';
  switch (event) {
    case 'team_joined':
      text = `${String(c.team ?? 'A team')} joined`;
      break;
    case 'team_left':
      text = `${String(c.team ?? 'A team')} left`;
      break;
    case 'session_metadata_updated': {
      const by = String(c.by ?? 'A team');
      const reason = c.reason ? ` — "${String(c.reason)}"` : '';
      text = `${by} updated session metadata${reason}`;
      break;
    }
    case 'session_concluded':
      text = `${String(c.by ?? 'A team')} concluded the session`;
      break;
    default:
      text = event ? `${event}` : JSON.stringify(content);
  }

  return (
    <em className="block text-xs text-muted-foreground py-1 px-2 select-none cursor-default">{text}</em>
  );
}

// ---------------------------------------------------------------------------
// Single message row
// ---------------------------------------------------------------------------

function MessageItem({
  message,
  participants,
}: {
  message: MessageRow;
  participants: ParticipantRow[];
}) {
  if (message.type === 'system') {
    return <SystemMessage content={message.content} />;
  }

  const senderName = getTeamName(message.posted_by_team_id, participants);
  const contentObj = message.content as Record<string, unknown>;
  const text = typeof contentObj.text === 'string' ? contentObj.text : '';
  const attachments = message.attachments;

  return (
    <div className="px-3 py-2 group">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium shrink-0">{senderName}</span>
        <span className="text-xs text-muted-foreground">
          {formatTime(message.posted_at)}
        </span>
      </div>
      {text && (
        <p className="text-sm mt-0.5 whitespace-pre-wrap break-words">{text}</p>
      )}
      {attachments && attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-1">
          {attachments.map((att, idx) => (
            <Dialog key={idx}>
              <DialogTrigger asChild>
                <img
                  src={`data:${att.mime};base64,${att.data}`}
                  alt={`attachment ${idx + 1}`}
                  className="max-h-48 max-w-xs rounded border border-border object-contain cursor-zoom-in"
                />
              </DialogTrigger>
              <DialogContent className="max-w-[90vw] max-h-[90vh] p-2 flex items-center justify-center">
                <VisuallyHidden.Root>
                  <DialogTitle>Attachment {idx + 1}</DialogTitle>
                </VisuallyHidden.Root>
                <img
                  src={`data:${att.mime};base64,${att.data}`}
                  alt={`attachment ${idx + 1}`}
                  className="w-full h-auto max-h-[85vh] object-contain rounded"
                />
              </DialogContent>
            </Dialog>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Feed panel
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Pending attachment type (client-side only, includes preview URL)
// ---------------------------------------------------------------------------

interface PendingAttachment {
  mime: string;
  data: string; // raw base64, no "data:" prefix
  previewUrl: string; // object URL for <img> preview
}

// ---------------------------------------------------------------------------
// Feed panel
// ---------------------------------------------------------------------------

export function FeedPanel({ sessionId, sessionClosed }: FeedPanelProps) {
  const myTeamId = getTeamId(sessionId);
  const { messages, error: streamError } = useMessageStream(sessionId);
  const { data: rosterData } = useParticipants(sessionId);
  const participants = rosterData?.participants ?? [];

  const postMessage = usePostMessage();
  const [draft, setDraft] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Revoke object URLs when pendingAttachments changes to avoid memory leaks
  useEffect(() => {
    return () => {
      pendingAttachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    };
  }, [pendingAttachments]);

  async function handleSend() {
    const text = draft.trim();
    if ((!text && pendingAttachments.length === 0) || !myTeamId) return;
    const attachmentsToSend: Attachment[] = pendingAttachments.map((a) => ({
      type: 'image' as const,
      mime: a.mime,
      data: a.data,
    }));
    setDraft('');
    setPendingAttachments([]);
    await postMessage.mutateAsync({
      session_id: sessionId,
      content: { text },
      type: 'chat',
      attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
    }).finally(() => {
      textareaRef.current?.focus();
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const imageItems = Array.from(e.clipboardData.items).filter((item) =>
      item.type.startsWith('image/'),
    );
    if (imageItems.length === 0) return; // no images — let default text paste proceed
    e.preventDefault();

    imageItems.forEach((item) => {
      const file = item.getAsFile();
      if (!file) return;
      const previewUrl = URL.createObjectURL(file);
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        // Strip "data:<mime>;base64," prefix to get raw base64
        const commaIdx = dataUrl.indexOf(',');
        const rawBase64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
        setPendingAttachments((prev) => [
          ...prev,
          { mime: file.type, data: rawBase64, previewUrl },
        ]);
      };
      reader.readAsDataURL(file);
    });
  }

  function removeAttachment(idx: number) {
    setPendingAttachments((prev) => {
      URL.revokeObjectURL(prev[idx]!.previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  }

  const canSend = !sessionClosed && Boolean(myTeamId) && !postMessage.isPending;
  const hasContent = draft.trim().length > 0 || pendingAttachments.length > 0;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Feed
        </h2>
      </div>

      {/* Message list */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border/40">
          {messages.length === 0 && (
            <p className="text-xs text-muted-foreground px-3 py-4">
              No messages yet.
            </p>
          )}
          {messages.map((msg) => (
            <MessageItem key={msg.id} message={msg} participants={participants} />
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Stream errors */}
      {streamError && (
        <div className="px-3 py-1 bg-destructive/10 text-xs text-destructive">
          Stream error: {streamError.message}
        </div>
      )}

      {/* Input area */}
      <div className="px-3 py-3 border-t border-border space-y-1">
        {/* Attachment preview strip */}
        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap gap-2 pb-1">
            {pendingAttachments.map((att, idx) => (
              <div key={idx} className="relative inline-flex">
                <img
                  src={att.previewUrl}
                  alt={`pending attachment ${idx + 1}`}
                  className="max-h-20 max-w-xs rounded border border-border object-contain"
                />
                <button
                  type="button"
                  onClick={() => removeAttachment(idx)}
                  aria-label={`Remove attachment ${idx + 1}`}
                  className="absolute -top-1.5 -right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs leading-none"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="relative">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label="Keyboard shortcuts"
                  className="absolute top-1.5 right-1.5 z-10 cursor-help text-muted-foreground hover:text-foreground transition-colors"
                  tabIndex={-1}
                >
                  <HelpCircle className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" align="end">
                <div className="space-y-1">
                  <div><kbd className="font-mono text-xs">Enter</kbd> — Send message</div>
                  <div><kbd className="font-mono text-xs">Shift+Enter</kbd> — New line</div>
                  <div><kbd className="font-mono text-xs">Ctrl+V</kbd> — Paste image</div>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={
              sessionClosed
                ? 'Session is closed'
                : 'Send a message...'
            }
            disabled={!canSend}
            rows={2}
            className="resize-none w-full text-sm pr-7"
          />
        </div>
        {postMessage.isError && (
          <p className="text-xs text-destructive">
            {postMessage.error instanceof Error
              ? postMessage.error.message
              : 'Failed to send message.'}
          </p>
        )}
        {/* Hidden submit — keyboard (Enter) is the primary trigger; hasContent kept for gating */}
        <span className="sr-only" aria-hidden={!hasContent} />
      </div>
    </div>
  );
}
