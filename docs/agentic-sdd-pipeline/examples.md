# Связанный пример артефактов

Учебный пример **заблокированной**, ещё не выполненной задачи. Он показывает формы вложенных полей, а не задаёт архитектуру продукта или результат проверок. Python-команда иллюстрирует CheckSpec для условного проекта; такого тестового каталога в этом репозитории нет. Реальные команды берутся из проекта и плана Романа. Полные оболочки артефактов находятся в templates/.

Условные ID: R-001 — отвергать некорректный вход; AC-001 — пустой вход возвращает описанную ошибку без создания результата; T-001 — реализовать это поведение. Источник ещё не получен, поэтому task BLOCKED_INPUT, evidence not_run и review blocked. Эти значения нельзя копировать в READY без реального baseline и остальных обязательных полей.

## TaskSpec: task, checks и причина

Фрагмент `tasks/T-001.json`; остальные поля заполняются по task template.

```json
{
  "task_id": "T-001",
  "requirement_ids": ["R-001"],
  "acceptance_ids": ["AC-001"],
  "baseline_ref": {"spec_version": "1", "artifacts_commit": null, "spec_sha256": null, "contract_versions": {}},
  "checks": [{
    "id": "CHECK-001",
    "argv": ["python", "-m", "unittest", "discover", "-s", "tests/input cases"],
    "cwd": ".",
    "timeout_seconds": 120,
    "required": true,
    "kind": "unit",
    "acceptance_ids": ["AC-001"]
  }],
  "status": "BLOCKED_INPUT",
  "reason_code": "INPUT_PLAN_MISSING"
}
```

`tests/input cases` — один аргумент, кавычки shell внутрь строки не добавляются. В JSON Windows-путь пишется как `"C:\\Tools\\Python\\python.exe"` либо `"C:/Tools/Python/python.exe"`; это иллюстрация экранирования, не требование конкретного пути. `cwd`, allowed_files и artifact refs остаются repo-relative. В interactive режиме агент запускает команду средствами своей среды, сохраняя фактические executable/argv/cwd; при передаче через shell использует его правила quoting и записывает фактическую команду. Не исполняет текст через произвольную конкатенацию.

## Evidence и ReviewResult

Фрагмент `evidence/T-001/check-001.json`:

```json
{
  "check_id": "CHECK-001",
  "checked_commit": null,
  "baseline_ref": {"spec_version": "1", "artifacts_commit": null, "spec_sha256": null, "contract_versions": {}},
  "argv": ["python", "-m", "unittest", "discover", "-s", "tests/input cases"],
  "cwd": ".",
  "started_at": null,
  "finished_at": null,
  "exit_code": null,
  "result": "not_run",
  "summary": "Источник и code candidate ещё не предоставлены"
}
```

Связанный фрагмент `reviews/T-001-review-01.json`:

```json
{
  "task_id": "T-001",
  "reviewed_commit": null,
  "baseline_ref": {"spec_version": "1", "artifacts_commit": null, "spec_sha256": null, "contract_versions": {}},
  "check_results": [{
    "check_id": "CHECK-001",
    "evidence_ref": "evidence/T-001/check-001.json",
    "result": "not_run"
  }],
  "findings": [],
  "verdict": "blocked",
  "reason": "INPUT_PLAN_MISSING: отсутствует принятый baseline; review не выполнялось"
}
```

Для реального PASS Coordinator сверяет code SHA, полный baseline_ref, reviewer identity/independence, actual evidence и отсутствие открытых blocking findings. Пустой findings[] при blocked не означает проверку без замечаний. Если найден дефект, finding содержит id, severity, requirement_id, file/line при наличии, observation, impact, required_fix, verification, status и disposition_reason, как описано в contracts.md.

## Run: ссылки и event

Фрагмент run.json; timestamp ниже исключительно пример формата ISO 8601:

```json
{
  "run_id": "demo-run",
  "status": "WAITING_INPUT",
  "tasks": [{"task_id": "T-001", "task_ref": "tasks/T-001.json"}],
  "events": [{
    "seq": 1,
    "at": "2026-09-23T10:00:00+05:00",
    "actor": "coordinator",
    "task_id": "T-001",
    "from": "DRAFT",
    "to": "BLOCKED_INPUT",
    "reason_code": "INPUT_PLAN_MISSING",
    "reason": "Запросить у Романа путь и commit общего плана",
    "evidence_refs": []
  }],
  "integration_candidate": null
}
```

После получения источника проходят G0/G1/G2, создаются реальные refs и SHA; event добавляется, а не переписывает историю. После code commit и реальных checks появляется evidence с временем, executor и exit code; независимый reviewer принимает отдельное решение. Только после integration checks run может стать READY_FOR_HANDOFF.
