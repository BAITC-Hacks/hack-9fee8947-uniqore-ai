# Передеплой Tyuin на Brev — 23.09.2026

По запросу пользователя приложение на CPU VM `tyuin` обновлено с `3c6b1cd` до опубликованной `main` **`f4077ff90fa3cd364abae92ea4c1b513ab66a322`**. Адрес: **[hackalemai.uniqore.dev](https://hackalemai.uniqore.dev)**. Переключение выполнено около 12:48 UTC. Код приложения и конфигурация в этой задаче не менялись.

Онлайн доступны алгоритм **1.2.0**, интерфейс «Скрытые финансовые связи», импорт трёх Parquet и необязательное подключение AI из браузера. Снимок исходного набора: `c138a62d811d6c39`.

## Версия и способ обновления

- Архив commit включает runtime, Docker/Compose, зависимости, данные и каталоги для тестов. SHA-256: `8957683da9c7f3fd81317dfaefb3edce9b754d5ccbd49383df9e07b66086d40f`; сумма после передачи на VM совпала.
- Каталог VM: `~/workspace/tyuin-f4077ff`; образ `tyuin:f4077ff`. OCI label `org.opencontainers.image.revision` содержит полный commit.
- ID образа Docker на VM: `sha256:006d6bd4de5dfa69bedb8ad6b2dfd1cd158de7fcf35a7f8e9b9e944322cf7cc8`. В реестр образ не публиковался.
- До переключения образ проверен проектом `tyuin-candidate-f4077ff` на loopback-порту 18767 с отдельным томом. После передеплоя проверочный контейнер остановлен.
- Основной проект — `tyuin`, порт — `127.0.0.1:8765`, том — `tyuin_analysis-output`. Пересоздан только `app`; ID контейнера Caddy до и после совпадает, тома сертификатов сохранены. Caddy продолжает монтировать конфигурацию из `~/workspace/tyuin-3c6b1cd/deploy/brev/caddy`.
- Старый образ сохранён как `tyuin:rollback-3c6b1cd` (`sha256:b0699a9b2ec1a4f506aa839786259b8cad6dcaebb233fe16f78dc4109fee9ac2`); прежний каталог сохранён.
- Серверные `LLM_*` оставлены пустыми, как до обновления. Основной сценарий и локальные объяснения работают без внешнего AI.

Сборка и тесты на VM:

```bash
cd ~/workspace/tyuin-f4077ff
export TYUIN_IMAGE=tyuin:f4077ff
docker compose --env-file .env.example config --quiet
docker build --label org.opencontainers.image.revision=f4077ff90fa3cd364abae92ea4c1b513ab66a322 \
  --tag "$TYUIN_IMAGE" .
docker run --rm --network none \
  --mount "type=bind,source=$(pwd)/tests,target=/app/tests,readonly" \
  --mount "type=bind,source=$(pwd)/scripts,target=/app/scripts,readonly" \
  --mount "type=bind,source=$(pwd)/results,target=/app/results,readonly" \
  "$TYUIN_IMAGE" python -m pytest -q -p no:cacheprovider /app/tests
```

После отдельной проверки выполнено переключение:

```bash
export TYUIN_IMAGE=tyuin:f4077ff
export TYUIN_PORT=8765
docker compose -p tyuin --env-file .env.example \
  up -d --no-deps --no-build --wait --wait-timeout 360 app
docker exec tyuin-app-1 python -m moneygraph verify --data /app/data --out /app/out
curl --fail https://hackalemai.uniqore.dev/api/health
```

Предупреждение Compose о контейнерах `domain-web` и остановленном `public-web` ожидаемо при использовании только основного Compose-файла. Они сохранены; `--remove-orphans` не применяется.

## Проверки

| Проверка | Результат |
|---|---|
| Сборка и тесты внутри образа без сети | **127 passed**, 20,21 с; прежние предупреждения Starlette/httpx и pandas о смешанных часовых поясах |
| Предварительный и основной контейнеры | `healthy`; основной использует ожидаемый образ и `restart: unless-stopped` |
| `moneygraph verify` | `ok`; 2 248 узлов, 88 кластеров, 20 строк top |
| Исходный набор | Алгоритм 1.2.0; 2 248 узлов, 3 119 связей, 4 840 операций; проверка набора `passed` |
| Досье и локальное объяснение | Клиент `100000000031787100`, тот же `analysis_id`, режим `local` |
| Публичный HTTPS и HTTP | Проверка TLS без отключения доверия; health — `ok`; HTTP — 308 на HTTPS |
| Три CSV через HTTPS | Байты совпали с файлами `/app/out`; `X-Analysis-ID` совпал со снимком |
| Импорт через публичный HTTPS | Синтетические 3 узла и 2 перевода: HTTP 201, отдельный анализ и корректные CSV; исходный снимок неизменен |
| Очистка проверочного импорта | Удалён только созданный тестом набор: HTTP 204, чтение по его токену — 410; исходный health — `ok` |
| Браузер | Новый заголовок, форма импорта, поиск и досье работают; JS/CSS, логотип и API — 200; page load — 606 мс в данном прогоне |

При проверке формы и поиска обработчики `error`/`unhandledrejection` текущей вкладки не зарегистрировали ошибок. Общий журнал gstack содержит 401 из других открытых вкладок и не использован как доказательство отсутствия ошибок начальной загрузки. [Снимок интерфейса](../finance/screenshots/brev-redeploy-f4077ff.png).

| Выгрузка | SHA-256 |
|---|---|
| `nodes_roles.csv` | `482f5a94003c9ac811db932c3931600327c0cf5636a2f8c3eed382a2afe82297` |
| `clusters.csv` | `5471ad6e32a921f5b6e354386a4ec1847d62b70a47105a254ed086a30538deda` |
| `top_nodes.csv` | `8ad548bb145a6741b06e20355a7cbc21dc69280fd9f76d5ad865b6c6e3981164` |

## Откат

Предыдущий каталог и образ сохранены. При необходимости выполнить на VM:

```bash
cd ~/workspace/tyuin-3c6b1cd
export TYUIN_IMAGE=tyuin:rollback-3c6b1cd
export TYUIN_PORT=8765
docker compose -p tyuin --env-file .env.example \
  up -d --no-deps --no-build --wait --wait-timeout 360 app
docker exec tyuin-app-1 python -m moneygraph verify --data /app/data --out /app/out
curl --fail https://hackalemai.uniqore.dev/api/health
```

Ожидаемый снимок после отката: `ad6239d9995448b0`. Откат не выполнялся: новая версия прошла проверки. Прежний каталог нужен также работающему Caddy.

## Review и ограничения

Рекомендация по протоколу `hackalem-change-review`: **принять передеплой в проверенном объёме**. Основной сценарий и выгрузки проверены на целевом сервере; онлайн-версия включает принятые изменения main. Улучшены доступность демонстрации и соответствие документации фактической версии. Новые баллы, accuracy или превосходство алгоритма не заявляются.

Живой запрос к внешнему AI, предельные размеры импорта, нагрузка, перезагрузка VM и фактический откат не проверялись. Пересоздание приложения проверено; дополнительный перезапуск после публикации не выполнялся. Импорт остаётся временным и ограниченным одним серверным процессом. Слияние документации в main требует приёмки по правилам репозитория.
