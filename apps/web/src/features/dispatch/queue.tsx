// D02 · Planning queue (Figma 2038:1782)
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Button,
  Checkbox,
  Chip,
  DeltaBadge,
  Dropdown,
  EmptyState,
  ErrorState,
  HistoryDots,
  Icon,
  IconButton,
  LoadingState,
  MetricCard,
  Popover,
  StatusBadge,
  Tabs,
  Tag,
} from '../../components/waypoint';
import { downloadCsv } from '../../lib/csv';
import { clock, shortDay, weekDay } from '../../lib/format';
import {
  planningQueueSchema,
  type QueueFilters,
  type QueueOrder,
  savedViewListSchema,
} from './contracts';
import { api, message } from './data/client';
import {
  type FilterKey,
  filterChoices,
  filterNames,
  hasFilters,
  matches,
  sameFilters,
  tagKinds,
  withFilter,
} from './queue-filters';
import { SavedViewsDrawer } from './queue-views';
import { Page, useDispatch } from './workspace';
import './queue.css';

type Tab = 'action' | 'held' | 'all';
const inTab: Record<Tab, (order: QueueOrder) => boolean> = {
  action: (order) => order.state.kind === 'unallocated',
  held: (order) => order.state.kind === 'held',
  all: () => true,
};

const columns = [
  { id: 'temp', label: 'Temp' },
  { id: 'kg', label: 'Kg' },
  { id: 'window', label: 'Window' },
  { id: 'constraints', label: 'Constraints' },
  { id: 'history', label: 'Last 4 runs' },
] as const;
type ColumnId = (typeof columns)[number]['id'];

function exportCsv(date: string, orders: readonly QueueOrder[]) {
  downloadCsv(
    `planning-queue-${date}.csv`,
    ['Order', 'Outlet code', 'Outlet', 'Brand', 'Temp', 'Kg', 'Window', 'Constraints', 'Status'],
    orders.map((order) => [
      order.reference,
      order.outlet.code,
      order.outlet.name,
      order.brand,
      order.temp,
      order.weightKg,
      `${order.window.open}-${order.window.close}`,
      order.tags.join(' '),
      order.state.kind === 'allocated'
        ? `${order.state.vehicleId} T${order.state.tripNo}`
        : order.state.kind === 'held'
          ? `held until ${order.state.until}`
          : 'unallocated',
    ]),
  );
}

function OrderStatus({ state }: { state: QueueOrder['state'] }) {
  if (state.kind === 'allocated') {
    return <StatusBadge status="allocated" label={`${state.vehicleId} · T${state.tripNo}`} />;
  }
  if (state.kind === 'held') return <StatusBadge status="deferred" label={weekDay(state.until)} />;
  return <StatusBadge status="planning" label="Unallocated" />;
}

export function PlanningQueuePage() {
  const { date, dates, setDate, run } = useDispatch();
  const navigate = useNavigate();
  const queue = useQuery({
    queryKey: ['planning', date, 'queue'],
    queryFn: () => api(`/planning/runs/${date}/queue`, planningQueueSchema),
  });
  const views = useQuery({
    queryKey: ['planning', 'views'],
    queryFn: () => api('/planning/views', savedViewListSchema),
  });
  const [tab, setTab] = useState<Tab>('action');
  const [filters, setFilters] = useState<QueueFilters>({});
  const [search, setSearch] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<ColumnId>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [drawer, setDrawer] = useState(false);

  const orders = queue.data?.items ?? [];
  const rows = useMemo(() => {
    const term = search?.trim().toLowerCase() ?? '';
    return orders.filter(
      (order) =>
        inTab[tab](order) &&
        matches(order, filters) &&
        (!term ||
          `${order.reference} ${order.outlet.name} ${order.outlet.code}`
            .toLowerCase()
            .includes(term)),
    );
  }, [orders, tab, filters, search]);
  const chosen = rows.filter((order) => selected.has(order.id));
  const ids = chosen.map((order) => order.id).join(',');

  // Bulk shortcuts A, D and H act on the selection, as hinted on the bulk bar.
  useEffect(() => {
    if (!ids) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (target.closest('input:not([type="checkbox"]), textarea, select, [role="dialog"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'a') navigate(`/dispatcher/allocate?date=${date}&orders=${ids}`);
      if (key === 'd') navigate(`/dispatcher/deferrals?date=${date}&orders=${ids}`);
      if (key === 'h') navigate(`/dispatcher/orders?date=${date}&order=${ids.split(',')[0]}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ids, date, navigate]);

  if (queue.isPending) return <LoadingState label="Loading the planning queue…" rows={6} />;
  if (!queue.data) {
    return <ErrorState description={message(queue.error)} onRetry={() => void queue.refetch()} />;
  }

  const count = (test: (order: QueueOrder) => boolean) => orders.filter(test).length;
  const unallocated = count(inTab.action);
  const held = count(inTab.held);
  const choices = filterChoices(orders);
  const show = (id: ColumnId) => !hidden.has(id);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (!next.delete(id)) next.add(id);
    setSelected(next);
  };
  const allChosen = rows.length > 0 && chosen.length === rows.length;

  return (
    <Page
      title="Planning queue"
      description={`One queue for ${shortDay(date)} · ${run && !run.intake.closed ? 'open until' : 'closed at'} ${clock(queue.data.cutoffAt)}`}
      actions={
        <>
          <Dropdown
            label="Service date"
            value={date}
            options={dates.map((item) => ({ value: item, label: shortDay(item) }))}
            onChange={setDate}
          />
          <Button variant="secondary" size="md" onClick={() => exportCsv(date, rows)}>
            Export
          </Button>
          <Button asChild size="md">
            <Link to={`/dispatcher/allocate?date=${date}`}>
              {unallocated > 0 ? `Allocate ${unallocated}` : 'Open allocation'}
            </Link>
          </Button>
        </>
      }
    >
      <div className="d-kpis">
        <MetricCard
          label="Confirmed orders"
          value={queue.data.total}
          badge={
            queue.data.deltaPercent === null ? undefined : (
              <DeltaBadge value={queue.data.deltaPercent} unit="%" />
            )
          }
          icon={<Icon name="check" />}
        />
        <MetricCard label="Unallocated" value={unallocated} icon={<Icon name="layers" />} />
        <MetricCard
          label="Chilled"
          value={count((order) => order.temp === 'chilled')}
          icon={<Icon name="snow" />}
          iconTone="chilled"
        />
        <MetricCard
          label="Held · next run"
          value={held}
          icon={<Icon name="clock" />}
          iconTone="hold"
        />
      </div>
      <section className="wp-card dq-card" aria-label="Orders">
        <div className="dq-toolbar">
          <Tabs
            label="Queue views"
            value={tab}
            onChange={(next) => {
              setTab(next);
              setSelected(new Set());
            }}
            options={[
              { value: 'action', label: `Needs action · ${unallocated}` },
              { value: 'held', label: `Held · next run · ${held}` },
              { value: 'all', label: `All orders · ${queue.data.total}` },
            ]}
          />
          {search !== null && (
            <input
              // biome-ignore lint/a11y/noAutofocus: the field appears because the user asked to search
              autoFocus
              type="search"
              className="dq-search"
              aria-label="Search the queue"
              placeholder="Order, outlet or code"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          )}
          <IconButton
            icon="search"
            label={search === null ? 'Search the queue' : 'Close search'}
            active={search !== null}
            onClick={() => setSearch(search === null ? '' : null)}
          />
          <Popover icon="filter" label="Filter orders" active={hasFilters(filters)}>
            {(Object.keys(choices) as FilterKey[]).map((key) => (
              <div className="dq-filter" key={key}>
                <span>{filterNames[key]}</span>
                <Dropdown
                  label={filterNames[key]}
                  value={filters[key] ?? ''}
                  options={[{ value: '', label: 'Any' }, ...choices[key]]}
                  onChange={(value) => setFilters(withFilter(filters, key, value))}
                />
              </div>
            ))}
            <Button
              variant="secondary"
              size="md"
              disabled={!hasFilters(filters)}
              onClick={() => setFilters({})}
            >
              Clear filters
            </Button>
          </Popover>
          <Popover icon="cols" label="Choose columns" active={hidden.size > 0}>
            {columns.map((column) => (
              <Checkbox
                key={column.id}
                label={column.label}
                checked={show(column.id)}
                onChange={() => {
                  const next = new Set(hidden);
                  if (!next.delete(column.id)) next.add(column.id);
                  setHidden(next);
                }}
              />
            ))}
          </Popover>
        </div>
        <div className="dq-chips">
          <Icon name="eye" size={14} />
          {views.data?.items
            .filter((view) => view.pinned)
            .map((view) => {
              const active = sameFilters(view.filters, filters);
              return (
                <Chip
                  key={view.id}
                  count={count((order) => matches(order, view.filters))}
                  accent={view.filters.tag === 'repeat_deferral'}
                  active={active}
                  onClick={() => {
                    setFilters(active ? {} : view.filters);
                    if (!active) setTab('all');
                  }}
                >
                  {view.name}
                </Chip>
              );
            })}
          <Chip dashed icon="plus" onClick={() => setDrawer(true)}>
            Save view
          </Chip>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            title="No orders match"
            description="Change the tab, the search or the filters to see more orders."
            action={
              (hasFilters(filters) || search) && (
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => {
                    setFilters({});
                    setSearch(null);
                  }}
                >
                  Clear search and filters
                </Button>
              )
            }
          />
        ) : (
          <div className="dq-scroll">
            <table className="wp-rows dq-table">
              <caption className="wp-sr-only">Orders in the planning queue</caption>
              <thead>
                <tr>
                  <th className="dq-col-check">
                    <Checkbox
                      hideLabel
                      label="Select all orders shown"
                      checked={allChosen}
                      indeterminate={chosen.length > 0 && !allChosen}
                      onChange={() =>
                        setSelected(allChosen ? new Set() : new Set(rows.map((order) => order.id)))
                      }
                    />
                  </th>
                  <th className="dq-col-order">Order</th>
                  <th className="dq-col-outlet">Outlet</th>
                  {show('temp') && <th className="dq-col-temp">Temp</th>}
                  {show('kg') && <th className="dq-col-kg wp-num">Kg</th>}
                  {show('window') && <th className="dq-col-window">Window</th>}
                  {show('constraints') && <th className="dq-col-tags">Constraints</th>}
                  {show('history') && <th className="dq-col-history">Last 4 runs</th>}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((order) => (
                  <tr key={order.id} data-selected={selected.has(order.id) || undefined}>
                    <td>
                      <Checkbox
                        hideLabel
                        label={`Select ${order.reference}`}
                        checked={selected.has(order.id)}
                        onChange={() => toggle(order.id)}
                      />
                    </td>
                    <td className="wp-mono">{order.reference}</td>
                    <td>
                      <strong>{order.outlet.name}</strong>
                      <small>
                        {order.outlet.code} · {order.brand}
                      </small>
                    </td>
                    {show('temp') && (
                      <td>
                        <Tag kind={order.temp === 'chilled' ? 'chilled' : 'ambient'} />
                      </td>
                    )}
                    {show('kg') && <td className="wp-num">{order.weightKg}</td>}
                    {show('window') && (
                      <td>
                        {order.window.open}–{order.window.close}
                      </td>
                    )}
                    {show('constraints') && (
                      <td>
                        <span className="dq-tags">
                          {order.tags.map((tag) => (
                            <Tag key={tag} kind={tagKinds[tag]} />
                          ))}
                        </span>
                      </td>
                    )}
                    {show('history') && (
                      <td>
                        <HistoryDots runs={order.history} />
                      </td>
                    )}
                    <td>
                      <OrderStatus state={order.state} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {chosen.length > 0 && (
          <div className="d-bulk" role="toolbar" aria-label="Actions for the selected orders">
            <span role="status">{chosen.length} selected</span>
            <Link to={`/dispatcher/allocate?date=${date}&orders=${ids}`}>
              <Icon name="layers" size={14} />
              Assign <kbd>A</kbd>
            </Link>
            <Link to={`/dispatcher/deferrals?date=${date}&orders=${ids}`}>
              <Icon name="history" size={14} />
              Defer <kbd>D</kbd>
            </Link>
            <Link to={`/dispatcher/orders?date=${date}&order=${chosen[0]?.id}`}>
              <Icon name="eye" size={14} />
              History <kbd>H</kbd>
            </Link>
          </div>
        )}
      </section>
      <SavedViewsDrawer
        open={drawer}
        onClose={() => setDrawer(false)}
        orders={orders}
        views={views.data?.items ?? []}
        initialFilters={filters}
      />
    </Page>
  );
}
