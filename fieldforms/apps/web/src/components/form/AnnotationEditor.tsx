import { useEffect, useRef, useState } from 'react';

type Tool = 'pen' | 'arrow' | 'text';
const COLOURS = ['#e53e3e', '#f6e05e', '#ffffff', '#1a202c'];
const MAX_SIDE = 1600;

/**
 * Draws on a transparent layer over a photo: freehand, arrows and text. The photo itself is never
 * changed; the layer is saved as its own PNG and shown on top of the original wherever it is viewed.
 */
export function AnnotationEditor({
  imageUrl,
  layerUrl,
  onSave,
  onCancel,
}: {
  imageUrl: string;
  /** An earlier layer to keep drawing on. */
  layerUrl?: string | null;
  onSave(layer: Blob): void;
  onCancel(): void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>('pen');
  const [colour, setColour] = useState(COLOURS[0]!);
  const [ready, setReady] = useState(false);
  const history = useRef<ImageData[]>([]);
  const drawing = useRef<{ x: number; y: number; snapshot: ImageData } | null>(null);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const c = canvas.current!;
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      c.width = Math.round(img.naturalWidth * scale);
      c.height = Math.round(img.naturalHeight * scale);
      if (layerUrl) {
        const layer = new Image();
        layer.onload = () => {
          c.getContext('2d')!.drawImage(layer, 0, 0, c.width, c.height);
          setReady(true);
        };
        layer.onerror = () => setReady(true);
        layer.src = layerUrl;
      } else setReady(true);
    };
    img.src = imageUrl;
  }, [imageUrl, layerUrl]);

  const ctx = () => canvas.current!.getContext('2d')!;
  const point = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.current!.width,
      y: ((e.clientY - r.top) / r.height) * canvas.current!.height,
    };
  };
  const width = () => Math.max(3, canvas.current!.width / 150);
  const remember = () => {
    const c = canvas.current!;
    history.current.push(ctx().getImageData(0, 0, c.width, c.height));
    if (history.current.length > 20) history.current.shift();
  };

  function arrow(x1: number, y1: number, x2: number, y2: number) {
    const g = ctx();
    const head = width() * 5;
    const angle = Math.atan2(y2 - y1, x2 - x1);
    g.strokeStyle = colour;
    g.fillStyle = colour;
    g.lineWidth = width();
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.stroke();
    g.beginPath();
    g.moveTo(x2, y2);
    g.lineTo(x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7));
    g.lineTo(x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7));
    g.closePath();
    g.fill();
  }

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!ready) return;
    const p = point(e);
    if (tool === 'text') {
      const text = prompt('Text to add');
      if (!text) return;
      remember();
      const g = ctx();
      const size = Math.max(16, canvas.current!.width / 22);
      g.font = `bold ${size}px system-ui, sans-serif`;
      g.lineWidth = size / 6;
      g.strokeStyle = colour === '#1a202c' ? '#ffffff' : '#1a202c';
      g.strokeText(text, p.x, p.y);
      g.fillStyle = colour;
      g.fillText(text, p.x, p.y);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    remember();
    const c = canvas.current!;
    drawing.current = { ...p, snapshot: ctx().getImageData(0, 0, c.width, c.height) };
    if (tool === 'pen') {
      const g = ctx();
      g.strokeStyle = colour;
      g.lineWidth = width();
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      g.moveTo(p.x, p.y);
    }
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    const d = drawing.current;
    if (!d) return;
    const p = point(e);
    if (tool === 'pen') {
      ctx().lineTo(p.x, p.y);
      ctx().stroke();
    } else if (tool === 'arrow') {
      ctx().putImageData(d.snapshot, 0, 0);
      arrow(d.x, d.y, p.x, p.y);
    }
  }

  function up() {
    drawing.current = null;
  }

  function undo() {
    const last = history.current.pop();
    if (last) ctx().putImageData(last, 0, 0);
  }

  return (
    <div className="modal" role="dialog" aria-label="Mark up photo">
      <div className="annotate-toolbar">
        {(['pen', 'arrow', 'text'] as Tool[]).map((t) => (
          <button
            key={t}
            className={tool === t ? 'active' : 'secondary'}
            onClick={() => setTool(t)}
          >
            {t === 'pen' ? 'Draw' : t === 'arrow' ? 'Arrow' : 'Text'}
          </button>
        ))}
        {COLOURS.map((c) => (
          <button
            key={c}
            className={`swatch${colour === c ? ' on' : ''}`}
            style={{ background: c }}
            aria-label={`Colour ${c}`}
            onClick={() => setColour(c)}
          />
        ))}
        <button className="secondary" onClick={undo}>
          Undo
        </button>
      </div>
      <div className="annotate-stage">
        <img src={imageUrl} alt="" />
        <canvas
          ref={canvas}
          data-testid="annotation-canvas"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
        />
      </div>
      <div className="annotate-toolbar">
        <button className="secondary" onClick={onCancel}>
          Cancel
        </button>
        <button
          disabled={!ready}
          onClick={() => canvas.current!.toBlob((b) => b && onSave(b), 'image/png')}
        >
          Save markup
        </button>
      </div>
    </div>
  );
}
