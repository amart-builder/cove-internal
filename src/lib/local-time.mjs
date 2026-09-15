// Pure local-clock helpers shared by browser presentation and Node workers.
// Calendar boundaries are resolved in the selected IANA zone, never by adding
// 24 hours, so a daylight-saving day can contain 23 or 25 hours.
function clock(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

export function localDateKey(date, timeZone) {
  const { year, month, day } = clock(date, timeZone);
  return `${year}-${month}-${day}`;
}

export function localHour(date, timeZone) {
  return Number(clock(date, timeZone).hour);
}

function followingDate(date) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

function boundary(date, timeZone, hour = "00") {
  const desired = `${date}T${hour}:00:00`;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const anchor = Date.parse(`${date}T12:00:00Z`);
  let low = anchor - 36 * 3600000;
  let high = anchor + 36 * 3600000;
  // The first instant on/after midnight also handles zones whose spring change
  // skips midnight. Morning uses 05:00, after ordinary DST clock transitions.
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const p = Object.fromEntries(formatter.formatToParts(new Date(middle)).map(part => [part.type, part.value]));
    const rendered = `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
    if (rendered < desired) low = middle + 1;
    else high = middle;
  }
  return new Date(low);
}

export function localDayBounds(now, timeZone) {
  const date = localDateKey(now, timeZone);
  return { start: boundary(date, timeZone).toISOString(), end: boundary(followingDate(date), timeZone).toISOString() };
}

export function nextLocalMorning(now, timeZone) {
  const date = localDateKey(now, timeZone);
  const today = boundary(date, timeZone, "05");
  return today > now ? today : boundary(followingDate(date), timeZone, "05");
}
