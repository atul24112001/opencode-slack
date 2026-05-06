// Schedule parsing + due-time computation for /oc schedule.
// Supports three forms:
//   hourly                          → every hour on the minute
//   daily HH:MM | daily 9am         → every day at HH:MM (UTC)
//   weekly DAY HH:MM                → every week on DAY (mon|tue|...|sun) at HH:MM (UTC)

export type ScheduleKind = 'hourly' | 'daily' | 'weekly';

export interface ParsedSchedule {
  kind: ScheduleKind;
  hour: number | null;
  minute: number | null;
  weekday: number | null; // 0=Sun..6=Sat
}

const WEEKDAYS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  weds: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

export interface ParseResult {
  schedule?: ParsedSchedule;
  remainder: string;
  error?: string;
}

export function parseScheduleAndRemainder(args: string): ParseResult {
  const trimmed = args.trim();
  const lower = trimmed.toLowerCase();
  const tokens = trimmed.split(/\s+/);
  if (!tokens[0]) return { remainder: '', error: 'Missing schedule.' };

  const kindToken = tokens[0].toLowerCase();

  if (kindToken === 'hourly') {
    return {
      schedule: { kind: 'hourly', hour: null, minute: 0, weekday: null },
      remainder: tokens.slice(1).join(' '),
    };
  }

  if (kindToken === 'daily') {
    const timeToken = tokens[1];
    if (!timeToken) {
      return {
        remainder: tokens.slice(1).join(' '),
        error: 'Usage: daily HH:MM (e.g. `daily 9am` or `daily 14:30`)',
      };
    }
    const time = parseTime(timeToken);
    if (!time) {
      return {
        remainder: tokens.slice(2).join(' '),
        error: `Cannot parse time: ${timeToken}`,
      };
    }
    return {
      schedule: {
        kind: 'daily',
        hour: time.hour,
        minute: time.minute,
        weekday: null,
      },
      remainder: tokens.slice(2).join(' '),
    };
  }

  if (kindToken === 'weekly') {
    const dayToken = tokens[1];
    const timeToken = tokens[2];
    if (!dayToken || !timeToken) {
      return {
        remainder: tokens.slice(1).join(' '),
        error: 'Usage: weekly DAY HH:MM (e.g. `weekly mon 9am`)',
      };
    }
    const weekday = WEEKDAYS[dayToken.toLowerCase()];
    if (weekday === undefined) {
      return {
        remainder: tokens.slice(3).join(' '),
        error: `Cannot parse weekday: ${dayToken}`,
      };
    }
    const time = parseTime(timeToken);
    if (!time) {
      return {
        remainder: tokens.slice(3).join(' '),
        error: `Cannot parse time: ${timeToken}`,
      };
    }
    return {
      schedule: {
        kind: 'weekly',
        hour: time.hour,
        minute: time.minute,
        weekday,
      },
      remainder: tokens.slice(3).join(' '),
    };
  }

  return { remainder: lower, error: `Unknown schedule kind: ${kindToken}` };
}

function parseTime(token: string): { hour: number; minute: number } | null {
  const t = token.toLowerCase();
  // 9am | 12pm | 9:30am | 14:30
  const ampm = /^(\d{1,2})(?::(\d{1,2}))?(am|pm)$/.exec(t);
  if (ampm) {
    let hour = Number.parseInt(ampm[1] ?? '0', 10);
    const minute = ampm[2] ? Number.parseInt(ampm[2], 10) : 0;
    const mer = ampm[3];
    if (Number.isNaN(hour) || hour < 1 || hour > 12) return null;
    if (Number.isNaN(minute) || minute < 0 || minute > 59) return null;
    if (mer === 'am' && hour === 12) hour = 0;
    if (mer === 'pm' && hour < 12) hour += 12;
    return { hour, minute };
  }
  const h24 = /^(\d{1,2}):(\d{1,2})$/.exec(t);
  if (h24) {
    const hour = Number.parseInt(h24[1] ?? '0', 10);
    const minute = Number.parseInt(h24[2] ?? '0', 10);
    if (Number.isNaN(hour) || hour < 0 || hour > 23) return null;
    if (Number.isNaN(minute) || minute < 0 || minute > 59) return null;
    return { hour, minute };
  }
  return null;
}

export function computeNextRun(
  schedule: ParsedSchedule,
  after: Date = new Date(),
): number {
  const ms = 60 * 1000;
  if (schedule.kind === 'hourly') {
    const next = new Date(after);
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    return next.getTime();
  }
  if (schedule.kind === 'daily') {
    const hour = schedule.hour ?? 0;
    const minute = schedule.minute ?? 0;
    const next = new Date(
      Date.UTC(
        after.getUTCFullYear(),
        after.getUTCMonth(),
        after.getUTCDate(),
        hour,
        minute,
        0,
        0,
      ),
    );
    if (next.getTime() <= after.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime();
  }
  // weekly
  const hour = schedule.hour ?? 0;
  const minute = schedule.minute ?? 0;
  const targetDow = schedule.weekday ?? 0;
  const next = new Date(
    Date.UTC(
      after.getUTCFullYear(),
      after.getUTCMonth(),
      after.getUTCDate(),
      hour,
      minute,
      0,
      0,
    ),
  );
  const diffDays = (targetDow - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + diffDays);
  if (next.getTime() <= after.getTime()) {
    next.setUTCDate(next.getUTCDate() + 7);
  }
  // unused suppress
  void ms;
  return next.getTime();
}

export function formatSchedule(schedule: ParsedSchedule): string {
  const hh = (schedule.hour ?? 0).toString().padStart(2, '0');
  const mm = (schedule.minute ?? 0).toString().padStart(2, '0');
  if (schedule.kind === 'hourly') return 'hourly';
  if (schedule.kind === 'daily') return `daily at ${hh}:${mm} UTC`;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dayName = days[schedule.weekday ?? 0] ?? '?';
  return `weekly on ${dayName} at ${hh}:${mm} UTC`;
}
