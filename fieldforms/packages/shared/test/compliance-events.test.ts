import { describe, expect, it } from 'vitest';
import { checkGeofence, checkShiftTime, clockFlags, haversineMetres } from '../src/compliance.js';
import { deriveEntryEvent } from '../src/events.js';
import { registerSubmissionInput } from '../src/schemas.js';

const day = { startTime: '07:00', endTime: '16:00' };
const night = { startTime: '18:00', endTime: '06:00' };
const T = (iso: string) => new Date(iso);

describe('geofence', () => {
  it('computes known distances', () => {
    // Johannesburg CBD to Sandton is roughly 13 km.
    const d = haversineMetres(-26.2041, 28.0473, -26.1076, 28.0567);
    expect(d).toBeGreaterThan(10_000);
    expect(d).toBeLessThan(11_500);
  });

  it('returns null rather than false when it cannot check', () => {
    expect(checkGeofence(null, { lat: 1, lng: 1, geofenceMetres: 100 })).toEqual({ distanceMetres: null, ok: null });
    expect(checkGeofence({ lat: 1, lng: 1 }, { lat: null, lng: null, geofenceMetres: 100 }).ok).toBeNull();
  });

  it('passes inside and fails outside the radius', () => {
    const site = { lat: -26.2041, lng: 28.0473, geofenceMetres: 1000 };
    expect(checkGeofence({ lat: -26.205, lng: 28.048 }, site).ok).toBe(true);
    expect(checkGeofence({ lat: -26.1076, lng: 28.0567 }, site).ok).toBe(false);
  });
});

describe('shift time window', () => {
  it('checks start registers against shift start', () => {
    expect(checkShiftTime('start', day, T('2026-10-06T05:20:00Z'), 30)).toBe(true); // 07:20 local
    expect(checkShiftTime('start', day, T('2026-10-06T06:00:00Z'), 30)).toBe(false); // 08:00 local
  });

  it('handles a night shift start window across midnight', () => {
    const lateNight = { startTime: '23:50', endTime: '07:00' };
    expect(checkShiftTime('start', lateNight, T('2026-10-06T22:10:00Z'), 30)).toBe(true); // 00:10 local
  });

  it('checks end registers against shift end and is unknown for other kinds', () => {
    expect(checkShiftTime('end', night, T('2026-10-07T04:10:00Z'), 30)).toBe(true); // 06:10 local
    expect(checkShiftTime('late', day, T('2026-10-06T05:20:00Z'), 30)).toBeNull();
    expect(checkShiftTime('start', null, T('2026-10-06T05:20:00Z'), 30)).toBeNull();
  });
});

describe('clock flags', () => {
  const thresholds = { clockSkewSeconds: 120, syncDelayFlagHours: 24 };

  it('does not flag a record captured offline and synced hours later with a correct clock', () => {
    const f = clockFlags(
      {
        deviceCapturedAt: T('2026-10-06T05:00:00Z'),
        deviceSentAt: T('2026-10-06T09:00:00Z'),
        serverReceivedAt: T('2026-10-06T09:00:01Z'),
      },
      thresholds,
    );
    expect(f.clockSkewFlag).toBe(false);
    expect(f.syncDelaySeconds).toBe(4 * 3600);
    expect(f.syncDelayFlag).toBe(false);
  });

  it('flags a phone whose clock is wrong', () => {
    const f = clockFlags(
      {
        deviceCapturedAt: T('2026-10-06T04:00:00Z'),
        deviceSentAt: T('2026-10-06T04:00:00Z'),
        serverReceivedAt: T('2026-10-06T05:00:00Z'),
      },
      thresholds,
    );
    expect(f.clockSkewSeconds).toBe(3600);
    expect(f.clockSkewFlag).toBe(true);
  });

  it('flags very late uploads separately', () => {
    const f = clockFlags(
      {
        deviceCapturedAt: T('2026-10-01T05:00:00Z'),
        deviceSentAt: T('2026-10-06T05:00:00Z'),
        serverReceivedAt: T('2026-10-06T05:00:00Z'),
      },
      thresholds,
    );
    expect(f.clockSkewFlag).toBe(false);
    expect(f.syncDelayFlag).toBe(true);
  });
});

describe('deriveEntryEvent', () => {
  const base = { workDate: '2026-10-06', capturedAt: T('2026-10-06T05:05:00Z') };

  it('present on a start register is IN at shift start', () => {
    const e = deriveEntryEvent({ ...base, kind: 'start', shift: day, entry: { status: 'present' } });
    expect(e).toEqual({ event: 'in', eventAt: T('2026-10-06T05:00:00Z'), minutes: null });
  });

  it('late by minutes or by arrival time', () => {
    expect(
      deriveEntryEvent({ ...base, kind: 'start', shift: day, entry: { status: 'late', minutesLate: 25 } }),
    ).toEqual({ event: 'in', eventAt: T('2026-10-06T05:25:00Z'), minutes: 25 });
    expect(deriveEntryEvent({ ...base, kind: 'late', shift: day, entry: { status: 'late', time: '08:10' } })).toEqual({
      event: 'in',
      eventAt: T('2026-10-06T06:10:00Z'),
      minutes: 70,
    });
  });

  it('absent has no event', () => {
    expect(deriveEntryEvent({ ...base, kind: 'start', shift: day, entry: { status: 'absent' } }).event).toBeNull();
  });

  it('left early on a night shift lands on the next morning with minutes early', () => {
    const e = deriveEntryEvent({
      ...base,
      kind: 'left_early',
      shift: night,
      entry: { status: 'left_early', time: '04:00' },
    });
    expect(e).toEqual({ event: 'out', eventAt: T('2026-10-07T02:00:00Z'), minutes: 120 });
  });

  it('present on an end register is OUT at the stated end time, else capture time', () => {
    expect(
      deriveEntryEvent({ ...base, kind: 'end', shift: night, endTime: '06:05', entry: { status: 'present' } }),
    ).toEqual({ event: 'out', eventAt: T('2026-10-07T04:05:00Z'), minutes: null });
    expect(deriveEntryEvent({ ...base, kind: 'end', shift: day, entry: { status: 'present' } }).eventAt).toEqual(
      base.capturedAt,
    );
  });
});

describe('registerSubmissionInput', () => {
  const valid = {
    id: '6f1c1c1e-6a0e-4d55-9d1d-0d4c1f1f1f1f',
    kind: 'start',
    siteId: '6f1c1c1e-6a0e-4d55-9d1d-0d4c1f1f1f10',
    shiftId: '6f1c1c1e-6a0e-4d55-9d1d-0d4c1f1f1f11',
    workDate: '2026-10-06',
    deviceCapturedAt: '2026-10-06T05:05:00.000Z',
    deviceSentAt: '2026-10-06T05:05:01.000Z',
    location: null,
    entries: [{ employeeId: '6f1c1c1e-6a0e-4d55-9d1d-0d4c1f1f1f12', status: 'present' }],
  };

  it('accepts a valid start register', () => {
    expect(registerSubmissionInput.safeParse(valid).success).toBe(true);
  });

  it('rejects statuses that do not belong to the register kind', () => {
    const r = registerSubmissionInput.safeParse({
      ...valid,
      kind: 'end',
      entries: [{ employeeId: valid.entries[0]!.employeeId, status: 'absent' }],
    });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate employees and late without minutes', () => {
    const emp = valid.entries[0]!.employeeId;
    expect(
      registerSubmissionInput.safeParse({
        ...valid,
        entries: [
          { employeeId: emp, status: 'present' },
          { employeeId: emp, status: 'present' },
        ],
      }).success,
    ).toBe(false);
    expect(
      registerSubmissionInput.safeParse({ ...valid, entries: [{ employeeId: emp, status: 'late' }] }).success,
    ).toBe(false);
  });

  it('only lets absent employees have a replacement', () => {
    const emp = valid.entries[0]!.employeeId;
    expect(
      registerSubmissionInput.safeParse({
        ...valid,
        entries: [{ employeeId: emp, status: 'present', replacementEmployeeId: valid.siteId }],
      }).success,
    ).toBe(false);
  });
});
