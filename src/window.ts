import type { Window } from './types.js';

const iso = (date: Date): { year: number; week: number } => {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((value.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { year: value.getUTCFullYear(), week };
};

export function weekWindow(from?: string, to?: string, now = new Date()): Window {
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

  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = today.getUTCDay() || 7;
  const end = new Date(today);
  end.setUTCDate(today.getUTCDate() - day + 1);
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - 7);
  const info = iso(start);
  return { from: start, to: end, week: `${info.year}-W${String(info.week).padStart(2, '0')}` };
}
