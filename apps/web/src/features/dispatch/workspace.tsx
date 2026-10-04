import { useQuery } from '@tanstack/react-query';
import { calendarListResponseSchema, operatingClockSchema, type User } from '@waypoint/shared';
import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';
import {
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router-dom';
import { Avatar, ErrorState, LoadingState, MaskIcon, PageHeader } from '../../components/waypoint';
import { HttpError, api as http, message } from '../../lib/api';
import { clock, shortDay } from '../../lib/format';
import { SignOut } from '../auth/auth';
import { Notifications } from '../auth/notifications';
import { useOnline, useServerNow } from '../store/shared';
import { AllocationWorkspace } from './allocate';
import { AnalyticsForecast } from './analytics';
import { CommandCenter } from './command';
import { type DispatchRun, dispatchRunSchema } from './contracts';
import { api } from './data/client';
import { setDispatchSession } from './data/context';
import { DeferralCenter } from './deferrals';
import { DemoClock } from './demo-clock';
import { FleetTrips } from './fleet';
import { StoreIssues } from './issues';
import { LiveOperations } from './live';
import { LoadingExceptionPage } from './live-exception';
import { DispatchNotifications, useDispatchNotifications } from './notifications';
import { OrdersAudit } from './orders';
import { OutletsPage } from './outlets';
import { PlanningQueuePage } from './queue';
import { TripRecordPage } from './record';
import { ReplanPage } from './replan';
import { ReviewPublish } from './review';
import { AppShell, SidebarUser, TopBar } from './shell';
import { WhatIfSimulator } from './simulate';
import { pollInterval, type StreamState, useDashboardStream } from './stream';
import { ValidationPage } from './validation';
import './dispatch.css';

type Dispatcher = Extract<User, { role: 'dispatcher' }>;

interface DispatchContextValue {
  user: Dispatcher;
  date: string;
  setDate: (date: string) => void;
  dates: string[];
  online: boolean;
  /** Whether dashboard changes arrive over SSE, by polling, or not at all (offline). */
  stream: StreamState;
  /** Refetch interval for dashboard queries: 15 s while the stream is down (§11.2). */
  pollMs: number | false;
  /** Run context for the selected date; undefined until the first response. */
  run: DispatchRun | undefined;
  /** Server clock in ms, ticking between responses. */
  now: number;
}

const DispatchContext = createContext<DispatchContextValue | null>(null);

const DATES_BEHIND = 21;
const DATES_AHEAD = 45;
const shiftDays = (date: string, days: number) => {
  const at = new Date(`${date}T12:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};

export function useDispatch() {
  const value = useContext(DispatchContext);
  if (!value) throw new Error('Dispatcher workspace required');
  return value;
}

// Sidebar · Dispatcher (Figma 2034:673). Icon names are the Figma icon components.
const navigation = [
  {
    label: 'Operations',
    items: [
      { label: 'Command center', path: '/dispatcher', icon: 'Home' },
      { label: 'Planning queue', path: '/dispatcher/queue', icon: 'List', count: 'queue' },
      { label: 'Allocation', path: '/dispatcher/allocate', icon: 'Layers' },
      {
        label: 'Validation',
        path: '/dispatcher/validation',
        icon: 'Shield',
        count: 'hardViolations',
      },
      { label: 'Deferrals', path: '/dispatcher/deferrals', icon: 'History', count: 'deferrals' },
      { label: 'Review & publish', path: '/dispatcher/review', icon: 'Cc' },
      {
        label: 'Live operations',
        path: '/dispatcher/live',
        icon: 'Pulse',
        count: 'liveExceptions',
      },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { label: 'What-if simulator', path: '/dispatcher/simulate', icon: 'Branch' },
      { label: 'Analytics & forecast', path: '/dispatcher/analytics', icon: 'Chart' },
    ],
  },
  {
    label: 'Records',
    items: [
      { label: 'Fleet & trips', path: '/dispatcher/fleet', icon: 'Truck' },
      { label: 'Outlets', path: '/dispatcher/outlets', icon: 'Store' },
      { label: 'Orders & audit', path: '/dispatcher/orders', icon: 'File' },
      { label: 'Store issues', path: '/dispatcher/issues', icon: 'Cc' },
    ],
  },
] as const satisfies readonly {
  label: string;
  items: readonly {
    label: string;
    path: string;
    icon: string;
    count?: keyof DispatchRun['counts'];
  }[];
}[];

/** Phone tab bar (Figma 2045:4554). The phone is for watching the run, so it has four tabs. */
const phoneTabs = [
  { label: 'Home', path: '/dispatcher', icon: 'home' },
  { label: 'Queue', path: '/dispatcher/queue', icon: 'list' },
  { label: 'Live', path: '/dispatcher/live', icon: 'pulse' },
  { label: 'Alerts', path: '/dispatcher/notifications', icon: 'bell' },
] as const;

const isActive = (path: string, pathname: string) =>
  path === '/dispatcher'
    ? pathname === '/dispatcher' || pathname === '/dispatcher/'
    : pathname === path ||
      pathname.startsWith(`${path}/`) ||
      (path === '/dispatcher/fleet' && pathname.startsWith('/dispatcher/vehicles/'));

export function DispatchWorkspaceApp({ user }: { user: Dispatcher }) {
  // Scopes the Figma shell styles (shell.css) to this workspace, portals included.
  useLayoutEffect(() => {
    document.documentElement.dataset.workspace = 'dispatch';
    return () => {
      delete document.documentElement.dataset.workspace;
    };
  }, []);
  const calendar = useQuery({
    queryKey: ['calendar'],
    queryFn: () => http('/calendar', calendarListResponseSchema),
  });
  const operating = useQuery({
    queryKey: ['dispatcher', user.id, 'operating-clock'],
    queryFn: operatingToday,
    retry: false,
  });
  const allDates = useMemo(
    () =>
      (calendar.data?.items ?? [])
        .filter((day) => day.isOperating)
        .map((day) => day.date)
        .sort(),
    [calendar.data],
  );
  const [params, setParams] = useSearchParams();
  const requested = params.get('date');
  // Default to the next run after the operating clock's day, as the store does.
  const today = operating.data?.today;
  // Until the operating clock answers, the device date stands in. The calendar is generated
  // well ahead, so its last day is never the right default.
  const anchor = today ?? new Date().toISOString().slice(0, 10);
  const nextRun = allDates.find((day) => day > anchor);
  const date =
    requested && allDates.includes(requested) ? requested : (nextRun ?? allDates.at(-1) ?? '');
  // The date picker offers the weeks around the operating day, not the whole calendar.
  const dates = useMemo(() => {
    const from = shiftDays(anchor, -DATES_BEHIND);
    const to = shiftDays(anchor, DATES_AHEAD);
    return allDates.filter((day) => (day >= from && day <= to) || day === date);
  }, [allDates, anchor, date]);
  // Sources and fixtures read the signed-in dispatcher and the operating clock from here.
  setDispatchSession({
    name: user.name,
    depotId: user.depotId ?? '',
    date,
    dates,
    demoNow: operating.data?.demoNow ?? null,
    demoAt: operating.dataUpdatedAt,
  });
  const online = useOnline();
  const stream = useDashboardStream(date, user.id, online);
  const pollMs = pollInterval(stream);
  const notices = useDispatchNotifications(user.id, pollMs);
  const [noticesOpen, setNoticesOpen] = useState(false);
  const [search, setSearch] = useState('');
  const location = useLocation();
  const navigate = useNavigate();
  const run = useQuery({
    queryKey: ['dashboard', date, 'run'],
    queryFn: () => api(`/dashboard/run?date=${date}`, dispatchRunSchema),
    enabled: date.length > 0 && Boolean(user.depotId),
    refetchInterval: pollMs,
  });
  // Local time stands in until the first run response sets the server clock.
  const [localNow] = useState(() => new Date().toISOString());
  const now = useServerNow(run.data?.now ?? localNow, run.dataUpdatedAt);
  const setDate = (next: string) => {
    const query = new URLSearchParams(params);
    query.set('date', next);
    setParams(query);
  };
  if (calendar.isPending || operating.isPending) {
    return (
      <main className="store-signin">
        <LoadingState label="Loading the operating calendar…" />
      </main>
    );
  }
  if (!calendar.data) {
    return (
      <ErrorState
        description={message(calendar.error)}
        onRetry={() => {
          void calendar.refetch();
        }}
      />
    );
  }
  if (!date) {
    return (
      <ErrorState
        title="No operating day"
        description="The calendar has no operating day to plan."
      />
    );
  }
  const groups = navigation.map((group) => ({
    label: group.label,
    items: group.items.map((item) => {
      const key = 'count' in item ? item.count : undefined;
      const total = key ? run.data?.counts[key] : undefined;
      return {
        label: item.label,
        href: `${item.path}?date=${date}`,
        active: isActive(item.path, location.pathname),
        icon: <MaskIcon src={`/waypoint/shell/2034-673-imgIcon${item.icon}.svg`} />,
        ...(total
          ? { count: total, alert: key === 'hardViolations' || key === 'liveExceptions' }
          : {}),
      };
    }),
  }));
  const tabs = phoneTabs.map((tab) => ({
    label: tab.label,
    href: `${tab.path}?date=${date}`,
    active: isActive(tab.path, location.pathname),
    icon: <MaskIcon src={`/waypoint/icons/${tab.icon}.svg`} size={24} />,
  }));
  const current = navigation
    .flatMap((group) => group.items.map((item) => ({ ...item, section: group.label })))
    .find((item) => isActive(item.path, location.pathname));
  return (
    <DispatchContext.Provider
      value={{ user, date, setDate, dates, online, stream, pollMs, run: run.data, now }}
    >
      <div className="dispatch-workspace">
        <AppShell
          navigation={groups}
          rail
          tabs={tabs}
          onLink={(href) => navigate(href)}
          sidebarFooter={
            <SidebarUser name={user.name} detail={`Dispatcher · ${user.depotId ?? 'no depot'}`}>
              <label className="dispatch-date">
                Service date
                <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
              </label>
              {operating.data?.demoNow && (
                <DemoClock
                  now={operating.data.demoNow}
                  date={date}
                  dates={dates}
                  // Keep the selected run in the URL so a clock move does not switch dates.
                  onMoved={() => setDate(date)}
                />
              )}
              <SignOut />
            </SidebarUser>
          }
          topBar={
            <TopBar
              section={current?.section ?? 'Operations'}
              title={current?.label ?? 'Notifications'}
              onSearch={setSearch}
              onSearchSubmit={(query) => {
                if (query) {
                  navigate(`/dispatcher/orders?date=${date}&q=${encodeURIComponent(query)}`);
                }
              }}
              searchValue={search}
              searchPlaceholder="Search orders, outlets, trips"
              searchLabel="Search orders, outlets, trips"
              context={
                run.data
                  ? `${shortDay(now)} · planning ${clock(run.data.planning.opensAt)}–${clock(run.data.planning.publishBy)}`
                  : streamLabel[stream]
              }
              connectivity={stream === 'offline' ? 'offline' : 'online'}
              onNotifications={() => setNoticesOpen((open) => !open)}
              unread={notices.unread > 0}
              profile={<Avatar name={user.name} />}
            />
          }
        >
          {noticesOpen && (
            <DispatchNotifications
              userId={user.id}
              date={date}
              feed={notices}
              onClose={() => setNoticesOpen(false)}
            />
          )}
          {!user.depotId && (
            <ErrorState
              title="No depot assigned"
              description="A dispatcher needs a home depot before planning."
            />
          )}
          {user.depotId && (
            <Routes>
              <Route path="/" element={<Outlet />}>
                <Route index element={<CommandCenter />} />
                <Route path="queue" element={<PlanningQueuePage />} />
                <Route path="allocate" element={<AllocationWorkspace />} />
                <Route path="fleet" element={<FleetTrips />} />
                <Route path="vehicles/:vehicleId" element={<FleetTrips />} />
                <Route path="vehicles/:vehicleId/replan" element={<ReplanPage />} />
                <Route
                  path="vehicles/:vehicleId/trips/:tripNo/record"
                  element={<TripRecordPage />}
                />
                <Route path="validation" element={<ValidationPage />} />
                <Route
                  path="conflicts"
                  element={<Navigate to={`/dispatcher/validation?date=${date}`} replace />}
                />
                <Route path="deferrals" element={<DeferralCenter />} />
                <Route path="simulate" element={<WhatIfSimulator />} />
                <Route path="review" element={<ReviewPublish />} />
                <Route path="live" element={<LiveOperations />} />
                <Route path="live/exceptions/:exceptionId" element={<LoadingExceptionPage />} />
                <Route path="analytics" element={<AnalyticsForecast />} />
                <Route path="outlets" element={<OutletsPage />} />
                <Route path="orders" element={<OrdersAudit />} />
                <Route path="issues" element={<StoreIssues />} />
                <Route path="notifications" element={<Notifications user={user} />} />
                <Route path="*" element={<Navigate to={`/dispatcher?date=${date}`} replace />} />
              </Route>
            </Routes>
          )}
        </AppShell>
      </div>
    </DispatchContext.Provider>
  );
}

const streamLabel: Record<StreamState, string> = {
  live: 'Live updates',
  polling: 'Reconnecting · refreshing every 15 s',
  offline: 'Offline · showing the last loaded data',
};

// The operating clock's Asia/Colombo date. GET /admin/clock exists only in DEMO_MODE; without
// it the server follows the host clock, so the device's time gives the same day.
async function operatingToday(): Promise<{ today: string; demoNow: string | null }> {
  try {
    const now = await http('/admin/clock', operatingClockSchema);
    return { today: now.now.slice(0, 10), demoNow: now.now };
  } catch (cause) {
    if (!(cause instanceof HttpError) || cause.status !== 404) throw cause;
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Colombo' }).format(new Date());
    return { today, demoNow: null };
  }
}

export function Page({
  title,
  description,
  actions,
  inShell,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  /** The title repeats the sidebar label, so tablet and phone show it in the top bar only. */
  inShell?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} description={description} inShell={inShell}>
        {actions}
      </PageHeader>
      {children}
    </>
  );
}
