// D06 · Deferral decision center (Figma 2102:6825) and D06a · Confirm deferrals (2040:3005)
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CreateDeferralRequest, DeferralType, ReasonCode } from '@waypoint/shared';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Banner,
  Button,
  Checkbox,
  Chip,
  Dropdown,
  ErrorState,
  Field,
  HistoryDots,
  Icon,
  LoadingState,
  MetricCard,
  Overlay,
  Popover,
  ProgressBar,
  SegmentedControl,
  Tag,
} from '../../components/waypoint';
import { shortDay } from '../../lib/format';
import { type DeferralCandidate, deferralBoardSchema } from './contracts';
import { api, message, noContent } from './data/client';
import { ruleIcons } from './rules';
import { CardHead, planState } from './ui';
import { Page, useDispatch } from './workspace';
import './deferrals.css';

/** Structured reasons a dispatcher can record. Only R-03 is numbered in the design. */
const reasons: { value: ReasonCode; label: string }[] = [
  { value: 'MIXED_BRAND_DISTRICT', label: 'R-01 · No route for this brand and district' },
  { value: 'VEHICLE_UNAVAILABLE', label: 'R-02 · Vehicle unavailable' },
  { value: 'REEFER_REQUIRED', label: 'R-03 · Refrigerated capacity exhausted' },
  { value: 'VAN_REQUIRED', label: 'R-04 · Van capacity exhausted' },
  { value: 'WEIGHT_CAP', label: 'R-05 · Weight capacity exhausted' },
  { value: 'VOLUME_CAP', label: 'R-06 · Volume capacity exhausted' },
  { value: 'TRIP_LIMIT', label: 'R-07 · Trip limit reached' },
  { value: 'FRESH_TIME_BUDGET', label: 'R-08 · Fresh time budget exceeded' },
  { value: 'DAY_TIME_BUDGET', label: 'R-09 · Day time budget exceeded' },
  { value: 'WINDOW_MISSED', label: 'R-10 · Delivery window cannot be met' },
  { value: 'FUEL_QUOTA', label: 'R-11 · Fuel quota exhausted' },
  { value: 'WRONG_DEPOT', label: 'R-12 · No vehicle at the outlet’s depot' },
];

// The API calls a discretionary deferral "prioritized" (SYSTEM_DESIGN §7.4).
const types = [
  { value: 'unavoidable', label: 'Unavoidable' },
  { value: 'prioritized', label: 'Discretionary' },
] as const;

const ordinal = (n: number) =>
  `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const served = (candidate: DeferralCandidate) =>
  `last served ${shortDay(candidate.lastServed).slice(0, 3)}${
    candidate.daysSinceServed > 0 ? ` · ${plural(candidate.daysSinceServed, 'day')}` : ''
  }`;

interface Decision {
  reasonCode: ReasonCode;
  type: DeferralType;
}

export function DeferralCenter() {
  const { date, run } = useDispatch();
  const client = useQueryClient();
  const [params] = useSearchParams();
  const [policy, setPolicy] = useState<string | null>(null);
  const board = useQuery({
    queryKey: ['planning', date, 'deferral-candidates', policy],
    queryFn: () =>
      api(
        `/planning/runs/${date}/deferral-candidates${policy ? `?policy=${policy}` : ''}`,
        deferralBoardSchema,
      ),
    placeholderData: (previous) => previous,
  });
  // Until the dispatcher changes it, the selection is what the policy recommends.
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [justification, setJustification] = useState('');
  const [touched, setTouched] = useState(false);
  const [blockingOnly, setBlockingOnly] = useState(false);
  const [preview, setPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [repeatNotes, setRepeatNotes] = useState<Record<string, string>>({});
  const [done, setDone] = useState<number | null>(null);

  const candidates = board.data?.candidates ?? [];
  const recommended = candidates.filter((item) => item.advice === 'defer');
  const preset = params.get('orders')?.split(',') ?? [];
  const selectedIds =
    picked ??
    new Set(
      preset.length > 0
        ? candidates.filter((item) => preset.includes(item.orderId)).map((item) => item.orderId)
        : recommended.map((item) => item.orderId),
    );
  const selected = candidates.filter((item) => selectedIds.has(item.orderId));
  const decisionOf = (candidate: DeferralCandidate): Decision =>
    decisions[candidate.orderId] ?? {
      reasonCode: candidate.suggestedReason,
      type: candidate.suggestedType,
    };

  const confirm = useMutation({
    mutationFn: async () => {
      for (const candidate of selected) {
        const repeatNote = repeatNotes[candidate.orderId]?.trim();
        const request: CreateDeferralRequest = {
          orderId: candidate.orderId,
          serviceDate: date,
          ...decisionOf(candidate),
          note: repeatNote ? `${justification.trim()} — ${repeatNote}` : justification.trim(),
        };
        await api('/deferrals', noContent, { method: 'POST', body: JSON.stringify(request) });
      }
      return selected.length;
    },
    onSuccess: async (count) => {
      setConfirming(false);
      setPicked(null);
      setJustification('');
      setTouched(false);
      setRepeatNotes({});
      setDone(count);
      await client.invalidateQueries({ queryKey: ['planning', date] });
      await client.invalidateQueries({ queryKey: ['dashboard', date] });
    },
  });

  const header = { title: 'Deferral decision center' };
  if (board.isPending) {
    return (
      <Page {...header} description="Deciding who waits when capacity runs out">
        <LoadingState label="Loading the candidates…" rows={6} />
      </Page>
    );
  }
  if (!board.data) {
    return (
      <Page {...header} description="Deciding who waits when capacity runs out">
        <ErrorState description={message(board.error)} onRetry={() => void board.refetch()} />
      </Page>
    );
  }

  const data = board.data;
  const focus = candidates.find((item) => item.orderId === focusId) ?? selected[0] ?? candidates[0];
  const rows = blockingOnly
    ? candidates.filter((item) => item.reasons.some((reason) => reason.severity === 'blocking'))
    : candidates;
  const repeats = selected.filter((item) => item.repeat);
  const unavoidable = selected.filter((item) => decisionOf(item).type === 'unavoidable').length;
  const ready = selected.length > 0 && justification.trim().length > 0;
  const label = `Confirm ${plural(selected.length, 'deferral')}`;
  const toggle = (id: string) => {
    const next = new Set(selectedIds);
    if (!next.delete(id)) next.add(id);
    setPicked(next);
  };
  const added = selected.filter((item) => item.advice !== 'defer');
  const dropped = recommended.filter((item) => !selectedIds.has(item.orderId));
  const moveTo = shortDay(data.nextRun);
  const summary =
    added.length === 1 && dropped.length === 1 && added[0] && dropped[0]
      ? `You swapped ${dropped[0].outlet.name} for ${added[0].outlet.name} · ${
          selected.length === 2 ? 'both' : 'all'
        } move to ${moveTo}`
      : `${plural(selected.length, 'order')} ${selected.length === 1 ? 'moves' : 'move'} to ${moveTo}`;
  const repeatsReady = repeats.every((item) => repeatNotes[item.orderId]?.trim());
  const openConfirm = () => {
    confirm.reset();
    setConfirming(true);
  };

  return (
    <Page
      {...header}
      description={`Plan v${data.planVersion} ${planState(run)} · ${
        data.shortage ? 'capacity cannot serve every order tonight' : 'capacity covers every order'
      }`}
      actions={
        <>
          <Dropdown
            label="Priority policy"
            value={data.policy.id}
            options={data.policies.map((item) => ({ value: item.id, label: item.name }))}
            onChange={setPolicy}
          />
          <Button
            variant={ready ? 'primary' : 'secondary'}
            size="md"
            disabled={!ready}
            aria-describedby="deferral-lock"
            onClick={openConfirm}
          >
            {label}
          </Button>
        </>
      }
    >
      {done !== null && (
        <Banner tone="success" title={`${plural(done, 'deferral')} recorded`}>
          The orders move to {moveTo}. Store notices go out when the plan is published.
        </Banner>
      )}
      <div className="df-top">
        <article className="wp-card wp-inverse df-short">
          {data.shortage ? (
            <>
              <div className="d-head">
                <h2>{data.shortage.label}</h2>
                <span className="wp-icon-well df-well">
                  <Icon name="snow" />
                </span>
              </div>
              <p className="df-short-value">
                <strong>{data.shortage.count}</strong>
                {data.shortage.detail}
              </p>
              <p className="df-short-bar">
                Needed
                <ProgressBar
                  label="Capacity needed"
                  track="inverse"
                  tone="danger"
                  value={data.shortage.neededPercent}
                />
              </p>
              <p className="df-short-bar df-short-bar--have">
                {data.shortage.capacityLabel}
                <ProgressBar
                  label={data.shortage.capacityLabel}
                  track="inverse"
                  value={data.shortage.capacityPercent}
                />
              </p>
            </>
          ) : (
            <>
              <h2>No shortage</h2>
              <p className="df-short-value">Every remaining order has a feasible trip.</p>
            </>
          )}
        </article>
        <MetricCard
          label="Unallocated orders"
          value={data.unallocated}
          icon={<Icon name="layers" />}
        />
        <MetricCard
          label="Candidates to defer"
          value={candidates.length}
          icon={<Icon name="history" />}
        />
        <MetricCard
          label="Would be a repeat deferral"
          value={candidates.filter((item) => item.repeat).length}
          icon={<Icon name="alert" />}
          iconTone="warning"
        />
      </div>
      <div className="df-main">
        <section className="wp-card df-table" aria-label="Who waits">
          <CardHead title="Who waits · recommended order" icon="bulb">
            <span className="df-hint">rank 1 = defer first</span>
            <Popover icon="sliders" label="Table options" active={blockingOnly}>
              <Checkbox
                label="Only orders a hard rule blocks"
                checked={blockingOnly}
                onChange={(event) => setBlockingOnly(event.target.checked)}
              />
            </Popover>
          </CardHead>
          {rows.length === 0 ? (
            <p className="wp-muted">No orders are waiting on a deferral decision.</p>
          ) : (
            <div className="dq-scroll">
              <table className="wp-rows df-rows">
                <caption className="wp-sr-only">Orders that may be deferred, by rank</caption>
                <thead>
                  <tr>
                    <th className="df-col-check">
                      <span className="wp-sr-only">Defer</span>
                    </th>
                    <th className="df-col-order">Order</th>
                    <th className="df-col-why">Why it is hard to serve</th>
                    <th className="df-col-past">Past deferrals</th>
                    <th className="df-col-since">Since served</th>
                    <th className="df-col-rank">Priority</th>
                    <th>Advice</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((candidate) => {
                    const chosen = selectedIds.has(candidate.orderId);
                    return (
                      <tr
                        key={candidate.orderId}
                        data-selected={chosen || undefined}
                        data-focus={candidate === focus || undefined}
                      >
                        <td>
                          <Checkbox
                            hideLabel
                            label={`Defer ${candidate.outlet.name}`}
                            checked={chosen}
                            onChange={() => {
                              toggle(candidate.orderId);
                              setFocusId(candidate.orderId);
                            }}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="df-open"
                            onClick={() => setFocusId(candidate.orderId)}
                          >
                            <strong>{candidate.outlet.name}</strong>
                            <small>
                              {candidate.outlet.code} · {candidate.weightKg} kg
                            </small>
                          </button>
                        </td>
                        <td>
                          <span className="df-reasons">
                            {candidate.reasons.map((reason) => (
                              <span
                                key={reason.label}
                                className="df-reason"
                                data-severity={reason.severity}
                              >
                                <Icon
                                  name={(reason.rule && ruleIcons[reason.rule]) || 'clock'}
                                  size={11}
                                />
                                {reason.label}
                              </span>
                            ))}
                          </span>
                        </td>
                        <td>
                          <HistoryDots runs={candidate.history} />
                        </td>
                        <td>
                          <span className="df-days">
                            <strong>{candidate.daysSinceServed}</strong> d
                          </span>
                        </td>
                        <td>
                          <span className="df-rank">
                            <b data-defer={candidate.advice === 'defer' || undefined}>
                              {candidate.rank}
                            </b>
                            <ProgressBar
                              label={`Priority to be served: ${Math.round(candidate.priorityPercent)}%`}
                              track="muted"
                              value={candidate.priorityPercent}
                            />
                          </span>
                        </td>
                        <td>
                          <span className="df-advice" data-advice={candidate.advice}>
                            <Icon
                              name={candidate.advice === 'defer' ? 'history' : 'truck'}
                              size={12}
                            />
                            {candidate.advice === 'defer' ? 'Defer' : 'Serve'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="df-weights">
            Priority weights
            {data.policy.weights.map((weight) => (
              <Chip key={weight.label}>
                {weight.label} {Math.round(weight.percent)}%
              </Chip>
            ))}
          </p>
        </section>
        <section className="wp-card df-decision" aria-label="Decision for the selected order">
          {!focus && <p className="wp-muted">Select an order to record its reason.</p>}
          {focus && (
            <>
              <div className="df-subject">
                <span className="wp-icon-well">
                  <Icon name="store" />
                </span>
                <div>
                  <h2 className="d-title">
                    {focus.outlet.name} · {focus.outlet.code}
                  </h2>
                  <span>
                    {focus.reference} · {focus.temp}
                  </span>
                </div>
                <Tag kind="recommended">Rank {focus.rank}</Tag>
              </div>
              <div className="df-facts">
                <h3 className="d-label">Why it is hard to serve</h3>
                <ul className="wp-list">
                  {focus.facts.map((fact) => (
                    <li key={fact.text}>
                      <Icon
                        name={fact.ok ? 'check' : 'xoct'}
                        size={14}
                        className={fact.ok ? 'df-fact-ok' : 'df-fact-hard'}
                      />
                      {fact.text}
                    </li>
                  ))}
                </ul>
              </div>
              <label className="wp-field df-reason-field">
                <span>Structured reason (required)</span>
                <select
                  value={decisionOf(focus).reasonCode}
                  onChange={(event) =>
                    setDecisions({
                      ...decisions,
                      [focus.orderId]: {
                        ...decisionOf(focus),
                        reasonCode: event.target.value as ReasonCode,
                      },
                    })
                  }
                >
                  {reasons.map((reason) => (
                    <option key={reason.value} value={reason.value}>
                      {reason.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="dq-drawer-group">
                <p>Type</p>
                <SegmentedControl
                  label="Deferral type"
                  value={decisionOf(focus).type}
                  options={types}
                  onChange={(type) =>
                    setDecisions({
                      ...decisions,
                      [focus.orderId]: { ...decisionOf(focus), type },
                    })
                  }
                />
              </div>
              <div className="df-notice">
                <p>
                  <Icon name="msg" size={14} />
                  <span>Store notice written from this reason</span>
                  <button
                    type="button"
                    className="d-link df-preview"
                    aria-expanded={preview}
                    onClick={() => setPreview(!preview)}
                  >
                    Preview
                  </button>
                </p>
                {preview && <blockquote>{focus.notice}</blockquote>}
              </div>
            </>
          )}
        </section>
      </div>
      <section className="wp-card df-final" aria-label="Final justification">
        <Field
          label="Final justification (required)"
          value={justification}
          onChange={(event) => setJustification(event.target.value)}
          onBlur={() => setTouched(true)}
          error={
            touched && selected.length > 0 && !justification.trim()
              ? `Explain why ${
                  selected.length === 1
                    ? 'this outlet waits'
                    : `these ${selected.length} outlets wait`
                }. Saved to the audit log with your name.`
              : undefined
          }
          hint="Saved to the audit log with your name."
        />
        <div className="df-final-side">
          <p className="df-final-chips">
            <Chip>{selected.length} selected</Chip>
            <Chip>
              {selected.length > 0 && unavoidable === selected.length
                ? `${selected.length === 2 ? 'Both' : 'All'} unavoidable`
                : `${unavoidable} unavoidable`}
            </Chip>
            <Chip>{repeats.length} repeat</Chip>
          </p>
          <p className="df-lock" id="deferral-lock">
            <Icon name={ready ? 'check' : 'lock'} size={14} />
            {selected.length === 0
              ? 'Select an order to defer'
              : ready
                ? 'Ready to confirm'
                : 'Add a justification to confirm'}
          </p>
        </div>
        <Button
          variant={ready ? 'primary' : 'secondary'}
          size="md"
          disabled={!ready}
          onClick={openConfirm}
        >
          {label}
        </Button>
      </section>
      <Overlay
        variant="modal"
        open={confirming}
        onClose={() => setConfirming(false)}
        title={label}
        icon="history"
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setConfirming(false)}>
              Back
            </Button>
            <Button
              variant={repeatsReady ? 'primary' : 'secondary'}
              size="md"
              disabled={!repeatsReady}
              busy={confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              Confirm deferrals
            </Button>
          </>
        }
      >
        <p className="df-modal-summary">{summary}</p>
        {selected.map((candidate) => (
          <div
            key={candidate.orderId}
            className="df-modal-row"
            data-repeat={candidate.repeat || undefined}
          >
            <div>
              <Icon
                name={candidate.repeat ? 'alert' : 'check'}
                size={18}
                className={candidate.repeat ? 'df-fact-warn' : 'df-fact-ok'}
              />
              <p>
                <strong>{candidate.outlet.name}</strong>
                <span>
                  {candidate.outlet.code} · {served(candidate)}
                </span>
              </p>
              <HistoryDots runs={candidate.history} />
              {candidate.repeat ? (
                <Tag kind="repeat-deferral">
                  {ordinal(candidate.history.filter(Boolean).length)} in {candidate.history.length}{' '}
                  runs
                </Tag>
              ) : (
                <Tag kind="ambient">
                  {decisionOf(candidate).type === 'unavoidable' ? 'Unavoidable' : 'Discretionary'}
                </Tag>
              )}
            </div>
            {candidate.repeat && (
              <Field
                label="Justification (required for repeat deferral)"
                value={repeatNotes[candidate.orderId] ?? ''}
                onChange={(event) =>
                  setRepeatNotes({ ...repeatNotes, [candidate.orderId]: event.target.value })
                }
                error={
                  repeatNotes[candidate.orderId]?.trim()
                    ? undefined
                    : 'Write why this outlet waits again. It is stored in the audit log and shown to the area manager.'
                }
              />
            )}
          </div>
        ))}
        <p className="df-modal-notice">
          <Icon name="msg" />
          {plural(selected.length, 'store notice')} will be sent when the plan is published
        </p>
        {confirm.isError && (
          <Banner tone="danger" title="The deferrals were not all recorded">
            {message(confirm.error)} Check the list before trying again.
          </Banner>
        )}
      </Overlay>
    </Page>
  );
}
