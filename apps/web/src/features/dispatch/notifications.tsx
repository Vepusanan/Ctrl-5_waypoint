import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  loadingIssueSchema,
  type NotificationFeedItem,
  type NotificationPriority,
  type NotificationType,
  notificationFeedItemSchema,
  notificationListResponseSchema,
} from '@waypoint/shared';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, LoadingLabel, SkeletonRows } from '../../components/waypoint';
import { api, HttpError, message } from '../../lib/api';
import { day, time } from '../store/shared';
import { dispatchNotificationsKey } from './stream';

// SYSTEM_DESIGN §11.1: the dispatcher's own feed (loading shortfalls, failed deliveries, receipt
// discrepancies, sync conflicts), sorted by the API by priority, then time. High-priority items
// need an action, not just a read.

const title: Record<NotificationType, string> = {
  order_confirmed: 'Order confirmed',
  order_deferred: 'Order deferred',
  plan_published: 'Plan published',
  plan_changed: 'Plan changed',
  loading_shortfall: 'Loading shortfall',
  delivery_failed: 'Delivery failed',
  delivery_issue: 'Delivery issue reported',
  delivered: 'Delivered',
  receipt_discrepancy: 'Receipt discrepancy',
  sync_conflict: 'Sync conflict',
  issue_resolved: 'Store issue resolved',
};

const tone: Record<NotificationPriority, 'danger' | 'warning' | 'neutral'> = {
  high: 'danger',
  medium: 'warning',
  info: 'neutral',
};

const priorityLabel: Record<NotificationPriority, string> = {
  high: 'High',
  medium: 'Medium',
  info: 'Info',
};

// A shortfall is resolved on the command center; field events are followed on live operations.
const target = (item: NotificationFeedItem) =>
  item.type === 'loading_shortfall' ? '/dispatcher' : '/dispatcher/live';

const ALREADY_ACKNOWLEDGED = 'Loading issue is already acknowledged';

export function useDispatchNotifications(userId: string, pollMs: number | false) {
  const feed = useQuery({
    queryKey: dispatchNotificationsKey(userId),
    queryFn: () => api('/notifications', notificationListResponseSchema),
    refetchInterval: pollMs,
  });
  const items = feed.data?.items ?? [];
  return {
    feed,
    items,
    unread: items.filter((item) => item.readAt === null || item.actionRequired).length,
  };
}

export function DispatchNotifications({
  userId,
  date,
  feed,
  onClose,
}: {
  userId: string;
  date: string;
  feed: ReturnType<typeof useDispatchNotifications>;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: dispatchNotificationsKey(userId) });
    await client.invalidateQueries({ queryKey: ['dashboard', date] });
    await client.invalidateQueries({ queryKey: ['trips', date] });
  };
  const read = useMutation({
    mutationFn: (item: NotificationFeedItem) =>
      api(`/notifications/${item.id}/read`, notificationFeedItemSchema, { method: 'POST' }),
    onSettled: refresh,
  });
  // A shortfall notice is acknowledged by acknowledging the shortfall itself, which is what
  // lets the loader continue; the notice is then cleared too.
  const acknowledge = useMutation({
    mutationFn: async (item: NotificationFeedItem) => {
      if (item.type === 'loading_shortfall' && item.entityType === 'loading_issue') {
        await api(`/loading/issues/${item.entityId}/ack`, loadingIssueSchema, {
          method: 'POST',
        }).catch((cause: unknown) => {
          if (!(cause instanceof HttpError && cause.message === ALREADY_ACKNOWLEDGED)) throw cause;
        });
      }
      await api(`/notifications/${item.id}/acknowledge`, notificationFeedItemSchema, {
        method: 'POST',
      });
    },
    onSettled: refresh,
  });
  const { items } = feed;

  return (
    <section className="dispatch-notices wp-card" aria-label="Notifications">
      <div className="dispatch-notices-head">
        <h2>Notifications{feed.unread > 0 ? ` · ${feed.unread} need attention` : ''}</h2>
        <Button variant="tertiary" onClick={onClose}>
          Close
        </Button>
      </div>
      {feed.feed.error && <p role="alert">{message(feed.feed.error)}</p>}
      {acknowledge.error && <p role="alert">{message(acknowledge.error)}</p>}
      {feed.feed.isPending ? (
        <>
          <LoadingLabel label="Loading notifications…" />
          <SkeletonRows rows={3} />
        </>
      ) : items.length === 0 ? (
        feed.feed.data && (
          <p className="wp-muted">
            Loading shortfalls, failed deliveries, receipt discrepancies and sync conflicts appear
            here.
          </p>
        )
      ) : (
        <ul className="dispatch-notices-list">
          {items.map((item) => (
            <li
              key={item.id}
              className={item.readAt === null ? 'dispatch-notice is-unread' : 'dispatch-notice'}
            >
              <div className="dispatch-notice-text">
                <strong>{title[item.type]}</strong>
                <small>
                  {day(item.createdAt)} · {time(item.createdAt)}
                  {item.actionRequired
                    ? ' · needs acknowledgement'
                    : item.readAt === null
                      ? ' · new'
                      : ''}
                </small>
              </div>
              <Badge tone={tone[item.priority]}>{priorityLabel[item.priority]}</Badge>
              <Button
                variant="secondary"
                onClick={() => {
                  if (item.readAt === null) read.mutate(item);
                  onClose();
                  navigate(`${target(item)}?date=${date}`);
                }}
              >
                Open
              </Button>
              {item.actionRequired && (
                <Button
                  busy={acknowledge.isPending && acknowledge.variables?.id === item.id}
                  onClick={() => acknowledge.mutate(item)}
                >
                  {item.type === 'loading_shortfall' ? 'Acknowledge shortfall' : 'Acknowledge'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
