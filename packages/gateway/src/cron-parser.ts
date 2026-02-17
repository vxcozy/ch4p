/**
 * Minimal 5-field cron expression parser — zero external dependencies.
 *
 * Supports standard cron syntax: minute hour dom month dow
 *
 * Field syntax: wildcard, exact value, range (N-M), list (N,M,O),
 * step (wildcard/N or N-M/N).
 *
 * Examples: "0 9 1 1 0" (midnight Jan 1 Sun), every-15-min, weekdays 9-17.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CronSchedule {
  /** Resolved set of valid minutes (0-59). */
  minutes: Set<number>;
  /** Resolved set of valid hours (0-23). */
  hours: Set<number>;
  /** Resolved set of valid days-of-month (1-31). */
  daysOfMonth: Set<number>;
  /** Resolved set of valid months (1-12). */
  months: Set<number>;
  /** Resolved set of valid days-of-week (0-6, Sunday=0). */
  daysOfWeek: Set<number>;
}

// ---------------------------------------------------------------------------
// Field ranges
// ---------------------------------------------------------------------------

const FIELD_RANGES: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute',       min: 0,  max: 59 },
  { name: 'hour',         min: 0,  max: 23 },
  { name: 'day-of-month', min: 1,  max: 31 },
  { name: 'month',        min: 1,  max: 12 },
  { name: 'day-of-week',  min: 0,  max: 6  },
];

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

/**
 * Parse a 5-field cron expression into a CronSchedule.
 * Throws if the expression is invalid.
 */
export function parseCron(expression: string): CronSchedule {
  const trimmed = expression.trim();
  const fields = trimmed.split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length} ("${trimmed}")`);
  }

  const parsed = fields.map((field, i) =>
    parseField(field!, FIELD_RANGES[i]!.min, FIELD_RANGES[i]!.max, FIELD_RANGES[i]!.name),
  );

  return {
    minutes:     new Set(parsed[0]!),
    hours:       new Set(parsed[1]!),
    daysOfMonth: new Set(parsed[2]!),
    months:      new Set(parsed[3]!),
    daysOfWeek:  new Set(parsed[4]!),
  };
}

/**
 * Check whether a Date matches a CronSchedule.
 */
export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  return (
    schedule.minutes.has(date.getMinutes()) &&
    schedule.hours.has(date.getHours()) &&
    schedule.daysOfMonth.has(date.getDate()) &&
    schedule.months.has(date.getMonth() + 1) &&
    schedule.daysOfWeek.has(date.getDay())
  );
}

// ---------------------------------------------------------------------------
// Field parser
// ---------------------------------------------------------------------------

/**
 * Parse a single cron field into an array of valid values.
 */
function parseField(field: string, min: number, max: number, name: string): number[] {
  const values = new Set<number>();

  // Split on commas for list support: "1,5,10"
  for (const part of field.split(',')) {
    const trimmedPart = part.trim();
    if (trimmedPart.length === 0) {
      throw new Error(`Empty value in ${name} field`);
    }

    // Check for step: "*/2" or "1-10/3"
    const slashIndex = trimmedPart.indexOf('/');
    let rangePart = trimmedPart;
    let step = 1;

    if (slashIndex !== -1) {
      rangePart = trimmedPart.slice(0, slashIndex);
      const stepStr = trimmedPart.slice(slashIndex + 1);
      step = parseInt(stepStr, 10);
      if (isNaN(step) || step < 1) {
        throw new Error(`Invalid step "${stepStr}" in ${name} field`);
      }
    }

    if (rangePart === '*') {
      // Wildcard — all values in range, optionally stepped.
      for (let v = min; v <= max; v += step) {
        values.add(v);
      }
    } else if (rangePart.includes('-')) {
      // Range: "5-10"
      const [startStr, endStr] = rangePart.split('-');
      const start = parseInt(startStr!, 10);
      const end = parseInt(endStr!, 10);

      if (isNaN(start) || isNaN(end)) {
        throw new Error(`Invalid range "${rangePart}" in ${name} field`);
      }
      if (start < min || end > max || start > end) {
        throw new Error(`Range ${start}-${end} out of bounds (${min}-${max}) in ${name} field`);
      }

      for (let v = start; v <= end; v += step) {
        values.add(v);
      }
    } else {
      // Single value: "5"
      const val = parseInt(rangePart, 10);
      if (isNaN(val) || val < min || val > max) {
        throw new Error(`Value "${rangePart}" out of bounds (${min}-${max}) in ${name} field`);
      }
      values.add(val);
    }
  }

  if (values.size === 0) {
    throw new Error(`No valid values resolved for ${name} field`);
  }

  return [...values].sort((a, b) => a - b);
}
