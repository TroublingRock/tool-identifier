/** Re-export builtins for callers that historically imported HOLDER_PRESETS. */
export { BUILTIN_HOLDER_PRESETS as HOLDER_PRESETS } from './holderPresets'

/** Minimum drop from local max before a peak counts (filters camera/hand jitter). */
export const PEAK_DROP_PX = 10
/** Minimum rise from trough before entering climb. */
export const MIN_RISE_PX = 6
/** Ignore new peaks closer than this (hand wobble makes fast false cycles). */
export const MIN_PEAK_INTERVAL_MS = 500
/** Spindle mode: collect max silhouette width for this long after arm delay. */
export const SPINDLE_SAMPLE_MS = 2500
/** Settle time after Arm before peaks/samples count. */
export const ARM_SETTLE_MS = 1500
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
 * Scan along the tool axis and count distinct diameter lands/steps.
 * orientation 'vertical': tip up/down (scan Y, diameter along X).
 * orientation 'horizontal': tip left/right (scan X, diameter along Y).
 */
export function analyzeSilhouetteSteps(
  imageData,
  {
    orientation = 'vertical',
    centerX,
    centerY,
    yStart,
    yEnd,
    xStart,
    xEnd,
    bandHalfWidth = 140,
    threshold = 95,
    minLandRows = 4,
    minStepDeltaPx = 10,
  } = {},
) {
  const { data, width, height } = imageData

  const widths = []
  let depthPx = 0

  if (orientation === 'horizontal') {
    const left = Math.max(0, Math.round(Math.min(xStart, xEnd)))
    const right = Math.min(width - 1, Math.round(Math.max(xStart, xEnd)))
    const cy = Math.round(centerY ?? height / 2)
    const y0 = Math.max(0, cy - bandHalfWidth)
    const y1 = Math.min(height - 1, cy + bandHalfWidth)
    depthPx = Math.max(0, right - left)
    for (let x = left; x <= right; x += 1) {
      let top = -1
      let bottom = -1
      for (let y = y0; y <= y1; y += 1) {
        const i = (y * width + x) * 4
        const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
        if (lum < threshold) {
          if (top < 0) top = y
          bottom = y
        }
      }
      const span = top >= 0 ? bottom - top + 1 : 0
      if (span >= 4) widths.push(span)
    }
  } else {
    const top = Math.max(0, Math.round(Math.min(yStart, yEnd)))
    const bottom = Math.min(height - 1, Math.round(Math.max(yStart, yEnd)))
    const cx = Math.round(centerX ?? width / 2)
    const x0 = Math.max(0, cx - bandHalfWidth)
    const x1 = Math.min(width - 1, cx + bandHalfWidth)
    depthPx = Math.max(0, bottom - top)
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
  }

  if (widths.length < minLandRows * 2) {
    return {
      detectedStepCount: 0,
      landCount: 0,
      lands: [],
      maxWidthPx: 0,
      minWidthPx: 0,
      depthPx,
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
    depthPx,
  }
}

/**
 * Measure tool diameter inside a crop: span across the tool (perpendicular to tip).
 * acrossAxis 'x' = tip up/down (horizontal pixel width).
 * acrossAxis 'y' = tip left/right (vertical pixel height).
 */
export function measureSilhouetteDiameter(imageData, acrossAxis = 'x', threshold = 95) {
  const { data, width, height } = imageData
  let maxSpan = 0

  if (acrossAxis === 'x') {
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
      if (left >= 0) maxSpan = Math.max(maxSpan, right - left + 1)
    }
    return maxSpan
  }

  for (let x = 0; x < width; x += 1) {
    let top = -1
    let bottom = -1
    for (let y = 0; y < height; y += 1) {
      const i = (y * width + x) * 4
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      if (lum < threshold) {
        if (top < 0) top = y
        bottom = y
      }
    }
    if (top >= 0) maxSpan = Math.max(maxSpan, bottom - top + 1)
  }
  return maxSpan
}

/** @deprecated prefer measureSilhouetteDiameter */
export function measureSilhouetteWidth(imageData, threshold = 95) {
  return measureSilhouetteDiameter(imageData, 'x', threshold)
}

function clamp01(n) {
  return Math.min(0.96, Math.max(0.02, n))
}

function sampleSpanAt(
  data,
  cw,
  ch,
  alongPos,
  crossCenter,
  tipDir,
  bandHalf,
  threshold,
) {
  let a0 = -1
  let a1 = -1
  if (tipDir === 'up' || tipDir === 'down') {
    const y = Math.round(alongPos)
    const x0 = Math.max(0, Math.round(crossCenter - bandHalf))
    const x1 = Math.min(cw - 1, Math.round(crossCenter + bandHalf))
    if (y < 0 || y >= ch) return null
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * cw + x) * 4
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      if (lum < threshold) {
        if (a0 < 0) a0 = x
        a1 = x
      }
    }
  } else {
    const x = Math.round(alongPos)
    const y0 = Math.max(0, Math.round(crossCenter - bandHalf))
    const y1 = Math.min(ch - 1, Math.round(crossCenter + bandHalf))
    if (x < 0 || x >= cw) return null
    for (let y = y0; y <= y1; y += 1) {
      const i = (y * cw + x) * 4
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      if (lum < threshold) {
        if (a0 < 0) a0 = y
        a1 = y
      }
    }
  }
  if (a0 < 0) return null
  return { span: a1 - a0 + 1, mid: (a0 + a1) / 2, a0, a1 }
}

/**
 * Detect which way the tool sticks out from the green collet box, then place
 * red/blue/yellow overlays along that axis (vertical or horizontal mills).
 */
export function proposeZonesFromSilhouette(
  imageData,
  greenBoxNorm,
  {
    threshold = 95,
    tipDir: forcedTipDir = null,
    bandHalfWidth = 180,
    minSpanPx = 8,
  } = {},
) {
  const { data, width: cw, height: ch } = imageData
  if (!cw || !ch) return null

  const gx = greenBoxNorm.x * cw
  const gy = greenBoxNorm.y * ch
  const gw = Math.max(1, greenBoxNorm.w * cw)
  const gh = Math.max(1, greenBoxNorm.h * ch)
  const cx = gx + gw / 2
  const cy = gy + gh / 2

  const candidates = forcedTipDir
    ? [forcedTipDir]
    : ['up', 'down', 'left', 'right']

  let best = null
  for (const tipDir of candidates) {
    const horizontal = tipDir === 'left' || tipDir === 'right'
    const crossCenter = horizontal ? cy : cx
    let start
    let limit
    let step
    if (tipDir === 'up') {
      start = gy
      limit = Math.round(ch * 0.02)
      step = -1
    } else if (tipDir === 'down') {
      start = gy + gh
      limit = Math.round(ch * 0.98)
      step = 1
    } else if (tipDir === 'left') {
      start = gx
      limit = Math.round(cw * 0.02)
      step = -1
    } else {
      start = gx + gw
      limit = Math.round(cw * 0.98)
      step = 1
    }

    const rows = []
    for (
      let along = Math.round(start) + step;
      step < 0 ? along >= limit : along <= limit;
      along += step
    ) {
      const hit = sampleSpanAt(
        data,
        cw,
        ch,
        along,
        crossCenter,
        tipDir,
        bandHalfWidth,
        threshold,
      )
      if (hit && hit.span >= minSpanPx) {
        rows.push({ along, ...hit })
      } else if (rows.length > 8) {
        let empty = 0
        let peek = along + step
        while (empty < 6 && (step < 0 ? peek >= limit : peek <= limit)) {
          const again = sampleSpanAt(
            data,
            cw,
            ch,
            peek,
            crossCenter,
            tipDir,
            bandHalfWidth,
            threshold,
          )
          if (again && again.span >= minSpanPx) {
            rows.push({ along: peek, ...again })
            along = peek
            break
          }
          empty += 1
          peek += step
        }
        if (empty >= 6) break
      }
    }

    if (rows.length < 12) continue
    const score =
      rows.length *
      (1 + rows.reduce((s, r) => s + r.span, 0) / rows.length / 100)
    if (!best || score > best.score) {
      best = { tipDir, horizontal, rows, score, crossCenter }
    }
  }

  if (!best) return null

  const { tipDir, horizontal, rows } = best
  const smooth = rows.map((row, i) => {
    const a = rows[Math.max(0, i - 2)].span
    const b = rows[Math.max(0, i - 1)].span
    const c = row.span
    const d = rows[Math.min(rows.length - 1, i + 1)].span
    const e = rows[Math.min(rows.length - 1, i + 2)].span
    return (a + b + c + d + e) / 5
  })

  let maxIdx = 0
  for (let i = 1; i < smooth.length; i += 1) {
    if (smooth[i] > smooth[maxIdx]) maxIdx = i
  }
  const tipBand = Math.max(6, Math.floor(rows.length * 0.12))
  let majorIdx = maxIdx
  if (maxIdx < tipBand) {
    let bestIdx = tipBand
    for (let i = tipBand; i < smooth.length; i += 1) {
      if (smooth[i] >= smooth[bestIdx]) bestIdx = i
    }
    majorIdx = bestIdx
  }

  const tipSlice = smooth.slice(0, Math.max(tipBand, 4))
  const tipWidth =
    tipSlice.reduce((s, v) => s + v, 0) / Math.max(1, tipSlice.length)
  const major = rows[majorIdx]
  const tip = rows[0]
  const axisMid =
    rows.reduce((s, r) => s + r.mid, 0) / rows.length || best.crossCenter

  const orientation = horizontal ? 'horizontal' : 'vertical'
  const acrossPx = smooth[majorIdx]
  const alongNorm = (v) => (horizontal ? v / cw : v / ch)
  const crossNorm = axisMid / (horizontal ? ch : cw)

  const boxAlong = Math.max(
    0.06,
    Math.min(0.11, (acrossPx * 0.35) / (horizontal ? cw : ch)),
  )
  const boxAcross = Math.min(
    0.72,
    Math.max(0.16, (acrossPx * 1.28) / (horizontal ? ch : cw)),
  )
  const tipAcross = Math.min(
    0.55,
    Math.max(0.12, (tipWidth * 1.35) / (horizontal ? ch : cw)),
  )

  let red
  let blue
  if (horizontal) {
    const redX = clamp01(alongNorm(major.along) - boxAlong / 2)
    const blueX = clamp01(alongNorm(tip.along) - boxAlong / 2)
    const redY = clamp01(crossNorm - boxAcross / 2)
    const blueY = clamp01(crossNorm - tipAcross / 2)
    red = {
      x: redX,
      y: redY,
      w: Math.min(boxAlong, 0.96 - redX),
      h: Math.min(boxAcross, 0.96 - redY),
    }
    blue = {
      x: blueX,
      y: blueY,
      w: Math.min(boxAlong * 0.95, 0.96 - blueX),
      h: Math.min(tipAcross, 0.96 - blueY),
    }
  } else {
    const redY = clamp01(alongNorm(major.along) - boxAlong / 2)
    const blueY = clamp01(alongNorm(tip.along) - boxAlong / 2)
    const redX = clamp01(crossNorm - boxAcross / 2)
    const blueX = clamp01(crossNorm - tipAcross / 2)
    red = {
      x: redX,
      y: redY,
      w: Math.min(boxAcross, 0.96 - redX),
      h: Math.min(boxAlong, 0.96 - redY),
    }
    blue = {
      x: blueX,
      y: blueY,
      w: Math.min(tipAcross, 0.96 - blueX),
      h: Math.min(boxAlong * 0.9, 0.96 - blueY),
    }
  }

  const yellow = {
    orientation,
    tipDir,
    cross: clamp01(crossNorm),
    shoulder: clamp01(alongNorm(major.along)),
    tip: clamp01(alongNorm(tip.along)),
    x: clamp01(crossNorm),
    y: clamp01(crossNorm),
    yShoulder: horizontal
      ? clamp01(crossNorm)
      : clamp01(alongNorm(major.along)),
    yTip: horizontal ? clamp01(crossNorm) : clamp01(alongNorm(tip.along)),
    xShoulder: horizontal
      ? clamp01(alongNorm(major.along))
      : clamp01(crossNorm),
    xTip: horizontal ? clamp01(alongNorm(tip.along)) : clamp01(crossNorm),
  }

  return {
    red,
    blue,
    yellow,
    tipDir,
    orientation,
    diameterAxis: horizontal ? 'y' : 'x',
    meta: {
      rowCount: rows.length,
      majorWidthPx: smooth[majorIdx],
      tipWidthPx: tipWidth,
      tipDir,
      orientation,
    },
  }
}

/**
 * Best-of-N rotation peak tracker (hand-spin).
 * Stricter drop/rise + min interval reject shaky false rotations.
 */
export function createPeakTracker({
  dropPx = PEAK_DROP_PX,
  minPeakPx = 12,
  minRisePx = MIN_RISE_PX,
  minIntervalMs = MIN_PEAK_INTERVAL_MS,
} = {}) {
  let peak = 0
  let trough = Infinity
  /** @type {'seek'|'climb'|'fall'} */
  let phase = 'seek'
  let lastCommitAt = 0
  const peaks = []

  return {
    reset() {
      peak = 0
      trough = Infinity
      phase = 'seek'
      lastCommitAt = 0
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
    push(widthPx, nowMs = performance.now()) {
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
          const okInterval =
            !lastCommitAt || nowMs - lastCommitAt >= minIntervalMs
          phase = 'fall'
          trough = widthPx
          if (!okInterval) {
            return { committedPeak: null, peak, phase }
          }
          lastCommitAt = nowMs
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

/** Simple EMA to calm silhouette width jitter before peak detection. */
export function createWidthSmoother(alpha = 0.35) {
  let value = null
  return {
    reset() {
      value = null
    },
    push(raw) {
      if (value == null) value = raw
      else value = alpha * raw + (1 - alpha) * value
      return value
    },
    get value() {
      return value
    },
  }
}
