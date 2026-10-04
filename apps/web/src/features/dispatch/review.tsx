// D08 · Review & publish (Figma 2040:3555) and D08a · Plan published (2040:3969)
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { publishPlanResponseSchema } from '@waypoint/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { z } from 'zod';
import {
  Banner,
  Button,
  ErrorState,
  Icon,
  LoadingState,
  Overlay,
  ProgressBar,
  Ring,
  StatusBadge,
  Tag,
  type Tone,
} from '../../components/waypoint';
import { clock, shortDay } from '../../lib/format';
import { planReviewSchema } from './contracts';
import { api, message } from './data/client';
import { CapacityRows, CardHead, DarkCard, Gauge, Row } from './ui';
import { Page, useDispatch } from './workspace';
import './review.css';

type Review = z.infer<typeof planReviewSchema>;
type Published = NonNullable<Review['published']>;

const checkLooks: Record<Review['checks'][number]['state'], { icon: string; tone: Tone }> = {
  pass: { icon: 'check', tone: 'success' },
  warn: { icon: 'alert', tone: 'warning' },
  fail: { icon: 'xoct', tone: 'danger' },
};
const notifyIcons: Record<Review['notify'][number]['key'], string> = {
  loaders: 'pkg',
  drivers: 'truck',
  stores: 'store',
  deferrals: 'history',
};
const milestoneIcons: Record<Published['timeline'][number]['key'], string> = {
  loading: 'pkg',
  departures: 'truck',
  first_stops: 'pin',
  last_stop: 'cc',
};

export function ReviewPublish() {
  const { date, run, now } = useDispatch();
  const client = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const review = useQuery({
    queryKey: ['planning', date, 'review'],
    queryFn: () => api(`/planning/runs/${date}/review`, planReviewSchema),
    // Acknowledgements keep arriving after the plan is published.
    refetchInterval: (query) => (query.state.data?.published ? 15_000 : false),
  });
  const publish = useMutation({
    mutationFn: () =>
      api(`/planning/runs/${date}/publish`, publishPlanResponseSchema, { method: 'POST' }),
    onSuccess: async () => {
      setConfirming(false);
      await client.invalidateQueries({ queryKey: ['planning', date] });
      await client.invalidateQueries({ queryKey: ['dashboard', date] });
    },
  });

  if (review.isPending) {
    return (
      <Page title="Review & publish">
        <LoadingState label="Loading the plan review…" rows={5} />
      </Page>
    );
  }
  if (!review.data) {
    return (
      <Page title="Review & publish">
        <ErrorState description={message(review.error)} onRetry={() => void review.refetch()} />
      </Page>
    );
  }

  const data = review.data;
  const version = `v${data.planVersion}`;
  if (data.published) {
    return <PublishedView review={data} published={data.published} />;
  }

  const failing = data.checks.filter((check) => check.state === 'fail').length;
  const passing = data.checks.length - failing;
  const atRisk = data.lateRisk.trips.filter(Boolean).length;
  const deadline = run ? Date.parse(run.planning.publishBy) : null;
  const opened = run ? Date.parse(run.planning.opensAt) : null;
  const minutes = deadline === null ? null : Math.ceil((deadline - now) / 60_000);
  const elapsed =
    deadline !== null && opened !== null && deadline > opened
      ? ((now - opened) / (deadline - opened)) * 100
      : 0;

  return (
    <Page
      title="Review & publish"
      description={`Plan ${version} · ${data.orders} orders on ${data.trips} trips · ${data.deferred} deferred`}
      actions={
        <>
          <Button asChild variant="secondary" size="md">
            <Link to={`/dispatcher/allocate?date=${date}`}>Back to allocation</Link>
          </Button>
          <Button
            size="md"
            variant={failing > 0 ? 'secondary' : 'primary'}
            disabled={failing > 0}
            aria-describedby="review-checks"
            onClick={() => {
              publish.reset();
              setConfirming(true);
            }}
          >
            Publish plan {version}
          </Button>
        </>
      }
    >
      {failing > 0 && (
        <Banner
          tone="danger"
          title={`${failing} ${failing === 1 ? 'check blocks' : 'checks block'} publishing`}
          action={
            <Link className="d-link" to={`/dispatcher/validation?date=${date}`}>
              Open validation
            </Link>
          }
        >
          Publish stays off until every blocking check passes.
        </Banner>
      )}
      <div className="rv-row">
        <section className="wp-card rv-quality" aria-label="Plan quality">
          <div className="rv-gauge">
            <Gauge size={260} score={data.quality.score} label="Plan quality · of 100" />
            {data.quality.delta !== null && (
              <span className="wp-delta" data-negative={data.quality.delta < 0 || undefined}>
                {data.quality.delta > 0 ? '+' : ''}
                {data.quality.delta}
                {data.quality.previousVersion !== null && ` vs v${data.quality.previousVersion}`}
              </span>
            )}
          </div>
          <div className="rv-factors">
            <h2 className="d-label">What makes up the score</h2>
            <CapacityRows plain rows={data.quality.factors} />
            {data.quality.note && <p className="d-note">{data.quality.note}</p>}
          </div>
        </section>
        <DarkCard title="Publish window" icon="clock">
          <p className="d-hero" role="timer">
            {minutes === null ? (
              <strong>—</strong>
            ) : minutes > 0 ? (
              <>
                <strong>{minutes}</strong>
                <span>min left</span>
              </>
            ) : (
              <strong>Overdue</strong>
            )}
          </p>
          <ProgressBar
            label="Planning window elapsed"
            track="inverse"
            tone={minutes !== null && minutes <= 0 ? 'danger' : 'neutral'}
            value={elapsed}
          />
          <p>{data.windowNote}</p>
        </DarkCard>
      </div>
      <div className="rv-row rv-row--three">
        <section className="wp-card rv-list" aria-label="Checks">
          <CardHead title="Checks">
            <span id="review-checks">
              <StatusBadge
                status={failing > 0 ? 'failed' : 'resolved'}
                label={`${passing} of ${data.checks.length}`}
              />
            </span>
          </CardHead>
          {data.checks.map((check) => (
            <Row
              key={check.key}
              {...checkLooks[check.state]}
              title={check.title}
              detail={check.detail}
            />
          ))}
        </section>
        <section className="wp-card rv-risk" aria-label="Predicted late risk">
          <CardHead title="Late risk">
            <Tag kind="predicted">{data.lateRisk.model}</Tag>
          </CardHead>
          <p className="rv-risk-count">
            <strong>{atRisk}</strong>
            of {data.lateRisk.trips.length} trips
          </p>
          <div
            className="rv-dots"
            role="img"
            aria-label={`${atRisk} of ${data.lateRisk.trips.length} trips carry a predicted late risk`}
          >
            {data.lateRisk.trips.map((risky, index) => (
              // One dot per trip, in plan order.
              // biome-ignore lint/suspicious/noArrayIndexKey: positional matrix
              <i key={index} data-risk={risky || undefined} />
            ))}
          </div>
          <p className="d-note rv-foot">
            Predictions flag risk only. No stop is marked late before it happens.
          </p>
        </section>
        <section className="wp-card rv-list" aria-label="Who is told on publish">
          <CardHead title="On publish" icon="bell" />
          {data.notify.map((item) => (
            <Row key={item.key} icon={notifyIcons[item.key]} title={item.label}>
              <strong className="d-count">{item.count}</strong>
            </Row>
          ))}
        </section>
      </div>
      <Overlay
        variant="modal"
        open={confirming}
        onClose={() => setConfirming(false)}
        title={`Publish plan ${version}?`}
        icon="cc"
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button size="md" busy={publish.isPending} onClick={() => publish.mutate()}>
              Publish plan {version}
            </Button>
          </>
        }
      >
        <p className="rv-confirm">
          Loaders, drivers and stores will see this version. A later change creates a new version
          that drivers must acknowledge.
        </p>
        <div className="rv-list">
          {data.notify.map((item) => (
            <Row key={item.key} icon={notifyIcons[item.key]} title={item.label}>
              <strong className="d-count">{item.count}</strong>
            </Row>
          ))}
        </div>
        {publish.isError && (
          <Banner tone="danger" title="The plan was not published">
            {message(publish.error)}
          </Banner>
        )}
      </Overlay>
    </Page>
  );
}

function PublishedView({ review, published }: { review: Review; published: Published }) {
  const { date, run } = useDispatch();
  const version = `v${review.planVersion}`;
  const share = (part: { done: number; total: number }) =>
    part.total > 0 ? (part.done / part.total) * 100 : 0;
  const deadline = run ? Date.parse(run.planning.publishBy) : null;
  const margin =
    deadline === null ? null : Math.round((deadline - Date.parse(published.at)) / 60_000);
  const first = published.timeline[0];
  const last = published.timeline.at(-1);
  const span = first && last ? Date.parse(last.at) - Date.parse(first.at) : 0;
  const tomorrow = run ? shortDay(date) !== shortDay(run.now) : true;
  return (
    <Page
      title={`Plan ${version} is live`}
      description={`Published ${clock(published.at)} by ${published.by}${
        margin === null
          ? ''
          : margin >= 0
            ? ` · ${margin} min before the window closed`
            : ` · ${-margin} min after the window closed`
      }`}
      actions={
        <>
          <Button asChild variant="secondary" size="md">
            <Link to={`/dispatcher/orders?date=${date}&plan=${review.planVersion}`}>
              View audit
            </Link>
          </Button>
          <Button asChild size="md">
            <Link to={`/dispatcher/live?date=${date}`}>Go to live operations</Link>
          </Button>
        </>
      }
    >
      <Banner tone="success" title={`Plan ${version} published to ${published.trips} trips`}>
        Loaders, drivers and stores now see the same version. Acknowledgements update below.
      </Banner>
      <div className="rv-acks">
        <section className="wp-card rv-drivers" aria-label="Driver acknowledgements">
          <Ring size={210} stroke={14} percent={share(published.drivers)}>
            <strong className="rv-ring-value">{published.drivers.done}</strong>
            <small className="rv-ring-label">of {published.drivers.total} drivers</small>
          </Ring>
          <div>
            <h2>Drivers acknowledged</h2>
            {published.drivers.recent && (
              <span className="wp-delta">
                +{published.drivers.recent.count} in {published.drivers.recent.minutes} min
              </span>
            )}
            <p className="d-note">{published.drivers.note}</p>
          </div>
        </section>
        <AckCard title="Loaders" icon="pkg" unit="docks" part={published.loaders} />
        <AckCard title="Stores" icon="store" unit="viewed" part={published.stores} />
      </div>
      <div className="rv-row rv-row--fill">
        <section className="wp-card rv-timeline" aria-label="Run timeline">
          <div className="d-head rv-timeline-head">
            <h2 className="d-title">
              <Icon name="cal" />
              {tomorrow ? 'Tomorrow’s run' : 'Today’s run'}
            </h2>
            <span>{shortDay(date)}</span>
          </div>
          <ol className="wp-list rv-track">
            {published.timeline.map((milestone) => (
              <li
                key={milestone.key}
                style={{
                  left:
                    span > 0 && first
                      ? `${((Date.parse(milestone.at) - Date.parse(first.at)) / span) * 100}%`
                      : '0%',
                }}
              >
                <span className="rv-node">
                  <Icon name={milestoneIcons[milestone.key]} />
                </span>
                <strong>{clock(milestone.at)}</strong>
                <span>{milestone.label}</span>
              </li>
            ))}
          </ol>
          {published.timelineNote && <p className="d-note">{published.timelineNote}</p>}
        </section>
        <article className="wp-card wp-inverse rv-versions">
          <CardHead title="Versions" icon="history" />
          {published.versions.map((item) => (
            <div key={item.version} className="rv-version">
              <p>
                <strong>
                  v{item.version} · {clock(item.at)}
                </strong>
                <span>{item.summary}</span>
              </p>
              {item.live ? (
                <StatusBadge status="completed" label="Live" />
              ) : (
                <Link
                  className="d-link rv-compare"
                  to={`/dispatcher/orders?date=${date}&plan=${review.planVersion}&compare=${item.version}`}
                >
                  Compare
                </Link>
              )}
            </div>
          ))}
        </article>
      </div>
    </Page>
  );
}

function AckCard({
  title,
  icon,
  unit,
  part,
}: {
  title: string;
  icon: string;
  unit: string;
  part: { done: number; total: number; note: string };
}) {
  return (
    <section className="wp-card rv-ack" aria-label={`${title} acknowledgements`}>
      <div className="d-head">
        <h2 className="d-title">{title}</h2>
        <span className="wp-icon-well">
          <Icon name={icon} />
        </span>
      </div>
      <div className="rv-ack-body">
        <p>
          <strong>{part.done}</strong>/ {part.total} {unit}
        </p>
        <ProgressBar
          label={`${title}: ${part.done} of ${part.total}`}
          tone="positive"
          value={part.total > 0 ? (part.done / part.total) * 100 : 0}
        />
        <p className="d-note">{part.note}</p>
      </div>
    </section>
  );
}
