'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getTeamId, setTeamId } from '@/lib/client/team-id';
import { useJoinSession, useMessageStream, useSession } from '@/lib/client/hooks';
import { TitleBar } from '@/components/session/title-bar';
import { RosterPanel } from '@/components/session/roster-panel';
import { FeedPanel } from '@/components/session/feed-panel';
import { DocumentTab } from '@/components/session/document-tab';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

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

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <TitleBar
        sessionId={sessionId}
        title={title}
        description={description}
        sessionClosed={sessionClosed}
        onMetadataUpdated={(t, d) => {
          setTitle(t);
          setDescription(d);
        }}
      />

      {/* Two-column panel layout */}
      <div
        className="flex-1 grid"
        style={{ gridTemplateColumns: '200px 1fr', minHeight: 0 }}
      >
        {/* Roster */}
        <div className="border-r border-border overflow-hidden">
          <RosterPanel sessionId={sessionId} />
        </div>

        {/* Feed + Document tabs */}
        <div className="overflow-hidden flex flex-col">
          <Tabs defaultValue="feed" className="flex flex-col h-full">
            <div className="px-4 pt-3 pb-2 border-b border-border">
              <TabsList>
                <TabsTrigger value="feed">Feed</TabsTrigger>
                <TabsTrigger value="document">Document</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="feed" className="flex-1 overflow-hidden flex flex-col mt-0">
              <FeedPanel sessionId={sessionId} sessionClosed={sessionClosed} />
            </TabsContent>
            <TabsContent value="document" className="flex-1 overflow-hidden flex flex-col mt-0">
              <DocumentTab sessionId={sessionId} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
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
