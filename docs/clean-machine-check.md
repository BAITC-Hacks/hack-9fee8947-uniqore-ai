# Проверка на чистой машине: Docker и Linux

Цель — первое обязательное требование ТЗ: команда из README запускается на чистой машине, создаёт три CSV и отрабатывает менее чем за пять минут ([условия](finance/requirements.md#3-пять-обязательных-требований)). Проверка выполнена 23.09.2026 без изменения кода.

## Версия и среда

- Команды README проверены на `main` `6620aa1`. Docker-образ собран из `78590c9`; до `6620aa1` после него менялся только `README.md`, поэтому код, данные, зависимости и Docker-конфигурация те же.
- Хост: Windows 11, Docker Desktop, Engine 25.0.3, Compose 2.24.5. Контейнеры Linux amd64 видят 16 vCPU и 15,3 GiB памяти.
- База обоих прогонов: `python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e`, Python 3.12.14.
- Чистота: свежий `git clone` в новую папку. Docker собирал образ с `--no-cache --pull`, в отдельном Compose-проекте с новым томом. Для README-пути в новый контейнер установлен только git; клон создан внутри контейнера из свежего клона хоста, без передачи токена в контейнер, поэтому переводы строк как на Linux. После всех команд `git status` пуст.

Измерения выполнены на одной машине, кэш ОС не очищался; это не гарантия времени для другого оборудования.

## Docker

Команды из корня свежего клона, как в [инструкции Brev](deployment/brev.md#вариант-1-сборка-на-brev-vm):

```bash
docker compose --env-file .env.example config --quiet
docker compose --env-file .env.example build --no-cache --pull
docker compose --env-file .env.example up -d --wait --wait-timeout 360
```

Для изоляции от других локальных образов проверка использовала `-p tyuin-clean-verify` и `TYUIN_IMAGE=tyuin:clean-verify`; на сборку и запуск это не влияет.

| Проверка | Результат |
|---|---|
| Сборка без кэша | 95 с, включая загрузку зависимостей из PyPI |
| `up --wait` | `healthy` через 33 с; сам расчёт в контейнере — 7,46 с |
| Снимок | `analysis_id=0a1216eed5476f02`, 2 248 узлов / 88 сообществ / топ-20 |
| Опубликованный порт `127.0.0.1:8765` | `/`, `/api/health` и три CSV — HTTP 200; 2 248 / 88 / 20 строк данных |
| API внутри контейнера | Выгрузки побайтно совпадают с `/app/out`, `x-analysis-id` совпадает; `index.html` и четыре asset — HTTP 200; ассистент без ключа отвечает локально |
| `moneygraph verify` в контейнере | `status: ok` |
| Браузер | Очередь, граф и досье загружены; поиск `100000000018102100` показывает 4-е колено и недостаточно данных для роли; ошибок консоли нет |
| Тесты в образе без сети | **89 passed** командой ниже |

Тестам нужны также `scripts/` и `results/`, которых нет в образе:

```bash
docker run --rm --network none \
  --mount "type=bind,source=$(pwd)/tests,target=/app/tests,readonly" \
  --mount "type=bind,source=$(pwd)/scripts,target=/app/scripts,readonly" \
  --mount "type=bind,source=$(pwd)/results,target=/app/results,readonly" \
  tyuin:local python -m pytest -q -p no:cacheprovider /app/tests
```

Лог контейнера печатает `http://0.0.0.0:8765` — это адрес внутри контейнера; в браузере открывать [http://127.0.0.1:8765](http://127.0.0.1:8765).

## Команды README на Linux

Выполнены без изменений команды раздела [«macOS / Linux»](../README.md#запустить-и-проверить), затем `demo`, пересчёт, проверки и smoke.

| Шаг | Результат |
|---|---|
| `python3 -m venv .venv` | 3,6 с, Python 3.12.14 |
| `python -m pip install -r requirements.lock` | 42,5 с, загрузка из PyPI |
| `pip check` и preflight | `No broken requirements found.`; `PASS` |
| `python -m moneygraph demo --data data --out out` | JSON `status: ok`, `/api/health` отвечает через 8,1 с; три CSV в `out/`; выгрузки API совпадают с файлами; Ctrl+C (SIGINT) — код 0, порт освобождён |
| `python -m moneygraph run --data data --out out` | **7,36 с** новым процессом при лимите ТЗ 300 с; расчёт внутри — 5,88 с |
| `verify` для `out` и `results` | `status: ok`, тот же `analysis_id` |
| `python -m pytest -q` | **89 passed** |
| `scripts/smoke_local_launch.py` | `status: pass`; `run` 7,45 с, весь smoke 18,9 с, порт освобождён |

## Найдено в ходе проверки

- На `b341fab` smoke на Linux завершался `CLEANUP_FAILED`, хотя приложение работало: проба порта без `SO_REUSEADDR` принимала завершённые соединения в `TIME_WAIT` за занятый порт. Исправлено в `a91e3de`; на `6620aa1` smoke проходит.
- После PR #17 прежняя команда тестов из инструкции Brev собирала тесты без `scripts/` и `results/` и останавливалась с двумя ошибками сбора. Команда в [инструкции Brev](deployment/brev.md#проверка-конфигурации) обновлена.

## Не проверялось

macOS и Windows в этой проверке, реальный Brev-инстанс, живой внешний LLM, установка без доступа к PyPI, скачивание CSV кнопками интерфейса (выгрузки проверены через API) и потребление памяти.
