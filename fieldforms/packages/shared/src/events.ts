import type { RegisterEntryInput, RegisterKind } from './schemas.js';
import { resolveShiftTime, shiftWindow, type ShiftTimes } from './time.js';

export interface DerivedEvent {
  event: 'in' | 'out' | null;
  eventAt: Date | null;
  /** Minutes late (for an IN) or minutes early (for an early OUT); null otherwise. */
  minutes: number | null;
}

const MS_PER_MIN = 60_000;

/**
 * What a register line means as a clock event. This is the single place that turns the
 * supervisor's view (present / late / absent / left early) into IN and OUT instants, so the
 * daily report can work with events only.
 */
export function deriveEntryEvent(args: {
  kind: RegisterKind;
  entry: Pick<RegisterEntryInput, 'status' | 'time' | 'minutesLate'>;
  shift: ShiftTimes;
  workDate: string;
  endTime?: string | undefined;
  capturedAt: Date;
}): DerivedEvent {
  const { kind, entry, shift, workDate } = args;
  const window = shiftWindow(workDate, shift);

  if (entry.status === 'absent') return { event: null, eventAt: null, minutes: null };

  if (entry.status === 'late') {
    if (entry.time) {
      const at = resolveShiftTime(workDate, entry.time, shift);
      const late = Math.max(0, Math.round((at.getTime() - window.start.getTime()) / MS_PER_MIN));
      return { event: 'in', eventAt: at, minutes: late };
    }
    const late = entry.minutesLate ?? 0;
    return { event: 'in', eventAt: new Date(window.start.getTime() + late * MS_PER_MIN), minutes: late };
  }

  if (entry.status === 'left_early') {
    const at = entry.time ? resolveShiftTime(workDate, entry.time, shift) : args.capturedAt;
    const early = Math.max(0, Math.round((window.end.getTime() - at.getTime()) / MS_PER_MIN));
    return { event: 'out', eventAt: at, minutes: early };
  }

  // present
  if (kind === 'end') {
    const at = args.endTime ? resolveShiftTime(workDate, args.endTime, shift) : args.capturedAt;
    return { event: 'out', eventAt: at, minutes: null };
  }
  return { event: 'in', eventAt: window.start, minutes: null };
}
