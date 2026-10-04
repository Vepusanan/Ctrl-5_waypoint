import type {
  LoadingStatus,
  OrderStatus,
  StopStatus,
  SyncStatus,
  TransitionEntity,
  TripStatus,
} from './enums.ts';

// Allowed status moves (SYSTEM_DESIGN §5.3). Anything not listed is illegal.

type TransitionTable<S extends string> = { readonly [From in S]: readonly S[] };

export class IllegalTransitionError extends Error {
  readonly entity: TransitionEntity;
  readonly from: string;
  readonly to: string;

  constructor(entity: TransitionEntity, from: string, to: string) {
    super(`Illegal ${entity} transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

export interface StateMachine<S extends string> {
  readonly entity: TransitionEntity;
  readonly transitions: TransitionTable<S>;
  canTransition: (from: S, to: S) => boolean;
  assertTransition: (from: S, to: S) => void;
  nextStates: (from: S) => readonly S[];
  isTerminal: (state: S) => boolean;
}

function createStateMachine<S extends string>(
  entity: TransitionEntity,
  transitions: TransitionTable<S>,
): StateMachine<S> {
  const canTransition = (from: S, to: S) => transitions[from].includes(to);
  return {
    entity,
    transitions,
    canTransition,
    assertTransition: (from, to) => {
      if (!canTransition(from, to)) {
        throw new IllegalTransitionError(entity, from, to);
      }
    },
    nextStates: (from) => transitions[from],
    isTerminal: (state) => transitions[state].length === 0,
  };
}

export const orderStateMachine = createStateMachine<OrderStatus>('order', {
  draft: ['submitted', 'cancelled'],
  submitted: ['confirmed', 'cancelled'],
  confirmed: ['allocated', 'deferred'],
  // A replan after publish can defer an order that has not left the depot, or take it off a
  // vehicle that broke down while loading and put it on another one.
  allocated: ['loading', 'deferred'],
  // A deferred order re-enters the next run's queue and can be allocated there.
  deferred: ['allocated'],
  loading: ['dispatched', 'allocated', 'deferred'],
  dispatched: ['delivered', 'failed'],
  delivered: ['receipt_confirmed'],
  failed: [],
  receipt_confirmed: [],
  cancelled: [],
});

export const tripStateMachine = createStateMachine<TripStatus>('trip', {
  planned: ['published', 'blocked'],
  published: ['loading', 'blocked'],
  loading: ['ready', 'blocked'],
  ready: ['departed', 'blocked'],
  departed: ['completed'],
  completed: [],
  blocked: [],
});

export const stopStateMachine = createStateMachine<StopStatus>('stop', {
  pending: ['arrived'],
  arrived: ['delivered', 'failed'],
  delivered: [],
  failed: [],
});

export const loadingStateMachine = createStateMachine<LoadingStatus>('loading', {
  not_started: ['in_progress'],
  in_progress: ['exception', 'ready'],
  // An acknowledged exception returns loading to in progress.
  exception: ['in_progress'],
  ready: ['departed'],
  departed: [],
});

export const syncStateMachine = createStateMachine<SyncStatus>('sync_event', {
  local: ['queued'],
  queued: ['syncing'],
  // A failed network call puts the event back in the queue for retry with backoff.
  syncing: ['synced', 'conflict', 'queued'],
  synced: [],
  conflict: [],
});
