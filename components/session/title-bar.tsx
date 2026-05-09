'use client';

import { useState } from 'react';
import { useUpdateSessionMetadata, useConcludeSession } from '@/lib/client/hooks';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

interface TitleBarProps {
  sessionId: string;
  title: string;
  description: string;
  sessionClosed: boolean;
  onMetadataUpdated?: (title: string, description: string) => void;
}

export function TitleBar({
  sessionId,
  title,
  description,
  sessionClosed,
  onMetadataUpdated,
}: TitleBarProps) {
  const [editOpen, setEditOpen] = useState(false);
  const [concludeOpen, setConcludeOpen] = useState(false);

  // Edit dialog state
  const [editTitle, setEditTitle] = useState(title);
  const [editDescription, setEditDescription] = useState(description);
  const [editReason, setEditReason] = useState('');

  // Conclude dialog state
  const [summary, setSummary] = useState('');

  const updateMetadata = useUpdateSessionMetadata();
  const concludeSession = useConcludeSession();

  function openEdit() {
    setEditTitle(title);
    setEditDescription(description);
    setEditReason('');
    setEditOpen(true);
  }

  async function handleEditSubmit() {
    if (!editReason.trim()) return;
    await updateMetadata.mutateAsync({
      session_id: sessionId,
      title: editTitle,
      description: editDescription,
      reason: editReason,
    });
    setEditOpen(false);
    onMetadataUpdated?.(editTitle, editDescription);
  }

  async function handleConcludeSubmit() {
    if (!summary.trim()) return;
    await concludeSession.mutateAsync({
      session_id: sessionId,
      summary_section: summary,
    });
    setConcludeOpen(false);
  }

  return (
    <div className="px-6 py-4 border-b border-border">
      <div className="flex items-start justify-between gap-4">
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

        <div className="flex gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            disabled={sessionClosed}
            onClick={openEdit}
          >
            Edit
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={sessionClosed}
            onClick={() => setConcludeOpen(true)}
          >
            Conclude session
          </Button>
        </div>
      </div>

      {/* Edit metadata dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit session metadata</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label htmlFor="edit-title">Title</Label>
              <Input
                id="edit-title"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="Session title"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-description">Description</Label>
              <Textarea
                id="edit-description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="Session description"
                rows={3}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-reason">
                Reason for change{' '}
                <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="edit-reason"
                value={editReason}
                onChange={(e) => setEditReason(e.target.value)}
                placeholder="Why is this change significant?"
                rows={2}
              />
              {editReason.trim() === '' && (
                <p className="text-xs text-muted-foreground">
                  A reason is required to explain the significance of this change.
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleEditSubmit}
              disabled={!editReason.trim() || updateMetadata.isPending}
            >
              {updateMetadata.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
          {updateMetadata.isError && (
            <p className="text-xs text-destructive mt-2">
              {updateMetadata.error instanceof Error
                ? updateMetadata.error.message
                : 'Failed to update metadata.'}
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* Conclude session dialog */}
      <Dialog open={concludeOpen} onOpenChange={setConcludeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Conclude session</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              This will close the session and write a conclusion section into the
              session document. All teams will be notified.
            </p>
            <div className="space-y-1">
              <Label htmlFor="conclude-summary">
                Conclusion summary{' '}
                <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="conclude-summary"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="Summarize what was accomplished and any next steps…"
                rows={5}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConcludeOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConcludeSubmit}
              disabled={!summary.trim() || concludeSession.isPending}
            >
              {concludeSession.isPending ? 'Concluding…' : 'Conclude session'}
            </Button>
          </DialogFooter>
          {concludeSession.isError && (
            <p className="text-xs text-destructive mt-2">
              {concludeSession.error instanceof Error
                ? concludeSession.error.message
                : 'Failed to conclude session.'}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
