import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { message } from '../../lib/api';
import { useAuth } from '../auth/auth';
import { initials } from '../store/shared';
import { DISPATCH_OFFICE, telHref } from './fixtures';
import { Chip, DriverHeader, DriverIcon, Glyph } from './shell';
import { useDriver } from './workspace';

const LANGUAGES = ['English', 'Sinhala', 'Tamil'] as const;
type Language = (typeof LANGUAGES)[number];

/** A preference kept on this phone only; storage can be unavailable, so reads never throw. */
function usePhoneSetting<Value extends string>(
  key: string,
  fallback: Value,
  allowed: readonly Value[],
) {
  const [value, setValue] = useState<Value>(() => {
    try {
      const stored = localStorage.getItem(key) as Value | null;
      return stored !== null && allowed.includes(stored) ? stored : fallback;
    } catch {
      return fallback;
    }
  });
  const save = (next: Value) => {
    setValue(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      // Private mode: the choice lasts for this visit.
    }
  };
  return [value, save] as const;
}

// DR08 `2106:10764`. Who is signed in, what is saved on this phone, two phone-only preferences,
// a call to the planning office and sign out. Signing out forgets this phone's session, so it
// waits until nothing is left to sync.
export function DriverAccount() {
  const { user, online, sync, route } = useDriver();
  const auth = useAuth();
  const logout = useMutation({ mutationFn: auth.logout });
  const [sound, setSound] = usePhoneSetting('waypoint.driver.sound', 'on', ['on', 'off']);
  const [language, setLanguage] = usePhoneSetting<Language>(
    'waypoint.driver.language',
    'English',
    LANGUAGES,
  );
  const waiting = sync.pending > 0;
  const locked = waiting || !online || logout.isPending;

  return (
    <>
      <DriverHeader eyebrow={null} title="Account" large />

      <section className="driver-card driver-profile" aria-label="Profile">
        <span className="driver-avatar driver-avatar--large">{initials(user.name)}</span>
        <div className="driver-row-text">
          <strong>{user.name}</strong>
          <span>Driver · {user.vehicleId}</span>
        </div>
      </section>

      <section className="driver-card driver-list-card" aria-label="Settings">
        <Link className="driver-row driver-row--link" to="/driver/sync">
          <span className="driver-well driver-well--small">
            <Glyph name="cloud" />
          </span>
          <span className="driver-row-text">
            <strong>Saved on this phone</strong>
            <span>
              {route ? `Route v${route.version} · ` : ''}
              {sync.pending} pending
            </span>
          </span>
          {sync.conflicts > 0 ? (
            <Chip tone="danger" icon="xoct">
              Conflict
            </Chip>
          ) : waiting ? (
            <Chip tone="warning" icon="cloud">
              Queued
            </Chip>
          ) : (
            <Chip tone="success" icon="check">
              Synced
            </Chip>
          )}
        </Link>
        <button
          type="button"
          className="driver-row driver-row--button"
          aria-pressed={sound === 'on'}
          onClick={() => setSound(sound === 'on' ? 'off' : 'on')}
        >
          <span className="driver-well driver-well--small">
            <Glyph name="bell" />
          </span>
          <span className="driver-row-text">
            <strong>Notification sound</strong>
            <span>{sound === 'on' ? 'On · vibrate when driving' : 'Off'}</span>
          </span>
          <DriverIcon name="chevron-right" size={16} />
        </button>
        <fieldset className="driver-language">
          <legend>Language</legend>
          <div className="driver-segments">
            {LANGUAGES.map((option) => (
              <label
                key={option}
                className={`driver-segment${language === option ? ' driver-segment--active' : ''}`}
              >
                <input
                  className="wp-sr-only"
                  type="radio"
                  name="driver-language"
                  value={option}
                  checked={language === option}
                  onChange={() => setLanguage(option)}
                />
                {option}
              </label>
            ))}
          </div>
        </fieldset>
        <a className="driver-row driver-row--link" href={telHref(DISPATCH_OFFICE.phone)}>
          <span className="driver-well driver-well--small">
            <Glyph name="phone" />
          </span>
          <span className="driver-row-text">
            <strong>Call dispatcher</strong>
            <span>{DISPATCH_OFFICE.name}</span>
          </span>
          <DriverIcon name="chevron-right" size={16} />
        </a>
      </section>

      <button
        type="button"
        className="driver-signout"
        disabled={locked}
        onClick={() => logout.mutate()}
      >
        <Glyph name="logout" size={18} />
        <strong>{logout.isPending ? 'Signing out…' : 'Sign out'}</strong>
        <span>
          {waiting
            ? `after ${sync.pending} pending sync`
            : online
              ? 'only when 0 pending'
              : 'reconnect first'}
        </span>
      </button>
      {logout.error && (
        <div className="driver-banner driver-banner--danger" role="alert">
          <strong>Not signed out</strong>
          <p>{message(logout.error)}</p>
        </div>
      )}
    </>
  );
}
