'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getTeamId, setTeamId } from '@/lib/client/team-id';
import { useJoinSession, useMessageStream, useSession, useLeaveSession, useConcludeSession, useUpdateSessionMetadata } from '@/lib/client/hooks';
import { TitleBar } from '@/components/session/title-bar';
import { RosterPanel } from '@/components/session/roster-panel';
import { FeedPanel } from '@/components/session/feed-panel';
import { DocumentTab } from '@/components/session/document-tab';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { LogOut, Share2 } from 'lucide-react';
import { toast } from 'sonner';

// ---------------------------------------------------------------------------
// Join gate — shown when user has no team_id for this session
// ---------------------------------------------------------------------------

function JoinGate({
  sessionId,
  onJoined,
}: {
  sessionId: string;
  onJoined: () => void;
}) {
  const [teamName, setTeamName] = useState('');
  const joinSession = useJoinSession();

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!teamName.trim()) return;
    await joinSession.mutateAsync({ session_id: sessionId, team_name: teamName });
    onJoined();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Join session</CardTitle>
          <CardDescription>
            Enter your team name to join this session.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void handleJoin(e)} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="team-name">Your team name</Label>
              <Input
                id="team-name"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="e.g. Alex's Team"
                required
              />
            </div>
            {joinSession.isError && (
              <p className="text-sm text-destructive">
                {joinSession.error instanceof Error
                  ? joinSession.error.message
                  : 'Failed to join session.'}
              </p>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={!teamName.trim() || joinSession.isPending}
            >
              {joinSession.isPending ? 'Joining…' : 'Join session'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session UI — title + description state are tracked locally, seeded from
// the first system message or from the join response. The stream surfaces
// metadata_updated events so the title bar can reflect changes without a
// separate metadata query.
// ---------------------------------------------------------------------------

function SessionUI({ sessionId }: { sessionId: string }) {
  const stream = useMessageStream(sessionId);
  const router = useRouter();
  const sessionQuery = useSession(sessionId);

  // Local state is seeded from useSession once data first arrives; subsequent
  // updates via useUpdateSessionMetadata invalidate the query cache so the
  // title bar reflects the latest values automatically.
  const [title, setTitle] = useState('Loading…');
  const [description, setDescription] = useState('');

  // Conclude dialog state
  const [concludeOpen, setConcludeOpen] = useState(false);
  const [summary, setSummary] = useState('');

  // Edit metadata dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editReason, setEditReason] = useState('');

  const leaveSession = useLeaveSession();
  const concludeSession = useConcludeSession();
  const updateMetadata = useUpdateSessionMetadata();
  const myTeamId = getTeamId(sessionId);

  // Seed local state from the first successful get_session response.
  useEffect(() => {
    if (sessionQuery.data) {
      setTitle(sessionQuery.data.title);
      setDescription(sessionQuery.data.description);
    }
  }, [sessionQuery.data]);

  // Redirect to home if the session is not found.
  useEffect(() => {
    if (
      sessionQuery.isError &&
      sessionQuery.error instanceof Error &&
      sessionQuery.error.message.includes('not_found')
    ) {
      console.warn('[SessionUI] session not found — redirecting to /');
      router.push('/');
    }
  }, [sessionQuery.isError, sessionQuery.error, router]);

  // Derive session_closed from both the stream and a local override (for
  // when the user themselves concludes the session via the TitleBar dialog).
  const sessionClosed = stream.sessionClosed;

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
    setTitle(editTitle);
    setDescription(editDescription);
    setEditOpen(false);
  }

  async function handleShare() {
    try {
      const shareUrl = window.location.href;
      const mcpUrl =
        process.env.NEXT_PUBLIC_MCP_URL ??
        window.location.origin + '/api/mcp';
      const payload = `[Project-Merkle session invitation]

You have been invited to join a Project-Merkle session.

session_id: ${sessionId}
session_url: ${shareUrl}
mcp_endpoint: ${mcpUrl}

Instructions:
1. Call get_app_info (no auth, no params) at the mcp_endpoint above to orient yourself.
2. Call join_session({ session_id, team_name: "<your team name>" }) to join and receive your team_id.
3. Use the returned team_id in the X-Team-ID header for all subsequent calls.
4. Begin polling with wait_for_messages to enter the session.`;
      await navigator.clipboard.writeText(payload);
      toast.success('Invitation copied', {
        description: 'Agent invitation copied to clipboard',
      });
    } catch {
      toast.error("Couldn't copy", {
        description: 'Browser blocked clipboard access',
      });
    }
  }

  async function handleLeave() {
    if (!myTeamId) return;
    await leaveSession.mutateAsync({ session_id: sessionId, team_id: myTeamId });
    router.push('/');
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
    <div className="flex flex-col min-h-screen bg-background">
      {/* Action row — lifecycle controls on left, metadata controls on right */}
      <div className="px-3 py-3 flex items-center gap-2 border-b border-border">
        <Button
          variant="outline"
          size="sm"
          onClick={handleLeave}
          disabled={!myTeamId || leaveSession.isPending}
        >
          <LogOut className="h-4 w-4 mr-1.5" />
          {leaveSession.isPending ? 'Leaving…' : 'Leave session'}
        </Button>
        {leaveSession.isError && (
          <span className="text-xs text-destructive">
            {leaveSession.error instanceof Error
              ? leaveSession.error.message
              : 'Failed to leave.'}
          </span>
        )}
        <Button
          variant="destructive"
          size="sm"
          disabled={sessionClosed}
          onClick={() => setConcludeOpen(true)}
        >
          Conclude Session
        </Button>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleShare()}
            aria-label="Share session link"
          >
            <Share2 className="h-4 w-4 mr-1.5" />
            Share Session
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={sessionClosed}
            onClick={openEdit}
          >
            Edit
          </Button>
        </div>
      </div>

      <Tabs defaultValue="feed" className="flex flex-col flex-1 min-h-0">
        <TitleBar
          title={title}
          description={description}
          sessionClosed={sessionClosed}
          centerSlot={
            <TabsList>
              <TabsTrigger value="feed">Feed</TabsTrigger>
              <TabsTrigger value="document">Document</TabsTrigger>
            </TabsList>
          }
        />

        {/* Two-column panel layout */}
        <div
          className="flex-1 grid min-h-0"
          style={{ gridTemplateColumns: '200px 1fr' }}
        >
          {/* Roster */}
          <div className="border-r border-border overflow-hidden">
            <RosterPanel sessionId={sessionId} />
          </div>

          {/* Feed + Document tab content */}
          <div className="overflow-hidden flex flex-col">
            <TabsContent value="feed" className="flex-1 overflow-hidden flex flex-col mt-0">
              <FeedPanel sessionId={sessionId} sessionClosed={sessionClosed} />
            </TabsContent>
            <TabsContent value="document" className="flex-1 overflow-hidden flex flex-col mt-0">
              <DocumentTab sessionId={sessionId} />
            </TabsContent>
          </div>
        </div>
      </Tabs>

      {/* Edit session metadata dialog */}
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
              onClick={() => void handleEditSubmit()}
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

// ---------------------------------------------------------------------------
// Page root
// ---------------------------------------------------------------------------

export default function SessionPage() {
  const params = useParams();
  const sessionId = typeof params.id === 'string' ? params.id : '';

  // Hydration-safe: localStorage is not available on the server; we check
  // after mount via useEffect.
  const [hasTeamId, setHasTeamId] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    setHasTeamId(getTeamId(sessionId) !== null);
    setChecked(true);
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Invalid session ID.</p>
      </div>
    );
  }

  // Render nothing until we've checked localStorage (avoids hydration flicker)
  if (!checked) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </div>
    );
  }

  if (!hasTeamId) {
    return (
      <JoinGate
        sessionId={sessionId}
        onJoined={() => setHasTeamId(true)}
      />
    );
  }

  return <SessionUI sessionId={sessionId} />;
}
