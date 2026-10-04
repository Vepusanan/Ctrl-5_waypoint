/** Small layout pieces shared by the Dispatcher pages. Styles live in dispatch.css (`d-*`). */
import type { ReactNode } from 'react';
import { Icon, ProgressBar, type Tone } from '../../components/waypoint';

/** "draft" until the run is published, then "published": page headers name the plan's state. */
export const planState = (run: { published: boolean } | undefined) =>
  run?.published ? 'published' : 'draft';

/** Card heading row: optional icon, title, and actions on the right. */
export function CardHead({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: string;
  children?: ReactNode;
}) {
  return (
    <div className="d-head">
      <h2 className="d-title">
        {icon && <Icon name={icon} />}
        {title}
      </h2>
      {children && <div className="d-head-actions">{children}</div>}
    </div>
  );
}

/** List row: 36px icon well, a title with one line of detail, and a trailing slot. */
export function Row({
  icon,
  tone,
  title,
  detail,
  children,
}: {
  icon: string;
  tone?: Tone | undefined;
  title: ReactNode;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="d-row">
      <span className={`wp-icon-well ${tone ? `tone-${tone}` : ''}`}>
        <Icon name={icon} />
      </span>
      <div className="d-row-text">
        <strong>{title}</strong>
        {detail && <span className="d-row-detail">{detail}</span>}
      </div>
      {children}
    </div>
  );
}

/** Icon followed by a large number and its label, as on the plan strips. */
export function Stat({
  icon,
  value,
  label,
  tone,
}: {
  icon: string;
  value: ReactNode;
  label: string;
  tone?: 'danger' | 'warning' | 'success';
}) {
  return (
    <div className="d-stat" data-tone={tone}>
      <Icon name={icon} />
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

/** The one dark card on a page: title, icon, a hero number and a short note. */
export function DarkCard({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: string;
  children: ReactNode;
}) {
  return (
    <article className="wp-card wp-inverse d-dark">
      <div className="d-head">
        <h2 className="d-title">{title}</h2>
        {icon && (
          <span className="wp-icon-well">
            <Icon name={icon} />
          </span>
        )}
      </div>
      <div className="d-dark-body">{children}</div>
    </article>
  );
}

/** Same thresholds as the shared CapacityBar: amber from 90%, red above 100%. */
export const capacityTone = (percent: number) =>
  percent > 100 ? 'danger' : percent >= 90 ? 'warning' : 'neutral';

/**
 * Capacity rows: label, bar and percentage. Amber and red rows also carry an icon, so the state
 * never depends on colour alone.
 */
export function CapacityRows({
  rows,
  narrow,
  plain,
}: {
  rows: readonly {
    key: string;
    label: string;
    percent: number;
    markerPercent?: number | undefined;
  }[];
  /** 56px labels, for rows inside a nested panel. */
  narrow?: boolean;
  /** Scores where higher is better: no amber or red near 100%. */
  plain?: boolean;
}) {
  return (
    <ul className="wp-list d-cap" data-narrow={narrow || undefined}>
      {rows.map((row) => {
        const tone = plain ? 'neutral' : capacityTone(row.percent);
        return (
          <li key={row.key} data-tone={tone}>
            <span className="d-cap-label">{row.label}</span>
            <ProgressBar
              label={`${row.label} used`}
              size={8}
              track="muted"
              tone={tone}
              value={row.percent}
              marker={row.markerPercent}
            />
            <strong>
              {tone !== 'neutral' && <Icon name={tone === 'danger' ? 'xoct' : 'alert'} size={12} />}
              <span className="wp-sr-only">
                {tone === 'danger' ? 'Over limit:' : tone === 'warning' ? 'Near limit:' : ''}
              </span>
              {Math.round(row.percent)}%
            </strong>
          </li>
        );
      })}
    </ul>
  );
}

/** Column chart with a value chip above each bar. `highlight` marks the bar that matters. */
export function Bars({
  label,
  bars,
  height = 200,
}: {
  label: string;
  bars: readonly { name: string; value: number; display?: string; highlight?: boolean }[];
  height?: number;
}) {
  const peak = Math.max(1, ...bars.map((bar) => bar.value));
  const dim = bars.some((bar) => bar.highlight);
  return (
    <ol className="d-bars" aria-label={label} style={{ height }}>
      {bars.map((bar, index) => (
        // One outlet can have two stops on a trip (dry and chilled), so the name alone repeats.
        // biome-ignore lint/suspicious/noArrayIndexKey: the list is rebuilt whole and never reordered
        <li key={`${bar.name}-${index}`}>
          <span className="d-bar-value">{bar.display ?? bar.value}</span>
          <span
            className="d-bar"
            aria-hidden="true"
            data-soft={(dim && !bar.highlight) || undefined}
            style={{ height: Math.round((bar.value / peak) * (height - 54)) }}
          />
          <span className="d-bar-name">{bar.name}</span>
        </li>
      ))}
    </ol>
  );
}

/** Headline number above a chart: small label, 40px value and an optional badge. */
export function Headline({
  label,
  value,
  children,
}: {
  label: string;
  value: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="d-headline">
      <p>{label}</p>
      <div>
        <strong>{value}</strong>
        {children}
      </div>
    </div>
  );
}

/**
 * Horizontal count bars in the categorical colour order. The count sits inside the bar end and
 * each bar is labelled with an icon and text, so colour is never the only cue.
 */
export function StatBars({
  bars,
}: {
  bars: readonly { key: string; label: string; icon: string; count: number }[];
}) {
  const most = Math.max(1, ...bars.map((bar) => bar.count));
  return (
    <ul className="wp-list d-statbars">
      {bars.map((bar) => (
        <li key={bar.key}>
          <span className="d-statbar-label">
            <Icon name={bar.icon} size={12} />
            {bar.label}
          </span>
          <b style={{ width: `${(bar.count / most) * 100}%` }}>{bar.count}</b>
        </li>
      ))}
    </ul>
  );
}

/** Half-ring score out of 100 with the number in the opening. */
export function Gauge({
  score,
  label,
  size = 200,
}: {
  score: number;
  label: string;
  size?: 200 | 260;
}) {
  const stroke = 14;
  const radius = (size - stroke) / 2;
  const arc = `M${stroke / 2} ${size / 2}A${radius} ${radius} 0 0 1 ${size - stroke / 2} ${size / 2}`;
  return (
    <div className="d-gauge" data-size={size} style={{ width: size }}>
      <svg width={size} height={size / 2} viewBox={`0 0 ${size} ${size / 2}`} aria-hidden="true">
        <path d={arc} pathLength={100} />
        <path
          className="d-gauge-fill"
          d={arc}
          pathLength={100}
          strokeDasharray={`${Math.max(0, Math.min(100, score))} 100`}
        />
      </svg>
      <p className="d-gauge-center" data-size={size}>
        <strong className="d-gauge-value" data-size={size}>
          {score}
        </strong>
        {label}
      </p>
    </div>
  );
}
