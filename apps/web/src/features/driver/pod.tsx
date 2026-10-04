import { type DeliveryStop, deliveryStopSchema, podSchema } from '@waypoint/shared';
import { useRef, useState } from 'react';
import { Button } from '../../components/waypoint';
import { api, HttpError } from '../../lib/api';
import { cartons } from './labels';
import { DriverIcon, ThumbZone } from './shell';
import { SignatureField, type SignatureHandle } from './signature';

// SYSTEM_DESIGN §8.1: the POD waits on the phone compressed to 300 KB or less, well inside the
// API's 2 MB image limit (§9.4). Larger photos are re-encoded, with smaller edges if needed.
const PHOTO_TARGET = 300 * 1024;
const PHOTO_EDGES = [1600, 1280, 960];
const RECIPIENT_MAX = 120;

/**
 * Uploads the proof of delivery and returns its id. An upload that the API already holds (a
 * 422, or a network failure after the server saved it) is recovered from GET /stops/:id rather
 * than asking the driver to sign again.
 */
export async function ensurePod(stopId: string, build: () => Promise<FormData>): Promise<string> {
  try {
    const pod = await api(`/stops/${stopId}/pod`, podSchema, {
      method: 'POST',
      body: await build(),
    });
    return pod.id;
  } catch (cause) {
    if (!(cause instanceof HttpError) || (cause.status !== 422 && cause.status !== 0)) throw cause;
    const stop = await api(`/stops/${stopId}`, deliveryStopSchema).catch(() => null);
    if (stop?.pod) return stop.pod.id;
    throw cause;
  }
}

/** What the driver captured; the outbox uploads it when there is signal (§8.2). */
export interface PodDraft {
  recipientName: string;
  signature: Blob;
  photo?: Blob;
}

// DR04. Recipient, signature and an optional photo, then the caller records the delivery.
// The form is display: contents so its thumb zone sits at the foot of the screen.
export function DeliveryForm({
  stop,
  recipient: expected,
  busy,
  onSubmit,
}: {
  stop: DeliveryStop;
  /** A known receiver to pre-fill. Empty until the API returns one: a POD name is never invented. */
  recipient: string;
  busy: boolean;
  onSubmit: (pod: PodDraft) => void;
}) {
  const signature = useRef<SignatureHandle>(null);
  const [recipient, setRecipient] = useState(expected);
  const [unsigned, setUnsigned] = useState(true);
  const [photo, setPhoto] = useState<Blob | null>(null);
  const [photoNote, setPhotoNote] = useState('');
  const [preparing, setPreparing] = useState(false);
  const name = recipient.trim();
  const ready = name.length > 0 && name.length <= RECIPIENT_MAX && !unsigned && !preparing;

  return (
    <form
      className="driver-form"
      aria-label="Proof of delivery"
      onSubmit={async (event) => {
        event.preventDefault();
        const pad = signature.current;
        if (!ready || !pad || pad.isEmpty()) return;
        const signed = await pad.toPng();
        onSubmit({ recipientName: name, signature: signed, ...(photo ? { photo } : {}) });
      }}
    >
      <label className="driver-field">
        <span>Received by</span>
        <input
          autoComplete="off"
          maxLength={RECIPIENT_MAX}
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
          placeholder="Recipient's name"
        />
      </label>
      <div className="driver-tiles">
        <div
          className={`driver-tile driver-tile--signature${unsigned ? ' driver-tile--empty' : ''}`}
        >
          <SignatureField ref={signature} onEmptyChange={setUnsigned} disabled={busy} />
          <span className="driver-tile-caption" aria-hidden="true">
            {unsigned ? 'Sign here' : 'Signature'}
          </span>
        </div>
        <label className={`driver-tile driver-tile--photo${photo ? ' driver-tile--done' : ''}`}>
          <input
            className="wp-sr-only"
            type="file"
            accept="image/*"
            capture="environment"
            disabled={busy}
            onChange={async (event) => {
              const file = event.target.files?.[0];
              setPhoto(null);
              setPhotoNote('');
              if (!file) return;
              setPreparing(true);
              try {
                const prepared = await preparePhoto(file);
                setPhoto(prepared);
                setPhotoNote(`Photo ready · ${Math.round(prepared.size / 1024)} KB`);
              } catch (cause) {
                event.target.value = '';
                setPhotoNote(
                  cause instanceof Error ? cause.message : 'The photo could not be used.',
                );
              } finally {
                setPreparing(false);
              }
            }}
          />
          <span className="driver-round driver-round--small">
            <DriverIcon name={photo ? 'check-success' : 'plus'} size={20} />
          </span>
          <span className="driver-tile-caption">
            {preparing ? 'Preparing…' : photo ? 'Photo' : 'Photo (optional)'}
          </span>
        </label>
      </div>
      {photoNote && (
        <p className="driver-note" role="status">
          {photoNote}
        </p>
      )}
      <section className="driver-card driver-count" aria-label="Cartons">
        <div className="driver-row-text">
          <span>Cartons handed over</span>
          <strong>
            {stop.order.units} of {stop.order.units} planned
          </strong>
        </div>
        {/* DR04 `2046:5521`. The API records a delivery as complete, so the count is fixed. */}
        <div className="driver-stepper" title="A short delivery cannot be recorded yet">
          <button type="button" disabled aria-label="One carton less">
            <DriverIcon name="minus" size={18} />
          </button>
          <output aria-label={`${cartons(stop.order.units)} handed over`}>
            {stop.order.units}
          </output>
          <button type="button" disabled aria-label="One carton more">
            <DriverIcon name="plus" size={18} />
          </button>
        </div>
      </section>
      {ready ? (
        <p className="driver-note">
          <DriverIcon name="check" size={16} />
          Proof complete · saves on this phone
        </p>
      ) : (
        !busy && (
          <p className="driver-note">
            {name.length === 0
              ? `Enter who received the goods at ${stop.order.outletId}.`
              : unsigned
                ? 'Ask the recipient to sign in the box.'
                : 'Preparing the photo…'}
          </p>
        )
      )}
      <ThumbZone>
        <Button type="submit" className="driver-cta" busy={busy} disabled={!ready}>
          Complete delivery
        </Button>
      </ThumbZone>
    </form>
  );
}

// Re-encodes a camera photo as JPEG, shrinking the edge and quality until it fits PHOTO_TARGET.
async function preparePhoto(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  const plain = ['image/jpeg', 'image/png', 'image/webp'].includes(file.type);
  if (plain && file.size <= PHOTO_TARGET) return file;
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) throw new Error('This photo format cannot be read. Try another photo.');
  try {
    for (const edge of PHOTO_EDGES) {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.8, 0.65, 0.5]) {
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, 'image/jpeg', quality),
        );
        if (blob && blob.size <= PHOTO_TARGET) return blob;
      }
    }
  } finally {
    bitmap.close();
  }
  throw new Error('The photo is too large even after compression. Try another photo.');
}
