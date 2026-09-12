/**
 * Fuzzy membership curve shapes — pure math, no state. Mirrors the exact
 * breakpoints in firmware/sonar_tx/sonar_tx.ino's fuzzify() (and
 * backend/src/fuzzy-simulator.ts), used only to DRAW the membership functions
 * (so the "adaptive logic" panel can show *why* a reading maps to a given
 * degree, not just the resulting number). The degrees themselves always come
 * from the device's own telemetry — this file never computes a value that's
 * presented as measured.
 */

export const ADC_MAX = 4095;
export const ADC_DOMAIN = { min: 0, max: ADC_MAX };

/** Same breakpoints as firmware's fuzzify(): a left shoulder, a centered triangle, a right shoulder. */
const BREAKPOINTS = { loLo: -2048, loHi: 0, midPeak: 2048, hiLo: 4095, hiHi: 6143 };

function triangularMF(x: number, a: number, b: number, c: number): number {
  if (x <= a || x >= c) return 0;
  if (x === b) return 1;
  return x < b ? (x - a) / (b - a) : (c - x) / (c - b);
}

export function fuzzify(value: number): { low: number; med: number; high: number } {
  return {
    low: triangularMF(value, BREAKPOINTS.loLo, BREAKPOINTS.loHi, BREAKPOINTS.midPeak),
    med: triangularMF(value, BREAKPOINTS.loHi, BREAKPOINTS.midPeak, BREAKPOINTS.hiLo),
    high: triangularMF(value, BREAKPOINTS.midPeak, BREAKPOINTS.hiLo, BREAKPOINTS.hiHi),
  };
}

export type MembershipKey = 'low' | 'med' | 'high';

/** The three curve shapes as SVG polyline points, over the visible 0..ADC_MAX domain, y in 0..1. */
export const MEMBERSHIP_CURVES: Record<MembershipKey, [number, number][]> = {
  low: [[0, 1], [BREAKPOINTS.midPeak, 0]],
  med: [[0, 0], [BREAKPOINTS.midPeak, 1], [BREAKPOINTS.hiLo, 0]],
  high: [[BREAKPOINTS.midPeak, 0], [BREAKPOINTS.hiLo, 1]],
};
