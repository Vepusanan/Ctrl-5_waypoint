// D01 · Command center (Figma 2037:496)
import { useQuery } from '@tanstack/react-query';
import { DASHBOARD_POLL_INTERVAL_MS } from '@waypoint/shared';
import { type CSSProperties, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ActionList,
  Button,
  Card,
  DeltaBadge,
  Dropdown,
  ErrorState,
  LoadingState,
  MetricCard,
  ProgressBar,
  SegmentedControl,
  Tag,
  type Tone,
} from '../../components/waypoint';
import { clock, shortDay } from '../../lib/format';
import { OperationsView } from './command-ops';
import {
  type CommandActionKind,
  type CommandCenter as CommandCenterData,
  commandCenterSchema,
} from './contracts';
import { api, message } from './data/client';
import { Gauge } from './ui';
import { Page, useDispatch } from './workspace';

const icon = (name: string) => `/waypoint/dispatch/2037-496-imgIcon${name}.svg`;

/** Where each alert opens, its icon and its severity tone. Neutral rows carry no tone. */
const actions: Record<CommandActionKind, { to: string; icon: string; tone?: Tone }> = {
  hard_violation: { to: 'validation', icon: 'Xoct1', tone: 'danger' },
  repeat_deferral: { to: 'deferrals', icon: 'History', tone: 'warning' },
  reefer_mismatch: { to: 'validation', icon: 'Snow1', tone: 'warning' },
  held_after_cutoff: { to: 'queue', icon: 'Clock1', tone: 'hold' },
  outlets_unconfirmed: { to: 'outlets', icon: 'Store' },
  loading_shortfall: { to: 'live', icon: 'Xoct1', tone: 'danger' },
  failed_delivery: { to: 'live', icon: 'Xoct1', tone: 'danger' },
  receipt_discrepancy: { to: 'issues', icon: 'Store' },
  sync_conflict: { to: 'live', icon: 'History', tone: 'warning' },
  vehicle_unavailable: { to: 'allocate', icon: 'Xoct1', tone: 'danger' },
  stale_driver: { to: 'live', icon: 'Clock1', tone: 'hold' },
  tight_window: { to: 'validation', icon: 'Clock1', tone: 'hold' },
};

/** Same thresholds as the shared CapacityBar: amber from 90%, red above 100%. */
const capacityTone = (percent: number) =>
  percent > 100 ? 'danger' : percent >= 90 ? 'warning' : 'neutral';

const views = [
  { value: 'planning', label: 'Planning' },
  { value: 'operations', label: 'Operations' },
] as const;

export function CommandCenter() {
  const { date, run } = useDispatch();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') === 'operations' ? 'operations' : 'planning';
  return (
    <Page
      inShell
      title="Command center"
      description={`Run for ${shortDay(date)}${run ? ` · ${run.depots.join(' + ')}` : ''}`}
      actions={
        <>
          <SegmentedControl
            label="Command center view"
            value={view}
            options={views}
            onChange={(next) => {
              const query = new URLSearchParams(params);
              if (next === 'planning') query.delete('view');
              else query.set('view', next);
              setParams(query);
            }}
          />
          <Button asChild size="md">
            <Link to={`/dispatcher/queue?date=${date}`}>Open queue</Link>
          </Button>
        </>
      }
    >
      {view === 'planning' ? <PlanningView /> : <OperationsView />}
    </Page>
  );
}

function PlanningView() {
  const { date } = useDispatch();
  const navigate = useNavigate();
  const query = useQuery({
    queryKey: ['dashboard', date, 'command-center'],
    queryFn: () => api(`/dashboard/command-center?date=${date}`, commandCenterSchema),
    refetchInterval: DASHBOARD_POLL_INTERVAL_MS,
  });
  if (query.isPending) return <LoadingState label="Loading the command center…" />;
  if (!query.data) {
    return (
      <ErrorState
        description={message(query.error)}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  }
  const data = query.data;
  const allocated = data.orders.total - data.unallocated;
  const reeferTone = capacityTone(data.reefer.percent);
  return (
    <div className="cc-bento cc-plan">
      <div className="cc-column">
        <OrdersCard orders={data.orders} />
        <div className="cc-kpis">
          <MetricCard
            label="Unallocated"
            value={data.unallocated}
            icon={<img src={icon('Layers')} alt="" />}
          >
            <ProgressBar
              label="Orders allocated"
              tone="positive"
              value={data.orders.total > 0 ? (allocated / data.orders.total) * 100 : 0}
            />
          </MetricCard>
          <MetricCard
            label="Held · next run"
            value={data.held.count}
            badge={data.held.delta === null ? undefined : <DeltaBadge value={data.held.delta} />}
            icon={<img src={icon('Clock')} alt="" />}
          />
          <MetricCard
            label="Hard violations"
            value={data.hardViolations}
            badge={data.hardViolations > 0 ? <Tag kind="blocks-publish" /> : undefined}
            icon={<img src={icon(data.hardViolations > 0 ? 'Xoct1' : 'Shield')} alt="" />}
            iconTone={data.hardViolations > 0 ? 'danger' : undefined}
          />
          {/* Tablet only (Figma 2045:4175): it stands in for the gauge card, which is hidden there. */}
          <MetricCard
            label="Plan quality"
            value={data.quality.score}
            badge={
              data.quality.delta === null ? undefined : <DeltaBadge value={data.quality.delta} />
            }
            icon={<img src={icon('Shield')} alt="" />}
          />
        </div>
        <div className="cc-pair">
          <RiskRadar risks={data.risks} />
          <PlanQuality quality={data.quality} />
        </div>
      </div>
      <div className="cc-column">
        <Card className="wp-inverse cc-reefer">
          <div className="cc-head">
            <h2 className="cc-title">Reefer capacity</h2>
            <span className="wp-icon-well">
              <img src={icon('Snow')} alt="" />
            </span>
          </div>
          <div className="cc-reefer-body">
            <strong>{Math.round(data.reefer.percent)}%</strong>
            <ProgressBar
              label="Reefer capacity used"
              track="inverse"
              tone={reeferTone === 'neutral' ? 'positive' : reeferTone}
              value={data.reefer.percent}
            />
            {data.reefer.note && <p>{data.reefer.note}</p>}
          </div>
        </Card>
        <ActionList
          items={data.actions.map((item) => {
            const { to, icon: name, tone } = actions[item.kind];
            return {
              id: `${item.kind}:${item.id}`,
              title: item.title,
              description: item.detail,
              icon: <img src={icon(name)} alt="" />,
              // A lost vehicle opens its own replan; every other alert opens a page.
              onClick: () =>
                navigate(
                  `/dispatcher/${item.kind === 'vehicle_unavailable' ? `vehicles/${item.id}/replan` : to}?date=${date}`,
                ),
              ...(tone ? { tone } : {}),
            };
          })}
          footer={<PublishWindow />}
        />
      </div>
    </div>
  );
}

function OrdersCard({ orders }: { orders: CommandCenterData['orders'] }) {
  const [key, setKey] = useState(orders.breakdowns[0]?.key ?? '');
  const breakdown = orders.breakdowns.find((item) => item.key === key) ?? orders.breakdowns[0];
  const peak = Math.max(1, ...(breakdown?.bars.map((bar) => bar.orders) ?? []));
  return (
    <Card className="cc-orders">
      <div className="cc-head cc-head--top">
        <div className="cc-stat">
          <p>Orders in tonight’s run</p>
          <div>
            <strong>{orders.total}</strong>
            {orders.deltaPercent !== null && <DeltaBadge value={orders.deltaPercent} unit="%" />}
          </div>
        </div>
        <div className="cc-controls">
          <Dropdown
            label="Break orders down"
            value={breakdown?.key ?? ''}
            options={orders.breakdowns.map((item) => ({ value: item.key, label: item.label }))}
            onChange={setKey}
          />
          {/* Figma shows this control without a behaviour; see IMPLEMENTATION.md §8. */}
          <button type="button" className="wp-icon-well" aria-label="Chart options" disabled>
            <img src={icon('Sliders')} alt="" />
          </button>
        </div>
      </div>
      <ol className="cc-bars" aria-label={`Orders ${breakdown?.label.toLowerCase() ?? ''}`}>
        {breakdown?.bars.map((bar) => (
          <li key={bar.name}>
            <span className="cc-bar-value">{bar.orders}</span>
            <span
              className="cc-bar"
              aria-hidden="true"
              style={{ '--cc-bar': bar.orders / peak } as CSSProperties}
            />
            <span className="cc-bar-name">{bar.name}</span>
          </li>
        ))}
      </ol>
      {orders.insight && <p className="cc-note">{orders.insight}</p>}
    </Card>
  );
}

function RiskRadar({ risks }: { risks: CommandCenterData['risks'] }) {
  return (
    <Card className="cc-risk">
      <div className="cc-head">
        <h2 className="cc-title">
          <img src={icon('Pulse')} alt="" />
          Risk radar
        </h2>
        {risks.nearLimit > 0 && <Tag kind="risk">{risks.nearLimit} near limit</Tag>}
      </div>
      <ul className="wp-list cc-risk-rows">
        {risks.items.map((risk) => {
          const tone = capacityTone(risk.percent);
          return (
            <li key={risk.key} data-tone={tone}>
              <span>{risk.label}</span>
              <ProgressBar
                label={`${risk.label} used`}
                size={8}
                track="muted"
                tone={tone}
                value={risk.percent}
                marker={risk.markerPercent}
              />
              <strong>
                {tone === 'warning' && <img src={icon('Alert1')} alt="Near limit" />}
                {tone === 'danger' && <img src={icon('Xoct2')} alt="Over limit" />}
                {Math.round(risk.percent)}%
              </strong>
            </li>
          );
        })}
      </ul>
      {risks.insight && <p className="cc-note">{risks.insight}</p>}
    </Card>
  );
}

function PlanQuality({ quality }: { quality: CommandCenterData['quality'] }) {
  return (
    <Card className="cc-quality">
      <div className="cc-head">
        <h2 className="cc-title">
          <img src={icon('Shield')} alt="" />
          Plan quality
        </h2>
        {quality.delta !== null && <DeltaBadge value={quality.delta} />}
      </div>
      <Gauge score={quality.score} label="of 100" />
      <ul className="wp-list cc-chips">
        <li>
          <strong>On time</strong> {Math.round(quality.onTimePercent)}%
        </li>
        <li>
          <strong>Fill</strong> {Math.round(quality.fillPercent)}%
        </li>
        <li>
          <strong>Fair</strong> {quality.fairness}
        </li>
      </ul>
    </Card>
  );
}

function PublishWindow() {
  const { run, now } = useDispatch();
  if (!run) return null;
  const opens = Date.parse(run.planning.opensAt);
  const deadline = Date.parse(run.planning.publishBy);
  const minutes = Math.ceil((deadline - now) / 60_000);
  const elapsed = deadline > opens ? ((now - opens) / (deadline - opens)) * 100 : 100;
  const left =
    minutes <= 0
      ? 'Overdue'
      : minutes < 60
        ? `${minutes} min`
        : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return (
    <div className="cc-publish">
      <div>
        <span>
          <img src={icon('Clock')} alt="" />
          Publish by {clock(run.planning.publishBy)}
        </span>
        <strong role="timer">{left}</strong>
      </div>
      <ProgressBar
        label="Planning window elapsed"
        track="muted"
        tone={minutes <= 0 ? 'danger' : 'neutral'}
        value={elapsed}
      />
    </div>
  );
}
