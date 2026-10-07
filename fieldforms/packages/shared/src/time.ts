import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/** All attendance is displayed in South African time. Storage is always UTC. */
export const DISPLAY_TZ = 'Africa/Johannesburg';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "HH:mm" (or "HH:mm:ss" as Postgres returns `time`) to minutes past midnight, or null. */
export function timeToMinutes(t: string | null | undefined): number | null {
  if (!t) return null;
  const m = HHMM.exec(t.slice(0, 5));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToTime(mins: number): string {
  const m = ((mins % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Shortest distance between two clock times, going either way round midnight. */
export function clockDiffMinutes(a: number, b: number): number {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

export function addDays(isoDate: string, days: number): string {
  const m = ISO_DATE.exec(isoDate);
  if (!m) throw new Error(`Invalid date: ${isoDate}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return d.toISOString().slice(0, 10);
}

/** A local wall-clock time on a date, in DISPLAY_TZ, as a UTC Date. */
export function localToUtc(isoDate: string, hhmm: string, tz = DISPLAY_TZ): Date {
  if (!ISO_DATE.test(isoDate)) throw new Error(`Invalid date: ${isoDate}`);
  if (timeToMinutes(hhmm) === null) throw new Error(`Invalid time: ${hhmm}`);
  return fromZonedTime(`${isoDate}T${hhmm.slice(0, 5)}:00`, tz);
}

export function formatLocal(d: Date | string, pattern = 'yyyy-MM-dd HH:mm', tz = DISPLAY_TZ): string {
  return formatInTimeZone(typeof d === 'string' ? new Date(d) : d, tz, pattern);
}

export function localDate(d: Date, tz = DISPLAY_TZ): string {
  return formatInTimeZone(d, tz, 'yyyy-MM-dd');
}

export function localTime(d: Date, tz = DISPLAY_TZ): string {
  return formatInTimeZone(d, tz, 'HH:mm');
}

export interface ShiftTimes {
  startTime: string; // "HH:mm"
  endTime: string; // "HH:mm"
}

/** A shift crosses midnight when it ends at or before the time it starts (e.g. 18:00-06:00). */
export function crossesMidnight(shift: ShiftTimes): boolean {
  const s = timeToMinutes(shift.startTime);
  const e = timeToMinutes(shift.endTime);
  if (s === null || e === null) return false;
  return e <= s;
}

/** The UTC start and end instants of a shift on a work date (the date the shift starts). */
export function shiftWindow(workDate: string, shift: ShiftTimes): { start: Date; end: Date } {
  const start = localToUtc(workDate, shift.startTime);
  const end = localToUtc(crossesMidnight(shift) ? addDays(workDate, 1) : workDate, shift.endTime);
  return { start, end };
}

/**
 * Turns a local "HH:mm" recorded against a shift into a UTC instant.
 *
 * For a shift that crosses midnight the same wall-clock time can fall on the work date or the day
 * after (05:30 on an 18:00-06:00 shift is the next morning). Both candidates are tried and the one
 * nearer the shift window wins, so an early arrival at 17:45 stays on the work date while a
 * 05:30 departure moves to the next day.
 */
export function resolveShiftTime(workDate: string, hhmm: string, shift: ShiftTimes): Date {
  const sameDay = localToUtc(workDate, hhmm);
  if (!crossesMidnight(shift)) return sameDay;
  const nextDay = localToUtc(addDays(workDate, 1), hhmm);
  const { start, end } = shiftWindow(workDate, shift);
  const distance = (t: Date) =>
    t < start ? start.getTime() - t.getTime() : t > end ? t.getTime() - end.getTime() : 0;
  return distance(nextDay) < distance(sameDay) ? nextDay : sameDay;
}

/**
 * The work date a supervisor most likely means right now for a shift: today, unless it is a
 * night shift that started yesterday and has not yet ended (plus a grace period to close it).
 */
export function defaultWorkDate(shift: ShiftTimes, now: Date, closeGraceMinutes = 240): string {
  const today = localDate(now);
  if (!crossesMidnight(shift)) return today;
  const yesterday = addDays(today, -1);
  const { end } = shiftWindow(yesterday, shift);
  return now.getTime() <= end.getTime() + closeGraceMinutes * 60_000 ? yesterday : today;
}
