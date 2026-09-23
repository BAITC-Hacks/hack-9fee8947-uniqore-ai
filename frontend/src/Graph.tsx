import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import cytoscape, { Core, ElementDefinition } from "cytoscape";
import { GraphEdge, GraphNode, roles, shortId } from "./types";
import { applyFilterHighlight, graphScope } from "./graphScope";

export interface GraphHandle {
  fit: () => void;
  zoom: (factor: number) => void;
}
interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selected: string;
  selectedEdgeId?: string;
  onSelect: (gid: string) => void;
  onEdge: (edge: GraphEdge) => void;
  scope: "ego" | "all";
  hops: number;
  allowed: Set<string>;
  highlightMatches?: boolean;
  direction: "both" | "in" | "out";
  colorBy: "role" | "cluster";
  days: [number, number];
  onCount: (count: number) => void;
}
export const Graph = forwardRef<GraphHandle, Props>(function Graph(props, ref) {
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    title: string;
    detail: string;
  } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const instance = useRef<Core | null>(null);
  const fullNetwork = useMemo(
    () => new Set(props.nodes.map((node) => node.gid)),
    [props.nodes],
  );
  const nodeById = useMemo(
    () => new Map(props.nodes.map((node) => [node.gid, node])),
    [props.nodes],
  );
  const displayScope = props.highlightMatches ? "all" : props.scope;
  const displayAllowed = props.highlightMatches ? fullNetwork : props.allowed;
  const displaySelected = props.highlightMatches ? "" : props.selected;
  const displayHops = props.highlightMatches ? 0 : props.hops;
  const displayDirection = props.highlightMatches ? "both" : props.direction;
  const renderedScope = useRef(displayScope);
  const saved = useRef(new Map<string, { x: number; y: number }>());
  const latest = useRef(props);
  latest.current = props;
  useImperativeHandle(
    ref,
    () => ({
      fit: () =>
        instance.current?.animate({
          fit: { eles: instance.current.elements(), padding: 60 },
          duration: 220,
        }),
      zoom: (factor) => {
        const cy = instance.current;
        if (cy)
          cy.zoom({
            level: cy.zoom() * factor,
            renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 },
          });
      },
    }),
    [],
  );
  useEffect(() => {
    if (!container.current) return;
    const cy = cytoscape({
      container: container.current,
      minZoom: 0.08,
      maxZoom: 4,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "data(color)",
            width: "data(size)",
            height: "data(size)",
            label: "data(label)",
            color: "#61718a",
            "font-size": 10,
            "font-family": "system-ui",
            "text-valign": "bottom",
            "text-margin-y": 8,
            "border-width": 2,
            "border-color": "#fff",
            shape: "data(shape)",
          },
        },
        {
          selector: "edge",
          style: {
            width: "data(width)",
            "line-color": "#d7dee7",
            "target-arrow-color": "#8c9fae",
            "target-arrow-shape": "triangle",
            "arrow-scale": 1.25,
            "curve-style": "bezier",
            opacity: 0.75,
          },
        },
        {
          selector: "node.filter-muted",
          style: { opacity: 0.32, "text-opacity": 0.25 },
        },
        {
          selector: "node.filter-match",
          style: { opacity: 1 },
        },
        {
          selector: "node.filter-emphasis",
          style: {
            width: "data(highlightSize)",
            height: "data(highlightSize)",
            "border-width": "data(highlightBorderWidth)",
            "underlay-color": "#00b5c8",
            "underlay-opacity": 0.26,
            "underlay-padding": "data(highlightPadding)",
            "z-index": 10,
          },
        },
        {
          selector: "edge.filter-muted",
          style: { opacity: 0.12 },
        },
        {
          selector: "edge.filter-match-edge",
          style: {
            "line-color": "#61aeb4",
            "target-arrow-color": "#367f88",
            opacity: 0.8,
          },
        },
        { selector: "node:selected", style: { "overlay-opacity": 0 } },
        {
          selector: ".chosen",
          style: {
            "border-width": 5,
            "border-color": "#8ed8da",
            "font-size": 12,
            "font-weight": 600,
            color: "#00313d",
            "z-index": 20,
          },
        },
        {
          selector: ".boundary",
          style: {
            "border-style": "dashed",
            "border-color": "#d2a56e",
            "border-width": 2,
          },
        },
        {
          selector: "node.boundary.filter-emphasis",
          style: { "border-width": "data(highlightBorderWidth)" },
        },
        {
          selector: ".selected-edge",
          style: {
            "line-color": "#70b4bb",
            "target-arrow-color": "#408d98",
            opacity: 0.85,
          },
        },
        {
          selector: "node.filter-selected",
          style: {
            opacity: 1,
            "text-opacity": 1,
            width: "data(selectedSize)",
            height: "data(selectedSize)",
            "border-color": "#00313d",
            "border-width": "data(selectedBorderWidth)",
            "font-size": "data(selectedFontSize)",
            "z-index": 30,
          },
        },
        {
          selector: "edge.selected-edge.filter-muted",
          style: { opacity: 0.4 },
        },
        {
          selector: ".inspected-edge",
          style: {
            "line-color": "#245f6a",
            "target-arrow-color": "#245f6a",
            "underlay-color": "#70b4bb",
            "underlay-opacity": 0.2,
            "underlay-padding": 4,
            opacity: 1,
          },
        },
        { selector: ".inactive", style: { opacity: 0.12 } },
        { selector: "edge.filter-muted.inactive", style: { opacity: 0.025 } },
        {
          selector: "edge.inspected-edge.filter-muted",
          style: { opacity: 1 },
        },
        {
          selector: "edge.inspected-edge.inactive",
          style: { opacity: 0.55, "line-style": "dashed" },
        },
        { selector: "node:active", style: { "overlay-opacity": 0 } },
      ] as cytoscape.StylesheetStyle[],
    });
    instance.current = cy;
    cy.on("tap", "node", (event) => latest.current.onSelect(event.target.id()));
    cy.on("tap", "edge", (event) => {
      const edge = latest.current.edges.find((e) => e.id === event.target.id());
      if (edge) latest.current.onEdge(edge);
    });
    cy.on("mouseover", "node", (event) => {
      const n = latest.current.nodes.find((n) => n.gid === event.target.id());
      if (n) {
        const p = event.target.renderedPosition();
        setHover({
          x: Math.max(4, Math.min(p.x + 12, cy.width() - 230)),
          y: Math.max(30, p.y - 55),
          title: n.gid,
          detail:
            roles[n.role].label +
            " · приоритет " +
            Math.round(n.priority_score * 100),
        });
      }
    });
    cy.on("mouseout", "node", () => setHover(null));
    cy.on("pan zoom", () => setHover(null));
    cy.on("zoom", () => {
      if (latest.current.highlightMatches)
        applyFilterHighlight(cy, latest.current.allowed, true);
    });
    cy.on("dragfree", "node", (event) =>
      saved.current.set(
        `${latest.current.highlightMatches ? "all" : latest.current.scope}:${event.target.id()}`,
        event.target.position(),
      ),
    );
    let previousWidth = container.current.clientWidth;
    let previousHeight = container.current.clientHeight;
    const observer = new ResizeObserver(() => {
      const width = container.current?.clientWidth || 0;
      const height = container.current?.clientHeight || 0;
      cy.resize();
      if (width !== previousWidth || height !== previousHeight) {
        previousWidth = width;
        previousHeight = height;
        if (cy.elements().length && !latest.current.highlightMatches)
          cy.fit(cy.elements(), 45);
      }
    });
    observer.observe(container.current);
    return () => {
      observer.disconnect();
      cy.destroy();
      instance.current = null;
    };
  }, []);
  useEffect(() => {
    const cy = instance.current;
    if (!cy) return;
    const view = graphScope(
      props.edges,
      displayAllowed,
      displaySelected,
      displayScope,
      displayHops,
      displayDirection,
      props.highlightMatches ? fullNetwork : undefined,
    );
    const visible = view.nodes;
    const shown = props.nodes.filter((n) => visible.has(n.gid));
    const clusterIds = [...new Set(shown.map((n) => n.cluster_id))].sort(
      (a, b) => a - b,
    );
    const counts = new Map<number, number>();
    const elements: ElementDefinition[] = shown.map((n) => {
      const clusterIndex = clusterIds.indexOf(n.cluster_id);
      const local = counts.get(n.cluster_id) || 0;
      counts.set(n.cluster_id, local + 1);
      const angle = local * 2.399963,
        radius = 25 * Math.sqrt(local + 1);
      const centerAngle = clusterIndex * 2.399963,
        centerRadius =
          clusterIds.length > 1 ? 160 * Math.sqrt(clusterIndex + 1) : 0;
      const initial = {
        x:
          (Math.cos(centerAngle) * centerRadius + Math.cos(angle) * radius) *
          (displayScope === "all" ? 1.7 : 1),
        y: Math.sin(centerAngle) * centerRadius + Math.sin(angle) * radius,
      };
      const color =
        props.colorBy === "role"
          ? roles[n.role].color
          : `hsl(${(n.cluster_id * 137.5) % 360}, 42%, 58%)`;
      return {
        data: {
          id: n.gid,
          color,
          label:
            n.gid === props.selected ||
            shown.length < 16 ||
            (shown.length < 100 && n.rank <= 10)
              ? shortId(n.gid)
              : "",
          shape: n.is_seed ? "diamond" : "ellipse",
          size:
            n.gid === props.selected
              ? 46
              : Math.min(35, 17 + Math.sqrt(n.in_degree + n.out_degree) * 2.1),
        },
        position: saved.current.get(`${displayScope}:${n.gid}`) || initial,
        classes: [
          n.gid === props.selected ? "chosen" : "",
          n.boundary ? "boundary" : "",
        ].join(" "),
      };
    });
    view.edges.forEach((e) => {
      const active = e.daily.some((d) => {
        const day = Number(d.date.slice(-2));
        return day >= props.days[0] && day <= props.days[1];
      });
      elements.push({
        data: {
          id: e.id,
          source: e.src,
          target: e.dst,
          width: Math.min(3, 0.7 + Math.log10(1 + e.amount) / 5),
        },
        classes: [
          e.src === props.selected || e.dst === props.selected
            ? "selected-edge"
            : "",
          active ? "" : "inactive",
        ].join(" "),
      });
    });
    cy.nodes().forEach((n) => {
      saved.current.set(`${renderedScope.current}:${n.id()}`, n.position());
    });
    renderedScope.current = displayScope;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    if (
      shown.length > 1 &&
      shown.length < 180 &&
      shown.some((n) => !saved.current.has(`${displayScope}:${n.gid}`))
    ) {
      cy.layout({
        name: "cose",
        animate: false,
        randomize: false,
        fit: true,
        padding: 55,
        nodeRepulsion: () => 7500,
        idealEdgeLength: () => 90,
        numIter: 450,
      } as cytoscape.LayoutOptions).run();
      const bounds = cy.nodes().boundingBox();
      const center = (bounds.x1 + bounds.x2) / 2;
      cy.nodes().positions((n) => ({
        x: center + (n.position().x - center) * 2.3,
        y: n.position().y,
      }));
      cy.fit(cy.elements(), 45);
      cy.nodes().forEach((n) => {
        saved.current.set(`${displayScope}:${n.id()}`, n.position());
      });
    } else cy.fit(cy.elements(), 55);
    if (!props.highlightMatches && shown.length < 180 && shown.length) {
      const zoom = cy.zoom();
      cy.batch(() => {
        cy.nodes().forEach((n) => {
          const size = Math.max(
            n.data("size"),
            (n.id() === props.selected ? 26 : 11) / zoom,
          );
          n.style({
            width: size,
            height: size,
            "font-size": Math.max(10, 9 / zoom),
          });
        });
        cy.edges().style("width", Math.max(1.4, 0.8 / zoom));
      });
    }
    props.onCount(shown.length);
  }, [
    props.nodes,
    props.edges,
    displaySelected,
    displayScope,
    displayHops,
    displayAllowed,
    props.colorBy,
    displayDirection,
    props.highlightMatches,
    fullNetwork,
  ]);
  useEffect(() => {
    const cy = instance.current;
    if (!cy) return;
    // Selection and filters only update classes in full-network highlighting mode.
    const nodeCount = cy.nodes().length;
    cy.batch(() => {
      cy.nodes().forEach((node) => {
        const selected = node.id() === props.selected;
        node.toggleClass("chosen", selected);
        const source = nodeById.get(node.id());
        if (source) {
          node.data(
            "size",
            selected
              ? 46
              : Math.min(
                  35,
                  17 + Math.sqrt(source.in_degree + source.out_degree) * 2.1,
                ),
          );
          node.data(
            "label",
            selected || nodeCount < 16 || (nodeCount < 100 && source.rank <= 10)
              ? shortId(source.gid)
              : "",
          );
        }
      });
      cy.edges().forEach((edge) => {
        edge.toggleClass(
          "selected-edge",
          edge.source().id() === props.selected ||
            edge.target().id() === props.selected,
        );
      });
    });
    applyFilterHighlight(cy, props.allowed, Boolean(props.highlightMatches));
  }, [
    props.allowed,
    props.highlightMatches,
    props.selected,
    props.nodes,
    props.edges,
    props.scope,
    props.hops,
    props.direction,
    props.colorBy,
    nodeById,
  ]);
  useEffect(() => {
    const cy = instance.current;
    if (!cy) return;
    cy.elements(".inspected-edge").removeClass("inspected-edge");
    if (props.selectedEdgeId)
      cy.getElementById(props.selectedEdgeId).addClass("inspected-edge");
  }, [
    props.selectedEdgeId,
    props.highlightMatches,
    props.nodes,
    props.edges,
    props.selected,
    props.scope,
    props.hops,
    props.allowed,
    props.colorBy,
    props.direction,
  ]);
  useEffect(() => {
    const cy = instance.current;
    if (!cy) return;
    cy.batch(() =>
      props.edges.forEach((e) => {
        const active = e.daily.some(
          (d) =>
            Number(d.date.slice(-2)) >= props.days[0] &&
            Number(d.date.slice(-2)) <= props.days[1],
        );
        cy.getElementById(e.id).toggleClass("inactive", !active);
      }),
    );
  }, [props.days, props.edges]);
  return (
    <>
      <div
        ref={container}
        className="network-canvas"
        role="region"
        aria-label="Интерактивный граф переводов"
      />
      {hover && (
        <div className="graph-tooltip" style={{ left: hover.x, top: hover.y }}>
          <strong>{hover.title}</strong>
          <small>{hover.detail}</small>
        </div>
      )}
    </>
  );
});
