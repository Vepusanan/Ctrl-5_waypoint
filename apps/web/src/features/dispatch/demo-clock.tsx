import { useMutation, useQueryClient } from '@tanstack/react-query';
import { operatingClockSchema, seedResetResponseSchema } from '@waypoint/shared';
import { useState } from 'react';
import { Button } from '../../components/waypoint';
import { api, message } from '../../lib/api';
import { useAuth } from '../auth/auth';
import { clockLabel } from '../store/shared';
import { forgetPlans } from './data/sources/plan';

/** Moves the operating clock (DEMO_MODE, PUT /admin/clock), then reloads every screen. */
export function useMoveClock(onMoved?: () => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (at: string) =>
      api('/admin/clock', operatingClockSchema, {
        method: 'PUT',
        body: JSON.stringify({ now: at }),
      }),
    onSuccess: async () => {
      onMoved?.();
      // Every screen reads the operating clock, so refetch everything.
      forgetPlans();
      await client.invalidateQueries();
    },
  });
}

// DEMO_MODE only (GET/PUT /admin/clock). Jumps the operating clock to the walkthrough's
// moments around the selected run: before and after the 4 PM cutoff that closes it, and the
// service-day morning when Fresh trips leave (03:30, SYSTEM_DESIGN §7.3). Reset restores the
// deterministic seed (POST /admin/reset) and ends every session, so it asks twice.
export function DemoClock({
  now,
  date,
  dates,
  onMoved,
}: {
  now: string;
  date: string;
  dates: readonly string[];
  onMoved: () => void;
}) {
  const { logout } = useAuth();
  const cutoffDay = dates.filter((day) => day < date).at(-1);
  const presets = [
    ...(cutoffDay
      ? [
          { label: 'Before cutoff', at: `${cutoffDay}T15:50:00.000+05:30` },
          { label: 'After cutoff', at: `${cutoffDay}T16:01:00.000+05:30` },
        ]
      : []),
    { label: 'Service morning', at: `${date}T03:30:00.000+05:30` },
  ];
  const [confirming, setConfirming] = useState(false);
  const reset = useMutation({
    mutationFn: () =>
      api('/admin/reset', seedResetResponseSchema, {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      }),
    // The API clears the session cookie as part of the reset; sign in again on the fresh seed.
    onSuccess: () => logout(),
  });
  const move = useMoveClock(onMoved);
  return (
    <section className="dispatch-demo-clock" aria-label="Demo clock">
      <strong>Demo clock</strong>
      <p className="wp-muted">Demo mode only. {clockLabel(Date.parse(now))}</p>
      {presets.map((preset) => (
        <Button
          key={preset.label}
          variant="secondary"
          busy={move.isPending && move.variables === preset.at}
          disabled={move.isPending || preset.at === now}
          onClick={() => move.mutate(preset.at)}
        >
          {preset.label}
        </Button>
      ))}
      {move.error && <p role="alert">{message(move.error)}</p>}
      {confirming ? (
        <div className="dispatch-demo-reset">
          <p>
            Reset all demo data? Orders, plans, loads and deliveries return to the seed and everyone
            is signed out.
          </p>
          <Button busy={reset.isPending} onClick={() => reset.mutate()}>
            Reset demo
          </Button>
          <Button
            variant="tertiary"
            disabled={reset.isPending}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="tertiary" onClick={() => setConfirming(true)}>
          Reset demo data
        </Button>
      )}
      {reset.error && <p role="alert">{message(reset.error)}</p>}
    </section>
  );
}
