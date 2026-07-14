/** Re-export builtins for callers that historically imported HOLDER_PRESETS. */
export { BUILTIN_HOLDER_PRESETS as HOLDER_PRESETS } from './holderPresets'

export const PEAK_DROP_PX = 3
export const MATCH_TOLERANCE_IN = 0.03
export const SPOTFACE_TOLERANCE_IN = 0.03
export const PILOT_TOLERANCE_IN = 0.02
/** Depth / major-diameter ratio that suggests a deep cartridge cavity. */
export const CAVITY_DEPTH_RATIO = 1.75

/**
 * Flute correction:
 * 2-flute / 4-flute → measured width is true diameter
 * 3-flute → true diameter = measured width / 0.866
 */
export function applyFluteCorrection(measuredInches, flutes) {
  if (Number(flutes) === 3) return measuredInches / 0.866
  return measuredInches
}

export function pixelsToInches(peakPixels, referencePixelWidth, referenceInches) {
  if (!referencePixelWidth || !referenceInches) return null
  return (peakPixels / referencePixelWidth) * referenceInches
}

export function avg(nums) {
  if (!nums?.length) return null
  return nums.reduce((a, b) => a + b, 0) / nums.length
}

/**
 * Dual-diameter + step-aware Port Form Classifier.
 * Deep/multi-step tools filter to cartridge cavity classes (C08–C16).
 */
export function matchPortForm({
  measuredSpotface,
  measuredPilot,
  measuredDepth = null,
  detectedStepCount = 1,
  formSizes,
  spotTolerance = SPOTFACE_TOLERANCE_IN,
  pilotTolerance = PILOT_TOLERANCE_IN,
}) {
  if (
    measuredSpotface == null ||
    measuredPilot == null ||
    Number.isNaN(measuredSpotface) ||
    Number.isNaN(measuredPilot)
  ) {
    return {
      match: null,
      nearest: null,
      candidates: [],
      searchMode: 'shallow',
      isComplexCavity: false,
      depthRatio: 0,
    }
  }

  const depthRatio =
    measuredDepth && measuredSpotface > 0
      ? measuredDepth / measuredSpotface
      : 0
  const isComplexCavity =
    detectedStepCount >= 3 || depthRatio >= CAVITY_DEPTH_RATIO
  const searchMode = isComplexCavity ? 'cartridge' : 'shallow'

  const pool = (formSizes || []).filter((row) => {
    const category = row.form_category || 'shallow'
    const blob = `${row.code || ''} ${row.size_token || ''} ${row.cavity_class || ''} ${row.short_name || ''} ${row.standard_name || ''}`
    const looksCartridge =
      category === 'cartridge' || /C0[89]|C1[026]|C16/i.test(blob)

    if (searchMode === 'cartridge') return looksCartridge
    return !looksCartridge
  })

  const scored = pool.map((row) => {
    const maxDia = Number(row.max_diameter ?? row.spotface_diameter)
    const pilotDia = Number(row.pilot_diameter)
    const spotDelta = Math.abs(maxDia - measuredSpotface)
    const pilotDelta = Math.abs(pilotDia - measuredPilot)
    let depthDelta = 0
    if (
      measuredDepth != null &&
      row.functional_depth != null &&
      Number(row.functional_depth) > 0
    ) {
      depthDelta = Math.abs(Number(row.functional_depth) - measuredDepth)
    }
    const stepDelta =
      row.step_count != null
        ? Math.abs(Number(row.step_count) - detectedStepCount)
        : 0

    const within =
      spotDelta <= spotTolerance &&
      pilotDelta <= pilotTolerance &&
      (searchMode === 'shallow' || stepDelta <= 1 || row.step_count == null)

    const score =
      spotDelta * 1.2 +
      pilotDelta * 1.5 +
      depthDelta * 0.35 +
      stepDelta * 0.08

    return {
      ...row,
      spotDelta,
      pilotDelta,
      depthDelta,
      stepDelta,
      score,
      withinTolerance: within,
      max_diameter: maxDia,
    }
  })

  scored.sort((a, b) => a.score - b.score)
  const best = scored[0] || null
  const within = scored.filter((r) => r.withinTolerance)

  return {
    match: within[0] || null,
    nearest: best,
    candidates: within.slice(0, 5),
    searchMode,
    isComplexCavity,
    depthRatio,
  }
}

/**
 * Scan a vertical band and count distinct diameter lands/steps.
 * Scan from holder face toward tip (yStart → yEnd).
 */
export function analyzeSilhouetteSteps(
  imageData,
  {
    centerX,
    yStart,
    yEnd,
    bandHalfWidth = 140,
    threshold = 95,
    minLandRows = 4,
    minStepDeltaPx = 10,
  } = {},
) {
  const { data, width, height } = imageData
  const top = Math.max(0, Math.round(Math.min(yStart, yEnd)))
  const bottom = Math.min(height - 1, Math.round(Math.max(yStart, yEnd)))
  const x0 = Math.max(0, Math.round(centerX - bandHalfWidth))
  const x1 = Math.min(width - 1, Math.round(centerX + bandHalfWidth))

  const widths = []
  for (let y = top; y <= bottom; y += 1) {
    let left = -1
    let right = -1
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * width + x) * 4
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      if (lum < threshold) {
        if (left < 0) left = x
        right = x
      }
    }
    const span = left >= 0 ? right - left + 1 : 0
    if (span >= 4) widths.push(span)
  }

  if (widths.length < minLandRows * 2) {
    return {
      detectedStepCount: 0,
      landCount: 0,
      lands: [],
      maxWidthPx: 0,
      minWidthPx: 0,
      depthPx: Math.max(0, bottom - top),
    }
  }

  const smooth = widths.map((_, i) => {
    const a = widths[Math.max(0, i - 1)]
    const b = widths[i]
    const c = widths[Math.min(widths.length - 1, i + 1)]
    return (a + b + c) / 3
  })

  const lands = []
  let landStart = 0
  let landSum = smooth[0]
  let landN = 1
  let landMean = smooth[0]

  for (let i = 1; i < smooth.length; i += 1) {
    const w = smooth[i]
    if (Math.abs(w - landMean) < minStepDeltaPx) {
      landSum += w
      landN += 1
      landMean = landSum / landN
    } else {
      if (landN >= minLandRows) {
        lands.push({
          meanWidthPx: landMean,
          rows: landN,
          start: landStart,
          end: i - 1,
        })
      }
      landStart = i
      landSum = w
      landN = 1
      landMean = w
    }
  }
  if (landN >= minLandRows) {
    lands.push({
      meanWidthPx: landMean,
      rows: landN,
      start: landStart,
      end: smooth.length - 1,
    })
  }

  const merged = []
  for (const land of lands) {
    const prev = merged[merged.length - 1]
    if (prev && Math.abs(prev.meanWidthPx - land.meanWidthPx) < minStepDeltaPx) {
      const totalRows = prev.rows + land.rows
      prev.meanWidthPx =
        (prev.meanWidthPx * prev.rows + land.meanWidthPx * land.rows) /
        totalRows
      prev.rows = totalRows
      prev.end = land.end
    } else {
      merged.push({ ...land })
    }
  }

  const detectedStepCount = Math.max(0, merged.length - 1)
  const maxWidthPx = merged.reduce((m, l) => Math.max(m, l.meanWidthPx), 0)
  const minWidthPx = merged.reduce(
    (m, l) => Math.min(m, l.meanWidthPx),
    maxWidthPx || 0,
  )

  return {
    detectedStepCount,
    landCount: merged.length,
    lands: merged,
    maxWidthPx,
    minWidthPx,
    depthPx: Math.max(0, bottom - top),
  }
}

/**
 * Dark silhouette horizontal width (px) inside an ImageData region.
 */
export function measureSilhouetteWidth(imageData, threshold = 95) {
  const { data, width, height } = imageData
  let maxSpan = 0

  for (let y = 0; y < height; y += 1) {
    let left = -1
    let right = -1
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      if (lum < threshold) {
        if (left < 0) left = x
        right = x
      }
    }
    if (left >= 0 && right >= left) {
      maxSpan = Math.max(maxSpan, right - left + 1)
    }
  }

  return maxSpan
}

/**
 * Best-of-N rotation peak tracker.
 */
export function createPeakTracker({
  dropPx = PEAK_DROP_PX,
  minPeakPx = 8,
  minRisePx = 2,
} = {}) {
  let peak = 0
  let trough = Infinity
  /** @type {'seek'|'climb'|'fall'} */
  let phase = 'seek'
  const peaks = []

  return {
    reset() {
      peak = 0
      trough = Infinity
      phase = 'seek'
      peaks.length = 0
    },
    get peaks() {
      return [...peaks]
    },
    get count() {
      return peaks.length
    },
    get currentPeak() {
      return peak
    },
    push(widthPx) {
      if (phase === 'seek') {
        trough = Math.min(trough, widthPx)
        if (widthPx >= trough + minRisePx) {
          phase = 'climb'
          peak = widthPx
        }
        return { committedPeak: null, peak, phase }
      }

      if (phase === 'climb') {
        if (widthPx >= peak) {
          peak = widthPx
          return { committedPeak: null, peak, phase }
        }
        if (peak >= minPeakPx && widthPx <= peak - dropPx) {
          phase = 'fall'
          trough = widthPx
          const committedPeak = peak
          peaks.push(committedPeak)
          return { committedPeak, peak, phase }
        }
        return { committedPeak: null, peak, phase }
      }

      trough = Math.min(trough, widthPx)
      if (widthPx >= trough + minRisePx) {
        phase = 'climb'
        peak = widthPx
      }
      return { committedPeak: null, peak, phase }
    },
  }
}
