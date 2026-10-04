import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { Button, ErrorState } from '../../components/waypoint';
import { message } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';
import { time } from '../store/shared';
import { DISPATCH_OFFICE, telHref } from './fixtures';
import { cartons, FAILURE_REASONS, reasonIcon } from './labels';
import { loadStop } from './offline/queries';
import { DeliveryForm } from './pod';
import { DriverHeader, DriverIcon, Strip, ThumbZone } from './shell';
import { StopSkeleton } from './skeletons';
import { useDriverOutlets } from './trip';
import { type StopAction, useDriver } from './workspace';

type Outcome = 'delivered' | 'failed';

const minutes = (clock: string) => {
  const [hours = 0, mins = 0] = clock.split(':').map(Number);
  return hours * 60 + mins;
};

// DR04 + DR04a. Recorded only from an arrived stop. Delivered needs a POD, uploaded first and then
// referenced by the delivered event; failed needs a reason from the list. Figma's third segment,
// Partial, is drawn but not selectable: the API has no partial outcome or delivered quantity.
export function StopOutcome() {
  const { stopId = '' } = useParams();
  const { user, record, stamp } = useDriver();
  const navigate = useNavigate();
  const [outcome, setOutcome] = useState<Outcome>('delivered');
  const [reason, setReason] = useState('');
  const stop = useQuery({
    queryKey: queryKeys.driver.stop(user.id, stopId),
    queryFn: () => loadStop(user.id, stopId),
    networkMode: 'always',
  });
  const outlets = useDriverOutlets(user.id);
  // Saved on the phone first; the outbox uploads the POD and sends the event (§8.2).
  const action = useMutation({
    mutationFn: (run: StopAction) => record(run),
    onSuccess: () => navigate(`/driver/stops/${stopId}/saved`, { replace: true }),
    networkMode: 'always',
  });

  if (stop.isPending) return <StopSkeleton back={`/driver/stops/${stopId}`} backLabel="Stop" />;
  if (!stop.data) {
    return <ErrorState description={message(stop.error)} onRetry={() => void stop.refetch()} />;
  }
  const detail = stop.data;
  // Outcomes follow an arrival; any other status belongs on the stop screen.
  if (detail.status !== 'arrived') return <Navigate to={`/driver/stops/${detail.id}`} replace />;
  const outlet = outlets.data?.items.find((item) => item.id === detail.order.outletId);
  const busy = action.isPending;

  const now = time(stamp());
  const close = detail.windowClose.slice(0, 5);
  const inside = minutes(now) <= minutes(close);

  return (
    <>
      <DriverHeader
        back={`/driver/stops/${detail.id}`}
        backLabel="Stop"
        eyebrow={`Stop ${detail.seq} · ${cartons(detail.order.units)}`}
        title={`${outlet?.district ?? detail.order.outletId} · outcome`}
      />

      <fieldset className="driver-segments">
        <legend className="wp-sr-only">Outcome</legend>
        {(['delivered', 'partial', 'failed'] as const).map((option) => (
          <label
            key={option}
            className={`driver-segment${outcome === option ? ' driver-segment--active' : ''}${
              option === 'partial' ? ' driver-segment--off' : ''
            }`}
            title={option === 'partial' ? 'Partial deliveries cannot be recorded yet' : undefined}
          >
            <input
              className="wp-sr-only"
              type="radio"
              name="stop-outcome"
              value={option}
              checked={outcome === option}
              disabled={busy || option === 'partial'}
              onChange={() => option !== 'partial' && setOutcome(option)}
            />
            {option === 'delivered' ? 'Delivered' : option === 'partial' ? 'Partial' : 'Failed'}
          </label>
        ))}
      </fieldset>

      {action.error && (
        <div className="driver-banner driver-banner--danger" role="alert">
          <strong>Not saved on this phone</strong>
          <p>{message(action.error)}</p>
        </div>
      )}

      {outcome === 'delivered' && detail.pod && (
        <>
          <Strip tone="info" icon={<DriverIcon name="info-info" size={16} />}>
            Proof of delivery already saved for {detail.pod.recipientName}. Complete the delivery to
            finish.
          </Strip>
          <ThumbZone>
            <Button
              className="driver-cta"
              busy={busy}
              onClick={() =>
                detail.pod &&
                action.mutate({ stop: detail, type: 'delivered', podId: detail.pod.id })
              }
            >
              Complete delivery
            </Button>
          </ThumbZone>
        </>
      )}
      {/* Once a POD is saved the form is not shown again, so the driver never re-signs. */}
      {outcome === 'delivered' && !detail.pod && (
        <DeliveryForm
          stop={detail}
          recipient=""
          busy={busy}
          onSubmit={(pod) => action.mutate({ stop: detail, type: 'delivered', pod })}
        />
      )}

      {outcome === 'failed' && (
        <form
          className="driver-form"
          aria-label="Failed delivery"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason) action.mutate({ stop: detail, type: 'failed', reason });
          }}
        >
          <fieldset className="driver-reasons">
            <legend>What happened?</legend>
            {FAILURE_REASONS.map((option) => (
              <label
                key={option}
                className={`driver-reason${reason === option ? ' driver-reason--active' : ''}`}
              >
                <input
                  className="wp-sr-only"
                  type="radio"
                  name="failure-reason"
                  value={option}
                  checked={reason === option}
                  disabled={busy}
                  onChange={() => setReason(option)}
                />
                <DriverIcon name={reasonIcon[option]} size={18} />
                {option}
              </label>
            ))}
          </fieldset>
          <section className="driver-tile driver-tile--time" aria-label="Delivery window">
            <DriverIcon name="clock-large" size={20} />
            <strong>{now}</strong>
            <span>inside window?</span>
            <span className={inside ? 'driver-yes' : 'driver-no'}>
              {inside ? `Yes · closes ${close}` : `No · closed ${close}`}
            </span>
          </section>
          <Strip tone="info" icon={<DriverIcon name="info-info" size={16} />}>
            No POD for a failed stop. Goods return to the depot.
          </Strip>
          <ThumbZone>
            <Button type="submit" className="driver-cta" busy={busy} disabled={!reason}>
              Record failed delivery
            </Button>
            <a className="driver-link" href={telHref(DISPATCH_OFFICE.phone)}>
              Call dispatcher
            </a>
          </ThumbZone>
        </form>
      )}
    </>
  );
}
