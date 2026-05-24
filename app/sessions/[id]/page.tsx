'use client';

import { useState, useEffect } from 'react';
import NextLink from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { getTeamId, setTeamId } from '@/lib/client/team-id';
import { useJoinSession, useMessageStream, useSession, useLeaveSession, useConcludeSession, useUpdateSessionMetadata, useReopenSession, getPasscode, getLastUsername } from '@/lib/client/hooks';
import { useQueryClient } from '@tanstack/react-query';
import { SupportTicketPicker } from '@/components/session/support-ticket-picker';
import { MCPClientError } from '@/lib/client/mcp-client';
import { showErrorToast } from '@/lib/client/error-toast';
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
import { ArrowLeft, Download, Link, LogOut, Share2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { ThemeToggle } from '@/components/theme-toggle';
import { DotFieldBackground } from '@/components/ui/dot-field-background';

// ---------------------------------------------------------------------------
// Join gate — shown when user has no team_id for this session
// ---------------------------------------------------------------------------

function JoinGate({
  sessionId,
  urlPasscode,
  onJoined,
  onNotFound,
}: {
  sessionId: string;
  urlPasscode: string | null;
  onJoined: () => void;
  onNotFound: () => void;
}) {
  const [teamName, setTeamName] = useState('');
  const [passcode, setPasscode] = useState('');
  const joinSession = useJoinSession();

  const storageKey = `merkle:join:${sessionId}:team_name`;

  // Prefill team_name (per-session first, global fallback) and passcode.
  // URL query param takes priority over localStorage for the passcode.
  useEffect(() => {
    const savedName = localStorage.getItem(storageKey);
    if (savedName) {
      setTeamName(savedName);
    } else {
      const lastGlobal = getLastUsername();
      if (lastGlobal) setTeamName(lastGlobal);
    }
    if (urlPasscode) {
      setPasscode(urlPasscode);
    } else {
      const savedPasscode = getPasscode(sessionId);
      if (savedPasscode) setPasscode(savedPasscode);
    }
  }, [storageKey, sessionId, urlPasscode]);

  async function handleJoin(e: React.FormEvent) {
    e.preventDefault();
    if (!teamName.trim() || !passcode.trim()) return;
    try {
      await joinSession.mutateAsync({ session_id: sessionId, team_name: teamName, passcode });
    } catch (err) {
      // If the server confirms the session doesn't exist, escalate to the
      // page-level not-found state instead of showing the inline error.
      if (err instanceof MCPClientError && err.code === 'not_found') {
        onNotFound();
        return;
      }
      // All other errors are surfaced as a persistent toast.
      showErrorToast(
        err instanceof Error ? err.message : 'Failed to join session.',
        { title: 'Failed to join session' },
      );
      return;
    }
    localStorage.setItem(storageKey, teamName);
    // Seed passcode to localStorage so future visits without the URL param still work.
    if (passcode) {
      localStorage.setItem(`merkle:passcode:${sessionId}`, passcode);
    }
    onJoined();
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Join Session</CardTitle>
          <CardDescription>
            Enter your team name and the session passcode to join.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={(e) => void handleJoin(e)} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="team-name">Username</Label>
              <Input
                id="team-name"
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                placeholder="e.g. Alex's Team"
                required
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="join-passcode">Passcode</Label>
              <Input
                id="join-passcode"
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
                placeholder="Session passcode"
                required
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <NextLink href="/">
                <Button variant="default" size="sm" type="button">
                  <ArrowLeft className="h-4 w-4 mr-1.5" />
                  Back
                </Button>
              </NextLink>
              <Button
                type="submit"
                size="sm"
                className="flex-1"
                disabled={!teamName.trim() || !passcode.trim() || joinSession.isPending}
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

function SessionUI({ sessionId, onNotFound }: { sessionId: string; onNotFound: () => void }) {
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

  // Reopen dialog state
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');

  // Edit metadata dialog state
  const [editOpen, setEditOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editReason, setEditReason] = useState('');

  // isCreator: SSR-safe — read localStorage after mount and store in state.
  const [isCreator, setIsCreator] = useState(false);

  const queryClient = useQueryClient();
  const leaveSession = useLeaveSession();
  const concludeSession = useConcludeSession();
  const reopenSession = useReopenSession();
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
      // Determine creator status: compare session's created_by_team_id against
      // the team_id we have stored in localStorage for this session.
      const storedTeamId = localStorage.getItem(`merkle:team_id:${sessionId}`);
      setIsCreator(
        Boolean(
          sessionQuery.data.created_by_team_id &&
          storedTeamId &&
          sessionQuery.data.created_by_team_id === storedTeamId,
        ),
      );
    }
  }, [sessionQuery.data, sessionId]);

  // Surface the not-found empty state if the session row no longer exists.
  useEffect(() => {
    if (
      sessionQuery.isError &&
      sessionQuery.error instanceof MCPClientError &&
      sessionQuery.error.code === 'not_found'
    ) {
      onNotFound();
    }
  }, [sessionQuery.isError, sessionQuery.error, onNotFound]);

  // Invalidate support-session queries when relevant system events arrive.
  const lastMsg = stream.messages.at(-1);
  useEffect(() => {
    if (!lastMsg || lastMsg.type !== 'system') return;
    const ev = (lastMsg.content as { event?: string } | null)?.event;
    if (ev === 'support_tickets_updated') {
      void queryClient.invalidateQueries({ queryKey: ['support_tickets', sessionId] });
    } else if (ev === 'support_ticket_selected') {
      void queryClient.invalidateQueries({ queryKey: ['support_selected_ticket', sessionId] });
    }
    // support_issue_appended: no UI state to invalidate beyond what feed-panel.tsx renders
  }, [lastMsg?.id, sessionId, queryClient]);

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
    try {
      await updateMetadata.mutateAsync({
        session_id: sessionId,
        title: editTitle,
        description: editDescription,
        reason: editReason,
      });
      setTitle(editTitle);
      setDescription(editDescription);
      setEditOpen(false);
    } catch (err) {
      showErrorToast(
        err instanceof Error ? err.message : 'Failed to update metadata.',
        { title: 'Failed to update session metadata' },
      );
    }
  }

  async function handleShare() {
    try {
      const shareUrl = window.location.href;
      const mcpUrl =
        process.env.NEXT_PUBLIC_MCP_URL ??
        window.location.origin + '/api/mcp';
      const passcode = getPasscode(sessionId) ?? '<PASSCODE — ask the session creator>';
      const payload = `[Project-Merkle session invitation]

You have been invited to join a Project-Merkle session.

session_id: ${sessionId}
passcode: ${passcode}
session_url: ${shareUrl}
mcp_endpoint: ${mcpUrl}

This guide assumes you are an agent running in Claude Code (HTTP-MCP transport). To join you will register with the server via curl and then use the merkle MCP tools, passing your team_id as an argument on every call. Approximate time: 30 seconds.

Step 1 -- Pick a team_name and register via curl. Run exactly:

curl -X POST ${mcpUrl} \\
  -H "Content-Type: application/json" \\
  -H "Accept: application/json, text/event-stream" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"join_session","arguments":{"session_id":"${sessionId}","team_name":"YOUR_TEAM_NAME","passcode":"${passcode}"}}}'

The response contains your team_id. Save it.

Step 2 -- Call merkle__wait_for_messages({ session_id: "${sessionId}", team_id: "YOUR_TEAM_ID", since_cursor: 0 }) to enter the session. From now on, include team_id in the arguments of every merkle__ tool call. Call merkle__get_app_info({ team_id: "YOUR_TEAM_ID" }) for a full tool reference.`;
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

  async function handleCopyUrl() {
    try {
      const passcode = getPasscode(sessionId);
      if (!passcode) {
        toast.error("Couldn't find passcode", {
          description: "Only the creator and joiners who saved it have it locally",
        });
        return;
      }
      const url = `${window.location.origin}/sessions/${sessionId}?passcode=${encodeURIComponent(passcode)}`;
      await navigator.clipboard.writeText(url);
      toast.success('URL copied', { description: 'Pasted to your clipboard' });
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
    try {
      await leaveSession.mutateAsync({ session_id: sessionId, team_id: myTeamId });
      router.push('/');
    } catch (err) {
      showErrorToast(
        err instanceof Error ? err.message : 'Failed to leave session.',
        { title: 'Failed to leave session' },
      );
    }
  }

  async function handleConcludeSubmit() {
    if (!summary.trim()) return;
    try {
      await concludeSession.mutateAsync({
        session_id: sessionId,
        summary_section: summary,
      });
      setConcludeOpen(false);
    } catch (err) {
      showErrorToast(
        err instanceof Error ? err.message : 'Failed to close session.',
        { title: 'Failed to close session' },
      );
    }
  }

  async function handleReopenSubmit() {
    if (!reopenReason.trim()) return;
    try {
      await reopenSession.mutateAsync({
        session_id: sessionId,
        reason: reopenReason,
      });
      setReopenReason('');
      setReopenOpen(false);
    } catch (err) {
      showErrorToast(
        err instanceof Error ? err.message : 'Failed to open session.',
        { title: 'Failed to open session' },
      );
    }
  }

  return (
    <div className="h-screen overflow-hidden flex flex-col bg-background">
      <Tabs defaultValue="feed" className="flex flex-col flex-1 min-h-0">
        {/* Action row — session label, lifecycle controls, tabs, and metadata controls */}
        <div className="shrink-0 px-2 py-2 flex items-center gap-2 border-b border-border">
          {/* Left cluster: lifecycle buttons */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={handleLeave}
              disabled={!myTeamId || leaveSession.isPending}
            >
              <LogOut className="h-4 w-4 mr-1.5 -scale-x-100" />
              {leaveSession.isPending ? 'Leaving…' : 'Leave'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="bg-red-500/10 border-red-500/20 text-red-700 dark:text-red-300 hover:bg-red-500/20 hover:text-red-700 dark:hover:text-red-300"
              disabled={sessionClosed}
              onClick={() => setConcludeOpen(true)}
            >
              Close Session
            </Button>
            {sessionClosed && isCreator && (
              <Button
                variant="outline"
                size="sm"
                className="bg-emerald-500/10 border-emerald-500/20 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20 hover:text-emerald-700 dark:hover:text-emerald-300"
                onClick={() => setReopenOpen(true)}
              >
                Open Session
              </Button>
            )}
          </div>

          {/* Divider: left cluster / center tabs */}
          <div className="self-stretch w-px bg-border mx-1 -my-2" />

          {/* Center: Feed / Document tabs */}
          <div className="flex-1 flex justify-center">
            <TabsList className="h-8 px-1 w-full">
              <span className="inline-flex items-center h-7 text-xs font-medium uppercase tracking-wide text-muted-foreground px-3 select-none leading-none flex-1">
                Current Session
              </span>
              <TabsTrigger value="feed" className="h-7 px-3 text-sm leading-none flex-1">Feed</TabsTrigger>
              <TabsTrigger value="document" className="h-7 px-3 text-sm leading-none flex-1">Document</TabsTrigger>
            </TabsList>
          </div>

          {/* Divider: center tabs / right cluster */}
          <div className="self-stretch w-px bg-border mx-1 -my-2" />

          {/* Right cluster: download (closed only), copy passcode, share, edit, theme */}
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
              onClick={() => void handleCopyUrl()}
              aria-label="Copy shareable session URL"
            >
              <Link className="h-4 w-4 mr-1.5" />
              Copy URL
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleShare()}
              aria-label="Add agent to session"
            >
              <UserPlus className="h-4 w-4 mr-1.5" />
              Add Agent
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

        {/* Support-session ticket picker — shown only for support sessions */}
        {sessionQuery.data?.is_support_session && (
          <div className="shrink-0 border-b border-border px-3 py-2">
            <SupportTicketPicker sessionId={sessionId} />
          </div>
        )}

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
        </DialogContent>
      </Dialog>

      {/* Open session dialog */}
      <Dialog open={reopenOpen} onOpenChange={setReopenOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open session</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              This will open the session so participants can post messages and
              edit the document again. All participants will be notified.
            </p>
            <div className="space-y-1">
              <Label htmlFor="reopen-reason">
                Reason{' '}
                <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="reopen-reason"
                value={reopenReason}
                onChange={(e) => setReopenReason(e.target.value)}
                placeholder="Why is this session being opened?"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReopenOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleReopenSubmit()}
              disabled={!reopenReason.trim() || reopenSession.isPending}
            >
              {reopenSession.isPending ? 'Opening…' : 'Open session'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close session dialog */}
      <Dialog open={concludeOpen} onOpenChange={setConcludeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close session</DialogTitle>
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
              variant="outline"
              className="bg-red-500/10 border-red-500/20 text-red-700 dark:text-red-300 hover:bg-red-500/20 hover:text-red-700 dark:hover:text-red-300"
              onClick={handleConcludeSubmit}
              disabled={!summary.trim() || concludeSession.isPending}
            >
              {concludeSession.isPending ? 'Closing…' : 'Close session'}
            </Button>
          </DialogFooter>
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
  const searchParams = useSearchParams();
  const sessionId = typeof params.id === 'string' ? params.id : '';
  const urlPasscode = searchParams.get('passcode');

  // Hydration-safe: localStorage is not available on the server; we check
  // after mount via useEffect.
  const [hasTeamId, setHasTeamId] = useState(false);
  const [checked, setChecked] = useState(false);
  // Set to true when the server confirms the session row does not exist.
  const [isNotFound, setIsNotFound] = useState(false);

  useEffect(() => {
    setHasTeamId(getTeamId(sessionId) !== null);
    setChecked(true);
  }, [sessionId]);

  if (!sessionId) {
    return (
      <div className="relative min-h-screen flex items-center justify-center p-4">
        <DotFieldBackground />
        <Card className="relative z-10 w-full max-w-md">
          <CardContent className="p-6 text-center space-y-6">
            <p className="text-3xl font-bold tracking-tight text-foreground">
              Project Merkle
            </p>
            <h1 className="text-xl font-semibold text-muted-foreground">Session Not Found</h1>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              This session doesn&apos;t exist or has been removed.
            </p>
            <NextLink href="/" className="inline-block">
              <Button variant="default" size="sm">
                <ArrowLeft className="h-4 w-4 mr-1.5" />
                Dashboard
              </Button>
            </NextLink>
          </CardContent>
        </Card>
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

  // Server confirmed this session row does not exist.
  if (isNotFound) {
    return (
      <div className="relative min-h-screen flex items-center justify-center p-4">
        <DotFieldBackground />
        <Card className="relative z-10 w-full max-w-md">
          <CardContent className="p-6 text-center space-y-6">
            <p className="text-3xl font-bold tracking-tight text-foreground">
              Project Merkle
            </p>
            <h1 className="text-xl font-semibold text-muted-foreground">Session Not Found</h1>
            <p className="text-sm text-muted-foreground max-w-xs mx-auto">
              We couldn&apos;t load this session. It may not exist or may have been removed.
            </p>
            <NextLink href="/" className="inline-block">
              <Button variant="default" size="sm">
                <ArrowLeft className="h-4 w-4 mr-1.5" />
                Dashboard
              </Button>
            </NextLink>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!hasTeamId) {
    return (
      <JoinGate
        sessionId={sessionId}
        urlPasscode={urlPasscode}
        onJoined={() => setHasTeamId(true)}
        onNotFound={() => setIsNotFound(true)}
      />
    );
  }

  return <SessionUI sessionId={sessionId} onNotFound={() => setIsNotFound(true)} />;
}
