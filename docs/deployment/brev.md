# Tyuin на NVIDIA Brev

Конфигурация запускает существующий CPU-пайплайн и веб-интерфейс в одном контейнере на порту **8765**. GPU, CUDA, NGC и ключ LLM для основного сценария не нужны. Python 3.12, зависимости, готовый frontend и три Parquet из репозитория входят в образ. Первый старт и каждый перезапуск пересчитывают результаты.

## Вариант 1: сборка на Brev VM

Создайте инстанс в [Brev Console](https://brev.nvidia.com/) в **VM Mode**. Выберите CPU-инстанс, если он доступен, либо доступную VM с GPU: приложение GPU не использует. Jupyter для Tyuin не нужен. Docker и Compose должны быть доступны на хосте.

На своём компьютере подключитесь к VM:

```bash
brev login
brev shell tyuin --host
```

`tyuin` здесь и ниже — имя вашего инстанса. На VM клонируйте репозиторий и выберите проверенный commit с этим конфигом:

```bash
git clone https://github.com/BAITC-Hacks/hack-9fee8947-uniqore-ai.git
cd hack-9fee8947-uniqore-ai
git checkout <проверенный-commit>
docker compose version
docker compose --env-file .env.example config --quiet
docker compose --env-file .env.example up -d --build --wait --wait-timeout 360
```

Для закрытого репозитория нужна авторизация Git на VM. Не вставляйте токен в URL и не сохраняйте его в конфиге. Образ собирается из текущего checkout; выбранный commit должен уже быть доступен на GitHub. Для первичной сборки нужны Docker Hub и PyPI. Указанные 360 секунд относятся к ожиданию готовности контейнера после сборки.

Проверьте на VM:

```bash
docker compose --env-file .env.example ps
curl --fail http://127.0.0.1:8765/api/health
docker compose --env-file .env.example exec -T app python -m moneygraph verify --data /app/data --out /app/out
```

На своём компьютере откройте SSH-туннель и оставьте команду работающей:

```bash
brev port-forward tyuin --host --port 8765:8765
```

Откройте [http://127.0.0.1:8765](http://127.0.0.1:8765). Корневой Compose по умолчанию публикует порт только на loopback VM. Если локальный порт занят, используйте `--port 8766:8765` и адрес с портом 8766.

## Вариант 2: Docker Compose в Brev Console / Launchable

Для загрузки в Brev используйте [deploy/brev/docker-compose.yml](../../deploy/brev/docker-compose.yml). Он не зависит от соседнего Dockerfile или checkout: нужен готовый образ в реестре, доступном инстансу.

Сначала соберите образ для Linux amd64 на машине с Docker Buildx и опубликуйте в **разрешённом реестре**. Пример для GHCR; замените `YOUR_ORG` на namespace в нижнем регистре. Авторизуйтесь в реестре стандартным способом перед публикацией.

```bash
export TYUIN_IMAGE="ghcr.io/YOUR_ORG/tyuin:$(git rev-parse --short=12 HEAD)"
docker buildx build --platform linux/amd64 --tag "$TYUIN_IMAGE" --push .
docker compose -f deploy/brev/docker-compose.yml config --quiet
```

Образ содержит конкурсный датасет: сохраняйте доступ в пределах разрешённого использования кейса. Команда `--push` публикует образ; для подготовки локального конфига выполнять её не требуется. Образ должен быть доступен Brev для скачивания; для закрытого реестра предварительно настройте доступ на целевой VM или используйте вариант 1.

В настройках Brev:

| Поле | Значение |
|---|---|
| Software / Runtime | Docker Compose |
| Compose file | Загрузить `deploy/brev/docker-compose.yml` |
| Source | My code files are embedded in my container(s) |
| Jupyter | Выключен |
| Launch parameters | Обязательный Text `TYUIN_IMAGE`: опубликованный тег, лучше `registry/image@sha256:…` |
| Network | Secure Link на порт `8765` |
| View access | Only my organization для командного деплоя |

Brev-конфиг публикует порт 8765 на интерфейсах VM для маршрутизации платформой. Не открывайте сырой TCP-порт всему интернету: используйте **Secure Link** с авторизацией Brev. Приложение не содержит собственной авторизации. Для скриптов и прямых API-запросов используйте `brev port-forward ... --host`, поскольку веб-туннель требует входа через браузер.

Оба Compose-файла позволяют изменить адрес и порт хоста через `TYUIN_BIND_ADDRESS` и `TYUIN_PORT`. Для локальной проверки готового образа задайте `TYUIN_BIND_ADDRESS=127.0.0.1`. Внутри контейнера приложение всегда слушает `0.0.0.0:8765`; порт Secure Link должен совпадать с портом хоста.

При обычном создании инстанса без Launchable значения окружения должны быть доступны процессу Compose. Если форма не предлагает Setup values, используйте Launchable с Launch parameters или вариант 1.

## Необязательный LLM

По умолчанию все три `LLM_*` пусты, ассистент объясняет рассчитанные факты локально. Для внешнего провайдера передайте `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`.

На VM скопируйте `.env.example` в `.env`, внесите значения и запускайте Compose с `--env-file .env`. Compose передаёт значения backend; сам Python файл `.env` не загружает. Не включайте `.env` в Git или образ.

В Launchable добавьте три необязательных Text-параметра. Для ключа используйте **Use a secret** и выбранную версию секрета, без значения по умолчанию. Brev передаёт параметры первому запуску Compose; при последующем пересоздании контейнера из SSH их нужно снова предоставить. Перезапуск существующего контейнера сохраняет его окружение. Не выводите полный `docker compose config` или `docker inspect` с настоящими ключами; для валидации достаточно `config --quiet`.

## Управление и данные

Команды выполнять из checkout на VM, с тем же `--env-file`, что при запуске:

```bash
docker compose --env-file .env.example logs --tail=100 app
docker compose --env-file .env.example restart app
docker compose --env-file .env.example exec -T app python -m moneygraph verify --data /app/data --out /app/out
docker compose --env-file .env.example down
```

`down` останавливает приложение и сохраняет том `analysis-output`; `down --volumes` удаляет результаты. При новом старте результаты пересчитываются, а не загружаются вместо анализа. Для обновления выберите новый проверенный commit и повторите `up -d --build --wait --wait-timeout 360`. Для отката выберите предыдущий проверенный commit и пересоберите образ. В режиме готового образа используйте соответствующий сохранённый тег или digest.

Контейнер работает как UID/GID 10001; Docker инициализирует новый именованный том с правами каталога `/app/out`. Не подменяйте его произвольным bind mount без настройки прав. Проверка здоровья ждёт первый расчёт до 300 секунд, затем проверяет `/api/health`. `restart: unless-stopped` перезапускает завершившийся процесс, но сам по себе не перезапускает контейнер со статусом `unhealthy`.

Остановка контейнера не останавливает облачную VM. Завершение работы и управление стоимостью выполняются отдельно в Brev Console. Локальный Python-запуск из [README](../../README.md) по-прежнему работает без Brev и аккаунтов команды.

## Проверка конфигурации

Проверено 23.09.2026 на Docker Desktop, Engine 25.0.3, Compose 2.24.5: Linux amd64, Python 3.12.14, зависимости без изменений из `requirements.lock`. База изменения — `e8172e0`. Локальный ID проверенного образа: `sha256:651035ed05dcbb15ee566aa23b6513e60566481bc11340ad51848df36e636bf9` (это ID локального образа, не опубликованный registry digest).

| Проверка | Результат |
|---|---|
| Оба Compose: `config --quiet` | Успешно; Brev-конфиг без `TYUIN_IMAGE` отклоняется с понятной ошибкой |
| `docker compose --env-file .env.example build` | Образ собран из исходников и существующего lock-файла |
| Корневой Compose: `up --wait` | `healthy`; первый расчёт, запись и проверка результатов — 6,004 с в этом запуске |
| Отдельный Compose Brev с `TYUIN_IMAGE=tyuin:local` | `healthy`, без сборки и подключения исходников с хоста |
| `/api/health`, `/api/analysis`, досье и три CSV | Один `analysis_id=ad6239d9995448b0`; 2 248 / 88 / 20 строк, CSV совпадают с файлами контейнера |
| Ассистент без ключа | Локальное объяснение |
| Проверка через браузер | HTTP 200, Tyuin, граф и изображения загружены, ошибок консоли нет |
| Существующие тесты внутри образа без сети | **26 passed**, 12,67 с; одно предупреждение Starlette о будущем переходе TestClient с httpx на httpx2 |
| Перезапуск контейнера и `moneygraph verify` | Повторный `healthy`, 2 248 узлов / 88 кластеров / топ-20, тот же `analysis_id` |
| Содержимое образа и пользователь | UID 10001; `.env`, `.git` и `docs` отсутствуют в `/app` |
| Документация | Локальные ссылки и `git diff --check` проверены |

Проверочные Compose-проекты использовали loopback-порты 18765 и 18766, пустые `LLM_*` и отдельные тома. Команда тестов для Bash из корня репозитория:

```bash
docker run --rm --network none \
  --mount "type=bind,source=$(pwd)/tests,target=/app/tests,readonly" \
  tyuin:local python -m pytest -q -p no:cacheprovider /app/tests
```

**Review: принять конфигурацию в рамках локально проверенного объёма.** Улучшены запуск и воспроизводимость; неизменные алгоритмы и CSV проверены существующими тестами и запуском. Семантика ролей, ранжирование, точность и масштабируемость этим изменением не улучшались и новых оценок не получают. Для демонстрации появился повторяемый запуск контейнера. Существенных регрессий в затронутых сценариях не найдено.

Деплой на реальном Brev-инстансе, Secure Link, публикация в реестр и внешний LLM **не проверены**. Следующий шаг облачной приёмки: развернуть проверенный commit или опубликованный образ на Brev и пройти интерфейс через выбранный способ доступа. Задача остаётся в «В работе» до требуемой приёмки; это не разрешение на слияние в `main`.

## Источники

Формат и настройки сверены с официальной документацией NVIDIA:

- [Custom Docker Containers](https://docs.nvidia.com/brev/guides/development-tools/custom-containers): Compose upload/URL и режим VM.
- [Launchables](https://docs.nvidia.com/brev/concepts/launchables): Launch parameters, Source, Secure Link и время жизни параметров.
- [CLI Connectivity](https://docs.nvidia.com/brev/cli/connectivity): `brev shell`, `--host`, port forwarding и ограничения веб-туннелей.
