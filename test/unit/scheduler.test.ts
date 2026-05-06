import { describe, expect, it } from 'vitest';
import {
  computeNextRun,
  formatSchedule,
  parseScheduleAndRemainder,
} from '../../src/scheduler.js';

describe('parseScheduleAndRemainder', () => {
  it('parses `daily 9am explore <q>`', () => {
    const r = parseScheduleAndRemainder('daily 9am explore what changed');
    expect(r.error).toBeUndefined();
    expect(r.schedule).toEqual({
      kind: 'daily',
      hour: 9,
      minute: 0,
      weekday: null,
    });
    expect(r.remainder).toBe('explore what changed');
  });

  it('parses `daily 14:30 review 142`', () => {
    const r = parseScheduleAndRemainder('daily 14:30 review 142');
    expect(r.schedule).toEqual({
      kind: 'daily',
      hour: 14,
      minute: 30,
      weekday: null,
    });
  });

  it('parses `weekly mon 9am ...`', () => {
    const r = parseScheduleAndRemainder('weekly mon 9am ship something');
    expect(r.schedule).toEqual({
      kind: 'weekly',
      hour: 9,
      minute: 0,
      weekday: 1,
    });
    expect(r.remainder).toBe('ship something');
  });

  it('parses hourly', () => {
    const r = parseScheduleAndRemainder('hourly cost');
    expect(r.schedule).toEqual({
      kind: 'hourly',
      hour: null,
      minute: 0,
      weekday: null,
    });
  });

  it('errors on unknown kind', () => {
    const r = parseScheduleAndRemainder('quarterly review');
    expect(r.error).toContain('Unknown');
  });

  it('errors on bad time', () => {
    const r = parseScheduleAndRemainder('daily wat');
    expect(r.error).toContain('Cannot parse time');
  });
});

describe('computeNextRun', () => {
  it('daily fires today if before the hour, tomorrow if after', () => {
    const before = new Date(Date.UTC(2025, 0, 1, 8, 0, 0));
    const next1 = computeNextRun(
      { kind: 'daily', hour: 9, minute: 0, weekday: null },
      before,
    );
    expect(new Date(next1).getUTCHours()).toBe(9);
    expect(new Date(next1).getUTCDate()).toBe(1);

    const after = new Date(Date.UTC(2025, 0, 1, 10, 0, 0));
    const next2 = computeNextRun(
      { kind: 'daily', hour: 9, minute: 0, weekday: null },
      after,
    );
    expect(new Date(next2).getUTCDate()).toBe(2);
  });

  it('hourly rolls to next hour boundary', () => {
    const at = new Date(Date.UTC(2025, 0, 1, 8, 30, 0));
    const next = computeNextRun(
      { kind: 'hourly', hour: null, minute: 0, weekday: null },
      at,
    );
    const d = new Date(next);
    expect(d.getUTCHours()).toBe(9);
    expect(d.getUTCMinutes()).toBe(0);
  });

  it('weekly picks the right weekday', () => {
    // 2025-01-01 was a Wednesday (weekday=3)
    const wed = new Date(Date.UTC(2025, 0, 1, 8, 0, 0));
    const next = computeNextRun(
      { kind: 'weekly', hour: 9, minute: 0, weekday: 1 }, // Mon
      wed,
    );
    expect(new Date(next).getUTCDay()).toBe(1);
  });
});

describe('formatSchedule', () => {
  it('formats daily', () => {
    expect(
      formatSchedule({
        kind: 'daily',
        hour: 9,
        minute: 30,
        weekday: null,
      }),
    ).toBe('daily at 09:30 UTC');
  });
  it('formats weekly', () => {
    expect(
      formatSchedule({ kind: 'weekly', hour: 14, minute: 0, weekday: 1 }),
    ).toBe('weekly on Mon at 14:00 UTC');
  });
});
