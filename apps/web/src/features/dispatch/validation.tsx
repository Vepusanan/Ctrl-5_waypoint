// D05 · Validation (Figma 2040:2166): violations block publishing, risks only inform.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Banner,
  Button,
  ErrorState,
  Icon,
  LoadingState,
  ProgressBar,
  Ring,
  Tag,
} from '../../components/waypoint';
import { clock } from '../../lib/format';
import { type HardViolation, type RuleGroup, validationSchema } from './contracts';
import { api, message, noContent } from './data/client';
import { ruleExplanations } from './rules';
import { CardHead, capacityTone, planState, StatBars } from './ui';
import { Page, useDispatch } from './workspace';
import './validation.css';

const groups: Record<RuleGroup, { label: string; icon: string }> = {
  capacity: { label: 'Weight / volume', icon: 'box' },
  refrigeration: { label: 'Refrigeration', icon: 'snow' },
  access: { label: 'Outlet access', icon: 'truck' },
  window: { label: 'Time window', icon: 'clock' },
  time: { label: 'Driving time', icon: 'clock' },
  fuel: { label: 'Fuel quota', icon: 'fuel' },
  grouping: { label: 'Brand and district', icon: 'layers' },
};

export function ValidationPage() {
  const { date, run } = useDispatch();
  const client = useQueryClient();
  const key = ['planning', date, 'validation'];
  const report = useQuery({
    queryKey: key,
    queryFn: () => api(`/planning/runs/${date}/validation`, validationSchema),
  });
  const rerun = useMutation({
    mutationFn: () =>
      api(`/planning/runs/${date}/validation`, validationSchema, { method: 'POST' }),
    onSuccess: (data) => client.setQueryData(key, data),
  });

  const header = { title: 'Validation' };
  if (report.isPending) {
    return (
      <Page {...header} description="Checking the draft plan against every rule">
        <LoadingState label="Checking the plan…" rows={5} />
      </Page>
    );
  }
  if (!report.data) {
    return (
      <Page {...header} description="Checking the draft plan against every rule">
        <ErrorState description={message(report.error)} onRetry={() => void report.refetch()} />
      </Page>
    );
  }

  const data = report.data;
  const blocked = data.violations.length;
  const share = (part: number) => (data.orders > 0 ? (part / data.orders) * 100 : 0);
  const tally = new Map<RuleGroup, number>();
  for (const item of [...data.violations, ...data.risks]) {
    tally.set(item.group, (tally.get(item.group) ?? 0) + 1);
  }
  const byRule = [...tally.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <Page
      {...header}
      description={`Plan v${data.planVersion} ${planState(run)} · checked ${clock(data.checkedAt)} · rules are deterministic`}
      actions={
        <>
          <Button
            variant="secondary"
            size="md"
            busy={rerun.isPending}
            onClick={() => rerun.mutate()}
          >
            Re-run checks
          </Button>
          {blocked > 0 ? (
            // The reason is the card heading below: "N rules block publishing".
            <Button variant="secondary" size="md" disabled aria-describedby="validation-verdict">
              Publish
            </Button>
          ) : (
            <Button asChild size="md">
              <Link to={`/dispatcher/review?date=${date}`}>Publish</Link>
            </Button>
          )}
        </>
      }
    >
      {rerun.isError && (
        <Banner tone="danger" title="The checks did not run">
          {message(rerun.error)}
        </Banner>
      )}
      <div className="va-row">
        <section className="wp-card va-result" aria-label="Check result">
          <Ring
            size={200}
            stroke={14}
            segments={[
              { percent: share(data.passing), tone: 'positive' },
              { percent: share(data.risks.length), tone: 'warning' },
              { percent: share(blocked), tone: 'danger' },
            ]}
          >
            <strong className="va-ring-value">{data.passing}</strong>
            <small className="va-ring-label">of {data.orders} pass</small>
          </Ring>
          <div className="va-verdict">
            <h2 id="validation-verdict">
              {blocked === 0
                ? 'No rule blocks publishing'
                : `${blocked} ${blocked === 1 ? 'rule blocks' : 'rules block'} publishing`}
            </h2>
            <p>
              <span className="wp-icon-well tone-danger">
                <Icon name="xoct" />
              </span>
              <strong>{blocked}</strong>
              Hard violations · fix before publish
            </p>
            <p>
              <span className="wp-icon-well tone-warning">
                <Icon name="alert" />
              </span>
              <strong>{data.risks.length}</strong>
              Risks · review, never blocking
            </p>
            <p>
              <span className="wp-icon-well tone-success">
                <Icon name="check" />
              </span>
              <strong>{data.passing}</strong>
              Orders pass every rule
            </p>
          </div>
        </section>
        <section className="wp-card va-rules" aria-label="Findings by rule">
          <CardHead title="By rule" icon="shield" />
          {byRule.length === 0 && <p className="wp-muted">No findings.</p>}
          <StatBars
            bars={byRule.map(([group, count]) => ({ key: group, count, ...groups[group] }))}
          />
          {data.insight && <p className="d-note">{data.insight}</p>}
        </section>
      </div>
      <div className="va-row va-row--even">
        <section className="wp-card va-fix" aria-label="Must fix">
          <CardHead title="Must fix">
            <Tag kind="blocks-publish">{blocked}</Tag>
          </CardHead>
          {blocked === 0 && (
            <p className="wp-muted">Nothing blocks publishing. Review the risks, then publish.</p>
          )}
          {data.violations.map((violation) => (
            <ViolationCard key={violation.id} violation={violation} />
          ))}
        </section>
        <section className="wp-card va-review" aria-label="Risks to review">
          <CardHead title="Review">
            <Tag kind="risk">{data.risks.length}</Tag>
          </CardHead>
          {data.risks.length === 0 && <p className="wp-muted">No risks to review.</p>}
          <ul className="wp-list">
            {data.risks.map((risk) => {
              const to = risk.vehicleId
                ? `/dispatcher/vehicles/${risk.vehicleId}?date=${date}`
                : `/dispatcher/allocate?date=${date}`;
              return (
                <li key={risk.id}>
                  <Link className="wp-action-row va-risk" to={to}>
                    <span className="wp-icon-well tone-warning">
                      <Icon name={groups[risk.group].icon} />
                    </span>
                    <span>
                      <strong>{risk.title}</strong>
                      <small>{risk.detail}</small>
                    </span>
                    {risk.percent !== null && (
                      <span className="va-risk-bar">
                        <ProgressBar
                          label={risk.title}
                          track="muted"
                          tone={capacityTone(risk.percent)}
                          value={risk.percent}
                        />
                      </span>
                    )}
                    {risk.lateRiskPercent !== null && (
                      <span className="d-predict">
                        Late risk {Math.round(risk.lateRiskPercent)}%
                      </span>
                    )}
                    <Icon name="cr" className="d-chevron" />
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="va-legend">
            <span>
              <Icon name="xoct" size={14} className="va-legend-danger" />
              Violation = blocks
            </span>
            <span>
              <Icon name="alert" size={14} className="va-legend-warning" />
              Risk = informs
            </span>
            <span>
              <Icon name="trend" size={14} className="va-legend-predict" />
              Predicted
            </span>
          </p>
        </section>
      </div>
    </Page>
  );
}

function ViolationCard({ violation }: { violation: HardViolation }) {
  const { date } = useDispatch();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [why, setWhy] = useState(false);
  // Refrigeration and access violations are fixed by re-placing the orders on another vehicle.
  const reassignable = violation.group === 'refrigeration' || violation.group === 'access';
  const reassign = useMutation({
    mutationFn: async () => {
      for (const orderId of violation.orderIds) {
        await api(`/planning/runs/${date}/allocations`, noContent, {
          method: 'PUT',
          body: JSON.stringify({ orderId, target: null }),
        });
      }
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['planning', date] });
      await client.invalidateQueries({ queryKey: ['dashboard', date] });
      navigate(`/dispatcher/allocate?date=${date}&orders=${violation.orderIds.join(',')}`);
    },
  });
  const orders = violation.orderIds.length;
  return (
    <article className="va-violation">
      <header>
        <Icon name="xoct" size={18} className="va-legend-danger" />
        <h3>
          {violation.vehicleId} · Trip {violation.tripNo}
        </h3>
        <span>{violation.summary}</span>
      </header>
      <p>{violation.detail}</p>
      {why && <p>{ruleExplanations[violation.rule]}</p>}
      {reassign.isError && <p role="alert">{message(reassign.error)}</p>}
      <div className="d-fix-actions">
        {reassignable ? (
          <Button size="md" busy={reassign.isPending} onClick={() => reassign.mutate()}>
            Reassign {orders} {orders === 1 ? 'order' : 'orders'}
          </Button>
        ) : (
          <Button asChild size="md">
            <Link
              to={`/dispatcher/vehicles/${violation.vehicleId}?date=${date}&trip=${violation.tripNo}`}
            >
              Fix in allocation
            </Link>
          </Button>
        )}
        <Button variant="tertiary" size="md" aria-expanded={why} onClick={() => setWhy(!why)}>
          Why this rule
        </Button>
      </div>
    </article>
  );
}
