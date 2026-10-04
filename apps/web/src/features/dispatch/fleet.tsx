// D04 · Fleet & trips (Figma 2040:1599): one vehicle, one trip, one question — does it fit?
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MoveAllocationRequest } from '@waypoint/shared';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Banner,
  Button,
  Dropdown,
  EmptyState,
  ErrorState,
  Icon,
  LoadingState,
  ProgressBar,
  SegmentedControl,
  Tag,
} from '../../components/waypoint';
import { clock } from '../../lib/format';
import { fleetListSchema, vehicleInspectorSchema } from './contracts';
import { api, message, noContent } from './data/client';
import { ChangeStop, MarkUnavailable } from './replan-controls';
import { Bars, CapacityRows, CardHead, capacityTone, DarkCard, Headline } from './ui';
import { Page, useDispatch } from './workspace';
import './fleet.css';

const metrics = [
  { value: 'weight', label: 'Weight' },
  { value: 'volume', label: 'Volume' },
] as const;
type Metric = (typeof metrics)[number]['value'];

const number = (value: number) => value.toLocaleString('en-GB');
/** Trip states in which the orders are still at the depot. */
const OPEN_TRIPS = ['published', 'loading', 'blocked'];

export function FleetTrips() {
  const { date } = useDispatch();
  const client = useQueryClient();
  const params = useParams();
  const [query, setQuery] = useSearchParams();
  const [metric, setMetric] = useState<Metric>('weight');
  const [why, setWhy] = useState(false);
  const [marking, setMarking] = useState(false);
  const [changing, setChanging] = useState<{ orderId: string; name: string } | null>(null);

  const fleet = useQuery({
    queryKey: ['planning', date, 'vehicles'],
    queryFn: () => api(`/planning/runs/${date}/vehicles`, fleetListSchema),
  });
  // Open on the vehicle asked for, else the first one that breaks a rule, else the first.
  const vehicleId =
    params.vehicleId ??
    query.get('vehicle') ??
    fleet.data?.items.find((item) => item.violation)?.id ??
    fleet.data?.items[0]?.id;
  const inspector = useQuery({
    queryKey: ['planning', date, 'vehicles', vehicleId],
    queryFn: () => api(`/planning/runs/${date}/vehicles/${vehicleId}`, vehicleInspectorSchema),
    enabled: vehicleId !== undefined,
  });
  const apply = useMutation({
    mutationFn: (request: MoveAllocationRequest) =>
      api(`/planning/runs/${date}/allocations`, noContent, {
        method: 'PUT',
        body: JSON.stringify(request),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['planning', date] });
      await client.invalidateQueries({ queryKey: ['dashboard', date] });
    },
  });
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(query);
    next.set(key, value);
    setQuery(next);
  };

  if (fleet.isPending || (vehicleId !== undefined && inspector.isPending)) {
    return <LoadingState label="Loading the vehicle…" rows={5} />;
  }
  if (fleet.data && !vehicleId) {
    return (
      <EmptyState
        title="No vehicles in this run"
        description="Vehicles appear here once the run has a fleet."
      />
    );
  }
  if (!fleet.data || !inspector.data) {
    return (
      <ErrorState
        description={message(fleet.error ?? inspector.error)}
        onRetry={() => void (fleet.data ? inspector.refetch() : fleet.refetch())}
      />
    );
  }

  const { vehicle, fuel, trips, published = false, unavailable = false } = inspector.data;
  const worst = [...trips].sort(
    (a, b) =>
      Math.max(...b.capacity.map((row) => row.percent)) -
      Math.max(...a.capacity.map((row) => row.percent)),
  )[0];
  const trip = trips.find((item) => String(item.tripNo) === query.get('trip')) ?? worst;
  const cap = metric === 'weight' ? vehicle.weightCapKg : vehicle.volumeCapM3;
  const unit = metric === 'weight' ? 'kg' : 'm³';
  const load = trip ? (metric === 'weight' ? trip.loadKg : trip.loadM3) : 0;
  const loadPercent = Math.round((load / cap) * 100);
  const tone = capacityTone(loadPercent);
  const heaviest = trip
    ? Math.max(...trip.stops.map((stop) => (metric === 'weight' ? stop.weightKg : stop.volumeM3)))
    : 0;
  const pending = fuel.afterPercent !== fuel.percent;

  return (
    <Page
      title={`${vehicle.id} · ${vehicle.kind}`}
      description={`${vehicle.depot} · ${number(vehicle.weightCapKg)} kg · ${vehicle.volumeCapM3} m³ · ${vehicle.kmPerL} km/L`}
      actions={
        <>
          <Dropdown
            label="Vehicle"
            value={vehicle.id}
            options={fleet.data.items.map((item) => ({
              value: item.id,
              label: `${item.id} · ${item.kind}`,
            }))}
            onChange={(id) => {
              const next = new URLSearchParams(query);
              next.set('vehicle', id);
              next.delete('trip');
              setQuery(next);
            }}
          />
          {trips.length > 0 && trip && (
            <SegmentedControl
              label="Trip"
              value={String(trip.tripNo)}
              options={trips.map((item) => ({
                value: String(item.tripNo),
                label: `Trip ${item.tripNo}`,
              }))}
              onChange={(value) => set('trip', value)}
            />
          )}
          {trip && (
            <Button asChild variant="secondary" size="md">
              <Link
                to={`/dispatcher/vehicles/${vehicle.id}/trips/${trip.tripNo}/record?date=${date}`}
              >
                Trip record
              </Link>
            </Button>
          )}
          <Button asChild variant="secondary" size="md">
            <Link to={`/dispatcher/orders?date=${date}&vehicle=${vehicle.id}`}>Audit trail</Link>
          </Button>
          {unavailable ? (
            <Button asChild size="md">
              <Link to={`/dispatcher/vehicles/${vehicle.id}/replan?date=${date}`}>Open replan</Link>
            </Button>
          ) : (
            <Button variant="secondary" size="md" onClick={() => setMarking(true)}>
              Mark unavailable
            </Button>
          )}
        </>
      }
    >
      <MarkUnavailable vehicleId={vehicle.id} open={marking} onClose={() => setMarking(false)} />
      {trip && (
        <ChangeStop
          stop={changing}
          from={{ vehicleId: vehicle.id, tripNo: trip.tripNo }}
          vehicles={fleet.data.items}
          onClose={() => setChanging(null)}
        />
      )}
      {unavailable && (
        <Banner tone="warning" title={`${vehicle.id} is unavailable on this date`}>
          Its trips that had not departed are stopped. Open the replan to give their orders a new
          trip.
        </Banner>
      )}
      {apply.isError && (
        <Banner tone="danger" title="The fix was not applied">
          {message(apply.error)}
        </Banner>
      )}
      {!trip && <Banner title="No trips planned">This vehicle has no stops in the run yet.</Banner>}
      {trip && (
        <>
          <div className="fl-row">
            <section className="wp-card fl-load" aria-label={`Trip ${trip.tripNo} load by stop`}>
              <div className="d-head fl-load-head">
                <Headline label={`Trip ${trip.tripNo} load`} value={`${number(load)} ${unit}`}>
                  {tone === 'danger' && <Tag kind="blocks-publish">{loadPercent}% of limit</Tag>}
                  {tone === 'warning' && <Tag kind="risk">{loadPercent}% of limit</Tag>}
                </Headline>
                <Dropdown label="Measure" value={metric} options={metrics} onChange={setMetric} />
              </div>
              <Bars
                label={`${metric === 'weight' ? 'Weight' : 'Volume'} by stop`}
                height={160}
                bars={trip.stops.map((stop) => {
                  const value = metric === 'weight' ? stop.weightKg : stop.volumeM3;
                  return {
                    name: stop.name,
                    value,
                    // The largest stop is the one that tips an over-limit trip.
                    highlight: tone === 'danger' ? value === heaviest : true,
                  };
                })}
              />
              {trip.insight && <p className="d-note">{trip.insight}</p>}
            </section>
            <DarkCard title="Weekly fuel quota" icon="fuel">
              <p className="d-hero">
                <strong>{Math.round(fuel.percent)}%</strong>
                {pending && <span>→ {Math.round(fuel.afterPercent)}%</span>}
              </p>
              <ProgressBar
                label="Weekly fuel quota used"
                size={8}
                track="inverse"
                tone={
                  capacityTone(fuel.percent) === 'neutral' ? 'warning' : capacityTone(fuel.percent)
                }
                value={fuel.percent}
                marker={pending ? fuel.afterPercent : undefined}
              />
              <p>{fuel.note}</p>
            </DarkCard>
          </div>
          <div className="fl-row fl-row--three">
            <section className="wp-card fl-capacity" aria-label="Capacity">
              <CardHead title="Capacity" icon="box" />
              <CapacityRows rows={trip.capacity} />
              {trip.capacityNote && <p className="d-note fl-foot">{trip.capacityNote}</p>}
            </section>
            <section className="wp-card fl-stops" aria-label="Stops">
              <CardHead title="Stops">
                <Tag kind="predicted">Service time</Tag>
              </CardHead>
              <ol className="wp-list">
                {trip.stops.map((stop, index) => (
                  <li key={stop.orderId} className="fl-stop">
                    <span className="d-num">{index + 1}</span>
                    <span className="fl-stop-text">
                      <strong>{stop.name}</strong>
                      <span>
                        {clock(stop.plannedArrival)} · ~{Math.round(stop.serviceMinutes)} min
                      </span>
                    </span>
                    {stop.lateRiskPercent !== null && (
                      <span className="d-predict">
                        Late risk {Math.round(stop.lateRiskPercent)}%
                      </span>
                    )}
                    {/* A published stop that has not left the depot can still move or be deferred. */}
                    {published && trip.status !== undefined && OPEN_TRIPS.includes(trip.status) && (
                      <Button
                        variant="secondary"
                        size="md"
                        aria-label={`Move or defer ${stop.name}`}
                        onClick={() => setChanging({ orderId: stop.orderId, name: stop.name })}
                      >
                        Change
                      </Button>
                    )}
                  </li>
                ))}
              </ol>
            </section>
            <section className="wp-card fl-fix" aria-label="Fix">
              <CardHead title="Fix" icon="bulb" />
              {!trip.fix && (
                <p className="wp-muted">
                  {tone === 'danger'
                    ? 'No single move clears this trip. Reallocate its stops in Allocation.'
                    : 'Nothing to fix. This trip is within every limit.'}
                </p>
              )}
              {trip.fix && (
                <div className="d-fix">
                  <h3 className="d-fix-title">{trip.fix.title}</h3>
                  <CapacityRows
                    narrow
                    rows={trip.fix.effects.map((effect) => ({ key: effect.label, ...effect }))}
                  />
                  <p className="d-fix-note">
                    <Icon name="check" size={14} />
                    {trip.fix.note}
                  </p>
                  {why && (
                    <ul className="d-fix-reasons">
                      {trip.fix.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  )}
                  <div className="d-fix-actions">
                    <Button
                      size="md"
                      busy={apply.isPending}
                      onClick={() =>
                        trip.fix &&
                        apply.mutate({ orderId: trip.fix.orderId, target: trip.fix.target })
                      }
                    >
                      Apply
                    </Button>
                    <Button
                      variant="tertiary"
                      size="md"
                      aria-expanded={why}
                      onClick={() => setWhy(!why)}
                    >
                      Why this?
                    </Button>
                  </div>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </Page>
  );
}
