import { useMutation, useQuery } from '@tanstack/react-query';
import type { Outlet } from '@waypoint/shared';
import { Link, useParams } from 'react-router-dom';
import { Button, ErrorState, Tag } from '../../components/waypoint';
import { HttpError, message } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import { issueTypeLabel } from '../loader/labels';
import { time } from '../store/shared';
import { cartons, dockLabel } from './labels';
import { loadStop, loadTrip } from './offline/queries';
import type { OutboxEntry } from './offline/types';
import { DriverHeader, DriverIcon, InverseCard, ListRow, Strip, ThumbZone } from './shell';
import { StopSkeleton } from './skeletons';
import { useDriverOutlets } from './trip';
import { useDriver, useStopSync } from './workspace';

const minutes = (clock: string) => {
  const [hours = 0, mins = 0] = clock.split(':').map(Number);
  return hours * 60 + mins;
};

/** Where the ETA falls inside the outlet window, as a percentage of the bar (Figma T2 · Window). */
function windowMarker(eta: string, outlet: Outlet): number {
  const open = minutes(outlet.window.open);
  const close = minutes(outlet.window.close);
  if (close <= open) return 0;
  const at = minutes(time(eta));
  return Math.min(100, Math.max(0, ((at - open) / (close - open)) * 100));
}

/** Arrived after the window, or still expected after it closes. */
function pastWindow(eta: string, outlet: Outlet, late: boolean, pending: boolean): boolean {
  return late || (pending && minutes(time(eta)) > minutes(outlet.window.close));
}

// DR03. Only moves the API allows from the current status are offered: pending → arrived here,
// then the outcome screen (DR04) records delivered with POD or failed with a reason.
export function StopDetail() {
  const { stopId = '' } = useParams();
  const { user, record } = useDriver();
  const stop = useQuery({
    queryKey: queryKeys.driver.stop(user.id, stopId),
    queryFn: () => loadStop(user.id, stopId),
    networkMode: 'always',
  });
  const tripId = stop.data?.tripId ?? '';
  const trip = useQuery({
    queryKey: queryKeys.driver.trip(user.id, tripId),
    queryFn: () => loadTrip(user.id, tripId),
    enabled: tripId !== '',
    networkMode: 'always',
  });
  const outlets = useDriverOutlets(user.id);
  const local = useStopSync(stopId);
  // Recorded on the phone first and sent by the outbox, with or without signal (§8.2).
  const arrive = useMutation({
    mutationFn: () => {
      if (!stop.data) throw new Error('The stop is not loaded yet.');
      return record({ stop: stop.data, type: 'arrived' });
    },
    networkMode: 'always',
  });

  if (stop.isPending) return <StopSkeleton back="/driver" backLabel="My trips" />;
  if (!stop.data) {
    const hidden = stop.error instanceof HttpError && stop.error.status === 404;
    return (
      <ErrorState
        {...(hidden ? { title: 'Stop not available' } : {})}
        description={
          hidden
            ? 'Stops open once your trip has started. Start the trip from its overview first.'
            : message(stop.error)
        }
        onRetry={() => void stop.refetch()}
      />
    );
  }
  const detail = stop.data;
  const outlet = outlets.data?.items.find((item) => item.id === detail.order.outletId);
  const arrival = local.entries.findLast(
    (entry) => entry.type === 'arrived' && entry.status !== 'conflict',
  );
  const ordered = [...(trip.data?.stops ?? [])].sort((left, right) => left.seq - right.seq);
  const next = ordered.find(
    (item) => item.id !== detail.id && (item.status === 'pending' || item.status === 'arrived'),
  );
  const shortfalls = (trip.data?.exceptions ?? []).filter(
    (issue) => issue.orderId === detail.order.id,
  );
  const place = outlet?.district ?? detail.order.outletId;
  const waiting = local.entries.filter(
    (entry) => entry.status === 'queued' || entry.status === 'syncing',
  );
  const refused = local.entries.filter((entry) => entry.status === 'conflict').at(-1);
  const deliveredLocally = waiting.find((entry) => entry.type === 'delivered');

  return (
    <>
      <DriverHeader
        back={`/driver/trips/${detail.tripId}`}
        backLabel="Trip"
        eyebrow={`Stop ${detail.seq}${ordered.length ? ` of ${ordered.length}` : ''} · ${detail.order.outletId}`}
        title={place}
      />

      <InverseCard>
        <div className="driver-window-head">
          <div>
            <span>{detail.status === 'pending' ? 'ETA' : arrival ? 'Arrived' : 'Planned'}</span>
            <strong className="driver-hero-number">
              {time(
                detail.status === 'pending'
                  ? detail.eta
                  : (arrival?.clientTime ?? detail.plannedArrival),
              )}
            </strong>
          </div>
          <div>
            <span>Window</span>
            <strong className="driver-window-value">
              {outlet
                ? `${outlet.window.open}–${outlet.window.close}`
                : `closes ${detail.windowClose}`}
            </strong>
          </div>
        </div>
        {outlet && (
          <div className="driver-window-bar" aria-hidden="true">
            <span
              className={
                pastWindow(detail.eta, outlet, detail.late, detail.status === 'pending')
                  ? 'driver-window-bar--late'
                  : undefined
              }
            />
            <i style={{ left: `${windowMarker(detail.eta, outlet)}%` }} />
          </div>
        )}
      </InverseCard>

      <section className="driver-card driver-list-card" aria-label="Access">
        <ListRow
          icon={<DriverIcon name="nav" size={20} />}
          title={
            outlet
              ? `${dockLabel[outlet.dockType]}${outlet.parkingConstraint === 'van_only' ? ' · van only' : ''}`
              : 'Access'
          }
          detail={
            outlet?.mallWindow
              ? `Mall window ${outlet.mallWindow.open}–${outlet.mallWindow.close}`
              : outlet
                ? `Deliver between ${outlet.window.open} and ${outlet.window.close}`
                : 'Delivery window not cached'
          }
        />
        {/* The API has no outlet contact yet, so the row names the outlet, not an invented person. */}
        <ListRow
          icon={<DriverIcon name="user" size={20} />}
          title={`${detail.order.brand} outlet ${detail.order.outletId}`}
          detail="Hand over to the staff member who signs"
        />
      </section>

      <section className="driver-card driver-items" aria-label="Goods">
        <div className="driver-items-head">
          <strong className="driver-big-number">{detail.order.units}</strong>
          <span className="driver-items-label">
            {detail.order.units === 1 ? 'carton' : 'cartons'} to hand over
          </span>
          <Tag kind={detail.order.temp === 'chilled' ? 'chilled' : 'ambient'} />
        </div>
        {shortfalls.map((issue) => (
          <Strip key={issue.id} tone="warning" icon={<DriverIcon name="info-warning" size={16} />}>
            {cartons(issue.qty)} {issueTypeLabel[issue.type].toLowerCase()} ·{' '}
            {issue.acknowledgedAt ? 'dispatcher informed' : 'waiting for the dispatcher'}
          </Strip>
        ))}
      </section>

      {arrive.error && (
        <div className="driver-banner driver-banner--danger" role="alert">
          <strong>Not saved on this phone</strong>
          <p>{message(arrive.error)}</p>
        </div>
      )}
      {refused && <RefusedBanner entry={refused} />}
      {waiting.length > 0 && (
        <Strip tone="neutral" icon={<DriverIcon name="clock" size={16} />}>
          Saved on this phone at {time(waiting.at(-1)?.clientTime ?? '')}. It syncs automatically
          when there is signal.
        </Strip>
      )}
      {detail.status === 'arrived' && detail.late && (
        <Strip tone="warning" icon={<DriverIcon name="info-warning" size={16} />}>
          Arrived after the delivery window closed.
        </Strip>
      )}
      {detail.status === 'arrived' && detail.pod && (
        <Strip tone="info" icon={<DriverIcon name="info-info" size={16} />}>
          Proof of delivery already saved for {detail.pod.recipientName}. Complete the delivery to
          finish.
        </Strip>
      )}
      {detail.status === 'delivered' && (
        <div className="driver-banner driver-banner--success" role="status">
          <strong>Delivered{detail.late ? ' · late' : ''}</strong>
          {detail.pod ? (
            <p>
              Received by {detail.pod.recipientName} at {time(detail.pod.clientTime)}
              {detail.pod.hasPhoto ? ' · photo attached' : ''}
            </p>
          ) : deliveredLocally?.recipientName ? (
            <p>
              Received by {deliveredLocally.recipientName} at {time(deliveredLocally.clientTime)}
            </p>
          ) : null}
        </div>
      )}
      {detail.status === 'failed' && (
        <div className="driver-banner driver-banner--danger" role="status">
          <strong>Not delivered</strong>
          <p>Reason: {detail.failureReason ?? 'not recorded'}</p>
        </div>
      )}

      <ThumbZone>
        {detail.status === 'pending' && (
          <Button className="driver-cta" busy={arrive.isPending} onClick={() => arrive.mutate()}>
            I've arrived
          </Button>
        )}
        {detail.status === 'arrived' && (
          <Button asChild className="driver-cta">
            <Link to={`/driver/stops/${detail.id}/outcome`}>
              {detail.pod ? 'Complete delivery' : 'Record delivery'}
            </Link>
          </Button>
        )}
        {(detail.status === 'delivered' || detail.status === 'failed') &&
          (next ? (
            <Button asChild className="driver-cta">
              <Link to={`/driver/stops/${next.id}`}>
                Next stop · {next.seq}. {next.order.outletId}
              </Link>
            </Button>
          ) : (
            <Button asChild className="driver-cta">
              <Link to={`/driver/trips/${detail.tripId}`}>Back to trip</Link>
            </Button>
          ))}
      </ThumbZone>
    </>
  );
}

const eventLabel: Record<OutboxEntry['type'], string> = {
  arrived: 'Arrival',
  delivered: 'Delivery',
  failed: 'Failed delivery',
};

/** A refused event stays visible with the server's reason; it is never resolved silently. */
function RefusedBanner({ entry }: { entry: OutboxEntry }) {
  return (
    <div className="driver-banner driver-banner--danger" role="alert">
      <strong>{eventLabel[entry.type]} not accepted</strong>
      <p>{entry.detail ?? 'The server refused this event.'}</p>
      <p>
        <Link to="/driver/sync">Open Sync</Link> for details, or contact the dispatcher.
      </p>
    </div>
  );
}
