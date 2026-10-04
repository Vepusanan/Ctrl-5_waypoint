import type { StoreOrder, TemperatureRequirement } from '@waypoint/shared';
import { Link } from 'react-router-dom';
import { Button, DeltaBadge, ProgressBar } from '../../components/waypoint';
import { catalogueFor, insights, linesFor, readDraft, totals } from './data';
import { PhoneBell } from './shell';
import {
  CardHead,
  canEdit,
  day,
  greeting,
  kg,
  ListRow,
  OrderPill,
  orderPath,
  PageHead,
  Pill,
  plural,
  remaining,
  StoreIcon,
  TempTag,
  ThumbZone,
  tempIcon,
  tempName,
  tempsFor,
  time,
  usePhone,
  Well,
  weekdayName,
} from './ui';
import { useStore } from './workspace';

interface Half {
  temp: TemperatureRequirement;
  item: StoreOrder | null;
  lines: number;
  weightKg: number;
  /** This order's weight against the usual order for the weekday, 0–100. */
  usualPct: number;
}

const ORDERING_WINDOW_MS = 8 * 3_600_000; // Ordering opens at 08:00 and closes at 16:00.
const DONE = ['delivered', 'receipt_confirmed', 'failed'];

function newOrderHref(date: string | null) {
  return date ? `/store/orders/new?date=${date}` : '/store/orders/new';
}

function useHome() {
  const { data, now, user, unread } = useStore();
  const date = data.nextServiceDate ?? data.eligibleServiceDate;
  const catalogue = catalogueFor(data.outlet.brand);
  const draft = date ? readDraft(data.outlet.id, date) : {};
  const halves: Half[] = tempsFor(data.outlet.brand).map((temp) => {
    const products = catalogue.filter((product) => product.temp === temp);
    const usualKg = products.reduce((sum, product) => sum + product.usual * product.unitKg, 0);
    const item =
      data.orders.find(
        ({ order }) =>
          order.requestedDate === date && order.temp === temp && order.status !== 'cancelled',
      ) ?? null;
    const size = item
      ? { lines: linesFor(item.order).length, weightKg: item.order.weightKg }
      : totals(products.map((product) => ({ product, qty: draft[product.sku] ?? 0 })));
    return {
      temp,
      item,
      lines: size.lines,
      weightKg: size.weightKg,
      usualPct: usualKg > 0 ? Math.min(100, (size.weightKg / usualKg) * 100) : 0,
    };
  });
  const sent = halves.flatMap((half) => (half.item ? [half.item] : []));
  const cutoff = data.cutoffAt;
  const open = cutoff !== null && now < Date.parse(cutoff);
  const after = data.serviceDates.find((item) => date !== null && item.date > date)?.date ?? null;
  return {
    data,
    now,
    unread,
    first: user.name.split(' ')[0] ?? user.name,
    date,
    halves,
    sent,
    empty: sent.length === 0 && halves.every((half) => half.lines === 0),
    placeHref: newOrderHref(data.eligibleServiceDate),
    // The run shown has closed and new orders go to a later one.
    locked:
      data.eligibleServiceDate !== null &&
      data.nextServiceDate !== null &&
      data.eligibleServiceDate !== data.nextServiceDate,
    cutoff,
    open,
    left: remaining(cutoff, now),
    elapsedPct: cutoff
      ? ((now - (Date.parse(cutoff) - ORDERING_WINDOW_MS)) / ORDERING_WINDOW_MS) * 100
      : 0,
    cutoffNote: !cutoff
      ? 'No upcoming operating day is open for a new order.'
      : open
        ? `Closes ${time(cutoff)}. Later orders go to ${after ? weekdayName(after) : 'the next operating day'}.`
        : `This run is locked.${data.eligibleServiceDate ? ` New orders are for ${day(data.eligibleServiceDate)}.` : ''}`,
    last: data.orders.find((item) => DONE.includes(item.order.status)) ?? null,
    awaiting: data.orders.find((item) => item.order.status === 'delivered') ?? null,
    openIssues: data.issues.filter((issue) => issue.status === 'open').length,
    resolvedIssues: data.issues.filter((issue) => issue.status === 'resolved').length,
    reliability: insights.reliability(data),
  };
}
type Home = ReturnType<typeof useHome>;

export function StoreHome() {
  const home = useHome();
  return usePhone() ? <HomePhone home={home} /> : <HomeDesktop home={home} />;
}

function OrderStatus({ home }: { home: Home }) {
  const first = home.sent[0];
  if (!first) {
    return (
      <Pill tone="neutral" icon="pen">
        {home.date ? 'Not submitted' : 'No run open'}
      </Pill>
    );
  }
  return <OrderPill status={first.order.status} />;
}

function HomeDesktop({ home }: { home: Home }) {
  const { data, halves, reliability } = home;
  const late = reliability.arrivals.filter((arrival) => arrival.lateMin !== null);
  return (
    <>
      <PageHead
        title={`${greeting(home.now)}, ${home.first}`}
        sub={`Waypoint ${data.outlet.brand} ${data.outlet.district} · ${data.outlet.id}`}
      >
        <Button asChild size="md">
          <Link to={home.placeHref}>{home.locked ? 'Order the next run' : 'Place order'}</Link>
        </Button>
      </PageHead>
      <div className="st-grid st-grid--hero">
        <section className="wp-card st-tall st-order-card">
          <div className="st-card-head">
            <h2>{home.date ? `Order for ${day(home.date)}` : 'Your orders'}</h2>
            <OrderStatus home={home} />
          </div>
          {home.empty ? (
            <div className="st-nested st-empty-order">
              <StoreIcon name="box" size={18} />
              <strong>No current orders</strong>
              <p>
                {home.date
                  ? `Place the order for ${day(home.date)} before the cutoff. ${
                      halves.length > 1 ? 'Chilled and dry go as separate orders.' : ''
                    }`
                  : 'The calendar has no upcoming operating day for a new order.'}
              </p>
            </div>
          ) : (
            <div className="st-halves">
              {halves.map((half) => (
                <Link
                  key={half.temp}
                  className="st-nested st-half"
                  to={half.item ? orderPath(half.item) : home.placeHref}
                >
                  <div className="st-half-head">
                    <StoreIcon name={tempIcon(half.temp)} size={18} />
                    <strong>{tempName(half.temp)}</strong>
                    <TempTag temp={half.temp} />
                  </div>
                  <p className="st-figure">
                    <b>{half.lines}</b>
                    <span>lines · {kg(half.weightKg)}</span>
                  </p>
                  <ProgressBar
                    label={`${tempName(half.temp)} against the usual order`}
                    value={half.usualPct}
                    track="muted"
                  />
                  <small>vs usual {home.date ? weekdayName(home.date) : 'order'}</small>
                </Link>
              ))}
            </div>
          )}
          <p className="st-caption">
            {halves.length > 1
              ? 'Chilled and dry are separate orders. They can arrive on different vehicles.'
              : `Delivery window ${data.outlet.window.open}–${data.outlet.window.close}.`}
          </p>
        </section>
        <section className="wp-card st-tall st-dark st-cutoff">
          <div className="st-card-head">
            <h2>Order cutoff</h2>
            <Well icon="clock" tone="inverse" size={36} />
          </div>
          <div className="st-cutoff-body">
            <p className="st-hero">{home.left}</p>
            <ProgressBar label="Ordering window used" value={home.elapsedPct} track="inverse" />
            <small>{home.cutoffNote}</small>
          </div>
        </section>
      </div>
      <div className="st-grid st-grid--three st-fill">
        <section className="wp-card">
          <CardHead icon="truck" title="On-time arrivals">
            {reliability.deltaPct !== null && <DeltaBadge value={reliability.deltaPct} unit="%" />}
          </CardHead>
          {reliability.arrivals.length === 0 ? (
            <p className="st-caption">Your delivery record appears here after the first one.</p>
          ) : (
            <>
              <p className="st-figure st-figure--md">
                <b>
                  {reliability.arrivals.length - late.length} of {reliability.arrivals.length}
                </b>
                <span>inside the window</span>
              </p>
              <span
                className="st-arrivals"
                role="img"
                aria-label={`${late.length} late of ${reliability.arrivals.length} deliveries`}
              >
                {reliability.arrivals.map((arrival) => (
                  <i key={arrival.date} data-late={arrival.lateMin !== null || undefined} />
                ))}
              </span>
              <p className="st-caption">
                {late.length === 0
                  ? 'No late arrivals in this period.'
                  : `${late.length === 1 ? 'One late arrival' : `${late.length} late arrivals`} (${late
                      .map((arrival) => `${day(arrival.date)}, +${arrival.lateMin} min`)
                      .join('; ')}).`}
              </p>
            </>
          )}
        </section>
        <section className="wp-card">
          <CardHead icon="boxc" title="Last delivery" />
          {home.last ? (
            <ListRow
              title={day(home.last.order.requestedDate)}
              sub={`${plural(home.last.order.units, 'carton')} · ${tempName(home.last.order.temp).toLowerCase()}`}
              to={orderPath(home.last)}
              end={<OrderPill status={home.last.order.status} />}
            />
          ) : (
            <p className="st-caption">No completed deliveries yet.</p>
          )}
          {home.awaiting && (
            <Button asChild variant="secondary" size="md">
              <Link to={`/store/orders/${home.awaiting.order.id}/receipt`}>Confirm receipt</Link>
            </Button>
          )}
        </section>
        <Link className="wp-card st-card-link" to="/store/issues">
          <CardHead icon="alert" title="Issues" />
          <p className="st-figure st-figure--md">
            <b>{home.openIssues}</b>
            <span>open</span>
          </p>
          {home.openIssues > 0 ? (
            <Pill tone="warning" icon="alert">
              With planning
            </Pill>
          ) : (
            <Pill tone="success" icon="check">
              {home.resolvedIssues > 0 ? 'All closed' : 'None reported'}
            </Pill>
          )}
        </Link>
      </div>
    </>
  );
}

function HomePhone({ home }: { home: Home }) {
  const { data, halves, sent } = home;
  const first = sent[0];
  const editable = first && canEdit(first, home.now) ? first : null;
  const closing =
    home.open && home.cutoff !== null && Date.parse(home.cutoff) - home.now < 3_600_000;
  return (
    <>
      <PageHead
        title={data.outlet.district}
        eyebrow={`${data.outlet.id} · ${day(home.now)}`}
        phoneAction={<PhoneBell unread={home.unread} />}
      />
      <section className="wp-card st-dark st-cutoff-phone">
        <small>{home.open ? 'Order cutoff in' : 'Order cutoff'}</small>
        <p className="st-hero">{home.left}</p>
        <ProgressBar
          label="Ordering window used"
          value={home.elapsedPct}
          track="inverse"
          tone={closing ? 'warning' : 'neutral'}
        />
      </section>
      <div className="st-kpis">
        {halves.map((half) => (
          <Link
            key={half.temp}
            className="wp-card st-kpi"
            to={half.item ? orderPath(half.item) : home.placeHref}
          >
            <b>{kg(half.weightKg)}</b>
            <span>
              {tempName(half.temp)} · {plural(half.lines, 'line')}
            </span>
            <Well
              icon={tempIcon(half.temp)}
              tone={half.temp === 'chilled' ? 'chilled' : 'neutral'}
              size={32}
            />
          </Link>
        ))}
      </div>
      <section className="wp-card st-list-card">
        {first ? (
          <ListRow
            icon="check"
            tone="success"
            title={`Order ${first.order.status === 'submitted' ? 'submitted' : 'confirmed'}`}
            sub={`${time(first.order.submittedAt)} · ${
              editable ? `editable until ${time(first.cutoffAt)}` : 'locked by planning'
            }`}
            to={`/store/orders/${first.order.id}/confirmation`}
          />
        ) : (
          <ListRow
            icon="pen"
            title="Order not submitted"
            sub={home.cutoffNote}
            to={home.placeHref}
          />
        )}
        {home.awaiting ? (
          <ListRow
            icon="boxc"
            tone="success"
            title="Delivered · confirm receipt"
            sub={day(home.awaiting.order.requestedDate)}
            to={`/store/orders/${home.awaiting.order.id}/receipt`}
          />
        ) : (
          <ListRow icon="clock" title="ETA window" sub="Sent by 18:00" />
        )}
      </section>
      <ThumbZone>
        {editable ? (
          <Button asChild variant="secondary" className="st-btn-xl">
            <Link to={`/store/orders/${editable.order.id}/edit`}>Edit order</Link>
          </Button>
        ) : (
          <Button asChild className="st-btn-xl">
            <Link to={home.placeHref}>{home.locked ? 'Order the next run' : 'Place order'}</Link>
          </Button>
        )}
      </ThumbZone>
    </>
  );
}
