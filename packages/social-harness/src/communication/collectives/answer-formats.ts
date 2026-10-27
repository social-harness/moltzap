/**
 * @file The string formats a form-mode string field may require of an answer.
 *
 * Every endpoint must judge one answer the same way, since an all_gather's
 * members agree on its result, so each format is the JSON Schema 2020-12
 * format exactly as the full-mode `ajv-formats` validator judges it: `date`
 * and `date-time` per RFC 3339 with a time zone required and a leap second
 * only at 23:59 UTC, `email` as an RFC 5322 dot-atom at a dotted host name,
 * and `uri` as an RFC 3986 absolute URI. The URI grammar also admits a single
 * slash before an authority, which that validator admits.
 */

/** The formats a form-mode string field may name. */
export type AnswerFormat = "email" | "uri" | "date" | "date-time";

const DAYS_IN_MONTH = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME =
  /^(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)(z|([+-])(\d{2})(?::?(\d{2}))?)$/i;
const DATE_TIME_SEPARATOR = /t|\s/i;

const atom = "[a-z0-9!#$%&'*+/=?^_`{|}~-]+";
const hostLabel = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const EMAIL = new RegExp(
  `^${atom}(?:\\.${atom})*@(?:${hostLabel}\\.)+${hostLabel}$`,
  "i",
);

const hex = "[0-9a-f]";
const pctEncoded = `%${hex}{2}`;
const unreserved = "a-z0-9\\-._~";
const subDelims = "!$&'()*+,;=";
const decOctet = "(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)";
const ipv4 = `(?:${decOctet}\\.){3}${decOctet}`;
const h16 = `${hex}{1,4}`;
const ls32 = `(?:${h16}:${h16}|${ipv4})`;
const ipv6 = [
  `(?:${h16}:){6}${ls32}`,
  `::(?:${h16}:){5}${ls32}`,
  `(?:${h16})?::(?:${h16}:){4}${ls32}`,
  `(?:(?:${h16}:){0,1}${h16})?::(?:${h16}:){3}${ls32}`,
  `(?:(?:${h16}:){0,2}${h16})?::(?:${h16}:){2}${ls32}`,
  `(?:(?:${h16}:){0,3}${h16})?::${h16}:${ls32}`,
  `(?:(?:${h16}:){0,4}${h16})?::${ls32}`,
  `(?:(?:${h16}:){0,5}${h16})?::${h16}`,
  `(?:(?:${h16}:){0,6}${h16})?::`,
].join("|");
const ipFuture = `v${hex}+\\.[${unreserved}${subDelims}:]+`;
const host = `(?:\\[(?:${ipv6}|${ipFuture})\\]|${ipv4}|(?:[${unreserved}${subDelims}]|${pctEncoded})*)`;
const userinfo = `(?:[${unreserved}${subDelims}:]|${pctEncoded})*`;
const pchar = `(?:[${unreserved}${subDelims}:@]|${pctEncoded})`;
const segments = `(?:\\/${pchar}*)*`;
const hierPart = [
  `\\/?\\/(?:${userinfo}@)?${host}(?::\\d*)?${segments}`,
  `\\/(?:${pchar}+${segments})?`,
  `${pchar}+${segments}`,
].join("|");
const queryOrFragment = `(?:[${unreserved}${subDelims}:@/?]|${pctEncoded})*`;
const URI = new RegExp(
  `^[a-z][a-z0-9+\\-.]*:(?:${hierPart})(?:\\?${queryOrFragment})?(?:#${queryOrFragment})?$`,
  "i",
);

/**
 * Whether a string satisfies a format.
 * @param format The format a string field names.
 * @param text The answer's string.
 * @returns True when the string is in the format.
 */
export function matchesFormat(format: AnswerFormat, text: string): boolean {
  switch (format) {
    case "email":
      return EMAIL.test(text);
    case "uri":
      return URI.test(text);
    case "date":
      return isDate(text);
    case "date-time":
      return isDateTime(text);
    default: {
      const exhaustive: never = format;
      return exhaustive;
    }
  }
}

/** An RFC 3339 date and time, split at `T` or whitespace. */
function isDateTime(text: string): boolean {
  const parts = text.split(DATE_TIME_SEPARATOR);
  if (parts.length !== 2) {
    return false;
  }
  const [date = "", time = ""] = parts;
  return isDate(date) && isTime(time);
}

function isDate(text: string): boolean {
  const match = DATE.exec(text);
  return (
    match !== null &&
    isCalendarDay(Number(match[1]), Number(match[2]), Number(match[3]))
  );
}

function isCalendarDay(year: number, month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

function daysIn(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month] ?? 0);
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** A full-time's clock reading and its offset from UTC. */
interface ClockTime {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly offsetSign: number;
  readonly offsetHour: number;
  readonly offsetMinute: number;
}

/** An RFC 3339 full-time, offset included. */
function isTime(text: string): boolean {
  const match = TIME.exec(text);
  if (match === null) {
    return false;
  }
  const time: ClockTime = {
    hour: Number(match[1]),
    minute: Number(match[2]),
    second: Number(match[3]),
    offsetSign: match[5] === "-" ? -1 : 1,
    offsetHour: Number(match[6] ?? 0),
    offsetMinute: Number(match[7] ?? 0),
  };
  return (
    time.offsetHour <= 23 &&
    time.offsetMinute <= 59 &&
    (isOrdinaryTime(time) || isLeapSecond(time))
  );
}

function isOrdinaryTime({ hour, minute, second }: ClockTime): boolean {
  return hour <= 23 && minute <= 59 && second < 60;
}

/**
 * A second numbered 60 is a leap second only when the reading, shifted to
 * UTC, is 23:59; -1 is that instant reached by borrowing across midnight.
 */
function isLeapSecond(time: ClockTime): boolean {
  const utcMinute = time.minute - time.offsetMinute * time.offsetSign;
  const utcHour =
    time.hour - time.offsetHour * time.offsetSign - (utcMinute < 0 ? 1 : 0);
  const lastHour = utcHour === 23 || utcHour === -1;
  const lastMinute = utcMinute === 59 || utcMinute === -1;
  return lastHour && lastMinute && time.second < 61;
}
