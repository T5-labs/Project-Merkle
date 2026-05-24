'use client';

import * as React from 'react';
import { ChevronsUpDown, Check } from 'lucide-react';

import { useAvailableTickets, useSelectedTicket, useSetSelectedTicket } from '@/lib/client/hooks';
import { showErrorToast } from '@/lib/client/error-toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';

interface Props {
  sessionId: string;
}

/**
 * Horizontal ticket-picker strip shown in support sessions.
 *
 * Displays a searchable Combobox (Popover + Command) populated from the
 * agent-pushed ticket list. Tickets are grouped by project, alphabetically
 * sorted within each group. On selection, PATCHes the session's
 * selected_ticket_key via useSetSelectedTicket.
 */
export function SupportTicketPicker({ sessionId }: Props) {
  const [open, setOpen] = React.useState(false);

  const { data: ticketsData, isLoading: ticketsLoading } = useAvailableTickets(sessionId);
  const { data: selectedData } = useSelectedTicket(sessionId);
  const setSelectedTicket = useSetSelectedTicket(sessionId);

  const tickets = ticketsData?.tickets ?? [];
  const selectedKey = selectedData?.key ?? null;

  // Group tickets by project, sort projects and tickets within each group
  const grouped = tickets.reduce<Record<string, typeof tickets>>((acc, ticket) => {
    const proj = ticket.project;
    if (!acc[proj]) acc[proj] = [];
    acc[proj]!.push(ticket);
    return acc;
  }, {});

  const projects = Object.keys(grouped).sort();
  for (const proj of projects) {
    grouped[proj]!.sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }));
  }

  async function handleSelect(value: string) {
    setOpen(false);
    try {
      await setSelectedTicket.mutateAsync({ ticket_key: value === '__none__' ? null : value });
    } catch (err) {
      showErrorToast(
        err instanceof Error ? err.message : 'Failed to update ticket.',
        { title: 'Failed to update ticket' },
      );
    }
  }

  // Label shown on the trigger button
  const triggerLabel = selectedKey ?? 'Select a ticket…';
  const triggerIsPlaceholder = !selectedKey;

  return (
    <div className="flex items-center gap-3">
      <span className="text-sm font-medium shrink-0 text-muted-foreground">Ticket:</span>

      {ticketsLoading ? (
        <span className="text-sm text-muted-foreground italic">
          Waiting for agent to enumerate vault…
        </span>
      ) : tickets.length === 0 ? (
        <span className="text-sm text-muted-foreground italic">
          No tickets available yet — agent needs to refresh the vault.
        </span>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              size="sm"
              disabled={setSelectedTicket.isPending}
              className="max-w-xs justify-between"
            >
              <span className={cn(triggerIsPlaceholder && 'text-muted-foreground italic')}>
                {triggerLabel}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-0">
            <Command>
              <CommandInput placeholder="Search tickets…" />
              <CommandList>
                <CommandEmpty>No tickets match.</CommandEmpty>

                {/* None / clear option */}
                <CommandGroup>
                  <CommandItem
                    value="__none__"
                    onSelect={() => handleSelect('__none__')}
                  >
                    <Check
                      className={cn(
                        'mr-2 h-4 w-4',
                        selectedKey === null ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    <span className="text-muted-foreground italic">None</span>
                  </CommandItem>
                </CommandGroup>

                {/* Per-project groups */}
                {projects.map((project) => (
                  <CommandGroup key={project} heading={project}>
                    {grouped[project]!.map((ticket) => (
                      <CommandItem
                        key={ticket.key}
                        // value drives cmdk filtering — include both project and number
                        // so typing "CMMS" or "5412" both match
                        value={`${ticket.project} ${ticket.number} ${ticket.key}`}
                        onSelect={() => handleSelect(ticket.key)}
                      >
                        <Check
                          className={cn(
                            'mr-2 h-4 w-4',
                            selectedKey === ticket.key ? 'opacity-100' : 'opacity-0',
                          )}
                        />
                        {project}/{ticket.number}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
