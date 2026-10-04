// D03a · Automatic allocation result (Figma 2106:11837)
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Banner,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  Ring,
  Tag,
} from '../../components/waypoint';
import { clock } from '../../lib/format';
import { autoRunSchema } from './contracts';
import { api, HttpError, message, noContent } from './data/client';
import { ruleIcons, ruleLabels } from './rules';
import { CardHead, DarkCard, Row, StatBars } from './ui';
import { Page, useDispatch } from './workspace';

export function AutomaticRun({
  modeControl,
  setMode,
}: {
  modeControl: ReactNode;
  setMode: (mode: 'assisted') => void;
}) {
  const { date, run: context } = useDispatch();
  const client = useQueryClient();
  const run = useQuery({
    queryKey: ['planning', date, 'auto-run'],
    queryFn: () =>
      api(`/planning/runs/${date}/auto-run`, autoRunSchema).catch((error: unknown) => {
        // No run yet is a normal state, not a failure.
        if (error instanceof HttpError && error.status === 404) return null;
        throw error;
      }),
  });
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['planning', date] });
    await client.invalidateQueries({ queryKey: ['dashboard', date] });
  };
  const start = useMutation({
    mutationFn: () =>
      api(`/planning/runs/${date}/auto-allocate`, autoRunSchema, { method: 'POST' }),
    onSuccess: refresh,
  });
  const undoRun = useMutation({
    mutationFn: () => api(`/planning/runs/${date}/auto-run`, noContent, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const undoChange = useMutation({
    mutationFn: (id: string) =>
      api(`/planning/runs/${date}/auto-run/changes/${id}`, noContent, { method: 'DELETE' }),
    onSuccess: refresh,
  });
  const failure = start.error ?? undoRun.error ?? undoChange.error;

  if (run.isPending || run.isError || run.data === null) {
    return (
      <Page
        title="Allocation"
        description="Automatic mode places every order that passes the hard rules"
        actions={modeControl}
      >
        {run.isPending && <LoadingState label="Loading the automatic run…" />}
        {run.isError && (
          <ErrorState description={message(run.error)} onRetry={() => void run.refetch()} />
        )}
        {start.isError && (
          <Banner tone="danger" title="The automatic run did not start">
            {message(start.error)}
          </Banner>
        )}
        {run.data === null && (
          <EmptyState
            title="No automatic run yet"
            description="The engine places what it can and lists the rest for you. Nothing is published."
            action={
              <Button size="md" busy={start.isPending} onClick={() => start.mutate()}>
                Run automatic allocation
              </Button>
            }
          />
        )}
      </Page>
    );
  }

  const data = run.data;
  const left = data.orders - data.placed;
  return (
    <Page
      title="Automatic run finished"
      description={`Plan v${data.planVersion} draft · ${clock(data.finishedAt)} · ${Math.round(data.durationSeconds)} s · nothing is published yet`}
      actions={
        <>
          {modeControl}
          <Button
            variant="secondary"
            size="md"
            busy={undoRun.isPending}
            onClick={() => undoRun.mutate()}
          >
            Undo run
          </Button>
          <Button size="md" onClick={() => setMode('assisted')}>
            Review in assisted mode
          </Button>
        </>
      }
    >
      <Banner title={`${data.placed} orders placed automatically`}>
        Every placement passed the hard rules. Anything the engine could not place is listed for you
        — it never forces an order onto an infeasible trip.
      </Banner>
      {failure && (
        <Banner tone="danger" title="That change was not saved">
          {message(failure)}
        </Banner>
      )}
      <div className="au-row">
        <section className="wp-card au-placed" aria-label="Orders placed">
          <Ring
            size={200}
            stroke={14}
            percent={data.orders > 0 ? (data.placed / data.orders) * 100 : 0}
          >
            <strong className="au-ring-value">{data.placed}</strong>
            <small className="au-ring-label">of {data.orders} placed</small>
          </Ring>
          <div className="au-reasons">
            <h2 className="d-label">Why {left} were left for you</h2>
            <StatBars
              bars={data.leftover.map((item) => ({
                key: item.rule,
                label: ruleLabels[item.rule],
                icon: ruleIcons[item.rule] ?? 'alert',
                count: item.count,
              }))}
            />
          </div>
        </section>
        <DarkCard title="Plan quality" icon="shield">
          <p className="d-hero">
            <strong>{data.quality.score}</strong>
            <span>/ 100</span>
          </p>
          <p>{data.quality.note}</p>
        </DarkCard>
      </div>
      <div className="au-row au-row--fill">
        <section className="wp-card au-changes" aria-label="What the engine did">
          <CardHead title="What the engine did">
            <Tag kind="auto-applied">{data.placed} placements</Tag>
            <Link className="d-link" to={`/dispatcher/orders?date=${date}&source=auto`}>
              Audit
            </Link>
          </CardHead>
          {data.changes.length === 0 && (
            <p className="wp-muted">
              {data.placed > 0
                ? 'Placements are not listed one by one. Undo run takes them all off again.'
                : 'Every automatic change has been undone.'}
            </p>
          )}
          {data.changes.map((change) => (
            <Row key={change.id} icon="zap" tone="info" title={change.title} detail={change.detail}>
              <button
                type="button"
                className="d-link"
                disabled={undoChange.isPending}
                onClick={() => undoChange.mutate(change.id)}
              >
                Undo
              </button>
            </Row>
          ))}
        </section>
        <section className="wp-card" aria-label="Your next steps">
          <CardHead title="Your next steps" icon="list" />
          <ol className="wp-list au-steps">
            <li aria-current={left > 0 ? 'step' : undefined}>
              <button type="button" className="d-link" onClick={() => setMode('assisted')}>
                Place the {left} in assisted mode
              </button>
            </li>
            <li aria-current={left === 0 ? 'step' : undefined}>
              <Link to={`/dispatcher/validation?date=${date}`}>Validate the plan</Link>
            </li>
            <li>
              <Link to={`/dispatcher/deferrals?date=${date}`}>
                Decide deferrals if space runs out
              </Link>
            </li>
            <li>
              <Link to={`/dispatcher/review?date=${date}`}>
                Publish{context ? ` before ${clock(context.planning.publishBy)}` : ''}
              </Link>
            </li>
          </ol>
        </section>
      </div>
    </Page>
  );
}
