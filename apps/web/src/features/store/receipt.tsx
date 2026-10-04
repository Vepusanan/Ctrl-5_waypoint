import * as Dialog from '@radix-ui/react-dialog';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../components/waypoint';
import { message } from '../../lib/api';
import type { ReceiptLine } from './contracts';
import { insights, orderName, storeApi } from './data';
import { OrderPicker, type OrderScreenProps } from './order-page';
import {
  CardHead,
  ListRow,
  OrderPill,
  PageHead,
  Pill,
  plural,
  Stepper,
  StoreIcon,
  Strip,
  TempTag,
  ThumbZone,
  time,
  usePhone,
  Well,
} from './ui';
import { useStore } from './workspace';

/** S06-W and S06: the driver's proof of delivery, counted by the store and confirmed. */
/** A proof-of-delivery image from the driver, or a plain note when there is none to show. */
function PodImage({
  src,
  alt,
  missing,
  icon,
}: {
  src: string | null;
  alt: string;
  missing: string;
  icon: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="st-pod-tile">
      {src && !failed ? (
        <img src={src} alt={alt} onError={() => setFailed(true)} />
      ) : (
        <>
          <StoreIcon name={icon} size={22} />
          <small>{failed ? 'Could not load the image' : missing}</small>
        </>
      )}
    </span>
  );
}

export function Receipt({ detail, onChanged }: OrderScreenProps) {
  const { writable } = useStore();
  const phone = usePhone();
  const { order, delivery } = detail;
  const extras = insights.delivery(detail);
  const lines = insights.receiptLines(detail);
  const [counts, setCounts] = useState<Record<string, number>>(() =>
    Object.fromEntries(lines.map((line) => [line.product.sku, line.handedOver])),
  );
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const receipt = delivery?.receipt ?? null;
  const ready = order.status === 'delivered' && delivery?.status === 'delivered';
  const base = `/store/orders/${order.id}`;
  const shortage = extras.shortage;
  const got = (line: ReceiptLine) => counts[line.product.sku] ?? line.handedOver;
  // A shortage planning already announced is not reported a second time.
  const known = (line: ReceiptLine) =>
    shortage?.sku === line.product.sku && line.handedOver < line.qty;
  const ordered = lines.reduce((sum, line) => sum + line.qty, 0);
  const handed = lines.reduce((sum, line) => sum + line.handedOver, 0);
  const received = lines.reduce((sum, line) => sum + got(line), 0);
  const differs = lines.filter((line) => got(line) !== line.handedOver);
  const topUp = shortage?.topUp ? ` · top-up ${time(shortage.topUp.eta)}` : '';

  const confirm = useMutation({
    mutationFn: async () => {
      if (!delivery) throw new Error('This delivery is not ready to confirm.');
      if (differs.length > 0) {
        await storeApi.reportIssue({
          orderId: order.id,
          type: 'missing',
          note: differs
            .map(
              (line) =>
                `${Math.abs(line.handedOver - got(line))} cartons ${got(line) < line.handedOver ? 'short' : 'extra'} · ${line.product.name}`,
            )
            .join('; '),
        });
      }
      return storeApi.confirmReceipt(delivery.stopId);
    },
    onSuccess: async () => {
      setDone(true);
      await onChanged();
    },
    onError: (cause) => setError(message(cause)),
  });
  const submit = () => {
    setError('');
    confirm.mutate();
  };
  const confirmLabel =
    differs.length > 0 ? `Confirm with ${plural(differs.length, 'issue')}` : 'Confirm receipt';
  const sub = delivery
    ? `${delivery.vehicleId} · ${delivery.deliveredAt ? `arrived ${time(delivery.deliveredAt)}` : 'not arrived yet'}`
    : orderName(order.id);
  const problem = error && (
    <Strip tone="danger" icon="xoct">
      {error}
    </Strip>
  );
  const waiting = !ready && !receipt && (
    <p className="st-caption">Receipt confirmation opens after the driver records the delivery.</p>
  );
  const lineStatus = (line: ReceiptLine) =>
    known(line) && got(line) === line.handedOver ? (
      <Pill tone="warning" icon="alert">
        Short · pre-notified
      </Pill>
    ) : got(line) === line.handedOver ? (
      <Pill tone="success" icon="cc">
        Matches
      </Pill>
    ) : (
      <Pill tone="warning" icon="alert">
        {Math.abs(line.handedOver - got(line))} {got(line) < line.handedOver ? 'short' : 'extra'}
      </Pill>
    );
  const modal = (
    <Dialog.Root open={done} onOpenChange={setDone}>
      <Dialog.Portal>
        <Dialog.Overlay className="wp-overlay" />
        <Dialog.Content className="st-modal" aria-describedby={undefined}>
          <span className="st-big-check" data-size="sm">
            <StoreIcon name="check" size={24} />
          </span>
          <Dialog.Title>Receipt confirmed</Dialog.Title>
          <p>
            {orderName(order.id)} · {received} of {ordered}
            {delivery?.receipt ? ` · ${time(delivery.receipt.confirmedAt)}` : ''} · delivery loop
            closed
          </p>
          <Pill tone="neutral" icon="zap">
            {differs.length > 0
              ? 'Dispatcher gets a receipt issue'
              : 'Dispatcher now sees Receipt confirmed'}
          </Pill>
          <div className="st-modal-actions">
            <Button asChild variant="secondary" size="md">
              <Link to={base}>View order</Link>
            </Button>
            <Button asChild size="md">
              <Link to="/store">Back to home</Link>
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );

  if (phone) {
    return (
      <>
        <PageHead
          title={receipt ? 'Receipt confirmed' : 'Confirm receipt'}
          eyebrow={sub}
          back={base}
        />
        <section className="wp-card st-count-phone">
          <div className="st-eta-row">
            <p className="st-figure">
              <b>{received}</b>
              <span>cartons received</span>
            </p>
            <Pill tone="neutral" icon="eye">
              From driver
            </Pill>
          </div>
          <span className="st-split" aria-hidden="true">
            <i style={{ flexGrow: received }} />
            {ordered > received && <i data-short style={{ flexGrow: ordered - received }} />}
          </span>
          <p className="st-caption">
            {differs.length === 0
              ? `Matches the driver’s record (${received} of ${handed}${shortage ? ' after the change' : ''}).`
              : `${plural(differs.length, 'line')} differ from the driver’s record.`}
          </p>
        </section>
        <section className="wp-card st-list-card">
          {lines.map((line) => (
            <ListRow
              key={line.product.sku}
              icon={known(line) ? 'info' : 'check'}
              tone={known(line) ? 'warning' : 'success'}
              title={line.product.name}
              sub={
                known(line)
                  ? `${line.qty - line.handedOver} short · pre-notified${topUp}`
                  : plural(got(line), 'carton')
              }
              end={
                !known(line) &&
                !receipt && (
                  <Link className="st-issue-link" to={`${base}/issue?sku=${line.product.sku}`}>
                    Issue?
                  </Link>
                )
              }
            />
          ))}
        </section>
        {problem}
        {waiting}
        <ThumbZone>
          {receipt ? (
            <Button asChild variant="secondary" className="st-btn-xl">
              <Link to="/store">Back to home</Link>
            </Button>
          ) : (
            <Button
              className="st-btn-xl"
              busy={confirm.isPending}
              disabled={!writable || !ready}
              onClick={submit}
            >
              {confirmLabel}
            </Button>
          )}
        </ThumbZone>
        {modal}
      </>
    );
  }

  return (
    <>
      <PageHead
        title={receipt ? 'Receipt confirmed' : 'Confirm receipt'}
        sub={`${sub}${delivery?.pod ? ' · pre-filled from the driver’s proof of delivery' : ''}`}
      >
        <OrderPicker current={order.id} receipts />
        {receipt ? (
          <OrderPill status="receipt_confirmed" />
        ) : (
          <>
            <Button asChild variant="secondary" size="md">
              <Link to={`${base}/issue`}>Report an issue</Link>
            </Button>
            <Button
              size="md"
              busy={confirm.isPending}
              disabled={!writable || !ready}
              onClick={submit}
            >
              {confirmLabel}
            </Button>
          </>
        )}
      </PageHead>
      {problem}
      <div className="st-grid st-grid--hero">
        <section className="wp-card st-mid">
          <div className="st-eta-head">
            <div>
              <small>Cartons received</small>
              <p className="st-figure st-figure--hero">
                <b>{received}</b>
                <span>of {ordered} ordered</span>
              </p>
            </div>
            <Pill tone="neutral" icon="eye">
              From driver POD
            </Pill>
          </div>
          <span className="st-split" aria-hidden="true">
            <i style={{ flexGrow: received }} />
            {ordered > received && <i data-short style={{ flexGrow: ordered - received }} />}
          </span>
          <ul className="st-legend">
            <li data-key="done">
              {received} received ·{' '}
              {differs.length === 0 ? 'match the driver' : 'differs from the driver'}
            </li>
            {ordered > received && (
              <li data-key="short">
                {ordered - received} short
                {shortage ? ` · told ${time(shortage.toldAt)}${topUp}` : ''}
              </li>
            )}
          </ul>
          {waiting}
        </section>
        <section className="wp-card st-mid st-dark st-pod">
          <div className="st-card-head">
            <h2>Proof of delivery</h2>
            <Well icon="pen" tone="inverse" size={36} />
          </div>
          <div className="st-pod-tiles">
            <PodImage
              src={delivery?.pod ? insights.podImage(delivery.stopId, 'signature') : null}
              alt={delivery?.pod ? `Signature of ${delivery.pod.recipientName}` : ''}
              missing="No signature yet"
              icon="pen"
            />
            <PodImage
              src={delivery?.pod?.hasPhoto ? insights.podImage(delivery.stopId, 'photo') : null}
              alt="Delivery photo taken by the driver"
              missing="No photo"
              icon="camera"
            />
          </div>
          <small>
            {delivery?.pod
              ? `${delivery.pod.recipientName} · captured ${time(delivery.pod.clientTime)}${
                  extras.podSyncedAt ? ` offline · synced ${time(extras.podSyncedAt)}` : ''
                }`
              : 'The driver has not recorded this delivery yet.'}
          </small>
        </section>
      </div>
      <section className="wp-card">
        <CardHead icon="list" title="Lines" note="change a count only if it differs" />
        <div className="st-table-scroll">
          <table className="wp-rows st-receipt-table">
            <thead>
              <tr>
                <th>Product</th>
                <th>Temp</th>
                <th className="wp-num">Ordered</th>
                <th className="wp-num">Handed over</th>
                <th className="st-center">Received</th>
                <th>Status</th>
                <th>
                  <span className="wp-sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.product.sku}>
                  <td>
                    {line.product.name}
                    <small>{line.product.sku}</small>
                  </td>
                  <td>
                    <TempTag temp={line.product.temp} />
                  </td>
                  <td className="wp-num">{line.qty}</td>
                  <td className="wp-num">{line.handedOver}</td>
                  <td className="st-center">
                    <Stepper
                      label={`${line.product.name} received`}
                      size={36}
                      value={got(line)}
                      max={line.qty}
                      disabled={Boolean(receipt) || !ready}
                      flag={got(line) !== line.qty}
                      onChange={(value) =>
                        setCounts((current) => ({ ...current, [line.product.sku]: value }))
                      }
                    />
                  </td>
                  <td>{lineStatus(line)}</td>
                  <td>
                    {known(line) ? (
                      <span className="st-quiet">
                        {shortage?.topUp ? `Top-up ${time(shortage.topUp.eta)}` : 'With planning'}
                      </span>
                    ) : (
                      !receipt && (
                        <Link
                          className="st-issue-link"
                          to={`${base}/issue?sku=${line.product.sku}`}
                        >
                          <StoreIcon name="alert" size={14} />
                          Issue
                        </Link>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {modal}
    </>
  );
}
