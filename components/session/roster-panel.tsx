'use client';

import { useRouter } from 'next/navigation';
import { useParticipants, useLeaveSession } from '@/lib/client/hooks';
import { getTeamId } from '@/lib/client/team-id';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { LogOut } from 'lucide-react';

interface RosterPanelProps {
  sessionId: string;
}

function StatusDot({ status }: { status: 'active' | 'idle' | 'disconnected' }) {
  return (
    <span
      className={cn(
        'inline-block h-2 w-2 rounded-full shrink-0',
        status === 'active' && 'bg-green-500',
        status === 'idle' && 'bg-yellow-400',
        status === 'disconnected' && 'bg-muted-foreground/40',
      )}
      title={status}
    />
  );
}

export function RosterPanel({ sessionId }: RosterPanelProps) {
  const router = useRouter();
  const myTeamId = getTeamId(sessionId);
  const { data, isLoading, error } = useParticipants(sessionId);
  const leaveSession = useLeaveSession();

  async function handleLeave() {
    if (!myTeamId) return;
    await leaveSession.mutateAsync({ session_id: sessionId, team_id: myTeamId });
    router.push('/');
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-border">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Roster
        </h2>
      </div>

      <ScrollArea className="flex-1 px-2 py-2">
        {isLoading && (
          <p className="text-xs text-muted-foreground px-2 py-1">Loading…</p>
        )}
        {error && (
          <p className="text-xs text-destructive px-2 py-1">
            {error instanceof Error ? error.message : 'Failed to load roster.'}
          </p>
        )}
        {(() => {
          const visibleParticipants = data?.participants.filter(
            (p) => p.status !== 'disconnected',
          );
          return visibleParticipants?.map((p) => {
            const isMe = p.team_id === myTeamId;
            return (
              <div
                key={p.team_id}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                  isMe && 'bg-accent',
                )}
              >
                <StatusDot status={p.status} />
                <span className="flex-1 truncate">{p.team_name}</span>
                {isMe && (
                  <span className="text-xs text-muted-foreground">You</span>
                )}
              </div>
            );
          });
        })()}
        {!isLoading && !error && (data?.participants.filter((p) => p.status !== 'disconnected').length ?? 0) === 0 && (
          <p className="text-xs text-muted-foreground px-2 py-1">
            No active teams in this session.
          </p>
        )}
      </ScrollArea>

      <div className="px-4 py-3 border-t border-border">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={handleLeave}
          disabled={!myTeamId || leaveSession.isPending}
        >
          <LogOut className="h-4 w-4" />
          {leaveSession.isPending ? 'Leaving…' : 'Leave session'}
        </Button>
        {leaveSession.isError && (
          <p className="text-xs text-destructive mt-1">
            {leaveSession.error instanceof Error
              ? leaveSession.error.message
              : 'Failed to leave.'}
          </p>
        )}
      </div>
    </div>
  );
}
