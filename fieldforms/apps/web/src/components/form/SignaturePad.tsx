import { useRef, useState } from 'react';

/** A finger or stylus signature, saved as a transparent PNG. */
export function SignaturePad({ onSave, onCancel }: { onSave(png: Blob): void; onCancel(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);

  const point = (e: React.PointerEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return {
      x: ((e.clientX - r.left) / r.width) * canvas.current!.width,
      y: ((e.clientY - r.top) / r.height) * canvas.current!.height,
    };
  };

  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    last.current = point(e);
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!last.current) return;
    const p = point(e);
    const g = canvas.current!.getContext('2d')!;
    g.strokeStyle = '#1a202c';
    g.lineWidth = 3;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(last.current.x, last.current.y);
    g.lineTo(p.x, p.y);
    g.stroke();
    last.current = p;
    setEmpty(false);
  }

  function clear() {
    const c = canvas.current!;
    c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
    setEmpty(true);
  }

  return (
    <div className="signature">
      <canvas
        ref={canvas}
        width={700}
        height={240}
        data-testid="signature-canvas"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => (last.current = null)}
        onPointerCancel={() => (last.current = null)}
      />
      <div className="row">
        <span className="muted small">Sign above</span>
        <span>
          <button type="button" className="link" onClick={clear}>
            Clear
          </button>
          <button type="button" className="link" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={empty}
            onClick={() => canvas.current!.toBlob((b) => b && onSave(b), 'image/png')}
          >
            Save signature
          </button>
        </span>
      </div>
    </div>
  );
}
