import { describe, expect, it } from 'vitest';
import {
  addDays,
  clockDiffMinutes,
  crossesMidnight,
  defaultWorkDate,
  formatLocal,
  localToUtc,
  resolveShiftTime,
  shiftWindow,
  timeToMinutes,
} from '../src/time.js';

const day = { startTime: '07:00', endTime: '16:00' };
const night = { startTime: '18:00', endTime: '06:00' };

describe('time helpers', () => {
  it('parses HH:mm and Postgres HH:mm:ss', () => {
    expect(timeToMinutes('07:30')).toBe(450);
    expect(timeToMinutes('23:59:00')).toBe(1439);
    expect(timeToMinutes('24:00')).toBeNull();
    expect(timeToMinutes('')).toBeNull();
  });

  it('measures clock distance around midnight', () => {
    expect(clockDiffMinutes(timeToMinutes('23:50')!, timeToMinutes('00:10')!)).toBe(20);
    expect(clockDiffMinutes(600, 600)).toBe(0);
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
  });

  it('converts Johannesburg local time to UTC (UTC+2, no DST)', () => {
    expect(localToUtc('2026-06-15', '07:00').toISOString()).toBe('2026-06-15T05:00:00.000Z');
    expect(localToUtc('2026-01-15', '00:30').toISOString()).toBe('2026-01-14T22:30:00.000Z');
    expect(formatLocal(new Date('2026-01-14T22:30:00Z'))).toBe('2026-01-15 00:30');
  });
});

describe('shifts', () => {
  it('detects midnight crossing from the times, not the shift name', () => {
    expect(crossesMidnight(day)).toBe(false);
    expect(crossesMidnight(night)).toBe(true);
  });

  it('puts a night shift end on the next day', () => {
    const w = shiftWindow('2026-10-06', night);
    expect(w.start.toISOString()).toBe('2026-10-06T16:00:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-07T04:00:00.000Z');
  });

  it('resolves night-shift times to the nearer day', () => {
    // Leaving at 05:30 is the next morning.
    expect(resolveShiftTime('2026-10-06', '05:30', night).toISOString()).toBe(
      '2026-10-07T03:30:00.000Z',
    );
    // Arriving 15 minutes early stays on the work date.
    expect(resolveShiftTime('2026-10-06', '17:45', night).toISOString()).toBe(
      '2026-10-06T15:45:00.000Z',
    );
    // Late arrival just after midnight is the next calendar day.
    expect(resolveShiftTime('2026-10-06', '00:20', night).toISOString()).toBe(
      '2026-10-06T22:20:00.000Z',
    );
  });

  it('never moves a day-shift time to another day', () => {
    expect(resolveShiftTime('2026-10-06', '01:00', day).toISOString()).toBe(
      '2026-10-05T23:00:00.000Z',
    );
  });

  it('defaults a night-shift close-out after midnight to the previous work date', () => {
    // 05:00 local on the 7th, closing the shift that started at 18:00 on the 6th.
    expect(defaultWorkDate(night, new Date('2026-10-07T03:00:00Z'))).toBe('2026-10-06');
    // 19:00 local on the 7th is the new shift.
    expect(defaultWorkDate(night, new Date('2026-10-07T17:00:00Z'))).toBe('2026-10-07');
    expect(defaultWorkDate(day, new Date('2026-10-07T03:00:00Z'))).toBe('2026-10-07');
  });
});
