import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import cytoscape, { Core, ElementDefinition } from "cytoscape";
import { GraphEdge, GraphNode, roles, shortId } from "./types";

export interface GraphHandle {
  fit: () => void;
  zoom: (factor: number) => void;
}
interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selected: string;
  onSelect: (gid: string) => void;
  onEdge: (edge: GraphEdge) => void;
  scope: "ego" | "all";
  hops: number;
  allowed: Set<string>;
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
  const renderedScope = useRef(props.scope);
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
            "target-arrow-color": "#c6d0dd",
            "target-arrow-shape": "triangle",
            "arrow-scale": 0.95,
            "curve-style": "bezier",
            opacity: 0.75,
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
          selector: ".selected-edge",
          style: {
            "line-color": "#70b4bb",
            "target-arrow-color": "#408d98",
            opacity: 0.85,
          },
        },
        { selector: ".inactive", style: { opacity: 0.12 } },
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
    cy.on("dragfree", "node", (event) =>
      saved.current.set(
        `${latest.current.scope}:${event.target.id()}`,
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
        if (cy.elements().length) cy.fit(cy.elements(), 45);
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
    const adjacency = new Map<string, Set<string>>();
    props.edges.forEach((e) => {
      if (!adjacency.has(e.src)) adjacency.set(e.src, new Set());
      if (!adjacency.has(e.dst)) adjacency.set(e.dst, new Set());
      if (props.direction !== "in") adjacency.get(e.src)!.add(e.dst);
      if (props.direction !== "out") adjacency.get(e.dst)!.add(e.src);
    });
    let visible = new Set<string>(
      props.scope === "all" ? props.allowed : [props.selected],
    );
    if (props.scope === "ego")
      for (let hop = 0; hop < props.hops; hop++) {
        const next = new Set(visible);
        visible.forEach((gid) =>
          adjacency.get(gid)?.forEach((n) => next.add(n)),
        );
        visible = next;
      }
    visible = new Set([...visible].filter((gid) => props.allowed.has(gid)));
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
          (props.scope === "all" ? 1.7 : 1),
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
        position: saved.current.get(`${props.scope}:${n.gid}`) || initial,
        classes: [
          n.gid === props.selected ? "chosen" : "",
          n.boundary ? "boundary" : "",
        ].join(" "),
      };
    });
    props.edges
      .filter((e) => visible.has(e.src) && visible.has(e.dst))
      .forEach((e) => {
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
    renderedScope.current = props.scope;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    if (
      shown.length > 1 &&
      shown.length < 180 &&
      shown.some((n) => !saved.current.has(`${props.scope}:${n.gid}`))
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
        saved.current.set(`${props.scope}:${n.id()}`, n.position());
      });
    } else cy.fit(cy.elements(), 55);
    if (shown.length < 180 && shown.length) {
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
