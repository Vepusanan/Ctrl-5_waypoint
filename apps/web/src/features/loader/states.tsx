import type { LoadingStop } from '@waypoint/shared';
import { Link, useNavigate } from 'react-router-dom';
import { Button, StatusBadge } from '../../components/waypoint';
import { orderName, time } from '../store/shared';
import { firstArrival, issueTypeLabel, loadingBadge, planDiff, tripName, unitsOf } from './labels';
import type { LoadFlow } from './load';
import { ActionBar, DarkTile, LoaderIcon, PageHead, Seq, SharedIcon } from './shell';
import { byRun, TO_LOAD, useLoaderTrips } from './workspace';

// L04a. A shortfall is open: Ready waits for the dispatcher, so the screen says so and offers the
// next load in the meantime. Progress comes from the issues the API returns.
export function Deciding({ flow }: { flow: LoadFlow }) {
  const { detail, state } = flow;
  const trips = useLoaderTrips();
  const open = state.issues.filter((issue) => issue.acknowledgedAt === null);
  const latest = [...open].sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  const meanwhile = (trips.data?.items ?? [])
    .filter(
      (trip) =>
        trip.id !== detail.id &&
        trip.run.status === 'published' &&
        TO_LOAD.includes(trip.status) &&
        trip.loadingStatus !== 'ready',
    )
    .sort(byRun)[0];
  return (
    <>
      <PageHead
        title={tripName(detail)}
        detail={latest ? `Shortfall sent ${time(latest.createdAt)}` : undefined}
        status={<StatusBadge status={loadingBadge[state.status]} />}
      />
      <div className="loader-split">
        <section className="loader-card loader-deciding" aria-label="Waiting for the dispatcher">
          <span className="loader-wait-ring" aria-hidden="true">
            <span>
              <SharedIcon src="2037-861-imgIconClock" size={16} />
            </span>
          </span>
          <h2>Dispatcher is deciding</h2>
          <p>
            Keep {detail.vehicleId} at the dock. You will see the answer here once they acknowledge
            the shortfall.
          </p>
          <ol className="loader-steps">
            <li className="loader-step--done">
              <span className="loader-step-icon">
                <LoaderIcon name="check" size={18} />
              </span>
              <strong>Reported</strong>
              <small>{latest ? time(latest.createdAt) : ''}</small>
            </li>
            <li className="loader-step--current">
              <span className="loader-step-icon">
                <SharedIcon src="54-30-imgIconBulb" size={12} />
              </span>
              <strong>Decision</strong>
              <small>…</small>
            </li>
            <li className="loader-step--next">
              <span className="loader-step-icon">
                <SharedIcon src="54-30-imgIconRefresh" size={12} />
              </span>
              <strong>Ready again</strong>
              <small />
            </li>
          </ol>
          <ul className="loader-issue-list">
            {open.map((issue) => {
              const stop = state.stops.find((item) => item.order.id === issue.orderId);
              return (
                <li key={issue.id}>
                  <strong>
                    {issueTypeLabel[issue.type]} · {issue.qty} {issue.qty === 1 ? 'unit' : 'units'}
                  </strong>
                  <span>
                    Stop {stop?.seq ?? '?'} · {stop?.order.outletId ?? orderName(issue.orderId)}
                    {issue.note ? ` · ${issue.note}` : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
        <div className="loader-side">
          <DarkTile
            title="Departure"
            icon={<SharedIcon src="54-30-imgIconLock" size={14} />}
            value="On hold"
            detail={`First stop at ${time(firstArrival(state.stops))}`}
          />
          <section className="loader-card loader-meanwhile" aria-label="Meanwhile">
            <h2 className="loader-card-title">
              <SharedIcon src="2037-729-imgIconLayers" size={16} />
              Meanwhile
            </h2>
            {meanwhile ? (
              <>
                <Link className="loader-queue-row" to={`/loader/trips/${meanwhile.id}`}>
                  <span className="loader-well">
                    <LoaderIcon name="truck" size={20} />
                  </span>
                  <span className="loader-queue-text">
                    <strong>{tripName(meanwhile)}</strong>
                    <span>
                      {time(firstArrival(meanwhile.stops))} · {unitsOf(meanwhile.stops)} units
                    </span>
                  </span>
                  <LoaderIcon name="chevron-right" size={20} />
                </Link>
                <Button asChild variant="secondary" className="loader-cta loader-cta--full">
                  <Link to={`/loader/trips/${meanwhile.id}`}>Open {meanwhile.vehicleId}</Link>
                </Button>
              </>
            ) : (
              <p className="loader-faint">No other load is waiting.</p>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

// L05. The dispatcher changed the trip after loading started. The API keeps a snapshot of the plan
// the loader accepted (acceptedPlan), so the screen shows Before → Now and each change.
export function PlanChanged({ flow }: { flow: LoadFlow }) {
  const { detail, state } = flow;
  const stops = [...state.stops].sort((left, right) => left.seq - right.seq);
  const before = state.acceptedPlan
    ? [...state.acceptedPlan.stops].sort((left, right) => left.seq - right.seq)
    : null;
  const changes = before ? planDiff(before, stops) : [];
  return (
    <>
      <h1 className="wp-sr-only" tabIndex={-1}>
        Plan changed for {tripName(detail)}
      </h1>
      <div className="loader-banner" role="alert">
        <strong className="loader-status-line">
          <SharedIcon src="54-30-imgIconAlert" size={16} />
          Plan changed · trip version {state.acceptedTripVersion ?? '?'} → {state.tripVersion}
        </strong>
        <p>
          The dispatcher updated this trip. Check the counts against the new list and acknowledge
          before you continue.
        </p>
      </div>
      <div className="loader-split">
        <section className="loader-card loader-changes" aria-label="What changed">
          <h2 className="loader-card-title">
            <SharedIcon src="2037-729-imgIconLayers" size={16} />
            What changed for {detail.vehicleId}
          </h2>
          <div className="loader-compare">
            <div className="loader-before">
              <p className="loader-faint">
                Before{' '}
                <span className="loader-version loader-version--muted">
                  v{state.acceptedPlan?.tripVersion ?? state.acceptedTripVersion ?? '?'}
                </span>
              </p>
              {before ? (
                <PlanStops stops={before} />
              ) : (
                <p className="loader-faint">
                  The plan you accepted predates plan history. Recheck every current stop.
                </p>
              )}
            </div>
            <span className="loader-compare-arrow" aria-hidden="true">
              →
            </span>
            <div className="loader-now">
              <p className="loader-faint">
                Now <span className="loader-version">v{state.tripVersion}</span>
              </p>
              <PlanStops stops={stops} />
            </div>
          </div>
          {changes.length > 0 && (
            <ul className="loader-diff">
              {changes.map((change) => (
                <li
                  key={change.text}
                  className={change.removed ? 'loader-diff--removed' : undefined}
                >
                  {change.text}
                </li>
              ))}
            </ul>
          )}
          {before && changes.length === 0 && (
            <p className="loader-note loader-note--success">
              <LoaderIcon name="check" size={18} />
              Stop order, quantities, access and arrivals are unchanged.
            </p>
          )}
          <p className="loader-note">
            <LoaderIcon name="info" size={16} />
            Count each stop again after you acknowledge.
          </p>
        </section>
        <div className="loader-side">
          <DarkTile
            title="First stop at"
            icon={<LoaderIcon name="clock-inverse" size={16} />}
            value={time(firstArrival(state.stops))}
            detail={tripName(detail)}
          />
        </div>
      </div>
      <ActionBar
        status={
          <p className="loader-status-line">
            <LoaderIcon name="info" size={16} />
            You cannot mark Ready until you acknowledge.
          </p>
        }
      >
        <Button
          className="loader-cta"
          busy={flow.busy}
          disabled={!flow.online}
          onClick={() => flow.verify()}
        >
          Acknowledge v{state.tripVersion}
        </Button>
      </ActionBar>
    </>
  );
}

function PlanStops({ stops }: { stops: readonly LoadingStop[] }) {
  return (
    <ol>
      {stops.map((stop) => (
        <li key={stop.id}>
          <Seq value={stop.seq} />
          <span>
            {stop.order.outletId} · {stop.order.units} units
          </span>
        </li>
      ))}
    </ol>
  );
}

// L06. Ready rules from the API state and the loader's counts, then Mark Ready and, once ready,
// the departure confirmation.
export function Handover({ flow }: { flow: LoadFlow }) {
  const { detail, state } = flow;
  const navigate = useNavigate();
  const isReady = state.status === 'ready';
  const departed = state.status === 'departed';
  const lastStop = [...state.stops].sort((left, right) => left.seq - right.seq)[0];
  const rules = [
    {
      key: 'counted',
      done: flow.allLoaded,
      title: 'Every stop counted',
      detail: `${flow.loaded} of ${flow.total} units`,
    },
    {
      key: 'shortfalls',
      done: flow.open === 0,
      title: 'Shortfalls answered',
      detail:
        state.issues.length === 0
          ? 'No shortfalls reported'
          : `${state.issues.length - flow.open} of ${state.issues.length} acknowledged`,
    },
    {
      key: 'plan',
      // Departure moves the trip version itself; that is not a plan change to acknowledge.
      done: departed || !state.planStale,
      title: 'Plan change acknowledged',
      detail: `Trip version ${state.tripVersion} · plan v${state.planVersion}`,
    },
  ];
  const passed = rules.filter((rule) => rule.done).length;
  const canMark = passed === rules.length && flow.online && detail.status !== 'blocked';
  return (
    <>
      <PageHead
        title={departed ? 'Departed' : 'Ready to hand over'}
        detail={`${tripName(detail)} · ${flow.total} units · plan v${state.planVersion}`}
        status={<StatusBadge status={loadingBadge[state.status]} />}
      />
      {departed && (
        <div className="loader-banner loader-banner--success" role="status">
          <strong>Departed</strong>
          <p>The vehicle has left the depot. The driver now records each stop.</p>
        </div>
      )}
      <div className="loader-split">
        <section className="loader-card loader-rules" aria-label="Ready rules">
          <div className="loader-lines-head">
            <h2>Ready rules</h2>
            <StatusBadge
              status={passed === rules.length ? 'ready' : 'issue-open'}
              label={`${passed} of ${rules.length}`}
            />
          </div>
          <ul>
            {rules.map((rule) => (
              <li key={rule.key}>
                <span className={`loader-done${rule.done ? '' : ' loader-done--short'}`}>
                  {rule.done ? (
                    <LoaderIcon name="check" size={18} />
                  ) : (
                    <SharedIcon src="54-30-imgIconXoct" size={16} />
                  )}
                </span>
                <div className="loader-count-text">
                  <strong>{rule.title}</strong>
                  <span className="loader-count-detail">{rule.detail}</span>
                </div>
              </li>
            ))}
          </ul>
          {lastStop && (
            <>
              <p className="loader-label">Also noted · does not block</p>
              <ul>
                <li>
                  <span className="loader-done loader-done--neutral">
                    <SharedIcon src="54-30-imgIconBox" size={12} />
                  </span>
                  <div className="loader-count-text">
                    <strong>Loaded in stop order</strong>
                    <span className="loader-count-detail">
                      {lastStop.order.outletId} nearest the door
                    </span>
                  </div>
                </li>
              </ul>
            </>
          )}
        </section>
        <div className="loader-side">
          <DarkTile
            title="First stop at"
            icon={<LoaderIcon name="clock-inverse" size={16} />}
            value={time(firstArrival(state.stops))}
            detail={tripName(detail)}
          />
        </div>
      </div>
      {!departed && (
        <ActionBar
          status={
            <p className="loader-status-line">
              <SharedIcon src="2037-861-imgIconClock1" size={16} />
              First stop at {time(firstArrival(state.stops))}
            </p>
          }
        >
          {isReady ? (
            <Button
              className="loader-cta"
              busy={flow.busy}
              disabled={!flow.online || detail.status !== 'ready'}
              onClick={flow.depart}
            >
              Confirm departure
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                className="loader-cta"
                disabled={flow.busy}
                onClick={() => navigate(flow.base)}
              >
                Back
              </Button>
              <Button
                className="loader-cta"
                busy={flow.busy}
                disabled={!canMark}
                onClick={flow.ready}
              >
                Mark Ready
              </Button>
            </>
          )}
        </ActionBar>
      )}
    </>
  );
}
