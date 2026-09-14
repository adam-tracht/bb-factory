export interface LocalClock {
  readonly minute: number;
  readonly hour: number;
  readonly dayOfMonth: number;
  readonly month: number;
  readonly dayOfWeek: number;
}

export function localClock(date: Date, timeZone: string): LocalClock {
  if (timeZone === "server-local") {
    return {
      minute: date.getMinutes(),
      hour: date.getHours(),
      dayOfMonth: date.getDate(),
      month: date.getMonth() + 1,
      dayOfWeek: date.getDay(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "numeric",
    hour: "numeric",
    hourCycle: "h23",
    day: "numeric",
    month: "numeric",
    weekday: "short",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minute: Number(value("minute")),
    hour: Number(value("hour")),
    dayOfMonth: Number(value("day")),
    month: Number(value("month")),
    dayOfWeek: weekdays[value("weekday")] ?? 0,
  };
}

export function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const match = part.match(/^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/u);
    if (!match) return null;
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (step < 1) return null;
    const range = match[1];
    const [lo, hi] = range === "*"
      ? [min, max]
      : range.includes("-")
        ? range.split("-").map(Number)
        : [Number(range), Number(range)];
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) return null;
    for (let value = lo; value <= hi; value += step) values.add(value);
  }
  return values;
}

/**
 * Five-field cron match against the given local clock. Day-of-month and
 * day-of-week follow POSIX OR semantics when both are restricted.
 */
export function cronMatches(expression: string, date: Date, timeZone: string): boolean {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) return false;
  const clock = localClock(date, timeZone);
  const minutes = parseCronField(fields[0], 0, 59);
  const hours = parseCronField(fields[1], 0, 23);
  const dom = parseCronField(fields[2], 1, 31);
  const months = parseCronField(fields[3], 1, 12);
  const dow = parseCronField(fields[4], 0, 7);
  if (!minutes || !hours || !dom || !months || !dow) return false;
  if (!minutes.has(clock.minute) || !hours.has(clock.hour) || !months.has(clock.month)) return false;
  const domRestricted = fields[2] !== "*";
  const dowRestricted = fields[4] !== "*";
  const domMatch = dom.has(clock.dayOfMonth);
  const dowMatch = dow.has(clock.dayOfWeek) || (clock.dayOfWeek === 0 && dow.has(7));
  return domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
}

/** Whether the expression parses at all in the supported five-field subset. */
export function cronValid(expression: string): boolean {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5) return false;
  return [
    parseCronField(fields[0], 0, 59),
    parseCronField(fields[1], 0, 23),
    parseCronField(fields[2], 1, 31),
    parseCronField(fields[3], 1, 12),
    parseCronField(fields[4], 0, 7),
  ].every((field) => field !== null);
}

/** Next fire times by minute-stepping forward, bounded to a 14-day horizon. */
export function nextCronTimes(expression: string, timeZone: string, count: number, from = new Date()): Date[] {
  if (!cronValid(expression)) return [];
  const times: Date[] = [];
  const cursor = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
  const horizon = from.getTime() + 14 * 24 * 3600 * 1000;
  while (times.length < count && cursor.getTime() < horizon) {
    if (cronMatches(expression, cursor, timeZone)) times.push(new Date(cursor));
    cursor.setTime(cursor.getTime() + 60000);
  }
  return times;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A compact human description of a supported cron field set. */
export function describeCron(expression: string): string | null {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5 || !cronValid(expression)) return null;
  const [minuteField, hourField, domField, , dowField] = fields;
  const minutes = parseCronField(fields[0], 0, 59)!;
  const hours = parseCronField(fields[1], 0, 23)!;

  const minuteText = minuteField === "*"
    ? "every minute"
    : minuteField.startsWith("*/")
      ? `every ${minuteField.slice(2)} min`
      : minutes.size === 1
        ? `at :${String([...minutes][0]).padStart(2, "0")}`
        : `at ${[...minutes].map((m) => `:${String(m).padStart(2, "0")}`).join(", ")}`;

  const hourText = hourField === "*"
    ? "every hour"
    : hourField.includes("-")
      ? `${hourField}:00-${hourField.split("-")[1]}:59`
      : hours.size === 1
        ? `${[...hours][0]}:00`
        : `hours ${[...hours].join(", ")}`;

  let dayText = "every day";
  if (dowField !== "*" && domField !== "*") {
    dayText = `on day-of-month ${domField} or ${dowField}`;
  } else if (dowField !== "*") {
    const days = [...parseCronField(dowField, 0, 7)!].map((d) => WEEKDAY_NAMES[d % 7]);
    dayText = `on ${days.join(", ")}`;
  } else if (domField !== "*") {
    dayText = `on day-of-month ${domField}`;
  }

  return `${minuteText}, ${hourText}, ${dayText}`;
}
