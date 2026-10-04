import { useMutation } from '@tanstack/react-query';
import type { NotificationFeedItem, NotificationType } from '@waypoint/shared';
import { useNavigate } from 'react-router-dom';
import { Button, Icon } from '../../components/waypoint';
import { useAuth } from '../auth/auth';
import { insights, storeApi } from './data';
import { Empty } from './states';
import { day, PageHead, StoreIcon, time, usePhone, Well } from './ui';
import { useStore } from './workspace';

type WellTone = 'success' | 'warning' | 'info' | 'danger';
const look: Record<NotificationType, [icon: string, tone: WellTone]> = {
  order_confirmed: ['check', 'success'],
  order_deferred: ['skip', 'warning'],
  plan_published: ['cal', 'info'],
  plan_changed: ['cal', 'info'],
  loading_shortfall: ['alert', 'warning'],
  delivery_failed: ['xoct', 'danger'],
  delivery_issue: ['alert', 'warning'],
  delivered: ['boxc', 'success'],
  receipt_discrepancy: ['alert', 'warning'],
  sync_conflict: ['clock', 'warning'],
  issue_resolved: ['check', 'success'],
};

/** Where a notice leads: the order's notice, receipt, confirmation or tracking page. */
function target(item: NotificationFeedItem) {
  if (item.entityType === 'issue') return '/store/issues';
  if (item.entityType !== 'order') return null;
  const base = `/store/orders/${item.entityId}`;
  if (item.type === 'order_deferred') return `${base}/deferred`;
  if (item.type === 'delivered') return `${base}/receipt`;
  if (item.type === 'order_confirmed') return `${base}/confirmation`;
  if (item.type === 'receipt_discrepancy') return '/store/issues';
  return base;
}

const TOLD = [
  'Order confirmed or held after cutoff',
  'Delivery scheduled with expected arrival',
  'Order deferred and why',
  'Delivery completed · awaiting receipt',
  'Issue updates from planning',
];

/** Prototype I29 and J12: what planning told this outlet, newest first. */
export function StoreNotifications() {
  const { data, notes, refresh } = useStore();
  const phone = usePhone();
  const navigate = useNavigate();
  const auth = useAuth();
  const read = useMutation({
    mutationFn: async (items: NotificationFeedItem[]) => {
      for (const item of items) await storeApi.readNotification(item);
    },
    onSettled: () => refresh(),
  });
  const unread = notes.filter((item) => item.readAt === null);
  const needs = notes.filter((item) => item.actionRequired);
  const earlier = notes.filter((item) => !item.actionRequired);
  const row = (item: NotificationFeedItem) => {
    const [icon, tone] = look[item.type];
    const text = insights.note(item);
    return (
      <button
        key={item.id}
        type="button"
        className="st-note"
        data-open={item.actionRequired || undefined}
        onClick={() => {
          if (item.readAt === null || item.actionRequired) read.mutate([item]);
          const to = text.to ?? target(item);
          if (to) navigate(to);
        }}
      >
        <Well icon={icon} tone={tone} size={phone ? 44 : 40} />
        <span className="st-row-text">
          <strong>{text.title}</strong>
          <small>{text.detail}</small>
        </span>
        <time dateTime={item.createdAt}>
          {day(item.createdAt).split(' ')[0]} {time(item.createdAt)}
        </time>
        {item.readAt === null && <i aria-label="Unread" role="img" />}
        <Icon name="cr" size={16} />
      </button>
    );
  };
  return (
    <>
      <PageHead
        title="Notifications"
        sub={`Your outlet only · ${data.outlet.id}`}
        eyebrow={`${data.outlet.id} · ${data.outlet.district}`}
        back="/store"
      >
        <Button
          variant="secondary"
          size="md"
          busy={read.isPending}
          disabled={unread.length === 0}
          onClick={() => read.mutate(unread)}
        >
          Mark all read
        </Button>
      </PageHead>
      <div className="st-grid st-grid--hero">
        {notes.length === 0 ? (
          <Empty
            icon="bell"
            title="No notifications yet"
            description="Cutoff, deferral and delivery notices for your outlet appear here."
          />
        ) : (
          <section className="wp-card st-notes">
            {needs.length > 0 && <h2>Needs you</h2>}
            {needs.map(row)}
            {earlier.length > 0 && <h2>{needs.length > 0 ? 'Earlier' : 'All notices'}</h2>}
            {earlier.map(row)}
          </section>
        )}
        <section className="st-told">
          <h2>What you are told about</h2>
          <ul>
            {TOLD.map((text) => (
              <li key={text}>
                <StoreIcon name="check" size={14} />
                {text}
              </li>
            ))}
          </ul>
        </section>
      </div>
      {/* Added control: the phone has no sidebar, so signing out lives here. */}
      {phone && (
        <Button variant="tertiary" onClick={() => void auth.logout()}>
          Sign out
        </Button>
      )}
    </>
  );
}
