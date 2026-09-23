import { Check, Plus } from "lucide-react";
import { type GraphNode, roles, shortId } from "./types";

export function ClientRow({
  node,
  selected,
  inReview,
  expanded,
  onSelect,
  onToggleReview,
}: {
  node: GraphNode;
  selected: boolean;
  inReview: boolean;
  expanded: boolean;
  onSelect: () => void;
  onToggleReview: () => void;
}) {
  const score = Math.round(node.priority_score * 100);
  return (
    <article
      className={`queue-item client-row ${selected ? "selected" : ""} ${expanded ? "review-expanded" : ""}`}
    >
      <button className="client-row-select" onClick={onSelect} title={node.gid}>
        <span className="rank" title="Место в общем рейтинге">
          {String(node.rank).padStart(2, "0")}
        </span>
        <span className="queue-node">
          <strong>
            {expanded ? node.gid : shortId(node.gid)}
            {node.is_seed && <span className="seed-mini">S</span>}
          </strong>
          <span className="queue-role">
            <i style={{ background: roles[node.role].color }} />
            {node.role === "unknown"
              ? roles[node.role].label
              : `Гипотеза: ${roles[node.role].label}`}
          </span>
          <small className="queue-reason">
            {expanded && <b>Основание: </b>}
            {node.why}
          </small>
        </span>
        <span className="queue-score" aria-label={`Приоритет ${score} из 100`}>
          {score}
          <i style={{ width: `${score}%` }} />
        </span>
      </button>
      {expanded && (
        <p className="review-next-action">
          <strong>Следующий шаг:</strong> {node.next_action}
        </p>
      )}
      <button
        className={`row-review-toggle ${inReview ? "added" : ""}`}
        aria-label={`${inReview ? "Убрать из проверки" : "Добавить на проверку"} ${node.gid}`}
        aria-pressed={inReview}
        onClick={onToggleReview}
      >
        {inReview ? <Check size={12} /> : <Plus size={12} />}
        {inReview ? "На проверке · убрать" : "Добавить на проверку"}
      </button>
    </article>
  );
}
