# Agentic SDD Pipeline

План процесса разработки через Codex и Claude Code для HackAlem AI. Ветка: `agentic-sdd-pipeline`. Дата: 2026-09-23. Статус: проект процесса на ревью; автоматический orchestrator ещё не реализован.

**Граница ответственности:** Роман пишет общий план реализации продукта. Этот пакет определяет, как coding agents получают этот план, уточняют требования, реализуют задачи и доказывают их готовность. Он не выбирает продуктовый стек, AML-алгоритмы, UI или архитектуру LLM внутри продукта.

## Архитектура процесса

```text
                  Роман: общий план продукта
                Пользователь: приоритеты и объём
                              |
                              v
                INPUT BASELINE [пути + Git SHA + hash]
                              |
                              v
                SPEC AUTHOR [Codex или Claude Code]
        требования R -> критерии AC -> контракты C -> задачи T
                              |
                     независимый spec review
                              |
                  G1: подтверждённый spec baseline
                              |
                              v
                  COORDINATOR [coding agent]
              ready queue + dependencies + file ownership
                         /                   \
                        v                     v
           WORKER A [Codex]          WORKER B [Claude Code]
           отдельный worktree        отдельный worktree
           task T, allowed files     task U, allowed files
                        |                     |
                        v                     v
              VERIFIER / REVIEWER [fresh context]
                diff + requirements + actual test logs
                         \                   /
                          v                 v
                    INTEGRATOR [single writer]
             integration candidate -> full acceptance checks
                              |
                     G4: ready for human review
                              |
                   человек решает push / PR / merge
```

Agentic здесь означает ограниченный цикл «получить задачу → выполнить → запустить проверки → получить независимые findings → исправить → повторить». Агент самостоятельно действует внутри утверждённой задачи. Решения об изменении продукта и внешней публикации остаются у людей.

## Источник истины и ownership

| Область | Владелец | Что pipeline может делать |
|---|---|---|
| Общая архитектура, функциональность, ограничения | Роман и пользователь | Читать, находить пробелы, предлагать изменения |
| Требования и контракты, выведенные из общего плана | Spec Author; baseline подтверждает человек | Делать проверяемыми, сохранять трассировку |
| Задача и её разрешённые файлы | Coordinator | Декомпозировать и назначать в пределах baseline |
| Реализация | Назначенный Worker | Код и необходимые тесты внутри task scope |
| Независимая проверка | Reviewer, не автор task | Читать, запускать проверки, выдавать findings |
| Интеграция | Один Integrator | Собирать review candidate и перепроверять |
| Push, PR, merge, deploy | Человек либо явно делегированное разрешение | Исполнять только в пределах конкретной авторизации |

Codex и Claude Code взаимозаменяемы по роли; это не привязка качества к бренду модели. Предпочтительно implementation одной системой, review другой. Если reviewer той же модели, но с чистым контекстом, отметить `same_model_fresh_context`, не заявлять cross-model consensus.

## Два уровня запуска

**Первый хакатонный запуск:** документы, JSON-карточки задач, isolated worktrees и готовые prompts. Coordinator ведёт очередь и ledger; люди запускают свои Codex/Claude Code с переданными task packets. Каждый агент автономно выполняет ограниченный цикл задачи. Этот режим использует уже доступные coding environments и не требует нового orchestration-сервиса.

**Необязательный backlog после хакатона:** тонкий локальный runner для проверки схем, выдачи следующей задачи, вызова CLI-adapters, записи статусов и лимитов повторов. Начинать его только если пилот выявил повторяющуюся проблему координации, а ожидаемая экономия оправдывает поддержку. Сначала проверить наличие CLI, актуальные supported flags, авторизацию и exit/result semantics; не считать подписку или открытое приложение доказательством наличия headless API.

Это план agentic workflow, а не утверждение, что автоматическая диспетчеризация уже работает. Этапы реализации автоматизации находятся в [implementation-plan.md](implementation-plan.md).

## Канонические артефакты

```text
docs/agentic-sdd-pipeline/             # этот процесс и reusable templates
  README.md
  process-spec.md
  contracts.md
  acceptance.md
  implementation-plan.md
  prompts.md
  review.md
  templates/

docs/sdd/<feature-id>/                # создаётся при первом запуске по плану Романа
  inputs.json                        # путь/commit/hash источников
  spec.md                            # R-xxx и AC-xxx
  contracts/                         # C-xxx, типы, версии, совместимость
  tasks/T-001.json                    # задача и её boundaries
  reviews/T-001-review-01.json        # findings и результат
  evidence/T-001/                     # короткие отчёты, команды, exit codes
  decisions.md                       # принятые решения и причины
  run.json                           # версия baseline, последовательность событий

.sdd/runtime/                        # локально, игнорируется Git
  locks/                             # task и integration leases
  logs/                              # raw transcripts без публикации
```

Только Coordinator пишет `run.json` и статусы задач в канонической ветке. Workers создают изменения в своих worktrees и передают completion packet. Reviewer не меняет код при review, чтобы не проверять собственное исправление.

По умолчанию пользователь ведёт Coordinator/Integrator, Роман — продуктовые решения; это назначение фиксируется в inputs.json перед запуском. Первый пилот выполняется на одном host с двумя worktrees. Если участники работают на разных компьютерах, используется описанная в [contracts.md](contracts.md) передача Git bundle либо явно разрешённый remote: один SHA без Git objects не является переданной работой.

## Этапы и выходы

| Этап | Вход | Обязательный выход | Gate |
|---|---|---|---|
| 0 Intake | Общий план Романа, ТЗ, ограничения | inputs.json, список пробелов, baseline reference | G0: источник существует и проверен |
| 1 Specify | Baseline | R/AC/C, non-goals, edge/error cases | G1: spec review и подтверждение существенных решений |
| 2 Plan | Принятая spec | DAG задач, владельцы файлов, test map | G2: каждая ready-задача исполнима без догадок |
| 3 Build | Task packet, worktree | diff/commit + выполненные проверки | Worker не вправе принять свою работу |
| 4 Verify | Diff + spec + evidence | ReviewResult с findings и verdict | G3: нет открытых blocking findings |
| 5 Integrate | Проверенные task commits | интеграционный кандидат + полный прогон | G4: доказательства относятся к текущему candidate SHA |
| 6 Handoff | G4 | Краткий release/handoff report | Публикация только при авторизации |

Недостаток входного плана не заменяется выдуманной архитектурой: создать вопрос Роману, отметить зависимую задачу BLOCKED_INPUT и продолжить независимые задачи. Существующее явное решение не спрашивается повторно.

## SDD-инвариант

```text
каждая задача -> требования R -> acceptance AC -> доказательство проверки
каждое изменение контракта -> версия C -> список consumers -> affected tests
каждый merge candidate -> точный Git SHA -> повторная integration verification
```

Нет acceptance без фактического запуска и exit code. Нет DONE только на основании фразы агента «готово». Изменение реализации допустимо внутри поведения spec; изменение поведения сначала проходит change request к источнику истины.

## Как начать после плана Романа

1. Указать в inputs.json реальный путь и Git SHA общего плана. Пока этот вход не предоставлен, пакет является готовым процессом, но продуктовые задачи не запускаются.
2. Дать Spec Author prompt из [prompts.md](prompts.md); получить первую небольшую вертикальную задачу с проверяемым результатом.
3. Утвердить baseline, назначить workers и reviewers, создать task worktrees.
4. Выполнять задачи по DAG; интегрировать по одной, запускать приёмку на собранном результате.

Условия текущего кейса — 5 часов, два участника, Codex и Claude Code — определяют лимит параллелизма 2 и короткие циклы. Обязательность LLM в продукте передаётся в исходные требования Романа, но этот документ не навязывает способ его реализации.
