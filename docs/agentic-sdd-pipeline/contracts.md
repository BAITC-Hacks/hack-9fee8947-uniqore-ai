# Контракты артефактов

Все артефакты UTF-8, schema_version=1.0. JSON выбран для машинной проверки стандартной библиотекой Python; Markdown — для людей. Приведённые templates являются заготовками, а не evidence выполненных задач.

## Input manifest

`feature_id`, `product_plan.path`, `product_plan.git_commit`, `product_plan.sha256`, `source_refs[]`, `constraints`, `topology`, `coordinator_owner`, `integrator_owner`, `approved_by`, `approved_at`. При отсутствии product plan поля null, status=`WAITING_INPUT`; нельзя выдавать это состояние за готовый baseline. Git commit не заменяет hash незакоммиченного источника; предпочтительно сначала получить согласованный commit Романа.

## TaskSpec

| Поле | Тип / правило |
|---|---|
| task_id | `T-` + 3 цифры, уникален в feature |
| feature_id, spec_version | Непустые строки, существуют в baseline |
| requirement_ids, acceptance_ids, contract_ids | Массивы существующих ID; contract_ids может быть пуст |
| goal, non_goals | Проверяемый результат и явные границы |
| depends_on | Существующие task IDs, без self dependency/цикла |
| dependency_commits | task ID → проверенный commit; все нужны в task base |
| base_commit | Полный Git SHA; отсутствующий SHA не допускает READY |
| allowed_files, forbidden_files | Repo-relative paths/globs; абсолютные пути и `..` запрещены |
| worker, reviewer | Разные agent identities; human owner указан |
| checks | Список CheckSpec; минимум один для изменения поведения |
| limits | deadline/attempts; общий deadline сильнее отдельных attempts |
| status | Одно из состояний process-spec.md |

Worker не может расширить allowed_files редактированием собственного task JSON: изменение выдаёт Coordinator и записывает event. Правило проверяется по Git diff, а не только по обещанию в prompt.

## CheckSpec и Evidence

CheckSpec: id, argv (массив строк), cwd (repo-relative), timeout_seconds, required (bool), kind (`unit|integration|e2e|eval|manual`), acceptance_ids. Команда передаётся subprocess как argv без shell interpolation. Команды из внешних источников не запускаются автоматически; они включаются в task после review.

Evidence: check_id, checked_commit, started_at, finished_at, exit_code, result (`pass|fail|skipped|not_run`), summary, log_path, executor, verifier_mode. Для manual: steps, observed, reviewer, timestamp, target_commit; exit_code=null и машинная проверка не заявляется. Нельзя обозначать skipped как pass.

Точный код возврата и hash сами по себе не доказывают полноту теста: reviewer проверяет связь check с AC. Вердикт evidence действует только для указанного commit, spec_version и contract_versions. Зависимости/fixture hashes входят в context, если меняют поведение проверки.

## ReviewResult

task_id, reviewed_commit, base_commit, spec_version, reviewer, independence (`cross_model|same_model_fresh_context|human`), check_results[], findings[], verdict (`pass|changes_required|blocked`). finding содержит id, severity (`P0|P1|P2|P3`), requirement_id, file/line при наличии, observation, impact, required_fix, verification.

`pass` невозможен при P0/P1 open, failed required checks, missing evidence или stale commit. P2 может остаться только с явным disposition `deferred` и rationale, если не нарушает AC; P3 фиксируется как follow-up. Reviewer не может молча переопределить acceptance threshold.

## Run ledger

run_id, feature_id, baseline, mode (`interactive_agents|cli_runner`), max_parallel_workers, tasks[], events[], integration_candidate, publication_authorization. Каждый event: seq, at, actor, task_id, from, to, reason, evidence_refs. Канонический writer один; proposed runtime runner использует lock с exclusive creation, atomically replaced ledger и idempotency key `run_id/task_id/attempt/action`.

В интерактивном режиме Coordinator поддерживает те же поля и сверяет состояние с Git перед каждым переходом. Нельзя заявлять гарантию автоматического lock enforcement до реализации runner. При падении/зависшем lease владелец сначала проверяет процесс и незакоммиченные файлы; автоматическое удаление чужого worktree запрещено.

Publication authorization: action (`none|push|create_pr|merge|deploy`), target, authorized_by, user_message_ref, expires_after_run. Авторизация на одну action не даёт остальных. Для публикации этого пакета пользователь отдельно разрешил push ветки `agentic-sdd-pipeline` в `origin` сообщением «Сразу же пуш ветку в репозиторий». Это не разрешение на merge, deploy или публикацию будущих продуктовых задач; каждый новый run фиксирует свой scope авторизации.

## Handoff Роману

Вход от Романа: путь/SHA product plan, существующие conventions и check commands, shared contracts, интеграционная ветка и владелец решений. Выход к Роману: требования без двусмысленности, список задач с boundaries, проверенные commits, actual evidence, unresolved decisions.

Вопрос формулируется как `OPEN-001: наблюдаемый пробел -> какие задачи заблокированы -> рекомендованный вариант -> последствия альтернативы`. Роман не должен заново читать весь transcript coding agent, чтобы принять решение.

### Один или два компьютера

`topology=same_host` — дефолт пилота: два worktree одного Git repo, Coordinator/Integrator у пользователя; Роман владеет продуктовым baseline. Все task commits уже доступны в общей Git object database. Если Codex и Claude Code нельзя запустить на одном host, Coordinator явно выбирает `two_hosts_bundle` до READY.

При `two_hosts_bundle` отправитель готовит Git bundle с task ref и базой, получатель проверяет `git bundle verify`, импортирует в новый task ref без перезаписи своей ветки и проверяет task/base SHA. Относительные repo paths переносятся; абсолютные пути к worktree получатель назначает локально. Пакет также содержит spec/contract revisions, review/evidence и SHA-256 самого bundle. Человек переносит bundle выбранным им каналом; отправка через чужие сервисы автоматически не выполняется. До наличия всех dependency objects на receiving host задача BLOCKED_INPUT. Альтернатива — существующий remote с явно разрешёнными push/fetch для нужных refs.

В обоих режимах Integrator один. Идентификатор commit, переданный текстом, не заменяет доставку Git objects; evidence проверяется заново на интеграционном host.

## Версионирование

Поправка текста без изменения поведения повышает patch version; новый AC/контрактное поведение — minor либо major с явным impact map. В пятичасовом процессе достаточно последовательных целых revision и changelog: смысл version важнее semver-церемонии. Любая revision меняет baseline hash; Coordinator отмечает affected tasks STALE, unaffected оставляет с записанным обоснованием совместимости.
