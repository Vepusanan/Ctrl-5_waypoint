import { useMutation, useQueryClient } from '@tanstack/react-query';
import { loadingStateSchema, type TripDetail } from '@waypoint/shared';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, StatusBadge, Tag } from '../../components/waypoint';
import { api, HttpError, message } from '../../lib/api';
import { time } from '../store/shared';
import { firstArrival, loadingBadge, tripName, unitsOf } from './labels';
import { DarkTile, LoaderIcon, PageHead, RefreshButton, Seq, StateCard } from './shell';
import { AssignedSkeleton } from './skeletons';
import { byRun, loaderKey, TO_LOAD, useLoader, useLoaderTrips } from './workspace';

const RECENT_DEPARTURES = 6;

// L01. The next load is the hero; the rest of the queue and recent departures sit on the right.
export function AssignedLoads() {
  const { user, online } = useLoader();
  const navigate = useNavigate();
  const client = useQueryClient();
  const trips = useLoaderTrips();
  // A press on Refresh shows as busy; the 30 s background poll does not.
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    void trips.refetch().finally(() => setRefreshing(false));
  };
  // Starting records this loader against the vehicle, with the version the loader saw.
  const start = useMutation({
    mutationFn: async (trip: TripDetail) => {
      const state = await api(`/trips/${trip.id}/loading`, loadingStateSchema);
      return api(`/trips/${trip.id}/loading/start`, loadingStateSchema, {
        method: 'POST',
        headers: { 'If-Match': String(state.tripVersion) },
      });
    },
    onSuccess: (state) => navigate(`/loader/trips/${state.tripId}`),
    onSettled: () => client.invalidateQueries({ queryKey: loaderKey(user.id) }),
  });

  const loading = trips.isPending;
  const failed = !loading && !trips.data;
  const published = (trips.data?.items ?? []).filter((trip) => trip.run.status === 'published');
  const toLoad = published.filter((trip) => TO_LOAD.includes(trip.status)).sort(byRun);
  const departed = published
    .filter((trip) => trip.status === 'departed' || trip.status === 'completed')
    .sort(byRun)
    .reverse()
    .slice(0, RECENT_DEPARTURES);
  const [next, ...queue] = toLoad;
  const first = next ? firstArrival(next.stops) : null;
  const updated = trips.dataUpdatedAt
    ? ` · last updated ${time(new Date(trips.dataUpdatedAt).toISOString())}`
    : '';
  // The footnote names the state the list is in, as each Figma state frame does (G02–G05).
  const detail = loading
    ? 'refreshing…'
    : trips.isError
      ? `couldn’t refresh${updated}`
      : !next
        ? 'nothing waiting'
        : `${toLoad.length} ${toLoad.length === 1 ? 'load' : 'loads'} · load last stop first`;

  return (
    <>
      <PageHead
        title="Assigned loads"
        detail={`${user.depotId} · ${detail}`}
        status={<RefreshButton busy={loading || refreshing} onClick={refresh} />}
      />
      {start.error && (
        <div className="loader-banner loader-banner--danger" role="alert">
          <strong>Loading not started</strong>
          <p>
            {start.error instanceof HttpError && start.error.code === 'VERSION_CONFLICT'
              ? 'The trip changed since you opened it. The latest version is shown; try again.'
              : message(start.error)}
          </p>
        </div>
      )}
      {loading ? (
        <AssignedSkeleton />
      ) : failed ? (
        <StateCard
          tone="danger"
          icon={<LoaderIcon name="wifi-off-danger" size={30} />}
          title="Couldn’t load your assigned loads"
          description={message(trips.error)}
        >
          <Button
            variant="secondary"
            className="loader-cta"
            busy={trips.isFetching}
            onClick={refresh}
          >
            Retry
          </Button>
        </StateCard>
      ) : !next ? (
        <StateCard
          icon={<LoaderIcon name="truck-empty" size={30} />}
          title="No loads currently awaiting action"
          description={`No plan for ${user.depotId} is published yet. Loads appear here, without a reload, as soon as the dispatcher publishes one in Review & publish.`}
        >
          <Button variant="secondary" className="loader-cta" busy={refreshing} onClick={refresh}>
            Refresh
          </Button>
        </StateCard>
      ) : (
        <div className="loader-split">
          <NextLoad
            trip={next}
            busy={start.isPending}
            online={online}
            onStart={() => start.mutate(next)}
          />
          <div className="loader-side">
            <DarkTile
              title="First stop at"
              icon={<LoaderIcon name="clock-inverse" size={16} />}
              value={time(first)}
              detail={tripName(next)}
            />
            {[...queue, ...departed].map((trip) => (
              <QueueCard key={trip.id} trip={trip} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function NextLoad({
  trip,
  busy,
  online,
  onStart,
}: {
  trip: TripDetail;
  busy: boolean;
  online: boolean;
  onStart: () => void;
}) {
  const reversed = [...trip.stops].sort((left, right) => right.seq - left.seq);
  const open = trip.exceptions.filter((issue) => issue.acknowledgedAt === null).length;
  const canStart = trip.loadingStatus === 'not_started' && trip.status === 'published';
  return (
    <section className="loader-card loader-next" aria-label="Next load">
      <div className="loader-next-head">
        <span className="loader-well loader-well--large">
          <LoaderIcon name="truck-large" size={22} />
        </span>
        <div className="loader-next-title">
          <h2>{tripName(trip)}</h2>
          <p>
            {trip.brand} · {trip.district}
          </p>
        </div>
        <div className="loader-tags">
          <Tag kind={trip.vehicle.temp === 'reefer' ? 'reefer' : 'dry-box'} />
          {trip.vehicle.type === 'van' && <Tag kind="van" />}
          {trip.status === 'blocked' ? (
            <StatusBadge status="blocked" />
          ) : (
            <StatusBadge status={loadingBadge[trip.loadingStatus]} />
          )}
        </div>
      </div>
      <dl className="loader-numbers">
        <div>
          <dt>units</dt>
          <dd>{unitsOf(trip.stops)}</dd>
        </div>
        <div>
          <dt>{trip.stops.length === 1 ? 'stop' : 'stops'}</dt>
          <dd>{trip.stops.length}</dd>
        </div>
        <div>
          <dt>first stop</dt>
          <dd>{time(firstArrival(trip.stops))}</dd>
        </div>
      </dl>
      <h3 className="loader-label">Load order</h3>
      <ol className="loader-order">
        {reversed.map((stop, index) => (
          <li key={stop.id} className={index === 0 ? 'loader-order--first' : undefined}>
            <span className="loader-order-name">
              <Seq value={stop.seq} />
              {stop.order.outletId}
            </span>
            <span>
              {stop.order.units} {stop.order.units === 1 ? 'unit' : 'units'}
              {index === 0 ? ' · load first' : ''}
            </span>
          </li>
        ))}
      </ol>
      {open > 0 && <Tag kind="risk">{open} shortfall awaiting dispatcher</Tag>}
      <div className="loader-next-actions">
        {canStart ? (
          <Button className="loader-cta" busy={busy} disabled={!online} onClick={onStart}>
            Start loading
          </Button>
        ) : (
          <Button asChild className="loader-cta">
            <Link to={`/loader/trips/${trip.id}`}>
              {trip.loadingStatus === 'ready' ? 'Hand over' : 'Continue loading'}
            </Link>
          </Button>
        )}
        <Button asChild variant="secondary" className="loader-cta">
          <Link to={`/loader/trips/${trip.id}`}>View plan</Link>
        </Button>
      </div>
    </section>
  );
}

function QueueCard({ trip }: { trip: TripDetail }) {
  const departed = trip.status === 'departed' || trip.status === 'completed';
  return (
    <Link className="loader-card loader-queue" to={`/loader/trips/${trip.id}`}>
      <div className="loader-queue-row">
        <span className="loader-well">
          <LoaderIcon name="truck" size={20} />
        </span>
        <div className="loader-queue-text">
          <strong>{tripName(trip)}</strong>
          <span>
            {time(firstArrival(trip.stops))} · {unitsOf(trip.stops)} units
          </span>
        </div>
        <LoaderIcon name="chevron-right" size={20} />
      </div>
      {trip.status === 'blocked' ? (
        <StatusBadge status="blocked" />
      ) : departed ? (
        <StatusBadge status="departed" />
      ) : (
        <StatusBadge status={loadingBadge[trip.loadingStatus]} />
      )}
    </Link>
  );
}
