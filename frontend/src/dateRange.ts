const millisecondsPerDay = 86_400_000;

// UTC calendar days keep filtering independent of the browser's time zone.
export const calendarDay = (value: string) =>
  Math.floor(
    Date.parse(`${value.slice(0, 10)}T00:00:00Z`) / millisecondsPerDay,
  );
export const isoDay = (day: number) =>
  new Date(day * millisecondsPerDay).toISOString().slice(0, 10);
export const displayDate = (value: string) =>
  value.slice(0, 10).split("-").reverse().join(".");
export const displayPeriod = (start: string, end: string) => {
  if (start === end) return displayDate(start);
  const first = displayDate(start);
  return `${start.slice(0, 4) === end.slice(0, 4) ? first.slice(0, 5) : first}–${displayDate(end)}`;
};
export const inDateRange = (value: string, range: [number, number]) => {
  const day = calendarDay(value);
  return day >= range[0] && day <= range[1];
};

export function timelineBins(
  daily: { date: string; in_amount: number; out_amount: number }[],
  range: [number, number],
  maxBars = 62,
) {
  const width = Math.max(1, Math.ceil((range[1] - range[0] + 1) / maxBars));
  const bins = Array.from(
    { length: Math.ceil((range[1] - range[0] + 1) / width) },
    (_, index) => ({
      start: range[0] + index * width,
      end: Math.min(range[1], range[0] + (index + 1) * width - 1),
      in_amount: 0,
      out_amount: 0,
    }),
  );
  for (const row of daily) {
    if (!inDateRange(row.date, range)) continue;
    const bin = bins[Math.floor((calendarDay(row.date) - range[0]) / width)];
    bin.in_amount += row.in_amount;
    bin.out_amount += row.out_amount;
  }
  return bins;
}
