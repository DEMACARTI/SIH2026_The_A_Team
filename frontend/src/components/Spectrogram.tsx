import { useEffect, useRef, type ReactNode } from 'react';
import { useStore } from '../store';
import p from './panels.module.css';

/** Pale → cyan → deep teal, matching the console's signal accent on a light ground. Returns [r,g,b]. */
function magnitudeColor(v: number): [number, number, number] {
  const t = v / 255;
  if (t < 0.6) {
    const k = t / 0.6;
    return [Math.round(232 + k * (30 - 232)), Math.round(238 + k * (176 - 238)), Math.round(242 + k * (164 - 242))];
  }
  const k = (t - 0.6) / 0.4;
  return [Math.round(30 + k * (4 - 30)), Math.round(176 + k * (44 - 176)), Math.round(164 + k * (58 - 164))];
}

/**
 * Time (x) vs. frequency (y) heatmap of the transmitted signal's real spectral
 * content — from an on-device FFT of an ADC loopback of the DAC output (see
 * firmware's ENABLE_SPECTROGRAM_MONITOR), validating the actual analog wave,
 * not the digital buffer that generated it. Empty until that hardware exists.
 */
export function SpectrogramPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spec = useStore((st) => st.lastBurst?.spectrogram);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !spec) return;
    const nFrames = spec.frames.length;
    const nBins = spec.frames[0]?.length ?? 0;
    if (nFrames === 0 || nBins === 0) return;
    canvas.width = nFrames;
    canvas.height = nBins;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(nFrames, nBins);
    for (let f = 0; f < nFrames; f++) {
      for (let b = 0; b < nBins; b++) {
        const [r, g, bl] = magnitudeColor(spec.frames[f][b]);
        // Flip vertically: bin 0 (DC) at the bottom, like a real spectrum analyzer.
        const row = nBins - 1 - b;
        const idx = (row * nFrames + f) * 4;
        img.data[idx] = r; img.data[idx + 1] = g; img.data[idx + 2] = bl; img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [spec]);

  if (!spec) {
    return (
      <Panel>
        <div className={p.empty}>
          awaiting the DAC→ADC loopback hardware — see <code>ENABLE_SPECTROGRAM_MONITOR</code> in the firmware.
          Once wired, an on-device FFT of the real transmitted wave appears here.
        </div>
      </Panel>
    );
  }

  const nBins = spec.frames[0]?.length ?? 0;
  const maxHz = spec.freq_step_hz * nBins;
  const totalMs = spec.frame_step_ms * spec.frames.length;

  return (
    <Panel meta={`${(spec.freq_step_hz).toFixed(0)}Hz/bin · ${spec.frame_step_ms.toFixed(1)}ms/frame`}>
      <div className={p.spectrogramWrap}>
        <canvas ref={canvasRef} className={p.spectrogramCanvas} />
        <div className={p.spectrogramYAxis}>
          <span>{(maxHz / 1000).toFixed(0)}kHz</span>
          <span>{(maxHz / 2000).toFixed(0)}kHz</span>
          <span>0</span>
        </div>
      </div>
      <div className={p.spectrogramXAxis}>
        <span>0ms</span>
        <span>{totalMs.toFixed(0)}ms</span>
      </div>
    </Panel>
  );
}

function Panel({ meta, children }: { meta?: string; children: ReactNode }) {
  return (
    <div className={p.formation}>
      <div className={p.formationHead}>
        <span>Transmitted-signal spectrogram (real FFT, from ADC loopback)</span>
        {meta && <span className={p.dim}>{meta}</span>}
      </div>
      {children}
    </div>
  );
}
