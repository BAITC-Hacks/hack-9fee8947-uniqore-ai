import { roles, type GraphNode, type RoleCriterion } from "./types";

const formatValue = (value: number | boolean | null): string => {
  if (value === null) return "нет данных";
  if (typeof value === "boolean") return value ? "да" : "нет";
  return new Intl.NumberFormat("ru-RU", {
    maximumSignificantDigits: 6,
  }).format(value);
};

const requirement = (criterion: RoleCriterion): string => {
  if (criterion.threshold === null) return "порог недоступен";
  if (Array.isArray(criterion.threshold))
    return `${formatValue(criterion.threshold[0])}–${formatValue(criterion.threshold[1])}`;
  return `${criterion.operator === "gte" ? "≥ " : ""}${formatValue(criterion.threshold)}`;
};

function Criteria({ criteria }: { criteria: RoleCriterion[] }) {
  return (
    <dl className="role-criteria">
      {criteria.map((criterion) => (
        <div key={criterion.key}>
          <dt>{criterion.label}</dt>
          <dd>
            <strong title={String(criterion.observed)}>
              {formatValue(criterion.observed)}
            </strong>
            <span title={String(criterion.threshold)}>
              условие: {requirement(criterion)}
              {!criterion.passed && " · не выполнено"}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function RoleExplanation({ node }: { node: GraphNode }) {
  const explanation = node.role_explanation;
  const isUnknown = node.role === "unknown";
  return (
    <section
      className="role-explanation"
      aria-label="Обоснование гипотезы о роли"
    >
      <div className="role-explanation-heading">
        <div>
          <span className="section-label">Наблюдаемая структура</span>
          <h3>
            {isUnknown
              ? "Недостаточно данных для роли"
              : `Гипотеза: ${node.role_label}`}
          </h3>
        </div>
        {!isUnknown && (
          <div className="role-support">
            <strong>
              {Math.round(node.role_score * 100)}
              <small>/100</small>
            </strong>
            <span>поддержка признаками</span>
          </div>
        )}
      </div>
      <p className="role-support-note">
        {isUnknown
          ? "По этой выборке роль установить нельзя."
          : "Оценка по правилам, не вероятность. Точность на размеченных данных не измерялась."}
      </p>
      {explanation ? (
        <Criteria criteria={explanation.criteria} />
      ) : (
        <p>{node.evidence}</p>
      )}
      {(node.boundary || node.is_seed || node.isolated) && (
        <p className="role-observation-limit">{node.limitations[0]}</p>
      )}
      {explanation && (
        <details className="role-method">
          <summary>Как выбрана роль и рассчитана поддержка</summary>
          <p>{explanation.selection}</p>
          <p>
            Порядок правил:{" "}
            {explanation.rule_order
              .map((role) => roles[role].label)
              .join(" → ")}
            .
          </p>
          {explanation.excluded_rules.length > 0 && (
            <div className="role-excluded-rules">
              <h4>Почему не сработали предыдущие правила</h4>
              {explanation.excluded_rules.map((rule) => (
                <div key={rule.role}>
                  <h5>{rule.label}</h5>
                  <Criteria criteria={rule.unmet_criteria} />
                </div>
              ))}
            </div>
          )}
          <p>{explanation.score.formula}.</p>
          {explanation.score.factors.length > 0 && (
            <ul className="role-score-factors">
              {explanation.score.factors.map((factor) => (
                <li key={factor.key}>
                  {factor.label}: {formatValue(factor.value * 100)}/100
                  {factor.weight !== null &&
                    ` · вес ${Math.round(factor.weight * 100)}%`}
                </li>
              ))}
            </ul>
          )}
          <p>{explanation.score.rank_method}</p>
          <p>{explanation.threshold_method}</p>
          <p>{explanation.score.interpretation}</p>
          <ul className="role-method-limits">
            {explanation.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
