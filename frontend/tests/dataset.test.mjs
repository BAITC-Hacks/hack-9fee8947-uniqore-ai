import test from "node:test";
import assert from "node:assert/strict";
import {
  datasetFetch,
  DatasetApiError,
  maxFileBytes,
  validateSelection,
  readDatasetSession,
  writeDatasetSession,
} from "../src/dataset.ts";
import {
  calendarDay,
  displayPeriod,
  inDateRange,
  isoDay,
  timelineBins,
} from "../src/dateRange.ts";

const files = () =>
  Object.fromEntries(
    ["nodes", "edges", "transactions"].map((key) => [
      key,
      { name: `${key}.parquet`, size: 200 },
    ]),
  );

test("import requires all three nonempty canonical files and enforces per-file limits", () => {
  assert.match(validateSelection({}), /nodes\.parquet/);
  const selection = files();
  assert.equal(validateSelection(selection), "");
  selection.transactions.name = "nodes.parquet";
  assert.match(validateSelection(selection), /transactions\.parquet/);
  selection.transactions.name = "transactions.parquet";
  selection.transactions.size = 0;
  assert.match(validateSelection(selection), /пуст/);
  selection.transactions.size = maxFileBytes;
  assert.equal(validateSelection(selection), "");
  selection.transactions.size++;
  assert.match(validateSelection(selection), /10 МиБ/);
});

test("every scoped request including CSV and explanations sends its ID only in a header", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new Response("{}", { status: 200 });
  });
  for (const url of [
    "/api/analysis",
    "/api/nodes/client",
    "/api/clusters",
    "/api/exports/nodes_roles.csv",
  ])
    await datasetFetch(url, "private-dataset");
  await datasetFetch("/api/nodes/client/explain", "private-dataset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"question":"role"}',
  });
  for (const { url, options } of calls) {
    assert.equal(url.includes("private-dataset"), false);
    assert.equal(options.headers.get("X-Dataset-ID"), "private-dataset");
  }
  assert.equal(
    calls.at(-1).options.headers.get("Content-Type"),
    "application/json",
  );
  await datasetFetch("/api/analysis", "");
  assert.equal(calls.at(-1).options.headers.has("X-Dataset-ID"), false);
});

test("expired datasets and server validation failures remain actionable errors", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response('{"detail":"expired"}', { status: 410 }),
  );
  await assert.rejects(datasetFetch("/api/analysis", "expired"), (error) => {
    assert.ok(error instanceof DatasetApiError);
    assert.equal(error.status, 410);
    assert.match(error.message, /исходному набору/);
    return true;
  });
  globalThis.fetch = async () =>
    new Response('{"detail":"Суммы связей не совпадают"}', { status: 422 });
  await assert.rejects(
    datasetFetch("/api/datasets", ""),
    /Суммы связей не совпадают/,
  );
  globalThis.fetch = async () =>
    new Response("server unavailable", { status: 503 });
  await assert.rejects(datasetFetch("/api/analysis", ""), /Попробуйте ещё раз/);
});

test("dataset selection uses tab session storage and works when storage is blocked", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
  assert.equal(readDatasetSession(storage), "");
  writeDatasetSession("one", storage);
  assert.equal(readDatasetSession(storage), "one");
  writeDatasetSession("", storage);
  assert.equal(readDatasetSession(storage), "");
  storage.getItem = () => {
    throw new Error("blocked");
  };
  storage.setItem = () => {
    throw new Error("blocked");
  };
  assert.equal(readDatasetSession(storage), "");
  assert.doesNotThrow(() => writeDatasetSession("one", storage));
});

test("date filtering distinguishes equal day numbers in different months and crosses years", () => {
  const range = [calendarDay("2026-12-31"), calendarDay("2027-01-02")];
  for (const date of ["2026-12-31", "2027-01-01", "2027-01-02"])
    assert.equal(inDateRange(date, range), true);
  for (const date of ["2026-12-01", "2026-12-02", "2027-01-31"])
    assert.equal(inDateRange(date, range), false);
  assert.equal(isoDay(range[0]), "2026-12-31");
  assert.equal(calendarDay("2028-03-01") - calendarDay("2028-02-28"), 2);
  assert.equal(displayPeriod("2026-07-01", "2026-07-31"), "01.07–31.07.2026");
  assert.equal(
    displayPeriod("2026-12-31", "2027-01-02"),
    "31.12.2026–02.01.2027",
  );
});

test("timeline includes empty calendar days, handles single-day data and preserves long-period totals", () => {
  const day = calendarDay("2026-08-01");
  const rows = [
    { date: "2026-07-31", in_amount: 100, out_amount: 0 },
    { date: "2026-08-02", in_amount: 0, out_amount: 200 },
  ];
  const bins = timelineBins(rows, [day - 1, day + 1]);
  assert.equal(bins.length, 3);
  assert.deepEqual(
    bins.map((bin) => bin.in_amount),
    [100, 0, 0],
  );
  assert.deepEqual(
    bins.map((bin) => bin.out_amount),
    [0, 0, 200],
  );
  assert.deepEqual(timelineBins(rows, [day, day]), [
    { start: day, end: day, in_amount: 0, out_amount: 0 },
  ]);
  const year = timelineBins(rows, [day - 30, day + 335]);
  assert.ok(year.length <= 62);
  assert.equal(year[0].start, day - 30);
  assert.equal(year.at(-1).end, day + 335);
  assert.equal(
    year.reduce((sum, bin) => sum + bin.in_amount + bin.out_amount, 0),
    300,
  );
});
