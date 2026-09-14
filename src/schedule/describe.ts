import { cronValid, parseCronField } from "./cron.js";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad2 = (value: number): string => String(value).padStart(2, "0");

/** "a", "a and b", "a, b, and c". */
function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join("");
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

const sorted = (set: Set<number>): number[] => [...set].sort((a, b) => a - b);

const contiguous = (values: number[]): boolean =>
  values.every((value, index) => index === 0 || value === values[index - 1] + 1);

/**
 * Step n when the set is exactly the star-step tiling {0, n, 2n, ...} up to
 * max AND n divides the field evenly, so the same marks repeat every period
 * ("Every 10 minutes" is true of step 10 but not of step 40, which fires at
 * :00, :40, then :00 again twenty minutes later).
 */
function regularStep(values: number[], max: number): number | null {
  if (values.length < 2 || values[0] !== 0) return null;
  const step = values[1];
  for (let index = 0; index < values.length; index++) {
    if (values[index] !== index * step) return null;
  }
  return values[values.length - 1] + step > max && (max + 1) % step === 0 ? step : null;
}

/** Sentence fragment for the time-of-day fields, or null when the shape is not describable. */
function describeTime(minutes: Set<number>, hours: Set<number>): string | null {
  const allHours = hours.size === 24;
  const hourList = sorted(hours);
  const minuteList = sorted(minutes);
  const range = () =>
    `between ${pad2(hourList[0])}:00 and ${pad2(hourList[hourList.length - 1])}:59`;
  const during = () => `during hours ${joinAnd(hourList.map(pad2))}`;
  const span = (text: string): string =>
    allHours ? text : contiguous(hourList) ? `${text} ${range()}` : `${text} ${during()}`;

  if (minutes.size === 60) return span("Every minute");
  const step = regularStep(minuteList, 59);
  if (step !== null) return span(`Every ${step} minutes`);
  if (minuteList.length === 1) {
    const mm = pad2(minuteList[0]);
    if (allHours) return minuteList[0] === 0 ? "Every hour on the hour" : `Every hour at :${mm}`;
    if (hourList.length === 1) return `At ${pad2(hourList[0])}:${mm}`;
    if (contiguous(hourList)) return `At :${mm} past each hour ${range()}`;
    if (hourList.length <= 6) return `At ${joinAnd(hourList.map((hour) => `${pad2(hour)}:${mm}`))}`;
    return null;
  }
  if (minuteList.length <= 4) {
    if (allHours) return `At ${joinAnd(minuteList.map((minute) => `:${pad2(minute)}`))} past every hour`;
    if (hourList.length === 1) {
      return `At ${joinAnd(minuteList.map((minute) => `${pad2(hourList[0])}:${pad2(minute)}`))}`;
    }
  }
  return null;
}

/** Sentence fragment for the day fields; POSIX OR semantics when dom and dow are both restricted. */
function describeDays(
  domField: string,
  monthField: string,
  dowField: string,
  dom: Set<number>,
  months: Set<number>,
  dow: Set<number>,
): string {
  const domRestricted = domField !== "*";
  const dowRestricted = dowField !== "*";
  const dowAll = new Set([...dow].map((day) => day % 7)).size === 7;
  const dowNames = [...new Set([...dow].map((day) => day % 7))]
    .sort((a, b) => a - b)
    .map((day) => WEEKDAYS[day]);

  let day: string;
  if (domRestricted && dowRestricted) {
    day = dowAll
      ? "every day"
      : `on day-of-month ${joinAnd(sorted(dom).map(String))} or ${joinAnd(dowNames)}`;
  } else if (dowRestricted) {
    const normalized = new Set([...dow].map((value) => value % 7));
    const weekdays = normalized.size === 5 && [1, 2, 3, 4, 5].every((value) => normalized.has(value));
    const weekends = normalized.size === 2 && normalized.has(0) && normalized.has(6);
    day = dowAll ? "every day" : weekdays ? "on weekdays" : weekends ? "on weekends" : `on ${joinAnd(dowNames)}`;
  } else if (domRestricted) {
    day = `on day-of-month ${joinAnd(sorted(dom).map(String))}`;
  } else {
    day = "every day";
  }
  return monthField === "*"
    ? day
    : `${day} in ${joinAnd(sorted(months).map((month) => MONTHS[month - 1]))}`;
}

/**
 * A one-sentence reading of a five-field cron ("Every 10 minutes between
 * 01:00 and 05:59, every day"). Returns null for shapes it cannot describe
 * honestly; callers should render the raw expression instead.
 */
export function describeSchedule(expression: string): string | null {
  const fields = expression.trim().split(/\s+/u);
  if (fields.length !== 5 || !cronValid(expression)) return null;
  const time = describeTime(
    parseCronField(fields[0], 0, 59)!,
    parseCronField(fields[1], 0, 23)!,
  );
  if (time === null) return null;
  return `${time}, ${describeDays(
    fields[2],
    fields[3],
    fields[4],
    parseCronField(fields[2], 1, 31)!,
    parseCronField(fields[3], 1, 12)!,
    parseCronField(fields[4], 0, 7)!,
  )}`;
}
