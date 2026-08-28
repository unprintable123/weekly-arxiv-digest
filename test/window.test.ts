import { describe, expect, it } from 'vitest';
import { isoWeekOf, weekWindow } from '../src/window.js';

describe('weekWindow', () => {
    it('computes the last complete week by default (UTC)', () => {
        // 2026-08-28 is a Friday.
        const window = weekWindow(undefined, undefined, new Date('2026-08-28T12:00:00Z'));
        expect(window.week).toBe('2026-W34');
        expect(window.from.toISOString().slice(0, 10)).toBe('2026-08-17');
        expect(window.to.toISOString().slice(0, 10)).toBe('2026-08-24');
    });

    it('supports current-week mode', () => {
        const window = weekWindow(
            undefined,
            undefined,
            new Date('2026-08-28T12:00:00Z'),
            'UTC',
            'current-week',
        );
        expect(window.from.toISOString().slice(0, 10)).toBe('2026-08-24');
        expect(window.to.toISOString().slice(0, 10)).toBe('2026-08-31');
        expect(window.week).toBe('2026-W35');
    });

    it('honors an explicit from/to window', () => {
        const window = weekWindow('2024-01-01', '2024-01-08');
        expect(window.week).toBe('2024-W01');
        expect(window.from.toISOString()).toBe('2024-01-01T00:00:00.000Z');
        expect(window.to.toISOString()).toBe('2024-01-08T00:00:00.000Z');
    });

    it('rejects invalid or reversed windows', () => {
        expect(() => weekWindow('2024-01-08', '2024-01-01')).toThrow(/Invalid date window/);
        expect(() => weekWindow('2024-02-30', '2024-03-01')).toThrow(/Invalid date window/);
        expect(() => weekWindow(undefined, '2024-01-08')).toThrow(/must be supplied together/);
    });

    it('computes the window in a non-UTC timezone', () => {
        // 2026-08-28T16:00Z is 2026-08-29 01:00 in Asia/Tokyo (a Saturday).
        const window = weekWindow(undefined, undefined, new Date('2026-08-28T16:00:00Z'), 'Asia/Tokyo');
        // "Today" is Saturday 2026-08-29, so the last complete week ends 2026-08-24.
        expect(window.to.toISOString().slice(0, 10)).toBe('2026-08-24');
        expect(window.from.toISOString().slice(0, 10)).toBe('2026-08-17');
    });
});

describe('isoWeekOf', () => {
    it('computes the ISO week id for UTC date strings', () => {
        expect(isoWeekOf('2024-01-01T00:00:00.000Z')).toBe('2024-W01');
        expect(isoWeekOf('2024-01-07T00:00:00.000Z')).toBe('2024-W01'); // Sunday still week 1
        expect(isoWeekOf('2024-01-08T00:00:00.000Z')).toBe('2024-W02');
        expect(isoWeekOf('2024-12-30T00:00:00.000Z')).toBe('2025-W01'); // year boundary
        expect(isoWeekOf('2026-08-17T00:00:00.000Z')).toBe('2026-W34');
    });

    it('returns an empty string for invalid dates', () => {
        expect(isoWeekOf('not-a-date')).toBe('');
        expect(isoWeekOf('')).toBe('');
    });
});
