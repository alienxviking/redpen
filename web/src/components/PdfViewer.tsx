import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Annotation, AnnotationType, Rect } from "../lib/types.js";
import { ANNOTATION_COLOURS, ANNOTATION_LABELS } from "../lib/types.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * The answer paper with its editable annotation layer.
 *
 * The PDF is painted to a canvas; annotations are plain absolutely-positioned divs
 * on top of it. That separation is what makes the boxes editable at all - they are
 * never baked into the rendered page, only into the exported copy.
 *
 * Coordinates: the API speaks PDF user space (origin bottom-left, points). The DOM
 * works top-left in CSS pixels. All conversion happens in `toScreen` / `toPdf` so no
 * other component has to think about it.
 */

export interface PageGeometry {
  page: number;
  width: number; // PDF points
  height: number;
  scale: number;
}

interface Props {
  fileUrl: string;
  annotations: Annotation[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  onMove(id: string, rects: Rect[]): void;
  onCreate(rect: Rect): void;
  drawingType: AnnotationType | null;
}

function toScreen(rect: Rect, geometry: PageGeometry) {
  return {
    left: rect.x * geometry.scale,
    top: (geometry.height - rect.y - rect.h) * geometry.scale,
    width: rect.w * geometry.scale,
    height: rect.h * geometry.scale,
  };
}

function toPdf(
  box: { left: number; top: number; width: number; height: number },
  geometry: PageGeometry,
): Rect {
  return {
    page: geometry.page,
    x: box.left / geometry.scale,
    y: geometry.height - (box.top + box.height) / geometry.scale,
    w: box.width / geometry.scale,
    h: box.height / geometry.scale,
  };
}

export function PdfViewer({
  fileUrl,
  annotations,
  selectedId,
  onSelect,
  onMove,
  onCreate,
  drawingType,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
  const [geometries, setGeometries] = useState<PageGeometry[]>([]);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1.25);

  // Load the document. Setting the page count first gives React a chance to create
  // the per-page hosts that the canvases are then mounted into.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setGeometries([]);
    setPageCount(0);

    (async () => {
      try {
        const doc = await pdfjsLib.getDocument({ url: fileUrl }).promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }
        docRef.current = doc;
        setPageCount(doc.numPages);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not open this PDF.");
        }
      }
    })();

    return () => {
      cancelled = true;
      void docRef.current?.destroy();
      docRef.current = null;
    };
  }, [fileUrl]);

  // Paint the pages, and repaint on zoom.
  useEffect(() => {
    const doc = docRef.current;
    const container = containerRef.current;
    if (!doc || !container || pageCount === 0) return;

    let cancelled = false;
    (async () => {
      try {
        const next: PageGeometry[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n);
          if (cancelled) return;

          const viewport = page.getViewport({ scale: zoom });
          const base = page.getViewport({ scale: 1 });
          const host = container.querySelector<HTMLDivElement>(`[data-page="${n - 1}"]`);
          if (!host) continue;

          host.querySelectorAll("canvas").forEach((c) => c.remove());
          const canvas = document.createElement("canvas");
          canvas.className = "pdf-page-canvas";
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          host.prepend(canvas);

          const context = canvas.getContext("2d");
          if (context) await page.render({ canvasContext: context, viewport }).promise;
          next.push({ page: n - 1, width: base.width, height: base.height, scale: zoom });
        }
        if (!cancelled) setGeometries(next);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not display this PDF.");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pageCount, zoom]);

  return (
    <div className="viewer">
      <div className="viewer-toolbar">
        <span className="muted">Answer paper</span>
        <div className="zoom">
          <button type="button" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}>
            −
          </button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))}>
            +
          </button>
        </div>
        {drawingType && (
          <span className="drawing-hint">
            Drag on the page to box a {ANNOTATION_LABELS[drawingType].toLowerCase()} note
          </span>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      <div className="viewer-scroll" ref={containerRef}>
        {Array.from({ length: pageCount }, (_, index) => {
          const geometry = geometries.find((g) => g.page === index);
          return (
            <div className="pdf-page" data-page={index} key={index}>
              {geometry && (
                <AnnotationLayer
                  geometry={geometry}
                  annotations={annotations.filter((a) =>
                    a.rects.some((r) => r.page === index),
                  )}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onMove={onMove}
                  onCreate={onCreate}
                  drawingType={drawingType}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- layer */

interface LayerProps {
  geometry: PageGeometry;
  annotations: Annotation[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  onMove(id: string, rects: Rect[]): void;
  onCreate(rect: Rect): void;
  drawingType: AnnotationType | null;
}

type DragState =
  | { kind: "move"; id: string; startX: number; startY: number; origin: Rect[] }
  | { kind: "resize"; id: string; startX: number; startY: number; origin: Rect[] }
  | { kind: "draw"; startX: number; startY: number; currentX: number; currentY: number };

function AnnotationLayer({
  geometry,
  annotations,
  selectedId,
  onSelect,
  onMove,
  onCreate,
  drawingType,
}: LayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  /** Local offsets applied while dragging, so the box tracks the pointer smoothly. */
  const [preview, setPreview] = useState<{ id: string; rects: Rect[] } | null>(null);

  useEffect(() => {
    if (!drag) return;

    const onPointerMove = (event: PointerEvent) => {
      const bounds = layerRef.current?.getBoundingClientRect();
      if (!bounds) return;

      if (drag.kind === "draw") {
        setDrag({ ...drag, currentX: event.clientX - bounds.left, currentY: event.clientY - bounds.top });
        return;
      }

      const dx = (event.clientX - drag.startX) / geometry.scale;
      const dy = (event.clientY - drag.startY) / geometry.scale;

      const rects = drag.origin.map((rect) =>
        rect.page !== geometry.page
          ? rect
          : drag.kind === "move"
            ? { ...rect, x: rect.x + dx, y: rect.y - dy }
            : { ...rect, w: Math.max(8, rect.w + dx), y: rect.y - dy, h: Math.max(8, rect.h + dy) },
      );
      setPreview({ id: drag.id, rects });
    };

    const onPointerUp = () => {
      if (drag.kind === "draw") {
        const left = Math.min(drag.startX, drag.currentX);
        const top = Math.min(drag.startY, drag.currentY);
        const width = Math.abs(drag.currentX - drag.startX);
        const height = Math.abs(drag.currentY - drag.startY);
        if (width > 6 && height > 4) onCreate(toPdf({ left, top, width, height }, geometry));
      } else if (preview) {
        onMove(preview.id, preview.rects);
      }
      setDrag(null);
      setPreview(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [drag, preview, geometry, onCreate, onMove]);

  const startDraw = (event: React.PointerEvent) => {
    if (!drawingType || event.target !== event.currentTarget) return;
    const bounds = layerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    setDrag({ kind: "draw", startX: x, startY: y, currentX: x, currentY: y });
  };

  return (
    <div
      className={`annotation-layer${drawingType ? " drawing" : ""}`}
      ref={layerRef}
      style={{
        width: geometry.width * geometry.scale,
        height: geometry.height * geometry.scale,
      }}
      onPointerDown={startDraw}
      onClick={(event) => {
        if (event.target === event.currentTarget) onSelect(null);
      }}
    >
      {annotations.map((annotation) => {
        const rects =
          preview && preview.id === annotation.id ? preview.rects : annotation.rects;
        const selected = annotation.id === selectedId;
        const colour = ANNOTATION_COLOURS[annotation.type];

        return rects
          .filter((rect) => rect.page === geometry.page)
          .map((rect, index) => {
            const box = toScreen(rect, geometry);
            return (
              <div
                key={`${annotation.id}-${index}`}
                className={`annotation-box${selected ? " selected" : ""}`}
                style={{ ...box, borderColor: colour, background: `${colour}14` }}
                title={annotation.comment}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  onSelect(annotation.id);
                  setDrag({
                    kind: "move",
                    id: annotation.id,
                    startX: event.clientX,
                    startY: event.clientY,
                    origin: annotation.rects,
                  });
                }}
              >
                {index === 0 && (
                  <span className="annotation-tag" style={{ background: colour }}>
                    {ANNOTATION_LABELS[annotation.type]}
                    {annotation.edited && " ✎"}
                  </span>
                )}
                {selected && index === rects.length - 1 && (
                  <span
                    className="annotation-handle"
                    style={{ background: colour }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      setDrag({
                        kind: "resize",
                        id: annotation.id,
                        startX: event.clientX,
                        startY: event.clientY,
                        origin: annotation.rects,
                      });
                    }}
                  />
                )}
              </div>
            );
          });
      })}

      {drag?.kind === "draw" && (
        <div
          className="annotation-box drawing-preview"
          style={{
            left: Math.min(drag.startX, drag.currentX),
            top: Math.min(drag.startY, drag.currentY),
            width: Math.abs(drag.currentX - drag.startX),
            height: Math.abs(drag.currentY - drag.startY),
            borderColor: drawingType ? ANNOTATION_COLOURS[drawingType] : "#333",
          }}
        />
      )}
    </div>
  );
}
