# Первый запуск

Результат старта — один READY task packet для coding agent, затем один проверенный code candidate. Runner устанавливать не нужно: используется ваша доступная среда Codex или Claude Code. Этот документ описывает будущий запуск; шаблоны в текущей ветке ещё DRAFT.

## 1. Передайте вход Coordinator

Пользователь ведёт Coordinator/Integrator, Роман подтверждает продуктовые решения. Заполните пять значений в сообщении ниже и передайте его одному из coding agents в checkout репозитория. Общий план должен уже существовать; при его отсутствии правильный результат — конкретный OPEN вопрос Роману и WAITING_INPUT.

```text
Подготовь первый запуск по docs/agentic-sdd-pipeline/README.md.
План Романа: [repo-relative путь].
Commit плана: [полный SHA].
Code base: [полный SHA, от которого строим продукт].
Первый результат: [небольшой результат, согласованный с Романом].
Дедлайн всего run: [дата и время с часовым поясом].

Режим interactive_agents. Я владею Coordinator/Integrator,
Роман — продуктовым baseline. Проверь Git, доступность источников,
два coding environments и возможность отдельных worktrees.
Создай control branch/worktree для artifacts; код туда не реализуй.
Используй templates/inputs.json, spec.md, task.json и run.json
из docs/agentic-sdd-pipeline. Заполни их из источников, не выдумывай AC.
Выведи spec baseline на проверку, затем один полный task packet.
Не запускай Worker до G1/G2. Публикация будущего run пока не разрешена.
```

Это поручение разрешает подготовку локальных artifacts и worktrees, но не выбор новой архитектуры продукта. Если рабочая директория содержит чужие правки, агент сначала сохраняет её состояние и выбирает чистый отдельный checkout; не переносит/откатывает эти правки.

На выходе должны быть: `inputs.json`, `spec.md`, `tasks/T-001.json`, `run.json`, baseline_ref и OPEN вопросы. Coordinator предлагает точные названия локальных веток/пути для конкретного run, проверяет конфликты имён и фиксирует их в ledger. Значения placeholders/null не допускаются в READY. Цель — подготовить входное сообщение за 5 минут; получение принятой spec и READY packet входит в 20–30 минут setup и зависит от полноты плана Романа.

### Рецепт bootstrap для Coordinator

Предлагаемые имена ниже — образец; `<run>` заменяется уникальным ID. Ни одна из этих веток не создаётся автоматически чтением документа.

| Роль | Ветка от code base | Отдельный worktree | Кто пишет |
|---|---|---|---|
| Control | `codex/sdd/<run>/control` | `../sdd-<run>-control` | Coordinator: spec, tasks, ledger, reports |
| Worker A | `codex/sdd/<run>/task-001` | `../sdd-<run>-a` | Worker: только task code |
| Integration | `codex/sdd/<run>/integration` | `../sdd-<run>-integration` | Integrator: merges и проверки |
| Worker B, когда нужен | `codex/sdd/<run>/task-002` | `../sdd-<run>-b` | Второй Worker независимой задачи |

1. Проверить исходный repo, полный code base SHA, свободные имена refs/путей и доступные coding agents. Записать время `bootstrap_started_at`: с этого момента измеряется время до первого READY. Создать control worktree от code base, не переключая чужой checkout.
2. Скопировать inputs/spec/run templates и task template в `docs/sdd/<feature-id>/`, task — в `tasks/T-001.json`. Создать contracts только если они нужны. Coordinator заполняет источник, owners, constraints, R/AC и OPEN вопросы. Вход проходит G0; spec — независимое review и G1.
3. Зафиксировать inputs/spec/contracts в control commit B. Вычислить SHA-256 spec; baseline_ref содержит B, hash и версии контрактов. Только затем заполнить этим reference task/run: никаких ссылок commit на самого себя.
4. Создать integration и worker A от code base. Для задач с зависимостями использовать согласованный snapshot, содержащий dependency commits; Worker B создавать только после отсутствия ownership overlap. Заполнить реальные owners, allowed_files, checks, deadlines и полные локальные пути packet header.
5. Проверить G2 по contracts.md; записать task READY, run ACTIVE и event в control branch. Зафиксировать metadata отдельным control commit. Передать Worker packet и prompt; контрольный baseline B остаётся неизменным.

Второй участник может быть reviewer первой задачи до запуска Worker B. Три worktree пилота — не три одновременно работающих агента; лимит активных workers остаётся два. Git-команды и пути Coordinator формирует под реальный repo после preflight, не копирует чужие абсолютные пути.

## 2. Примите baseline и передайте packet Worker

Проверьте, что AC действительно соответствуют нужной функции, а allowed_files ограничены ей. Передайте Coordinator существующее разрешение на реализацию этой задачи либо подтвердите его один раз; не требуется заново согласовывать каждое техническое решение внутри неё. Coordinator записывает G1/G2, создаёт task worktree от code base с нужными dependency commits и выдаёт prompt Worker.

Минимальный packet: task JSON + frozen spec/contracts + пути к обоим worktrees + проверки + deadline. JSON генерирует Coordinator; люди не обязаны заполнять каждое поле вручную. Worker получает только этот контекст и релевантный код. Вторая независимая задача может идти параллельно, если ownership не пересекается.

## 3. Проверьте и интегрируйте

Worker коммитит код и передаёт результаты проверок. Другой agent в fresh context получает prompt Reviewer из [prompts.md](prompts.md), повторяет критичные checks и заполняет review template. При замечаниях — ограниченный repair; при PASS — один Integrator merge-ит task с сохранением ancestry, запускает общие checks и передаёт code SHA пользователю.

Coordinator хранит evidence/review/DONE в control branch. Проверенный code SHA от этого не меняется. Первый успешный цикл подтверждён только после G4, а не после получения task JSON. Задачи и reviews проверяются по [acceptance.md](acceptance.md); отложенные/упавшие проверки не обозначаются как PASS.

## Если что-то не получилось

| Сообщение Coordinator | Действие | Где правило |
|---|---|---|
| `INPUT_PLAN_MISSING: inputs.product_plan.path не существует; T-001 заблокирована` | Указать существующий путь и commit у Романа; повторить intake | [Контракты](contracts.md) |
| `BASELINE_MISMATCH: review.artifacts_commit отличается от task; PASS не принят` | Сверить revision, вернуть affected task STALE, повторить checks | [Spec](process-spec.md) |
| `TOOL_UNAVAILABLE: headless запуск недоступен; режим не изменён молча` | Выбрать доступный interactive agent; если его тоже нет — BLOCKED_TOOL | [План внедрения](implementation-plan.md) |
| `TASK_SCOPE_VIOLATION: изменён путь вне allowed_files; передача остановлена` | Передать конкретный diff Coordinator; сохранить работу, согласовать scope или отделить лишние изменения | [Контракты](contracts.md) |

Это формат ожидаемых сообщений процесса, а не вывод существующего runner. Каждая ошибка содержит код, файл/поле, затронутую задачу, причину, следующий шаг и ссылку на правило. API keys, auth tokens и сырые модельные логи в сообщение не включаются.

Для двух компьютеров используйте `two_hosts_bundle` из contracts.md до старта workers; SHA без Git objects недостаточен. Если процесс уже запущен, возобновляйте его по run.json и фактическому Git, не создавайте новый run для обхода budget.
