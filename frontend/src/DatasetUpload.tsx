import { useEffect, useRef, useState } from "react";
import { FileUp, LoaderCircle, X } from "lucide-react";
import {
  datasetFetch,
  datasetFiles,
  type DatasetSelection,
  validateSelection,
} from "./dataset";

const schemas = {
  nodes: "gid, depth, is_seed",
  edges: "src, dst, sum_kzt, n_tx, depth",
  transactions: "src, dst, date, sum_kzt",
};

export function DatasetUpload({
  onClose,
  onUploaded,
}: {
  onClose: () => void;
  onUploaded: (datasetId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const request = useRef<AbortController | null>(null);
  const [files, setFiles] = useState<DatasetSelection>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    return () => request.current?.abort();
  }, []);

  const upload = async () => {
    const issue = validateSelection(files);
    if (issue) {
      setError(issue);
      return;
    }
    const body = new FormData();
    for (const key of datasetFiles) body.append(key, files[key]!);
    const controller = new AbortController();
    request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 330_000);
    setError("");
    setBusy(true);
    let uploadedId = "";
    try {
      const response = await datasetFetch("/api/datasets", "", {
        method: "POST",
        body,
        signal: controller.signal,
      });
      const result = await response.json();
      if (typeof result.dataset_id !== "string" || !result.dataset_id)
        throw new Error("Сервер не вернул готовый набор. Повторите загрузку.");
      uploadedId = result.dataset_id;
      // Keep the current workbench until its replacement is ready to open.
      await datasetFetch("/api/analysis", uploadedId, {
        signal: controller.signal,
      });
      onUploaded(uploadedId);
    } catch (caught) {
      if (uploadedId)
        void datasetFetch("/api/datasets/current", uploadedId, {
          method: "DELETE",
        }).catch(() => {});
      setError(
        controller.signal.aborted
          ? "Загрузка и обработка не завершились за 5 минут 30 секунд. Текущий анализ сохранён; попробуйте набор меньшего размера."
          : caught instanceof Error
            ? caught.message
            : "Не удалось загрузить данные. Повторите попытку.",
      );
      setBusy(false);
    } finally {
      window.clearTimeout(timeout);
    }
  };

  return (
    <dialog
      ref={dialog}
      className="modal-backdrop"
      aria-labelledby="upload-title"
      aria-describedby="upload-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section className="method-modal upload-modal">
        <button
          className="modal-close icon-button"
          aria-label="Закрыть загрузку данных"
          onClick={onClose}
          disabled={busy}
        >
          <X size={20} />
        </button>
        <div className="eyebrow">СВОЙ НАБОР ПЕРЕВОДОВ</div>
        <h2 id="upload-title">Загрузить данные</h2>
        <p id="upload-description">
          Выберите три согласованных Parquet-файла. После проверки откроется
          новый анализ; фильтры, перечень проверки, чат и ключ AI будут
          сброшены.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void upload();
          }}
        >
          <fieldset disabled={busy}>
            {datasetFiles.map((key) => (
              <label className="upload-file" key={key}>
                <strong>{key}.parquet</strong>
                <span>{schemas[key]}</span>
                <input
                  type="file"
                  accept=".parquet"
                  aria-label={key + ".parquet"}
                  onChange={(event) => {
                    setFiles((current) => ({
                      ...current,
                      [key]: event.target.files?.[0],
                    }));
                    setError("");
                  }}
                />
              </label>
            ))}
          </fieldset>
          <details className="upload-requirements">
            <summary>Формат и ограничения</summary>
            <p>
              До 10 МиБ на файл: 5 000 узлов, 20 000 связей, 100 000 операций.
              Весь запрос — до 30 МиБ с учётом служебных полей. Имена файлов и
              точный набор столбцов — как указано выше, без дополнительных
              столбцов.
            </p>
            <p>
              gid, src, dst — целые int64 без потери точности. depth — целое:
              0–4 для nodes, 1–4 для edges. is_seed — логическое значение;
              sum_kzt — сумма в тенге; n_tx — положительное целое число. date —
              дата; период до 366 дней. Сумма каждой операции — от 5 000 ₸.
            </p>
            <p>
              Все участники операций должны быть в nodes. В edges — точные суммы
              и количества операций по каждой паре src → dst из transactions.
              Исходные клиенты имеют depth = 0 и is_seed = true; остальные
              глубины соответствуют расстоянию по исходящим связям от исходных
              клиентов.
            </p>
          </details>
          <p className="upload-privacy">
            Файлы обрабатываются на сервере запущенного приложения. Набор
            временный: доступен до 1 часа или до перезапуска сервера. Выбор
            набора действует в этой вкладке; исходный набор можно вернуть.
          </p>
          {error && (
            <p className="upload-error" role="alert">
              {error}
            </p>
          )}
          {busy && (
            <div className="upload-progress" role="status" aria-live="polite">
              <LoaderCircle className="spin" size={17} />
              Загружаем файлы, проверяем связи и рассчитываем анализ…
            </div>
          )}
          <div className="upload-actions">
            <button type="button" onClick={onClose} disabled={busy}>
              Отмена
            </button>
            <button className="primary" type="submit" disabled={busy}>
              <FileUp size={16} />
              {busy ? "Обработка…" : "Загрузить и рассчитать"}
            </button>
          </div>
        </form>
      </section>
    </dialog>
  );
}
