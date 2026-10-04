import { useQuery } from '@tanstack/react-query';
import type { DeliveryStop, TripDetail, User } from '@waypoint/shared';
import { createContext, useContext, useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ErrorState, LoadingState } from '../../components/waypoint';
import { message } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import { useOnline } from '../store/shared';
import { DriverAccount } from './account';
import { colomboTimestamp, useDriverClock } from './clock';
import { SyncConflict } from './conflict';
import { NoticeDetail, Notices } from './notices';
import { type SyncState, useSyncEngine } from './offline/engine';
import { loadTrips } from './offline/queries';
import { enqueue, stopEntries } from './offline/store';
import { localStopStatus } from './offline/sync-core';
import type { OutboxEntry, PodBlob } from './offline/types';
import { StopOutcome } from './outcome';
import { StopSaved } from './saved';
import { DriverTabBar, OFFLINE_ICON, OfflineBar, SyncingBar } from './shell';
import { StopDetail } from './stop';
import { DriverSync } from './sync';
import { TripOverview } from './trip';
import { MyTrips } from './trips';
import './driver.css';

type Driver = Extract<User, { role: 'driver' }>;

/** One stop outcome as the driver records it, before it reaches the server. */
export type StopAction =
  | { stop: DeliveryStop; type: 'arrived' }
  | { stop: DeliveryStop; type: 'failed'; reason: string }
  | { stop: DeliveryStop; type: 'delivered'; podId: string }
  | {
      stop: DeliveryStop;
      type: 'delivered';
      pod: { recipientName: string; signature: Blob; photo?: Blob };
    };

interface DriverContextValue {
  user: Driver;
  online: boolean;
  /** The operating-clock time now, as an ISO timestamp with +05:30. */
  stamp: () => string;
  /** A device time (ms) on the operating clock, for times the phone itself keeps. */
  clockAt: (deviceMs: number) => string;
  /**
   * Records a stop outcome locally first (SYSTEM_DESIGN §8.2): IndexedDB, then the screens,
   * then the outbox sends it with its own client event id. Online and offline take this path.
   */
  record: (action: StopAction) => Promise<void>;
  sync: SyncState;
  /** The trip the driver is on (or about to start), as last read; null before the first read. */
  route: { tripId: string; version: number } | null;
}

/** Done on the server, or departed with every stop recorded on this phone but not synced yet. */
export function tripFinished(trip: TripDetail): boolean {
  if (trip.status === 'completed') return true;
  return (
    trip.status === 'departed' &&
    trip.stops.every((stop) => stop.status === 'delivered' || stop.status === 'failed')
  );
}

/** The first unfinished trip of a published run, in service order (the DR01 hero trip). */
function currentTrip(trips: readonly TripDetail[]): TripDetail | undefined {
  return trips
    .filter((trip) => trip.run.status === 'published')
    .sort(
      (left, right) =>
        left.run.serviceDate.localeCompare(right.run.serviceDate) || left.tripNo - right.tripNo,
    )
    .find((trip) => !tripFinished(trip));
}

const DriverContext = createContext<DriverContextValue | null>(null);

export function useDriver() {
  const value = useContext(DriverContext);
  if (!value) throw new Error('Driver workspace required');
  return value;
}

/** Whether this stop has events still on the phone, and whether the server refused one. */
export function useStopSync(stopId: string) {
  const { sync } = useDriver();
  const entries = sync.entries.filter((entry) => entry.stopId === stopId);
  const local = localStopStatus('pending', entries);
  return { entries, pending: local.pending, conflict: local.conflict };
}

export function DriverWorkspaceApp({ user }: { user: Driver }) {
  return <DriverLayout user={user} />;
}

function DriverLayout({ user }: { user: Driver }) {
  const online = useOnline();
  const location = useLocation();
  const clock = useDriverClock(user.id);
  const sync = useSyncEngine(user.id, online);
  // The same query as My trips: it names the saved route version in the offline bar.
  const trips = useQuery({
    queryKey: queryKeys.driver.trips(user.id),
    queryFn: () => loadTrips(user.id),
    networkMode: 'always',
    staleTime: 30_000,
  });
  // Fetch the offline bar's icon while online; once the connection drops it cannot be loaded.
  const offlineIcon = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const image = new Image();
    image.src = OFFLINE_ICON;
    offlineIcon.current = image;
  }, []);
  if (clock.isPending) {
    return (
      <div className="driver-app driver-app--focus">
        <main className="driver-main">
          <LoadingState label="Checking the operating clock…" />
        </main>
      </div>
    );
  }
  if (!clock.ready) {
    return (
      <div className="driver-app driver-app--focus">
        <main className="driver-main">
          <ErrorState description={message(clock.error)} onRetry={() => void clock.refetch()} />
        </main>
      </div>
    );
  }
  const offset = clock.offset;
  const clockAt = (deviceMs: number) => colomboTimestamp(deviceMs + offset);
  const stamp = () => clockAt(Date.now());
  const lastSync = sync.lastSyncAt === null ? null : clockAt(sync.lastSyncAt);
  const record = async (action: StopAction) => {
    const { stop } = action;
    // A second tap on the same outcome while the first is still on the phone is the same action.
    const earlier = await stopEntries(user.id, stop.id);
    if (earlier.some((entry) => entry.type === action.type && entry.status !== 'conflict')) return;
    const clientTime = stamp();
    const entry: OutboxEntry = {
      clientEventId: newEventId(),
      userId: user.id,
      tripId: stop.tripId,
      stopId: stop.id,
      outletId: stop.order.outletId,
      type: action.type,
      clientTime,
      tripVersion: stop.tripVersion,
      status: 'queued',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: Date.now(),
    };
    let pod: PodBlob | undefined;
    if (action.type === 'failed') entry.reason = action.reason;
    if (action.type === 'delivered' && 'podId' in action) entry.podId = action.podId;
    if (action.type === 'delivered' && 'pod' in action) {
      pod = {
        id: newEventId(),
        userId: user.id,
        stopId: stop.id,
        recipientName: action.pod.recipientName,
        clientTime,
        signature: action.pod.signature,
        ...(action.pod.photo ? { photo: action.pod.photo } : {}),
      };
      entry.blobId = pod.id;
      entry.recipientName = action.pod.recipientName;
    }
    await enqueue(entry, pod);
    void sync.syncNow();
  };
  const onTrip = currentTrip(trips.data?.items ?? []);
  const route = onTrip ? { tripId: onTrip.id, version: onTrip.version } : null;
  // Stop and outcome screens are focus screens without the tab bar (Figma DR03, DR04, DR04a, DR05a).
  const focus = location.pathname.startsWith('/driver/stops/');
  return (
    <DriverContext.Provider value={{ user, online, stamp, clockAt, record, sync, route }}>
      <div className={`driver-app${focus ? ' driver-app--focus' : ''}`}>
        <a href="#main-content" className="wp-skip">
          Skip to content
        </a>
        <main className="driver-main" id="main-content" tabIndex={-1}>
          {!online && (
            <OfflineBar
              pending={sync.pending}
              lastSyncAt={lastSync}
              routeVersion={route?.version ?? null}
            />
          )}
          {online && sync.pending + sync.conflicts > 0 && (
            <SyncingBar pending={sync.pending} conflicts={sync.conflicts} />
          )}
          <Routes>
            <Route path="/" element={<MyTrips />} />
            <Route path="trips/:tripId" element={<TripOverview />} />
            <Route path="stops/:stopId" element={<StopDetail />} />
            <Route path="stops/:stopId/outcome" element={<StopOutcome />} />
            <Route path="stops/:stopId/saved" element={<StopSaved />} />
            <Route path="notices" element={<Notices />} />
            <Route path="notices/:noticeId" element={<NoticeDetail />} />
            <Route path="sync" element={<DriverSync />} />
            <Route path="sync/conflicts/:eventId" element={<SyncConflict />} />
            <Route path="account" element={<DriverAccount />} />
            <Route path="*" element={<Navigate to="/driver" replace />} />
          </Routes>
        </main>
        {!focus && <DriverTabBar pathname={location.pathname} pending={sync.pending} />}
      </div>
    </DriverContext.Provider>
  );
}

// crypto.randomUUID needs a secure context; a phone on plain HTTP over the LAN is not one.
function newEventId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
