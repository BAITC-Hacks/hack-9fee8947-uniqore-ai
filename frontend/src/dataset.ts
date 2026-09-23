export const datasetFiles = ["nodes", "edges", "transactions"] as const;
export type DatasetFileKey = (typeof datasetFiles)[number];
export type DatasetSelection = Partial<Record<DatasetFileKey, File>>;
export const maxFileBytes = 10 * 1024 * 1024;
export const datasetSessionKey = "tyuin.dataset";

export function validateSelection(files: DatasetSelection): string {
  for (const key of datasetFiles) {
    const file = files[key];
    if (!file) return `Выберите ${key}.parquet.`;
    if (file.name !== `${key}.parquet`)
      return `Для «${key}» нужен файл с именем ${key}.parquet.`;
    if (!file.size) return `Файл ${file.name} пуст.`;
    if (file.size > maxFileBytes)
      return `Файл ${file.name} больше 10 МиБ. Уменьшите набор и повторите загрузку.`;
  }
  return "";
}

export class DatasetApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DatasetApiError";
    this.status = status;
  }
}

export async function datasetFetch(
  url: string,
  datasetId: string,
  options: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(options.headers);
  if (datasetId) headers.set("X-Dataset-ID", datasetId);
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const fallback =
      response.status === 410
        ? "Загруженный набор больше недоступен. Загрузите его снова или вернитесь к исходному набору."
        : response.status === 413
          ? "Размер набора превышает лимит загрузки."
          : response.status === 429
            ? "Сервер занят обработкой данных. Повторите загрузку позже."
            : "Не удалось выполнить запрос. Попробуйте ещё раз.";
    throw new DatasetApiError(
      response.status === 410
        ? fallback
        : typeof body?.detail === "string"
          ? body.detail
          : fallback,
      response.status,
    );
  }
  return response;
}

export function readDatasetSession(storage?: Pick<Storage, "getItem">): string {
  try {
    return (storage ?? sessionStorage).getItem(datasetSessionKey) || "";
  } catch {
    return "";
  }
}

export function writeDatasetSession(
  id: string,
  storage?: Pick<Storage, "setItem" | "removeItem">,
) {
  try {
    const session = storage ?? sessionStorage;
    if (id) session.setItem(datasetSessionKey, id);
    else session.removeItem(datasetSessionKey);
  } catch {
    // Storage may be disabled; the current tab can still use its in-memory ID.
  }
}
