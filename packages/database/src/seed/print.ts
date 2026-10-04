import { DEMO_USERS } from './constants.ts';
import type { SeedResult } from './run.ts';

export function formatSeedReport(result: SeedResult): string {
  const lines = [
    result.applied
      ? 'Waypoint demo seed applied.'
      : 'Waypoint demo seed already present. No rows changed.',
    `Demo date: ${result.serviceDate}`,
    `Source: ${result.source}`,
    '',
  ];
  const primary = new Set<string>(Object.values(DEMO_USERS).map((user) => user.email));
  for (const account of result.accounts.filter((row) => primary.has(row.email))) {
    lines.push(`${account.role.padEnd(14)} ${account.email}  ${account.scope}`);
  }
  const fleet = result.accounts.filter((row) => !primary.has(row.email));
  if (fleet.length > 0) {
    lines.push(
      `driver         driver.<vehicle id>@waypoint.test  one per depot vehicle (${fleet.length} more)`,
    );
  }
  lines.push('', `Password: ${result.password}`);
  if (!result.applied) {
    lines.push('Password hashes were kept from the first seed.');
  }
  return lines.join('\n');
}
