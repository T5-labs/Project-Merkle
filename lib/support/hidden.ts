/**
 * Manually-maintained list of vault items hidden from the support feature.
 * Anything in these lists is unreachable: not in the picker, can't be selected,
 * can't be read, can't be appended to — regardless of how an agent queries.
 *
 * Keys/names are matched case-sensitively. Whitespace is not trimmed.
 *
 * Match precedence (in isHidden):
 *   1. hiddenProjects        — exact match on the project key (the part before `/`)
 *   2. hiddenTickets         — exact match on the full `<PROJECT>/<NAME>` key
 *   3. hiddenTicketNames     — exact match on the name (the part after `/`), project-agnostic
 *   4. hiddenTicketNameSuffixes — name ends with one of these strings, project-agnostic
 */

export const hiddenProjects: readonly string[] = [
  'evermont',
];

export const hiddenTickets: readonly string[] = [
  // e.g., 'CMMS/5412',
];

export const hiddenTicketNames: readonly string[] = [
  'Migrations',
];

export const hiddenTicketNameSuffixes: readonly string[] = [
  'Notes',
  'Installation',
  'Support',
];

export function isHidden(ticketKey: string): boolean {
  if (!ticketKey.includes('/')) return false;

  const slash = ticketKey.indexOf('/');
  const project = ticketKey.slice(0, slash);
  const name = ticketKey.slice(slash + 1);

  if (hiddenProjects.includes(project)) return true;
  if (hiddenTickets.includes(ticketKey)) return true;
  if (hiddenTicketNames.includes(name)) return true;
  if (hiddenTicketNameSuffixes.some(suffix => name.endsWith(suffix))) return true;
  return false;
}
