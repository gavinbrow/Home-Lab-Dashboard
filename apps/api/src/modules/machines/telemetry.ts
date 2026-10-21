/** Pure calculations; network payloads are validated by @homelab/contracts. */
export function counterRate(
  previous: number | null,
  current: number | null,
  elapsedSeconds: number,
  sameBoot: boolean,
  maximumGapSeconds = 120,
): number | null {
  if (!sameBoot || previous === null || current === null ||
      !Number.isFinite(previous) || !Number.isFinite(current) ||
      previous < 0 || current < previous || !Number.isFinite(elapsedSeconds) ||
      elapsedSeconds <= 0 || elapsedSeconds > maximumGapSeconds) return null;
  const rate = (current - previous) / elapsedSeconds;
  return Number.isFinite(rate) ? rate : null;
}

/** Age uses the older clock so a future host timestamp cannot hide old receipt data. */
export function observationAgeMs(observedAt: string, receivedAt: string, now = Date.now()): number | null {
  const observed = Date.parse(observedAt);
  const received = Date.parse(receivedAt);
  if (!Number.isFinite(observed) || !Number.isFinite(received) || !Number.isFinite(now)) return null;
  return Math.max(0, now - Math.min(observed, received));
}

export function summarizeValues(values: readonly (number | null)[]) {
  const available = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (available.length === 0) return { min: null, max: null, mean: null, count: 0, missing: values.length };
  // Incremental mean avoids overflowing a sum of valid large observations.
  let mean = 0;
  for (let i = 0; i < available.length; i++) mean = mean * (i / (i + 1)) + available[i]! / (i + 1);
  return {
    min: available.reduce((a, b) => Math.min(a, b)), max: available.reduce((a, b) => Math.max(a, b)), mean,
    count: available.length, missing: values.length - available.length,
  };
}
