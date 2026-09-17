/**
 * Session size classification.
 *
 * The browser conversation view in DSH is not virtualized: every event of a
 * session lives in the page at once, and a long agent turn in a very large
 * session freezes the tab. The sidebar warns before that happens, with a
 * yellow badge once a session is large and a red one once it is dangerous.
 *
 * Pure and dependency-free so it runs under `node --test` without the harness.
 */

/** Default event count from which a session is marked as large. */
export const DEFAULT_WARN_EVENTS = 1500

/** Default event count from which a session is marked as dangerous. */
export const DEFAULT_DANGER_EVENTS = 3000

/**
 * Coerce a threshold to a positive whole number, falling back when it is not one.
 * @param value - raw setting value.
 * @param fallback - value to use when the setting is unusable.
 * @returns a positive integer.
 */
function positiveInt(value, fallback) {
  const n = Math.floor(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/**
 * Normalize the two thresholds so that warn is always below danger.
 *
 * A person may type them in the wrong order; swapping keeps both badges
 * meaningful instead of silently disabling one of them.
 * @param warn - yellow threshold in events.
 * @param danger - red threshold in events.
 * @returns `{ warn, danger }` with `warn < danger`.
 */
export function normalizeThresholds(warn, danger) {
  let w = positiveInt(warn, DEFAULT_WARN_EVENTS)
  let d = positiveInt(danger, DEFAULT_DANGER_EVENTS)
  if (w > d) [w, d] = [d, w]
  if (w === d) d = w + 1
  return { warn: w, danger: d }
}

/**
 * Classify one session by its event count.
 * @param events - logical event count, or undefined when the backend cannot tell.
 * @param warn - yellow threshold in events.
 * @param danger - red threshold in events.
 * @returns `'danger'`, `'warn'`, `'ok'`, or `null` when the size is unknown.
 */
export function sizeLevel(events, warn, danger) {
  if (typeof events !== 'number' || !Number.isFinite(events) || events < 0) return null
  const t = normalizeThresholds(warn, danger)
  if (events >= t.danger) return 'danger'
  if (events >= t.warn) return 'warn'
  return 'ok'
}
