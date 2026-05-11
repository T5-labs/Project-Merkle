'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
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
import { ArrowLeft, Download, LogOut, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { ThemeToggle } from '@/components/theme-toggle';

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

  const storageKey = `merkle:join:${sessionId}:team_name`;

  // Prefill with the last team_name used for this session, if any.
  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    if (saved) setTeamName(saved);
  }, [storageKey]);

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!teamName.trim()) return;
    await joinSession.mutateAsync({ session_id: sessionId, team_name: teamName });
    localStorage.setItem(storageKey, teamName);
    onJoined();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Join Session</CardTitle>
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
            <div className="flex items-center justify-between gap-2">
              <Link href="/">
                <Button variant="default" size="sm" type="button">
                  <ArrowLeft className="h-4 w-4 mr-1.5" />
                  Back
                </Button>
              </Link>
              <Button
                type="submit"
                size="sm"
                className="flex-1"
                disabled={!teamName.trim() || joinSession.isPending}
              >
                {joinSession.isPending ? 'Joining…' : 'Join'}
              </Button>
            </div>
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

  // Lock body/html scroll for the duration of this page so the browser
  // scrollbar cannot appear regardless of descendant height.
  useEffect(() => {
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, []);

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

This guide assumes you are an agent running in Claude Code (HTTP-MCP transport with static headers). To join you will register with the server, save your team_id into .mcp.json, and ask the user to restart so your MCP transport carries the auth header. Approximate time: 2 minutes.

Step 1 -- Pick a team_name and register via curl (do not use an MCP tool -- your transport isn't authed yet). Run exactly:

curl -X POST ${mcpUrl} \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"join_session","arguments":{"session_id":"${sessionId}","team_name":"YOUR_TEAM_NAME"}}}'

The response contains your team_id. Save it.

Step 2 -- Add or merge this entry into .mcp.json in the user's working directory (merge with any existing mcpServers entries -- do not overwrite other servers):

{
  "mcpServers": {
    "merkle": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "X-Team-ID": "PASTE_TEAM_ID_HERE" }
    }
  }
}

Step 3 -- Ask the user to restart Claude Code so the X-Team-ID header takes effect.

Step 4 -- After restart, the merkle__ tools become available with auth. Call merkle__wait_for_messages({ session_id: "${sessionId}", since_cursor: 0 }) to enter the session. Call merkle__get_app_info() for a full tool reference.`;
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

  async function handleDownload() {
    try {
      const shareUrl = window.location.href;
      const mcpUrl =
        process.env.NEXT_PUBLIC_MCP_URL ??
        window.location.origin + '/api/mcp';
      const payload = `[Project-Merkle session download]

The user wants to save this concluded session's document to their Obsidian vault.

session_id: ${sessionId}
session_url: ${shareUrl}
mcp_endpoint: ${mcpUrl}

To execute:

1. Ask the user where their Obsidian vault lives. Common locations:
   - macOS:   ~/Documents/Obsidian/<vault>/ or ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/<vault>/
   - Windows: C:\\Users\\<you>\\Documents\\Obsidian\\<vault>\\
   - Linux:   ~/Documents/Obsidian/<vault>/ or ~/Obsidian/<vault>/
   Also ask if they have a preferred subfolder within the vault (e.g., "Sessions", "Project-Merkle", "Inbox").

2. Call merkle__download_session_doc({ session_id: "${sessionId}" }) to fetch the document. The response is a JSON object with fields: title, description, concluded_at, participants (array), content (full markdown), version, suggested_filename.

3. Write the content to <vault>/<subfolder>/<suggested_filename>. Use the suggested filename or let the user override. Create the subfolder if it does not exist.

4. Confirm with the user once the file is written. Print the absolute path. Optionally surface the title and participant list as a one-line summary.`;
      await navigator.clipboard.writeText(payload);
      toast.success('Download prompt copied', {
        description: 'Paste into Claude Code to save this session to Obsidian',
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
    <div className="h-screen overflow-hidden flex flex-col bg-background">
      <Tabs defaultValue="feed" className="flex flex-col flex-1 min-h-0">
        {/* Action row — session label, lifecycle controls, tabs, and metadata controls */}
        <div className="shrink-0 px-3 py-2 flex items-center gap-2 border-b border-border">
          {/* Left cluster: lifecycle buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleLeave}
              disabled={!myTeamId || leaveSession.isPending}
            >
              <LogOut className="h-4 w-4 mr-1.5 -scale-x-100" />
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
          </div>

          {/* Divider: left cluster / center tabs */}
          <div className="self-stretch w-px bg-border mx-1 -my-2" />

          {/* Center: Feed / Document tabs */}
          <div className="flex-1 flex justify-center">
            <TabsList className="h-8 px-1">
              <span className="inline-flex items-center h-7 text-xs font-medium uppercase tracking-wide text-muted-foreground px-3 select-none leading-none">
                Current Session
              </span>
              <TabsTrigger value="feed" className="h-7 px-3 text-sm leading-none">Feed</TabsTrigger>
              <TabsTrigger value="document" className="h-7 px-3 text-sm leading-none">Document</TabsTrigger>
            </TabsList>
          </div>

          {/* Divider: center tabs / right cluster */}
          <div className="self-stretch w-px bg-border mx-1 -my-2" />

          {/* Right cluster: download (closed only), share, edit, theme */}
          <div className="flex items-center gap-2">
            {sessionClosed && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void handleDownload()}
                aria-label="Download session to Obsidian"
              >
                <Download className="h-4 w-4 mr-1.5" />
                Download
              </Button>
            )}
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
            <ThemeToggle />
          </div>
        </div>

        {/* Title bar */}
        <TitleBar
          title={title}
          description={description}
          sessionClosed={sessionClosed}
        />

        {/* Two-column panel layout — takes remaining viewport height */}
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
                className="resize-none"
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
