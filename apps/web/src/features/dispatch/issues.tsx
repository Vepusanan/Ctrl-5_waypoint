import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { issueSchema } from '@waypoint/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Banner,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  StatusBadge,
  Tabs,
  TextArea,
} from '../../components/waypoint';
import { clock, shortDay } from '../../lib/format';
import { issueBoardSchema, type StoreIssueRow } from './contracts';
import { api, message } from './data/client';
import './issues.css';
import { CardHead } from './ui';
import { Page, useDispatch } from './workspace';

const typeLabel: Record<StoreIssueRow['type'], string> = {
  missing: 'Short delivery',
  damaged: 'Damaged goods',
  incorrect: 'Wrong item',
};

const RESOLUTION_MAX = 500;

/** A proof-of-delivery image, or a plain note when the driver captured none or it will not load. */
function Proof({ src, label, missing }: { src: string | null; label: string; missing: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <figure>
      <span className="is-proof-frame">
        {src && !failed ? (
          <img src={src} alt={label} onError={() => setFailed(true)} />
        ) : (
          <span>{failed ? 'Could not load the image' : missing}</span>
        )}
      </span>
      <figcaption>{label}</figcaption>
    </figure>
  );
}

/**
 * Store issues (SRS §28, SYSTEM_DESIGN §9.2): the dispatcher sees every discrepancy a store
 * reported, with the delivery it is about, and closes it with a note the store can read.
 */
export function StoreIssues() {
  const { date } = useDispatch();
  const client = useQueryClient();
  const [tab, setTab] = useState<StoreIssueRow['status']>('open');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [resolution, setResolution] = useState('');
  const [touched, setTouched] = useState(false);
  const board = useQuery({
    queryKey: ['dashboard', date, 'store-issues'],
    queryFn: () => api('/issues/board', issueBoardSchema),
    refetchInterval: 30_000,
  });
  const resolve = useMutation({
    mutationFn: (issue: StoreIssueRow) =>
      api(`/issues/${issue.id}/resolve`, issueSchema, {
        method: 'POST',
        body: JSON.stringify({ resolution: resolution.trim() }),
      }),
    onSuccess: async () => {
      setResolution('');
      setTouched(false);
      await client.invalidateQueries({ queryKey: ['dashboard', date] });
    },
  });

  if (board.isPending) {
    return (
      <Page title="Store issues" inShell>
        <LoadingState label="Loading store issues…" rows={4} />
      </Page>
    );
  }
  if (!board.data) {
    return (
      <Page title="Store issues" inShell>
        <ErrorState
          description={message(board.error)}
          onRetry={() => void board.refetch()}
          retrying={board.isFetching}
        />
      </Page>
    );
  }

  const open = board.data.items.filter((issue) => issue.status === 'open');
  const resolved = board.data.items.filter((issue) => issue.status === 'resolved');
  const listed = tab === 'open' ? open : resolved;
  const selected = listed.find((issue) => issue.id === selectedId) ?? listed[0] ?? null;
  const empty = resolution.trim().length === 0;

  return (
    <Page
      title="Store issues"
      description="Shortages, damage and wrong items reported by stores · linked to a delivery"
      inShell
      actions={
        <Tabs
          label="Issues shown"
          value={tab}
          onChange={(next) => {
            setTab(next);
            setSelectedId(null);
            resolve.reset();
          }}
          options={[
            { value: 'open', label: `Open · ${open.length}` },
            { value: 'resolved', label: `Resolved · ${resolved.length}` },
          ]}
        />
      }
    >
      {resolve.isSuccess && (
        <Banner tone="success" title="Issue resolved">
          The store manager has been told and can read your note on the issue.
        </Banner>
      )}
      {listed.length === 0 || selected === null ? (
        <EmptyState
          title={tab === 'open' ? 'No open store issues' : 'No resolved issues yet'}
          description={
            tab === 'open'
              ? 'A discrepancy a store reports on a delivery appears here.'
              : 'Issues you resolve are kept here with your note.'
          }
        />
      ) : (
        <div className="is-layout">
          <section
            className="wp-card"
            aria-label={tab === 'open' ? 'Open issues' : 'Resolved issues'}
          >
            <CardHead title={tab === 'open' ? 'Needs a decision' : 'Resolved'} />
            <ul className="is-list">
              {listed.map((issue) => (
                <li key={issue.id}>
                  <button
                    type="button"
                    className="is-item"
                    aria-pressed={issue.id === selected.id}
                    onClick={() => {
                      setSelectedId(issue.id);
                      setResolution('');
                      setTouched(false);
                      resolve.reset();
                    }}
                  >
                    <span className="is-item-text">
                      <span className="is-item-title">
                        {issue.outlet.name} · {typeLabel[issue.type]}
                      </span>
                      <span className="is-item-note">{issue.note ?? 'No note from the store'}</span>
                      <span className="is-item-note">
                        {issue.reference} · reported {shortDay(issue.reportedAt)}{' '}
                        {clock(issue.reportedAt)}
                      </span>
                    </span>
                    <StatusBadge
                      status={issue.status === 'open' ? 'issue-open' : 'resolved'}
                      label={issue.status === 'open' ? 'Open' : 'Resolved'}
                    />
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="wp-card" aria-label="Issue detail">
            <CardHead title={`${selected.outlet.code} · ${typeLabel[selected.type]}`}>
              <Link
                className="d-link"
                to={`/dispatcher/orders?date=${date}&order=${selected.orderId}`}
              >
                Audit trail
              </Link>
            </CardHead>
            <dl className="is-facts">
              <dt>Order</dt>
              <dd>
                {selected.reference} · {selected.outlet.name}
              </dd>
              <dt>Store says</dt>
              <dd>{selected.note ?? 'No note'}</dd>
              <dt>Reported</dt>
              <dd>
                {shortDay(selected.reportedAt)} {clock(selected.reportedAt)}
              </dd>
              <dt>Delivery</dt>
              <dd>
                {selected.delivery
                  ? `${selected.delivery.vehicleId} trip ${selected.delivery.tripNo}${
                      selected.delivery.recipient
                        ? ` · received by ${selected.delivery.recipient}`
                        : ''
                    }`
                  : 'No delivery record'}
              </dd>
              {selected.resolvedAt && (
                <>
                  <dt>Resolved</dt>
                  <dd>
                    {shortDay(selected.resolvedAt)} {clock(selected.resolvedAt)}
                  </dd>
                  <dt>Resolution</dt>
                  <dd>{selected.resolution ?? '—'}</dd>
                </>
              )}
            </dl>
            <div className="is-proof">
              <Proof
                src={selected.delivery?.signatureUrl ?? null}
                label="Recipient signature"
                missing="No signature recorded"
              />
              <Proof
                src={selected.delivery?.photoUrl ?? null}
                label="Delivery photo"
                missing="No photo taken"
              />
            </div>
            {selected.status === 'open' && (
              <form
                className="is-resolve"
                onSubmit={(event) => {
                  event.preventDefault();
                  setTouched(true);
                  if (!empty) resolve.mutate(selected);
                }}
              >
                <TextArea
                  label="Resolution (required)"
                  value={resolution}
                  maxLength={RESOLUTION_MAX}
                  onChange={(event) => setResolution(event.target.value)}
                  hint="The store manager reads this on the issue. Say what was decided."
                  error={
                    touched && empty
                      ? 'Write what was decided before resolving the issue.'
                      : resolve.isError
                        ? message(resolve.error)
                        : undefined
                  }
                />
                <div className="is-resolve-actions">
                  <Button type="submit" size="md" busy={resolve.isPending}>
                    Resolve issue
                  </Button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </Page>
  );
}
