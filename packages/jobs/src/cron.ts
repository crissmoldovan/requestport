/**
 * Five-field cron, evaluated in UTC, for the Postgres worker's schedules.
 *
 * Trigger.dev reads the same expressions for the same schedules (in UTC unless
 * a schedule names a timezone, and none here does), so one catalogue serves
 * both runners. This reads what that catalogue uses and the standard forms
 * around it — `*`, `n`, `a-b`, lists, and `/step` on either — and refuses
 * anything else rather than guessing: names (`MON`, `JAN`), `L`, `W`, `#`,
 * `?` and six-field seconds are not accepted.
 *
 * When both day-of-month and day-of-week are restricted, a day matches if
 * either does. That is standard cron behaviour, and the surprising part of
 * it. A field written starting with `*` counts as unrestricted for that rule.
 */

type Field = {
  values: ReadonlySet<number>;
  unrestricted: boolean;
};

export type ParsedCron = {
  expression: string;
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
};

const bounds = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  // 7 is accepted as Sunday and folded onto 0.
  dayOfWeek: [0, 7],
} as const;

function refuse(expression: string, reason: string): never {
  throw new Error(
    `Invalid cron expression ${JSON.stringify(expression)}: ${reason}`,
  );
}

function parseNumber(
  expression: string,
  text: string,
  min: number,
  max: number,
) {
  if (!/^\d+$/u.test(text))
    refuse(expression, `${JSON.stringify(text)} is not a number`);
  const value = Number(text);
  if (value < min || value > max) {
    refuse(expression, `${value} is outside ${min}-${max}`);
  }
  return value;
}

function parseField(
  expression: string,
  text: string,
  [min, max]: readonly [number, number],
): Field {
  const values = new Set<number>();

  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (range === undefined || range === "" || extra !== undefined) {
      refuse(expression, `${JSON.stringify(part)} is malformed`);
    }
    const step =
      stepText === undefined ? 1 : parseNumber(expression, stepText, 1, max);
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [fromText = "", toText = ""] = range.split("-");
      from = parseNumber(expression, fromText, min, max);
      to = parseNumber(expression, toText, min, max);
      if (from > to) refuse(expression, `${range} runs backwards`);
    } else {
      from = parseNumber(expression, range, min, max);
      // `5/15` means "from 5, every 15", as in Vixie cron.
      to = stepText === undefined ? from : max;
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }

  return { values, unrestricted: text.startsWith("*") };
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5 || fields.some((field) => field === "")) {
    refuse(expression, "a cron expression has exactly five fields");
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const weekdays = parseField(expression, dayOfWeek, bounds.dayOfWeek);
  const folded = new Set(
    [...weekdays.values].map((value) => (value === 7 ? 0 : value)),
  );

  return {
    expression,
    minute: parseField(expression, minute, bounds.minute),
    hour: parseField(expression, hour, bounds.hour),
    dayOfMonth: parseField(expression, dayOfMonth, bounds.dayOfMonth),
    month: parseField(expression, month, bounds.month),
    dayOfWeek: { values: folded, unrestricted: weekdays.unrestricted },
  };
}

function dayMatches(cron: ParsedCron, date: Date) {
  const byMonthDay = cron.dayOfMonth.values.has(date.getUTCDate());
  const byWeekday = cron.dayOfWeek.values.has(date.getUTCDay());
  if (cron.dayOfMonth.unrestricted) return byWeekday;
  if (cron.dayOfWeek.unrestricted) return byMonthDay;
  return byMonthDay || byWeekday;
}

/**
 * The first minute strictly after `after` at which `cron` fires.
 *
 * Strictly after, so a caller that just ran at a firing minute gets the next
 * one rather than the same one again.
 */
export function nextCronFire(cron: string | ParsedCron, after: Date): Date {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const candidate = new Date(after.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  // Each step below moves to the start of the next month, day, hour or
  // minute, so a few thousand iterations cover any expression that can fire
  // at all; the bound exists only to turn one that cannot (30 February) into
  // an error instead of a hang. Eight years spans a leap day in every case.
  const limit = after.getTime() + 8 * 366 * 24 * 60 * 60_000;
  while (candidate.getTime() <= limit) {
    if (!parsed.month.values.has(candidate.getUTCMonth() + 1)) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1, 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(parsed, candidate)) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hour.values.has(candidate.getUTCHours())) {
      candidate.setUTCHours(candidate.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.minute.values.has(candidate.getUTCMinutes())) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return candidate;
  }

  throw new Error(
    `Cron expression ${JSON.stringify(parsed.expression)} never fires`,
  );
}
