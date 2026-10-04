import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type CreateLoadingIssueRequest,
  type LoadingState,
  type LoadingStop,
  loadingStateSchema,
  type Outlet,
  outletListResponseSchema,
  type TripDetail,
  tripDetailSchema,
} from '@waypoint/shared';
import { useState } from 'react';
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { Button, StatusBadge, Tag } from '../../components/waypoint';
import { api, HttpError, message } from '../../lib/api';
import { orderName, time } from '../store/shared';
import { firstArrival, loadingBadge, tripName, unitsOf } from './labels';
import {
  ActionBar,
  LoaderIcon,
  PageHead,
  ProgressRing,
  Seq,
  SharedIcon,
  StateCard,
  Stepper,
} from './shell';
import { ShortfallForm } from './shortfall';
import { LoadPlanSkeleton } from './skeletons';
import { Deciding, Handover, PlanChanged } from './states';
import { loaderKey, useLoader, useLoaderTrips } from './workspace';

/** Everything one trip's screens share: the API state, the loader's counts and the actions. */
export interface LoadFlow {
  base: string;
  detail: TripDetail;
  state: LoadingState;
  outletById: ReadonlyMap<string, Outlet>;
  /** Load order: last stop first, so goods come off the vehicle in delivery order. */
  reversed: LoadingStop[];
  counted: (stop: LoadingStop) => number;
  /** Units already reported short for the stop's order; they will not be loaded. */
  reported: (stop: LoadingStop) => number;
  /** Counted plus reported short covers the order. */
  complete: (stop: LoadingStop) => boolean;
  setCount: (stop: LoadingStop, count: number) => void;
  loaded: number;
  total: number;
  allLoaded: boolean;
  open: number;
  busy: boolean;
  /** The last action was refused or did not reach the server; the next tap is a retry. */
  failed: boolean;
  online: boolean;
  start: () => void;
  /** Records verification (and acceptance of a changed plan) against the current trip version. */
  verify: (onDone?: () => void) => void;
  ready: () => void;
  depart: () => void;
  report: (issue: CreateLoadingIssueRequest, onSent: () => void) => void;
}

// L02–L06 for one trip. The API enforces every rule (start, shortfall gate, plan version, ready,
// departure); these screens only explain them and send what the loader decides.
export function LoadDetail() {
  const { tripId = '' } = useParams();
  const { user } = useLoader();
  const trips = useLoaderTrips();
  const key = [...loaderKey(user.id), 'trip', tripId] as const;
  const trip = useQuery({
    queryKey: [...key, 'detail'],
    queryFn: () => api(`/trips/${tripId}`, tripDetailSchema),
  });
  const loading = useQuery({
    queryKey: [...key, 'loading'],
    queryFn: () => api(`/trips/${tripId}/loading`, loadingStateSchema),
    // Shortfalls wait on the dispatcher, so poll faster while one is open.
    refetchInterval: (query) => (query.state.data?.status === 'exception' ? 10_000 : 30_000),
  });
  const outlets = useQuery({
    queryKey: [...loaderKey(user.id), 'outlets'],
    queryFn: () => api('/outlets', outletListResponseSchema),
    staleTime: 5 * 60_000,
  });

  // The trip list is already loaded for the app bar, so the heading can be real while we wait.
  const listed = trips.data?.items.find((item) => item.id === tripId);
  if (trip.isPending || loading.isPending) {
    return <LoadPlanSkeleton {...(listed ? { title: tripName(listed) } : {})} />;
  }
  if (!trip.data || !loading.data) {
    return (
      <>
        <PageHead
          back="/loader"
          backLabel="Assigned loads"
          title={listed ? tripName(listed) : 'Load plan'}
          detail="couldn’t refresh"
        />
        <StateCard
          tone="danger"
          icon={<LoaderIcon name="wifi-off-danger" size={30} />}
          title="Couldn’t load this load plan"
          description={message(trip.error ?? loading.error)}
        >
          <Button
            variant="secondary"
            className="loader-cta"
            busy={trip.isFetching || loading.isFetching}
            onClick={() => {
              void trip.refetch();
              void loading.refetch();
            }}
          >
            Retry
          </Button>
        </StateCard>
      </>
    );
  }
  // Unsaved taps are dropped when the trip version changes. Counts already saved stay with their
  // orders, and verification checks them against the new plan.
  return (
    <Flow
      key={`${tripId}:${loading.data.tripVersion}`}
      detail={trip.data}
      state={loading.data}
      outlets={outlets.data?.items ?? []}
    />
  );
}

function Flow({
  detail,
  state,
  outlets,
}: {
  detail: TripDetail;
  state: LoadingState;
  outlets: readonly Outlet[];
}) {
  const { user, online } = useLoader();
  const client = useQueryClient();
  // Figma G15: a failed send on the shortfall form keeps the entries and offers Retry.
  const sending = useLocation().pathname.endsWith('/shortfall');
  const [counts, setCounts] = useState<ReadonlyMap<string, number>>(new Map());
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: loaderKey(user.id) });
  };
  const action = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: refresh,
    onError: (cause) => {
      // A stale version means someone else changed the trip: show the current state.
      if (cause instanceof HttpError && cause.code === 'VERSION_CONFLICT') void refresh();
    },
  });
  const tripId = detail.id;
  const saveCount = useMutation({
    mutationFn: ({ stop, units }: { stop: LoadingStop; units: number }) =>
      api(`/trips/${detail.id}/loading/counts`, loadingStateSchema, {
        method: 'PUT',
        body: JSON.stringify({ orderId: stop.order.id, units }),
      }),
    // A count the server refused is dropped, and the screen returns to what is saved.
    onError: (_cause, { stop }) => {
      setCounts((current) => {
        const next = new Map(current);
        next.delete(stop.id);
        return next;
      });
      void refresh();
    },
  });
  const ifMatch = { 'If-Match': String(state.tripVersion) };
  const post = (path: string, onDone?: () => void) =>
    action.mutate(
      () => api(path, loadingStateSchema, { method: 'POST', headers: ifMatch }),
      onDone ? { onSuccess: onDone } : undefined,
    );
  const reversed = [...state.stops].sort((left, right) => right.seq - left.seq);
  const loadedAll = state.status === 'ready' || state.status === 'departed';
  // The server keeps the count, so a refresh, another tablet or the next loader sees it. The
  // local value only covers the moment between a tap and the server's answer.
  const counted = (stop: LoadingStop) =>
    loadedAll
      ? stop.loadedUnits || stop.order.units
      : Math.min(stop.order.units, counts.get(stop.id) ?? stop.loadedUnits);
  const reported = (stop: LoadingStop) =>
    state.issues
      .filter((issue) => issue.orderId === stop.order.id)
      .reduce((sum, issue) => sum + issue.qty, 0);
  const complete = (stop: LoadingStop) => counted(stop) + reported(stop) >= stop.order.units;
  const loaded = reversed.reduce((total, stop) => total + counted(stop), 0);
  const total = unitsOf(state.stops);

  const flow: LoadFlow = {
    base: `/loader/trips/${tripId}`,
    detail,
    state,
    outletById: new Map(outlets.map((outlet) => [outlet.id, outlet])),
    reversed,
    counted,
    reported,
    complete,
    setCount: (stop, count) => {
      const units = Math.max(0, Math.min(stop.order.units, count));
      setCounts((current) => new Map(current).set(stop.id, units));
      saveCount.mutate({ stop, units });
    },
    loaded,
    total,
    allLoaded: reversed.every(complete),
    open: state.issues.filter((issue) => issue.acknowledgedAt === null).length,
    busy: action.isPending,
    failed: action.isError,
    online,
    start: () => post(`/trips/${tripId}/loading/start`),
    verify: (onDone) => post(`/trips/${tripId}/loading/verify`, onDone),
    ready: () => post(`/trips/${tripId}/loading/ready`),
    depart: () =>
      action.mutate(() =>
        api(`/trips/${tripId}/depart`, tripDetailSchema, { method: 'POST', headers: ifMatch }),
      ),
    report: (issue, onSent) =>
      action.mutate(
        () =>
          api(`/trips/${tripId}/loading/issues`, loadingStateSchema, {
            method: 'POST',
            headers: ifMatch,
            body: JSON.stringify(issue),
          }),
        { onSuccess: onSent },
      ),
  };
  const loadingOpen = state.status === 'in_progress' || state.status === 'exception';
  const canCount = loadingOpen && !state.planStale && detail.status !== 'blocked';

  return (
    <>
      {!online && (
        <div className="loader-banner" role="status">
          <strong>Offline</strong>
          <p>Reconnect to record loading. Nothing is saved while offline.</p>
        </div>
      )}
      {action.error && (
        <div className="loader-banner loader-banner--danger" role="alert">
          <strong>{sending ? 'Couldn’t send the shortfall' : 'Not saved'}</strong>
          <p>
            {message(action.error)}
            {sending ? ' Your entries are kept — tap Retry.' : ''}
          </p>
        </div>
      )}
      {detail.status === 'blocked' && (
        <div className="loader-banner loader-banner--danger" role="alert">
          <strong>Trip blocked</strong>
          <p>The vehicle is unavailable for this trip. Wait for the dispatcher to replan it.</p>
        </div>
      )}
      <Routes>
        <Route
          index
          element={
            // Departure itself moves the trip version, so a departed trip is never "changed".
            state.status === 'departed' ? (
              <Handover flow={flow} />
            ) : state.planStale ? (
              <PlanChanged flow={flow} />
            ) : flow.open > 0 ? (
              <Deciding flow={flow} />
            ) : loadedAll ? (
              <Handover flow={flow} />
            ) : (
              <LoadingPlan flow={flow} interactive={canCount} />
            )
          }
        />
        <Route
          path="verify"
          element={canCount ? <Verify flow={flow} /> : <Navigate to={flow.base} replace />}
        />
        <Route
          path="shortfall"
          element={canCount ? <ShortfallForm flow={flow} /> : <Navigate to={flow.base} replace />}
        />
        <Route
          path="ready"
          element={canCount ? <Handover flow={flow} /> : <Navigate to={flow.base} replace />}
        />
        <Route path="*" element={<Navigate to={flow.base} replace />} />
      </Routes>
    </>
  );
}

// L02. Count each stop in load order; the API keeps only the shortfalls, ready and departure.
function LoadingPlan({ flow, interactive }: { flow: LoadFlow; interactive: boolean }) {
  const { detail, state, reversed, counted, complete, setCount } = flow;
  const firstOpen = reversed.find((stop) => !complete(stop));
  const [selectedId, setSelectedId] = useState(firstOpen?.id ?? reversed[0]?.id);
  const selected = reversed.find((stop) => stop.id === selectedId) ?? reversed[0];
  const nextOpen = reversed.find((stop) => stop.id !== selected?.id && !complete(stop));
  const lastStop = [...reversed].sort((left, right) => left.seq - right.seq)[0];
  const navigate = useNavigate();
  const notStarted = state.status === 'not_started' && detail.status === 'published';

  return (
    <>
      <PageHead
        leading={
          <ProgressRing
            value={flow.loaded}
            total={flow.total}
            label={`${flow.loaded} of ${flow.total} units loaded`}
          />
        }
        title={tripName(detail)}
        detail={`${flow.loaded} of ${flow.total} units · first stop ${time(firstArrival(state.stops))} · plan v${state.planVersion}`}
        status={<StatusBadge status={loadingBadge[state.status]} />}
      />
      <div className="loader-columns">
        <div className="loader-stops">
          {reversed.map((stop) => {
            const count = counted(stop);
            const done = complete(stop);
            const current = stop.id === selected?.id;
            return (
              <button
                key={stop.id}
                type="button"
                className={`loader-card loader-stop${current ? ' loader-stop--current' : ''}`}
                aria-pressed={current}
                onClick={() => setSelectedId(stop.id)}
              >
                <span className="loader-stop-name">
                  {done ? (
                    <span className="loader-done">
                      <LoaderIcon name="check" size={18} />
                    </span>
                  ) : (
                    <Seq value={stop.seq} />
                  )}
                  {stop.order.outletId}
                </span>
                <span className={done ? 'loader-ok' : undefined}>
                  {count} / {stop.order.units} units
                </span>
              </button>
            );
          })}
          {lastStop && reversed.length > 1 && (
            <p className="loader-note">
              <LoaderIcon name="info" size={16} />
              {lastStop.order.outletId} is unloaded first, so it goes in last.
            </p>
          )}
        </div>
        {selected && (
          <section className="loader-card loader-lines" aria-label={`Stop ${selected.seq}`}>
            <div className="loader-lines-head">
              <h2>
                {selected.order.outletId} · stop {selected.seq}
              </h2>
              <div className="loader-tags">
                {selected.access === 'van_only' && <Tag kind="van-only" />}
                {selected.access === 'mall_dock' && <Tag kind="mall-window" />}
              </div>
            </div>
            <LineRow
              stop={selected}
              outlet={flow.outletById.get(selected.order.outletId)}
              count={counted(selected)}
              reported={flow.reported(selected)}
              interactive={interactive}
              onCount={(count) => setCount(selected, count)}
            />
          </section>
        )}
      </div>
      <ActionBar
        status={
          <>
            <p>
              {flow.loaded} of {flow.total} units
            </p>
            <div
              className="loader-bar"
              role="progressbar"
              aria-label="Units loaded"
              aria-valuemin={0}
              aria-valuemax={flow.total}
              aria-valuenow={flow.loaded}
            >
              <span style={{ width: `${flow.total ? (flow.loaded / flow.total) * 100 : 0}%` }} />
            </div>
          </>
        }
      >
        {notStarted && (
          <Button
            className="loader-cta"
            busy={flow.busy}
            disabled={!flow.online}
            onClick={flow.start}
          >
            Start loading
          </Button>
        )}
        {interactive && (
          <>
            <Button asChild variant="secondary" className="loader-cta">
              <Link to={`${flow.base}/shortfall`}>Report shortfall</Link>
            </Button>
            {nextOpen ? (
              <Button className="loader-cta" onClick={() => setSelectedId(nextOpen.id)}>
                Next stop · {nextOpen.order.outletId}
              </Button>
            ) : (
              <Button className="loader-cta" onClick={() => navigate(`${flow.base}/verify`)}>
                Verify load
              </Button>
            )}
          </>
        )}
      </ActionBar>
    </>
  );
}

/** One order line (Figma lines table). The API has one order per stop, so one line per stop. */
function LineRow({
  stop,
  outlet,
  count,
  reported,
  interactive,
  onCount,
}: {
  stop: LoadingStop;
  outlet: Outlet | undefined;
  count: number;
  reported: number;
  interactive: boolean;
  onCount: (count: number) => void;
}) {
  const done = count + reported >= stop.order.units;
  return (
    <div className="loader-line">
      <button
        type="button"
        className={`loader-line-check${done ? ' loader-line-check--done' : ''}`}
        aria-label={done ? 'Loaded' : `Mark all ${stop.order.units} units loaded`}
        disabled={!interactive}
        onClick={() => onCount(stop.order.units - reported)}
      >
        {done && <LoaderIcon name="check-large" size={22} />}
      </button>
      <div className="loader-line-text">
        <strong>
          {stop.order.units} units · {stop.order.weightKg.toFixed(0)} kg ·{' '}
          {stop.order.volumeM3.toFixed(2)} m³
        </strong>
        <span>
          <code>{orderName(stop.order.id)}</code>
          {stop.chilled ? <Tag kind="chilled" /> : <Tag kind="ambient" />}
          {outlet && <span>{outlet.district}</span>}
          <span>Arrive {time(stop.plannedArrival)}</span>
          {reported > 0 && <span className="loader-short-note">{reported} reported short</span>}
        </span>
      </div>
      <Stepper
        value={count}
        max={stop.order.units}
        label={`Units loaded for ${stop.order.outletId}`}
        disabled={!interactive}
        onChange={onCount}
      />
    </div>
  );
}

// L03. What the counts say before Ready: matched units, and any stop that is short.
function Verify({ flow }: { flow: LoadFlow }) {
  const { detail, reversed, counted, reported, complete } = flow;
  const navigate = useNavigate();
  const short = reversed.filter((stop) => !complete(stop));
  const missing = short.reduce(
    (sum, stop) => sum + stop.order.units - counted(stop) - reported(stop),
    0,
  );
  const reportedTotal = reversed.reduce((sum, stop) => sum + reported(stop), 0);
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const share = flow.total === 0 ? 0 : flow.loaded / flow.total;
  const firstShort = short[0];
  return (
    <>
      <PageHead
        back={flow.base}
        backLabel="Loading plan"
        title="Verify before Ready"
        detail={`${tripName(detail)} · count each stop`}
        status={<StatusBadge status={loadingBadge[flow.state.status]} />}
      />
      <div className="loader-split loader-split--verify">
        <section className="loader-dark loader-donut-card" aria-label="Units matched">
          <div className="loader-donut">
            <svg width="164" height="164" viewBox="0 0 164 164" aria-hidden="true">
              <circle className="loader-donut-missing" cx="82" cy="82" r={radius} />
              <circle
                className="loader-donut-match"
                cx="82"
                cy="82"
                r={radius}
                strokeDasharray={`${share * circumference} ${circumference}`}
                transform="rotate(-90 82 82)"
              />
            </svg>
            <div>
              <strong>{flow.loaded}</strong>
              <span>of {flow.total} units match</span>
            </div>
          </div>
          <p className="loader-legend">
            <span className="loader-legend-match">Match {flow.loaded}</span>
            <span className="loader-legend-missing">Missing {missing}</span>
            {reportedTotal > 0 && (
              <span className="loader-legend-reported">Reported {reportedTotal}</span>
            )}
          </p>
        </section>
        <div className="loader-side loader-side--wide">
          <section className="loader-card" aria-label="Stops">
            <ul className="loader-checks">
              {reversed.map((stop) => {
                const count = counted(stop);
                const ok = complete(stop);
                return (
                  <li key={stop.id}>
                    <Seq value={stop.seq} />
                    <span className="loader-checks-name">{stop.order.outletId}</span>
                    <span className={`loader-meter${ok ? '' : ' loader-meter--short'}`}>
                      <span
                        style={{
                          width: `${Math.min(100, ((count + reported(stop)) / stop.order.units) * 100)}%`,
                        }}
                      />
                    </span>
                    {ok ? (
                      <LoaderIcon name="check" size={18} />
                    ) : (
                      <SharedIcon src="54-30-imgIconXoct" size={16} />
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
          <section className="loader-card" aria-label="Counts">
            {reversed.map((stop) => {
              const count = counted(stop);
              const ok = complete(stop);
              const gap = stop.order.units - count - reported(stop);
              return (
                <div key={stop.id} className={`loader-count${ok ? '' : ' loader-count--short'}`}>
                  <span className={`loader-done${ok ? '' : ' loader-done--short'}`}>
                    {ok ? (
                      <LoaderIcon name="check" size={18} />
                    ) : (
                      <SharedIcon src="54-30-imgIconXoct" size={16} />
                    )}
                  </span>
                  <div className="loader-count-text">
                    <strong>
                      {stop.order.outletId} · stop {stop.seq}
                    </strong>
                    <span className="loader-count-detail">
                      {!ok
                        ? `${gap} ${gap === 1 ? 'unit' : 'units'} missing`
                        : reported(stop) > 0
                          ? `${reported(stop)} reported short`
                          : 'Matches plan'}
                    </span>
                  </div>
                  <strong className="loader-count-value">
                    {count} / {stop.order.units}
                  </strong>
                </div>
              );
            })}
          </section>
        </div>
      </div>
      <ActionBar
        status={
          missing > 0 ? (
            <p className="loader-status-line">
              <SharedIcon src="54-30-imgIconLock1" size={12} />
              Ready is blocked: {missing} {missing === 1 ? 'unit is' : 'units are'} not counted.
              Recount, or report a shortfall.
            </p>
          ) : (
            <p className="loader-status-line">
              <LoaderIcon name="check" size={18} />
              Every stop matches the plan.
            </p>
          )
        }
      >
        <Button asChild variant="secondary" className="loader-cta">
          <Link to={flow.base}>Recount</Link>
        </Button>
        {firstShort ? (
          <Button asChild className="loader-cta">
            <Link
              to={`${flow.base}/shortfall?order=${firstShort.order.id}&qty=${firstShort.order.units - counted(firstShort) - reported(firstShort)}`}
            >
              Report shortfall · {missing}
            </Link>
          </Button>
        ) : (
          // Verification is recorded against the current plan before the Ready rules.
          <Button
            className="loader-cta"
            busy={flow.busy}
            disabled={!flow.online}
            onClick={() => flow.verify(() => navigate(`${flow.base}/ready`))}
          >
            Confirm verification
          </Button>
        )}
      </ActionBar>
    </>
  );
}
