// Changes to a published plan (SRS §24, §42): a vehicle lost before it leaves, or one order
// moved or deferred. Every change is revalidated by the server and published as a new version.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  type ReasonCode,
  reasonCodeSchema,
  replanResponseSchema,
  vehicleUnavailableResponseSchema,
} from '@waypoint/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Banner,
  Button,
  Dropdown,
  Field,
  Overlay,
  SegmentedControl,
  TextArea,
} from '../../components/waypoint';
import { api, HttpError, message } from './data/client';
import { ruleLabels } from './rules';
import { useDispatch } from './workspace';

/** Marks the vehicle unavailable for the run date, then opens its replan. */
export function MarkUnavailable({
  vehicleId,
  open,
  onClose,
}: {
  vehicleId: string;
  open: boolean;
  onClose: () => void;
}) {
  const { date } = useDispatch();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [reason, setReason] = useState('');
  const mark = useMutation({
    mutationFn: () =>
      api(`/vehicles/${vehicleId}/unavailable`, vehicleUnavailableResponseSchema, {
        method: 'POST',
        body: JSON.stringify({ date, ...(reason.trim() ? { reason: reason.trim() } : {}) }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['planning', date] });
      await client.invalidateQueries({ queryKey: ['dashboard', date] });
      onClose();
      navigate(`/dispatcher/vehicles/${vehicleId}/replan?date=${date}`);
    },
  });
  return (
    <Overlay
      open={open}
      onClose={onClose}
      variant="modal"
      icon="truck"
      title={`Mark ${vehicleId} unavailable?`}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button size="md" busy={mark.isPending} onClick={() => mark.mutate()}>
            Mark unavailable
          </Button>
        </>
      }
    >
      <p>
        Trips of {vehicleId} that have not departed stop, and their orders wait for a replan. Trips
        already on the road are not changed.
      </p>
      <Field
        label="Reason (optional)"
        value={reason}
        maxLength={200}
        onChange={(event) => setReason(event.target.value)}
        hint="Shown to the team and kept in the audit log."
      />
      {mark.isError && (
        <Banner tone="danger" title="The vehicle was not marked unavailable">
          {message(mark.error)}
        </Banner>
      )}
    </Overlay>
  );
}

const modes = [
  { value: 'move', label: 'Move to a trip' },
  { value: 'defer', label: 'Defer to next run' },
] as const;
const tripNumbers = [
  { value: '1', label: 'Trip 1' },
  { value: '2', label: 'Trip 2' },
] as const;

/** Moves one published order to another trip, or defers it, with the dispatcher's reason. */
export function ChangeStop({
  stop,
  from,
  vehicles,
  onClose,
}: {
  stop: { orderId: string; name: string } | null;
  from: { vehicleId: string; tripNo: 1 | 2 };
  vehicles: readonly { id: string; kind: string }[];
  onClose: () => void;
}) {
  const { date } = useDispatch();
  const client = useQueryClient();
  const [mode, setMode] = useState<(typeof modes)[number]['value']>('move');
  const [vehicleId, setVehicleId] = useState(from.vehicleId);
  const [tripNo, setTripNo] = useState<'1' | '2'>(from.tripNo === 1 ? '2' : '1');
  const [reasonCode, setReasonCode] = useState<ReasonCode>('VEHICLE_UNAVAILABLE');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const change = useMutation({
    mutationFn: () =>
      api(`/planning/runs/${date}/replan`, replanResponseSchema, {
        method: 'POST',
        body: JSON.stringify({
          note: note.trim(),
          moves: [
            mode === 'move'
              ? { orderId: stop?.orderId, target: { vehicleId, tripNo: Number(tripNo) } }
              : { orderId: stop?.orderId, target: null, reasonCode },
          ],
        }),
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['planning', date] });
      await client.invalidateQueries({ queryKey: ['dashboard', date] });
      await client.invalidateQueries({ queryKey: ['trips', date] });
      setNote('');
      setTouched(false);
      onClose();
    },
  });
  const same = mode === 'move' && vehicleId === from.vehicleId && Number(tripNo) === from.tripNo;
  const missing = note.trim().length === 0;
  const violations = change.error instanceof HttpError ? change.error.violations : [];
  return (
    <Overlay
      open={stop !== null}
      onClose={() => {
        change.reset();
        onClose();
      }}
      variant="modal"
      icon="route"
      title={stop ? `Change ${stop.name}` : 'Change stop'}
      footer={
        <>
          <Button variant="secondary" size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="md"
            busy={change.isPending}
            disabled={same}
            onClick={() => {
              setTouched(true);
              if (!missing) change.mutate();
            }}
          >
            Publish the change
          </Button>
        </>
      }
    >
      <p>
        The plan is published. This change is checked against every hard rule and goes out as a new
        plan version to the loader, driver and store.
      </p>
      <SegmentedControl label="What to change" value={mode} options={modes} onChange={setMode} />
      {mode === 'move' ? (
        <div className="d-inline-fields">
          <Dropdown
            label="Vehicle"
            value={vehicleId}
            options={vehicles.map((item) => ({
              value: item.id,
              label: `${item.id} · ${item.kind}`,
            }))}
            onChange={setVehicleId}
          />
          <SegmentedControl
            label="Trip"
            value={tripNo}
            options={tripNumbers}
            onChange={setTripNo}
          />
        </div>
      ) : (
        <Dropdown
          label="Reason"
          value={reasonCode}
          options={reasonCodeSchema.options.map((rule) => ({
            value: rule,
            label: ruleLabels[rule],
          }))}
          onChange={setReasonCode}
        />
      )}
      {same && <p className="wp-muted">The order is already on that trip.</p>}
      <TextArea
        label="Why is the published plan changing? (required)"
        value={note}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        error={touched && missing ? 'Write the reason. It is kept in the audit log.' : undefined}
      />
      {change.isError && (
        <Banner tone="danger" title="The change was not published">
          {violations.length > 0
            ? violations.map((item) => item.detail).join(' · ')
            : message(change.error)}
        </Banner>
      )}
    </Overlay>
  );
}
