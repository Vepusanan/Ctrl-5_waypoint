import { type QueryKey, useQueryClient } from '@tanstack/react-query';
import {
  DASHBOARD_POLL_INTERVAL_MS,
  type DashboardStreamEventType,
  dashboardStreamEventTypeSchema,
} from '@waypoint/shared';
import { useEffect, useRef, useState } from 'react';

// SYSTEM_DESIGN §11.2: the dispatcher hears domain events over SSE and refetches only what they
// change. When the stream is down, the dashboard polls every 15 seconds instead.

export type StreamState = 'live' | 'polling' | 'offline';

/**
 * While the stream is live the dashboard still refreshes once a minute: driver presence is derived
 * from time (no event says "this driver went quiet"), so a stale driver must surface on its own.
 */
const LIVE_REFRESH_MS = 60_000;

export function pollInterval(state: StreamState): number | false {
  if (state === 'offline') return false;
  return state === 'live' ? LIVE_REFRESH_MS : DASHBOARD_POLL_INTERVAL_MS;
}

export const dispatchNotificationsKey = (userId: string) =>
  ['dispatch-notifications', userId] as const;

type Scope = 'planning' | 'trips' | 'dashboard' | 'notifications';

const scopes: Record<DashboardStreamEventType, readonly Scope[]> = {
  'order.submitted': ['planning', 'dashboard'],
  'order.confirmed': ['planning', 'dashboard'],
  'order.cancelled': ['planning', 'dashboard'],
  'order.changed': ['planning', 'dashboard'],
  'order.deferred': ['planning', 'trips', 'dashboard'],
  'plan.published': ['planning', 'trips', 'dashboard'],
  'allocation.changed': ['planning', 'trips', 'dashboard'],
  'trip.changed': ['trips', 'dashboard'],
  'trip.departed': ['trips', 'dashboard'],
  'loading.started': ['trips', 'dashboard'],
  'loading.verified': ['trips', 'dashboard'],
  'loading.issue_recorded': ['trips', 'dashboard', 'notifications'],
  'loading.issue_acknowledged': ['trips', 'dashboard', 'notifications'],
  'loading.ready': ['trips', 'dashboard'],
  'stop.arrived': ['trips', 'dashboard'],
  'stop.delivered': ['trips', 'dashboard'],
  'stop.failed': ['trips', 'dashboard', 'notifications'],
  'stop.pod_recorded': ['trips', 'dashboard'],
  'issue.resolved': ['dashboard', 'notifications'],
  'receipt.confirmed': ['dashboard', 'notifications'],
  'issue.reported': ['dashboard', 'notifications'],
  'sync.conflict': ['trips', 'dashboard', 'notifications'],
};

/** The query keys an event makes stale, so screens refetch only what changed. */
export function invalidationsFor(
  type: DashboardStreamEventType,
  date: string,
  userId: string,
): QueryKey[] {
  return scopes[type].map((scope) => {
    if (scope === 'planning') return ['planning'];
    if (scope === 'trips') return ['trips', date];
    if (scope === 'dashboard') return ['dashboard', date];
    return dispatchNotificationsKey(userId);
  });
}

const ALL_EVENTS = dashboardStreamEventTypeSchema.options;
const BATCH_MS = 250;

/** Opens the dispatcher stream while online and reports whether it is live. */
export function useDashboardStream(date: string, userId: string, online: boolean): StreamState {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);
  const pending = useRef(new Map<string, QueryKey>());

  useEffect(() => {
    if (!online || date.length === 0) {
      setConnected(false);
      return;
    }
    let source: EventSource | null = null;
    let reopen: number | null = null;
    let flush: number | null = null;
    let wasDown = false;

    const invalidate = (keys: readonly QueryKey[]) => {
      for (const key of keys) pending.current.set(JSON.stringify(key), key);
      if (flush !== null) return;
      // A load verification or a sync batch arrives as a burst; refetch once for all of it.
      flush = window.setTimeout(() => {
        flush = null;
        const keys = [...pending.current.values()];
        pending.current.clear();
        for (const queryKey of keys) void client.invalidateQueries({ queryKey });
      }, BATCH_MS);
    };
    const onEvent = (event: Event) => {
      const type = dashboardStreamEventTypeSchema.safeParse(event.type);
      if (type.success) invalidate(invalidationsFor(type.data, date, userId));
    };
    const onReady = () => {
      setConnected(true);
      // Events sent while the stream was down were missed; catch up once.
      if (wasDown) {
        invalidate([
          ['planning'],
          ['trips', date],
          ['dashboard', date],
          dispatchNotificationsKey(userId),
        ]);
      }
      wasDown = false;
    };
    const open = () => {
      source = new EventSource('/api/v1/dashboard/stream', { withCredentials: true });
      source.addEventListener('ready', onReady);
      for (const name of ALL_EVENTS) source.addEventListener(name, onEvent);
      source.onerror = () => {
        setConnected(false);
        wasDown = true;
        // A refused stream (signed out, server error) is closed for good by the browser; a dropped
        // one retries on its own. Either way the dashboard polls until the next "ready".
        if (source?.readyState === EventSource.CLOSED) {
          source = null;
          reopen = window.setTimeout(open, DASHBOARD_POLL_INTERVAL_MS);
        }
      };
    };
    open();
    return () => {
      if (reopen !== null) window.clearTimeout(reopen);
      if (flush !== null) window.clearTimeout(flush);
      source?.close();
      setConnected(false);
    };
  }, [client, date, online, userId]);

  if (!online) return 'offline';
  return connected ? 'live' : 'polling';
}
