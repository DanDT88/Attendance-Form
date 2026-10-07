import { clockDiffMinutes, localTime, timeToMinutes, type ShiftTimes } from './time.js';

/** Great-circle distance between two points, in metres. */
export function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface GeoCheck {
  distanceMetres: number | null;
  /** null means it could not be checked (no device fix, or the site has no GPS point). */
  ok: boolean | null;
}

export function checkGeofence(
  device: { lat: number; lng: number } | null | undefined,
  site: { lat: number | null; lng: number | null; geofenceMetres: number },
): GeoCheck {
  if (!device || site.lat === null || site.lng === null) return { distanceMetres: null, ok: null };
  const d = haversineMetres(device.lat, device.lng, site.lat, site.lng);
  return { distanceMetres: Math.round(d), ok: d <= site.geofenceMetres };
}

/**
 * Was the register captured within `graceMinutes` of the expected moment (shift start for the
 * morning register, shift end for closing it)? A symmetric window measured round the clock face,
 * so a night shift crossing midnight needs no special case. null = cannot be determined.
 */
export function checkShiftTime(
  kind: string,
  shift: ShiftTimes | null | undefined,
  capturedAt: Date,
  graceMinutes: number,
): boolean | null {
  if (!shift) return null;
  const anchor =
    kind === 'start' ? shift.startTime : kind === 'end' ? shift.endTime : null;
  const anchorMins = timeToMinutes(anchor);
  const captured = timeToMinutes(localTime(capturedAt));
  if (anchorMins === null || captured === null) return null;
  return clockDiffMinutes(anchorMins, captured) <= graceMinutes;
}

export interface ClockFlags {
  clockSkewSeconds: number;
  clockSkewFlag: boolean;
  syncDelaySeconds: number;
  syncDelayFlag: boolean;
}

/**
 * Two separate measures, because one comparison cannot tell a wrong clock from a late upload:
 *  - skew: server receipt vs the device's clock at the moment it sent (latency is seconds), so a
 *    large value means the phone's clock is wrong or was changed;
 *  - sync delay: server receipt vs when the register was captured, which is legitimately large
 *    for anything captured offline.
 */
export function clockFlags(
  args: { deviceCapturedAt: Date; deviceSentAt: Date; serverReceivedAt: Date },
  thresholds: { clockSkewSeconds: number; syncDelayFlagHours: number },
): ClockFlags {
  const skew = Math.round((args.serverReceivedAt.getTime() - args.deviceSentAt.getTime()) / 1000);
  // Measured on the device's own clock so that skew does not leak into the delay as well.
  const delay = Math.round((args.deviceSentAt.getTime() - args.deviceCapturedAt.getTime()) / 1000);
  return {
    clockSkewSeconds: skew,
    clockSkewFlag: Math.abs(skew) > thresholds.clockSkewSeconds,
    syncDelaySeconds: delay,
    syncDelayFlag: delay > thresholds.syncDelayFlagHours * 3600,
  };
}
