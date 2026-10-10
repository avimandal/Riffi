import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { Icon } from './Icon';

const HOLD_MS = 3000;

/** "Hold for 3 seconds" + a simple sum. Keeps little fingers out of the parent area. */
export function ParentGate({ onPass }: { onPass: () => void }) {
  const [stage, setStage] = useState<'hold' | 'sum'>('hold');
  const [progress, setProgress] = useState(0);
  const [answer, setAnswer] = useState('');
  const [nope, setNope] = useState(false);
  const [sum] = useState(() => ({ a: 6 + Math.floor(Math.random() * 7), b: 5 + Math.floor(Math.random() * 8) }));
  const start = useRef<number | null>(null);
  const raf = useRef(0);

  const stop = () => {
    start.current = null;
    cancelAnimationFrame(raf.current);
    setProgress(0);
  };
  const begin = () => {
    start.current = performance.now();
    const frame = (now: number) => {
      if (start.current === null) return;
      const p = Math.min(1, (now - start.current) / HOLD_MS);
      setProgress(p);
      if (p >= 1) {
        start.current = null;
        setStage('sum');
      } else raf.current = requestAnimationFrame(frame);
    };
    raf.current = requestAnimationFrame(frame);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  if (stage === 'hold') {
    return (
      <div className="card stack" style={{ alignItems: 'center', textAlign: 'center' }}>
        <h1>{t.parent.gateTitle}</h1>
        <button
          className="btn big primary"
          style={{ position: 'relative', overflow: 'hidden', minWidth: 280 }}
          onPointerDown={begin}
          onPointerUp={stop}
          onPointerLeave={stop}
          onPointerCancel={stop}
          onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && !e.repeat && start.current === null && begin()}
          onKeyUp={stop}
          onContextMenu={(e) => e.preventDefault()}
          data-testid="parent-hold"
        >
          <span
            aria-hidden
            style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,0.3)', transformOrigin: 'left', transform: `scaleX(${progress})` }}
          />
          <Icon name="lock" filled />
          <span style={{ position: 'relative' }}>{progress > 0 ? t.parent.gateHolding : t.parent.gateHold}</span>
        </button>
      </div>
    );
  }
  return (
    <form
      className="card stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (Number(answer) === sum.a + sum.b) onPass();
        else {
          setNope(true);
          setAnswer('');
        }
      }}
    >
      <h1>{t.parent.gateTitle}</h1>
      <div className="field">
        <label htmlFor="gate-answer">{t.parent.gateQuestion(sum.a, sum.b)}</label>
        <input id="gate-answer" type="number" inputMode="numeric" value={answer} onChange={(e) => setAnswer(e.target.value)} autoFocus data-testid="parent-answer" />
      </div>
      {nope && (
        <p className="notice warn" role="alert">
          {t.parent.gateNope}
        </p>
      )}
      <button className="btn primary big" type="submit">
        {t.parent.gateCheck}
      </button>
    </form>
  );
}
