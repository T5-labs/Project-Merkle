'use client';

import { useState, useEffect } from 'react';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { useCreateSession, useJoinSession, useListSessions, getPasscode, getLastUsername } from '@/lib/client/hooks';
import { showErrorToast } from '@/lib/client/error-toast';
import type { SessionSummary } from '@/lib/client/hooks';
import { Switch } from '@/components/ui/switch';
import { getTeamId } from '@/lib/client/team-id';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

// GitHub mark SVG (official simple path, public domain / freely usable)
function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      suppressHydrationWarning
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
import { X, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { DotFieldBackground } from '@/components/ui/dot-field-background';
import { ThemeToggle } from '@/components/theme-toggle';
import { VERSION } from '@/lib/version';

// ---------------------------------------------------------------------------
// Create session form
// ---------------------------------------------------------------------------

function CreateSessionForm() {
  const router = useRouter();
  const createSession = useCreateSession();

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [teamName, setTeamName] = useState('');
  const [isSupportSession, setIsSupportSession] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Prefill username from last-used global value (SSR-safe: read only after mount).
  useEffect(() => {
    const last = getLastUsername();
    if (last) setTeamName(last);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || !teamName.trim()) return;
    setSubmitting(true);
    try {
      const result = await createSession.mutateAsync({
        title,
        description,
        creator_team_name: teamName,
        is_support_session: isSupportSession,
      });
      router.push(`/sessions/${result.session_id}`);
    } catch (err) {
      setSubmitting(false);
      showErrorToast(
        err instanceof Error ? err.message : 'Failed to create session.',
        { title: 'Failed to Create Session' },
      );
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="text-xl">Create Session</CardTitle>
        <CardDescription>
          Start a new collaborative session. You'll receive a session ID to share
          with other teams.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="create-title">Session title</Label>
            <Input
              id="create-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Q3 architecture review"
              required
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="create-description">Description</Label>
            <Textarea
              id="create-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this session for? (optional)"
              rows={3}
              className="resize-none"
            />
          </div>

          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="create-support-session" className="cursor-pointer">
              Support Session
            </Label>
            <Switch
              id="create-support-session"
              checked={isSupportSession}
              onCheckedChange={(checked) => setIsSupportSession(checked === true)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="create-team">Username</Label>
            <Input
              id="create-team"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="e.g. Alex's Team"
              required
            />
          </div>

          <Button
            type="submit"
            className="w-full"
            disabled={!title.trim() || !teamName.trim() || createSession.isPending || submitting}
          >
            {(createSession.isPending || submitting) ? 'Creating…' : 'Create'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Join session form
// ---------------------------------------------------------------------------

function JoinSessionForm() {
  const router = useRouter();
  const joinSession = useJoinSession();

  const [sessionId, setSessionId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [passcode, setPasscode] = useState('');

  // Prefill username from last-used global value on mount (SSR-safe).
  useEffect(() => {
    const last = getLastUsername();
    if (last) setTeamName(last);
  }, []);

  // Pre-fill passcode from localStorage if the user previously joined/created this session.
  useEffect(() => {
    const trimmed = sessionId.trim();
    if (!trimmed) return;
    const stored = getPasscode(trimmed);
    if (stored) setPasscode(stored);
    else setPasscode('');
  }, [sessionId]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!sessionId.trim() || !teamName.trim() || !passcode.trim()) return;
    try {
      await joinSession.mutateAsync({
        session_id: sessionId,
        team_name: teamName,
        passcode,
      });
      router.push(`/sessions/${sessionId}`);
    } catch (err) {
      showErrorToast(
        err instanceof Error ? err.message : 'Failed to join session.',
        { title: 'Failed to join session' },
      );
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Join a session</CardTitle>
        <CardDescription>
          Enter an existing session ID, your team name, and the session passcode to join.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="join-session-id">Session ID</Label>
            <Input
              id="join-session-id"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
              placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
              required
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="join-team">Username</Label>
            <Input
              id="join-team"
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

          <Button
            type="submit"
            className="w-full"
            disabled={
              !sessionId.trim() || !teamName.trim() || !passcode.trim() || joinSession.isPending
            }
          >
            {joinSession.isPending ? 'Joining…' : 'Join session'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Time formatting helper
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ---------------------------------------------------------------------------
// Active sessions list
// ---------------------------------------------------------------------------

function SessionRow({ session }: { session: SessionSummary }) {
  const router = useRouter();
  const teamId = getTeamId(session.session_id);
  const label = teamId ? 'Rejoin' : 'Join';

  function navigate() {
    router.push(`/sessions/${session.session_id}`);
  }

  return (
    <div className="w-full rounded-xl border bg-card text-card-foreground shadow-sm p-4 flex items-center justify-between gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-semibold truncate">{session.title}</span>
          <Badge variant="outline" className="shrink-0 text-xs capitalize">
            {session.status}
          </Badge>
        </div>
        {session.description && (
          <p className="text-sm text-muted-foreground line-clamp-2 mb-1">
            {session.description}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {session.participant_count} participant{session.participant_count !== 1 ? 's' : ''} · created {relativeTime(session.created_at)}
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0"
        onClick={navigate}
      >
        {label} <ArrowRight className="h-4 w-4 ml-1.5" />
      </Button>
    </div>
  );
}

function SessionsList() {
  const [activeTab, setActiveTab] = useState<'active' | 'closed'>('active');
  const [query, setQuery] = useState('');

  const { data: activeSessions, isLoading: activeLoading } = useListSessions({ status: 'active' });
  const { data: closedSessions, isLoading: closedLoading } = useListSessions({ status: 'closed' });

  const activeCount = activeSessions?.length ?? 0;
  const closedCount = closedSessions?.length ?? 0;

  const currentSessions = activeTab === 'active' ? activeSessions : closedSessions;
  const isLoading = activeTab === 'active' ? activeLoading : closedLoading;

  const filtered = currentSessions
    ? currentSessions.filter((s) => {
        if (!query.trim()) return true;
        const q = query.toLowerCase();
        return (
          s.title.toLowerCase().includes(q) ||
          (s.description ?? '').toLowerCase().includes(q)
        );
      })
    : [];

  function renderList() {
    if (isLoading) {
      return <p className="text-sm text-muted-foreground">Loading sessions…</p>;
    }
    if (currentSessions && currentSessions.length > 0) {
      if (filtered.length > 0) {
        return (
          <div className="max-h-96 overflow-y-auto space-y-3">
            {filtered.map((session) => (
              <SessionRow key={session.session_id} session={session} />
            ))}
          </div>
        );
      }
      return (
        <p className="text-sm text-muted-foreground">
          No sessions match &ldquo;{query}&rdquo;.
        </p>
      );
    }
    if (activeTab === 'active') {
      return (
        <p className="text-sm text-muted-foreground">
          No active sessions yet — create one above to get started.
        </p>
      );
    }
    return (
      <p className="text-sm text-muted-foreground">No closed sessions.</p>
    );
  }

  return (
    <div className="w-full">
      <Tabs
        value={activeTab}
        onValueChange={(v) => {
          setActiveTab(v as 'active' | 'closed');
          setQuery('');
        }}
      >
        <TabsList className="h-8 px-1 mb-3 w-full">
          <span className="inline-flex items-center h-7 text-xs font-medium uppercase tracking-wide text-muted-foreground px-3 select-none leading-none flex-1">
            Sessions
          </span>
          <TabsTrigger value="active" className="h-7 px-3 text-sm flex-1">Active ({activeCount})</TabsTrigger>
          <TabsTrigger value="closed" className="h-7 px-3 text-sm flex-1">Closed ({closedCount})</TabsTrigger>
        </TabsList>
        <div className="relative mb-4">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions…"
            className="h-11 text-base px-4 bg-card dark:bg-card pr-10"
            disabled={!currentSessions || currentSessions.length === 0}
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <TabsContent value="active" className="mt-0">
          {renderList()}
        </TabsContent>
        <TabsContent value="closed" className="mt-0">
          {renderList()}
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Footer links
// ---------------------------------------------------------------------------

function FooterButtons() {
  const [mcpUrl, setMcpUrl] = useState('');

  useEffect(() => {
    const envUrl = process.env.NEXT_PUBLIC_MCP_URL;
    setMcpUrl(envUrl ?? window.location.origin + '/api/mcp');
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      toast.success('Copied to clipboard', { description: mcpUrl });
    } catch {
      toast.error("Couldn't copy", {
        description: 'Browser blocked clipboard access',
      });
    }
  }

  return (
    <>
      <Separator className="mt-6 mb-4" />
      <div className="flex items-center justify-between text-sm">
        <a
          href="https://github.com/T5-labs/Project-Merkle"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center text-muted-foreground hover:text-foreground hover:underline transition-colors"
        >
          <GithubIcon className="h-4 w-4 mr-1.5" />GitHub
        </a>
        <button
          type="button"
          onClick={() => void handleCopy()}
          disabled={!mcpUrl}
          className="text-muted-foreground hover:text-foreground hover:underline transition-colors disabled:cursor-not-allowed disabled:hover:text-muted-foreground disabled:hover:no-underline"
        >
          MCP Server
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Themed dot field (reads --card CSS var on theme change)
// ---------------------------------------------------------------------------

function ThemedDotField() {
  const { resolvedTheme } = useTheme();
  const [colors, setColors] = useState<{ from: string; to: string }>({
    from: 'hsla(0 0% 98% / 0.25)',
    to: 'hsla(0 0% 98% / 0.18)',
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const fgHsl = getComputedStyle(document.documentElement)
      .getPropertyValue('--foreground')
      .trim();
    if (fgHsl) {
      setColors({
        from: `hsla(${fgHsl} / 0.25)`,
        to: `hsla(${fgHsl} / 0.18)`,
      });
    }
  }, [resolvedTheme]);

  return <DotFieldBackground gradientFrom={colors.from} gradientTo={colors.to} />;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function HomePage() {
  return (
    <>
      <ThemedDotField />
      <div className="fixed top-4 right-4 z-20">
        <ThemeToggle />
      </div>
      <main className="relative z-10 min-h-screen bg-background/30 backdrop-blur-[1px] flex items-center justify-center">
      <div className="w-full max-w-4xl px-6 py-6">
        {/* Hero */}
        <div className="mb-6 text-center">
          <h1 className="text-6xl font-bold tracking-tight">
            Project Merkle
            <span className="ml-3 text-lg font-mono tabular-nums font-normal align-baseline text-foreground/55">{VERSION}</span>
          </h1>
          <p className="mt-3 text-lg text-muted-foreground">
            Multi-agent session coordination — create sessions, divide tasks, and
            collaborate across teams via MCP.
          </p>
        </div>

        <Separator className="mb-6" />

        {/* Create session form */}
        <CreateSessionForm />

        <Separator className="my-6" />

        {/* Sessions list */}
        <SessionsList />

        {/* Footer */}
        <FooterButtons />
      </div>
    </main>
    </>
  );
}
