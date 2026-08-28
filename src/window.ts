import type { Window } from './types.js';

const iso = (date: Date): { year: number; week: number } => {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((value.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: value.getUTCFullYear(), week };
};

/** Calendar date (YYYY-MM-DD) of `now` in the given IANA timezone, as a UTC midnight instant. */
function dateInTimezone(now: Date, timezone: string): Date {
  if (!timezone || timezone === 'UTC') {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (type: string): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}

export type WindowMode = 'last-complete-week' | 'current-week';

export function weekWindow(
  from?: string,
  to?: string,
  now = new Date(),
  timezone = 'UTC',
  mode: WindowMode = 'last-complete-week',
): Window {
  if (from || to) {
    if (!from || !to) throw new Error('--from and --to must be supplied together');

    const validDate = (value: string): boolean =>
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      (() => {
        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
      })();

    if (!validDate(from) || !validDate(to)) throw new Error('Invalid date window');

    const f = new Date(`${from}T00:00:00Z`);
    const t = new Date(`${to}T00:00:00Z`);
    if (f >= t) throw new Error('Invalid date window');

    const info = iso(f);
    return { from: f, to: t, week: `${info.year}-W${String(info.week).padStart(2, '0')}` };
  }

  // "Today" in the configured timezone, normalized to a UTC-midnight instant.
  const today = dateInTimezone(now, timezone);
  const day = today.getUTCDay() || 7;
  const thisMonday = new Date(today);
  thisMonday.setUTCDate(today.getUTCDate() - day + 1);

  let start: Date;
  let end: Date;
  if (mode === 'current-week') {
    start = thisMonday;
    end = new Date(thisMonday);
    end.setUTCDate(thisMonday.getUTCDate() + 7);
  } else {
    // last-complete-week
    end = thisMonday;
    start = new Date(end);
    start.setUTCDate(end.getUTCDate() - 7);
  }
  const info = iso(start);
  return { from: start, to: end, week: `${info.year}-W${String(info.week).padStart(2, '0')}` };
}
