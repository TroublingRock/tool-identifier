import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BUILTIN_HOLDER_PRESETS,
  CUSTOM_OPTION_ID,
  deleteCustomHolder,
  loadAllHolders,
  saveCustomHolder,
} from '../lib/holderPresets'
import {
  ARM_SETTLE_MS,
  PEAK_DROP_PX,
  SPINDLE_SAMPLE_MS,
  applyFluteCorrection,
  analyzeSilhouetteSteps,
  avg,
  createPeakTracker,
  createWidthSmoother,
  matchPortForm,
  measureSilhouetteDiameter,
  pixelsToInches,
  proposeZonesFromSilhouette,
} from '../lib/opticalMeasure'

const DEFAULT_GREEN = { x: 0.22, y: 0.68, w: 0.56, h: 0.12 }
/** Spotface / major — higher on the stepped profile */
const DEFAULT_RED = { x: 0.3, y: 0.34, w: 0.4, h: 0.12 }
/** Pilot / minor — nearer the tip */
const DEFAULT_BLUE = { x: 0.34, y: 0.16, w: 0.32, h: 0.12 }
/** Functional depth line: shoulder → tip (auto-orients with horizontal mills). */
const DEFAULT_YELLOW = {
  orientation: 'vertical',
  tipDir: 'up',
  cross: 0.5,
  shoulder: 0.4,
  tip: 0.12,
  x: 0.5,
  yShoulder: 0.4,
  yTip: 0.12,
  xShoulder: 0.5,
  xTip: 0.5,
  y: 0.5,
}

const DEFAULT_HOLDER =
  BUILTIN_HOLDER_PRESETS.find((h) => h.id === 'er32') || BUILTIN_HOLDER_PRESETS[0]

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

function boxPixels(box, cw, ch) {
  return {
    x: box.x * cw,
    y: box.y * ch,
    w: Math.max(1, box.w * cw),
    h: Math.max(1, box.h * ch),
  }
}

export default function OpticalPresetter({
  formSizes = [],
  onResult,
  saving,
}) {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)
  const streamRef = useRef(null)
  const rafRef = useRef(0)
  const loopRunningRef = useRef(false)
  const redTrackerRef = useRef(createPeakTracker({ dropPx: PEAK_DROP_PX }))
  const spotSmoothRef = useRef(createWidthSmoother(0.3))
  const pilotSmoothRef = useRef(createWidthSmoother(0.3))
  const pilotPeaksRef = useRef([])
  const pilotCycleMaxRef = useRef(0)
  const armReadyAtRef = useRef(0)
  const spindleStartRef = useRef(0)
  const spindleMaxSpotRef = useRef(0)
  const spindleMaxPilotRef = useRef(0)
  const dragRef = useRef(null)

  const greenRef = useRef(DEFAULT_GREEN)
  const redRef = useRef(DEFAULT_RED)
  const blueRef = useRef(DEFAULT_BLUE)
  const yellowRef = useRef(DEFAULT_YELLOW)
  const stepInfoRef = useRef({
    detectedStepCount: 0,
    depthPx: 0,
    landCount: 0,
  })
  const armedRef = useRef(false)
  const frozenRef = useRef(false)
  const holderRef = useRef(DEFAULT_HOLDER)
  const flutesRef = useRef(3)
  const captureModeRef = useRef('spindle')
  const diameterAxisRef = useRef('x')
  const formSizesRef = useRef(formSizes)
  const onResultRef = useRef(onResult)

  const [cameraOn, setCameraOn] = useState(false)
  const [error, setError] = useState('')
  const [holderId, setHolderId] = useState('er32')
  const [customHolders, setCustomHolders] = useState([])
  const [customName, setCustomName] = useState('')
  const [customInches, setCustomInches] = useState('')
  const [holderMsg, setHolderMsg] = useState('')
  const [savingHolder, setSavingHolder] = useState(false)
  const [flutes, setFlutes] = useState(3)
  const [captureMode, setCaptureMode] = useState('spindle')
  const [armed, setArmed] = useState(false)
  const [rotations, setRotations] = useState(0)
  const [liveSpotPx, setLiveSpotPx] = useState(0)
  const [livePilotPx, setLivePilotPx] = useState(0)
  const [consensus, setConsensus] = useState(false)
  const [greenBox, setGreenBox] = useState(DEFAULT_GREEN)
  const [redZone, setRedZone] = useState(DEFAULT_RED)
  const [blueZone, setBlueZone] = useState(DEFAULT_BLUE)
  const [yellowLine, setYellowLine] = useState(DEFAULT_YELLOW)
  const [detectedStepCount, setDetectedStepCount] = useState(0)
  const [tipDirLabel, setTipDirLabel] = useState('up')
  const [result, setResult] = useState(null)
  const [status, setStatus] = useState(
    'Green = holder. Red = spotface. Blue = pilot. Yellow = cutting depth (shoulder→tip). Prefer spindle mode at ~500 RPM.',
  )

  const allHolders = useMemo(
    () => [...BUILTIN_HOLDER_PRESETS, ...customHolders],
    [customHolders],
  )

  useEffect(() => {
    let cancelled = false
    loadAllHolders().then(({ customs }) => {
      if (!cancelled) setCustomHolders(customs)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    greenRef.current = greenBox
  }, [greenBox])
  useEffect(() => {
    redRef.current = redZone
  }, [redZone])
  useEffect(() => {
    blueRef.current = blueZone
  }, [blueZone])
  useEffect(() => {
    yellowRef.current = yellowLine
  }, [yellowLine])
  useEffect(() => {
    armedRef.current = armed
  }, [armed])
  useEffect(() => {
    flutesRef.current = flutes
  }, [flutes])
  useEffect(() => {
    captureModeRef.current = captureMode
  }, [captureMode])
  useEffect(() => {
    formSizesRef.current = formSizes
  }, [formSizes])
  useEffect(() => {
    onResultRef.current = onResult
  }, [onResult])
  useEffect(() => {
    if (holderId === CUSTOM_OPTION_ID) return
    holderRef.current =
      allHolders.find((h) => h.id === holderId) || DEFAULT_HOLDER
  }, [holderId, allHolders])

  useEffect(() => {
    return () => {
      cancelAnimationFrame(rafRef.current)
      loopRunningRef.current = false
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  async function handleSaveCustomHolder() {
    setHolderMsg('')
    setSavingHolder(true)
    try {
      const { holder, remoteError } = await saveCustomHolder({
        name: customName,
        inches: customInches,
      })
      const { customs } = await loadAllHolders()
      setCustomHolders(customs)
      setHolderId(holder.id)
      holderRef.current = holder
      setCustomName('')
      setCustomInches('')
      setHolderMsg(
        remoteError
          ? `Saved on this device. Cloud sync note: ${remoteError}`
          : 'Saved for future use.',
      )
    } catch (err) {
      setHolderMsg(err.message || 'Could not save custom holder.')
    } finally {
      setSavingHolder(false)
    }
  }

  async function handleDeleteCustom(id) {
    await deleteCustomHolder(id)
    const { customs } = await loadAllHolders()
    setCustomHolders(customs)
    if (holderId === id) setHolderId('er32')
    setHolderMsg('Removed custom holder.')
  }

  function stopLoop() {
    cancelAnimationFrame(rafRef.current)
    loopRunningRef.current = false
  }

  function startLoop() {
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video || loopRunningRef.current) return
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    let uiTick = 0
    loopRunningRef.current = true

    const completeConsensus = (greenPixelWidth, overrides = {}) => {
      frozenRef.current = true
      armedRef.current = false
      setArmed(false)
      setConsensus(true)
      stopLoop()

      const mode = captureModeRef.current
      const spotPeaks =
        overrides.spotPeaks || redTrackerRef.current.peaks.slice(0, 3)
      const pilotPeaks = overrides.pilotPeaks
        ? [...overrides.pilotPeaks]
        : pilotPeaksRef.current.slice(0, 3)
      while (pilotPeaks.length < Math.max(1, spotPeaks.length)) {
        pilotPeaks.push(pilotPeaks[pilotPeaks.length - 1] || 0)
      }

      const avgSpotPx = overrides.avgSpotPx ?? avg(spotPeaks)
      const avgPilotPx =
        overrides.avgPilotPx ?? avg(pilotPeaks.slice(0, spotPeaks.length || 1))
      const holder = holderRef.current
      const flutesN = mode === 'spindle' ? 0 : flutesRef.current
      const steps = stepInfoRef.current

      const rawSpot = pixelsToInches(avgSpotPx, greenPixelWidth, holder.inches)
      const rawPilot = pixelsToInches(avgPilotPx, greenPixelWidth, holder.inches)
      const measuredSpot =
        mode === 'spindle' ? rawSpot : applyFluteCorrection(rawSpot, flutesN)
      const measuredPilot =
        mode === 'spindle' ? rawPilot : applyFluteCorrection(rawPilot, flutesN)
      const measuredDepth = pixelsToInches(
        steps.depthPx,
        greenPixelWidth,
        holder.inches,
      )

      const matched = matchPortForm({
        measuredSpotface: measuredSpot,
        measuredPilot: measuredPilot,
        measuredDepth,
        detectedStepCount: steps.detectedStepCount,
        formSizes: formSizesRef.current,
      })

      ctx.save()
      ctx.lineWidth = Math.max(8, canvas.width * 0.01)
      ctx.strokeStyle = '#22c55e'
      ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8)
      ctx.fillStyle = 'rgba(22, 163, 74, 0.9)'
      ctx.fillRect(12, canvas.height - 64, canvas.width - 24, 48)
      ctx.fillStyle = '#fff'
      ctx.font = `bold ${Math.max(16, canvas.width * 0.022)}px sans-serif`
      ctx.fillText(
        mode === 'spindle' ? 'Spindle Sample Complete' : '3-Pass Consensus Reached',
        28,
        canvas.height - 34,
      )
      ctx.restore()

      video.pause()

      const snapshot = canvas.toDataURL('image/jpeg', 0.85)
      const matchRow = matched.match
      const payload = {
        holderId: holder.id,
        holderInches: holder.inches,
        flutes: flutesN,
        captureMode: mode,
        spotPeaksPx: spotPeaks,
        pilotPeaksPx: pilotPeaks.slice(0, Math.max(3, spotPeaks.length)),
        avgSpotPx,
        avgPilotPx,
        measuredSpotface: measuredSpot,
        measuredPilot: measuredPilot,
        measuredDepth,
        detectedStepCount: steps.detectedStepCount,
        landCount: steps.landCount,
        isComplexCavity: matched.isComplexCavity,
        searchMode: matched.searchMode,
        depthRatio: matched.depthRatio,
        match: matchRow,
        nearest: matched.nearest,
        candidates: matched.candidates,
        imageDataUrl: snapshot,
      }
      setResult(payload)
      setRotations(mode === 'spindle' ? 3 : spotPeaks.length)
      setDetectedStepCount(steps.detectedStepCount)
      setStatus(
        matchRow
          ? `Form match: ${matchRow.standard_name || matchRow.short_name} · ${matchRow.size_token} · ${steps.detectedStepCount} steps`
          : `Consensus — no form match (${steps.detectedStepCount} steps, mode ${matched.searchMode}).`,
      )
      onResultRef.current?.(payload)
    }

    const loop = () => {
      if (!loopRunningRef.current) return
      if (frozenRef.current) {
        loopRunningRef.current = false
        return
      }

      if (video.readyState >= 2) {
        if (
          canvas.width !== video.videoWidth ||
          canvas.height !== video.videoHeight
        ) {
          canvas.width = video.videoWidth || 1280
          canvas.height = video.videoHeight || 720
        }

        const { width: cw, height: ch } = canvas
        ctx.drawImage(video, 0, 0, cw, ch)

        const g = boxPixels(greenRef.current, cw, ch)
        const r = boxPixels(redRef.current, cw, ch)
        const b = boxPixels(blueRef.current, cw, ch)

        const redSample = ctx.getImageData(
          Math.round(r.x),
          Math.round(r.y),
          Math.round(r.w),
          Math.round(r.h),
        )
        const blueSample = ctx.getImageData(
          Math.round(b.x),
          Math.round(b.y),
          Math.round(b.w),
          Math.round(b.h),
        )
        const spotPx = measureSilhouetteDiameter(
          redSample,
          diameterAxisRef.current,
        )
        const pilotPx = measureSilhouetteDiameter(
          blueSample,
          diameterAxisRef.current,
        )
        const spotSmooth = Math.round(spotSmoothRef.current.push(spotPx))
        const pilotSmooth = Math.round(pilotSmoothRef.current.push(pilotPx))

        const yLine = yellowRef.current
        const horizontal = yLine.orientation === 'horizontal'
        const frame = ctx.getImageData(0, 0, cw, ch)
        const profile = horizontal
          ? analyzeSilhouetteSteps(frame, {
              orientation: 'horizontal',
              centerY: (yLine.cross ?? yLine.y ?? 0.5) * ch,
              xStart: (yLine.shoulder ?? yLine.xShoulder ?? 0.4) * cw,
              xEnd: (yLine.tip ?? yLine.xTip ?? 0.12) * cw,
            })
          : analyzeSilhouetteSteps(frame, {
              orientation: 'vertical',
              centerX: (yLine.cross ?? yLine.x ?? 0.5) * cw,
              yStart: (yLine.shoulder ?? yLine.yShoulder ?? 0.4) * ch,
              yEnd: (yLine.tip ?? yLine.yTip ?? 0.12) * ch,
            })
        stepInfoRef.current = profile

        const yx = horizontal
          ? (yLine.shoulder ?? yLine.xShoulder ?? 0.4) * cw
          : (yLine.cross ?? yLine.x ?? 0.5) * cw
        const yShoulder = horizontal
          ? (yLine.cross ?? yLine.y ?? 0.5) * ch
          : (yLine.shoulder ?? yLine.yShoulder ?? 0.4) * ch
        const yTipX = horizontal
          ? (yLine.tip ?? yLine.xTip ?? 0.12) * cw
          : (yLine.cross ?? yLine.x ?? 0.5) * cw
        const yTip = horizontal
          ? (yLine.cross ?? yLine.y ?? 0.5) * ch
          : (yLine.tip ?? yLine.yTip ?? 0.12) * ch
        // for vertical line drawing: from (yx,yShoulder) to (yx,yTip)
        // for horizontal: from (yx,yShoulder) to (yTipX,yTip) where yShoulder===yTip (same cross)

        const now = performance.now()
        let settleLeftMs = 0
        let spindleProgress = 0
        if (armedRef.current) {
          settleLeftMs = Math.max(0, armReadyAtRef.current - now)
          if (settleLeftMs <= 0) {
            const mode = captureModeRef.current
            if (mode === 'spindle') {
              if (!spindleStartRef.current) spindleStartRef.current = now
              spindleMaxSpotRef.current = Math.max(
                spindleMaxSpotRef.current,
                spotSmooth,
              )
              spindleMaxPilotRef.current = Math.max(
                spindleMaxPilotRef.current,
                pilotSmooth,
              )
              const elapsed = now - spindleStartRef.current
              spindleProgress = Math.min(1, elapsed / SPINDLE_SAMPLE_MS)
              if (uiTick % 8 === 0) {
                setRotations(Math.min(3, Math.ceil(spindleProgress * 3)))
              }
              if (elapsed >= SPINDLE_SAMPLE_MS) {
                const maxSpot = spindleMaxSpotRef.current
                const maxPilot = spindleMaxPilotRef.current
                completeConsensus(g.w, {
                  spotPeaks: [maxSpot, maxSpot, maxSpot],
                  pilotPeaks: [maxPilot, maxPilot, maxPilot],
                  avgSpotPx: maxSpot,
                  avgPilotPx: maxPilot,
                })
                return
              }
            } else {
              pilotCycleMaxRef.current = Math.max(
                pilotCycleMaxRef.current,
                pilotSmooth,
              )
              const { committedPeak } = redTrackerRef.current.push(
                spotSmooth,
                now,
              )
              if (committedPeak != null) {
                pilotPeaksRef.current.push(pilotCycleMaxRef.current)
                pilotCycleMaxRef.current = pilotSmooth
                const count = redTrackerRef.current.count
                setRotations(count)
                if (count >= 3) {
                  completeConsensus(g.w)
                  return
                }
              }
            }
          } else if (uiTick % 10 === 0) {
            setStatus(
              `Hold steady — starting in ${(settleLeftMs / 1000).toFixed(1)}s…`,
            )
          }
        }

        uiTick += 1
        if (uiTick % 4 === 0) {
          setLiveSpotPx(spotSmooth)
          setLivePilotPx(pilotSmooth)
        }
        if (uiTick % 8 === 0) setDetectedStepCount(profile.detectedStepCount)

        ctx.save()
        ctx.lineWidth = Math.max(2, cw * 0.003)
        ctx.font = `${Math.max(13, cw * 0.016)}px sans-serif`

        ctx.strokeStyle = '#22c55e'
        ctx.fillStyle = 'rgba(34, 197, 94, 0.12)'
        ctx.fillRect(g.x, g.y, g.w, g.h)
        ctx.strokeRect(g.x, g.y, g.w, g.h)
        ctx.fillStyle = '#166534'
        ctx.fillText('REF HOLDER', g.x + 8, g.y + Math.max(16, g.h * 0.55))

        ctx.strokeStyle = '#ef4444'
        ctx.fillStyle = 'rgba(239, 68, 68, 0.14)'
        ctx.fillRect(r.x, r.y, r.w, r.h)
        ctx.strokeRect(r.x, r.y, r.w, r.h)
        ctx.fillStyle = '#991b1b'
        ctx.fillText(
          'SPOTFACE / MAJOR',
          r.x + 8,
          r.y + Math.max(16, r.h * 0.55),
        )

        ctx.strokeStyle = '#3b82f6'
        ctx.fillStyle = 'rgba(59, 130, 246, 0.14)'
        ctx.fillRect(b.x, b.y, b.w, b.h)
        ctx.strokeRect(b.x, b.y, b.w, b.h)
        ctx.fillStyle = '#1e3a8a'
        ctx.fillText(
          'PILOT / MINOR',
          b.x + 8,
          b.y + Math.max(16, b.h * 0.55),
        )

        ctx.strokeStyle = '#eab308'
        ctx.fillStyle = 'rgba(234, 179, 8, 0.95)'
        ctx.lineWidth = Math.max(3, cw * 0.004)
        ctx.beginPath()
        if (horizontal) {
          ctx.moveTo(yx, yShoulder)
          ctx.lineTo(yTipX, yTip)
        } else {
          ctx.moveTo(yx, yShoulder)
          ctx.lineTo(yx, yTip)
        }
        ctx.stroke()
        const handle = Math.max(8, cw * 0.01)
        if (horizontal) {
          ctx.fillRect(yx - handle, yShoulder - handle, handle * 2, handle * 2)
          ctx.fillRect(yTipX - handle, yTip - handle, handle * 2, handle * 2)
          ctx.fillText(
            'DEPTH',
            (yx + yTipX) / 2,
            yShoulder - handle - 4,
          )
        } else {
          ctx.fillRect(yx - handle, yShoulder - handle, handle * 2, handle * 2)
          ctx.fillRect(yx - handle, yTip - handle, handle * 2, handle * 2)
          ctx.fillText('DEPTH', yx + handle + 4, (yShoulder + yTip) / 2)
        }

        ctx.fillStyle = 'rgba(15, 23, 42, 0.78)'
        ctx.fillRect(12, 12, Math.min(460, cw * 0.62), 88)
        ctx.fillStyle = '#f8fafc'
        ctx.fillText(
          `Spotface: ${spotSmooth}px · Pilot: ${pilotSmooth}px`,
          24,
          34,
        )
        if (armedRef.current && settleLeftMs > 0) {
          ctx.fillText(
            `Settle ${(settleLeftMs / 1000).toFixed(1)}s — start spindle / hold still`,
            24,
            56,
          )
        } else if (
          armedRef.current &&
          captureModeRef.current === 'spindle'
        ) {
          ctx.fillText(
            `Spindle sample ${Math.round(spindleProgress * 100)}% (max envelope)`,
            24,
            56,
          )
        } else {
          ctx.fillText(
            `Rotations Tracked: ${redTrackerRef.current.count}/3`,
            24,
            56,
          )
        }
        ctx.fillText(
          `Steps detected: ${profile.detectedStepCount} · lands ${profile.landCount}`,
          24,
          78,
        )
        ctx.restore()
      }

      rafRef.current = requestAnimationFrame(loop)
    }

    rafRef.current = requestAnimationFrame(loop)
  }

  useEffect(() => {
    if (!cameraOn) {
      stopLoop()
      return undefined
    }
    startLoop()
    return () => stopLoop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn])

  async function startCamera() {
    setError('')
    setConsensus(false)
    setResult(null)
    setArmed(false)
    armedRef.current = false
    setRotations(0)
    frozenRef.current = false
    redTrackerRef.current.reset()
    spotSmoothRef.current.reset()
    pilotSmoothRef.current.reset()
    pilotPeaksRef.current = []
    pilotCycleMaxRef.current = 0
    armReadyAtRef.current = 0
    spindleStartRef.current = 0
    spindleMaxSpotRef.current = 0
    spindleMaxPilotRef.current = 0
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCameraOn(true)
      setStatus(
        'Green = holder. Red = spotface/major step. Blue = tip pilot/minor.',
      )
    } catch {
      setError('Camera permission blocked.')
    }
  }

  function stopCamera() {
    stopLoop()
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCameraOn(false)
    setArmed(false)
    armedRef.current = false
    frozenRef.current = false
  }

  function autoPlaceZones() {
    if (!cameraOn || frozenRef.current) return
    const canvas = canvasRef.current
    const video = videoRef.current
    if (!canvas || !video || video.readyState < 2) {
      setStatus('Start the camera first, then align the green box on the collet nut.')
      return
    }
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (
      canvas.width !== video.videoWidth ||
      canvas.height !== video.videoHeight
    ) {
      canvas.width = video.videoWidth || 1280
      canvas.height = video.videoHeight || 720
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const proposal = proposeZonesFromSilhouette(frame, greenRef.current)
    if (!proposal) {
      setStatus(
        'Could not see a clear tool silhouette from the green box. Check backlight and collet alignment.',
      )
      return
    }
    setRedZone(proposal.red)
    setBlueZone(proposal.blue)
    setYellowLine(proposal.yellow)
    diameterAxisRef.current = proposal.diameterAxis || 'x'
    setTipDirLabel(proposal.tipDir || 'up')
    setStatus(
      `Auto-placed for tip-${proposal.tipDir} (${proposal.orientation}). Nudge if needed, then Arm.`,
    )
  }

  function armCapture() {
    if (!cameraOn) return
    redTrackerRef.current.reset()
    spotSmoothRef.current.reset()
    pilotSmoothRef.current.reset()
    pilotPeaksRef.current = []
    pilotCycleMaxRef.current = 0
    spindleStartRef.current = 0
    spindleMaxSpotRef.current = 0
    spindleMaxPilotRef.current = 0
    armReadyAtRef.current = performance.now() + ARM_SETTLE_MS
    setRotations(0)
    setResult(null)
    setConsensus(false)
    frozenRef.current = false
    videoRef.current?.play()
    armedRef.current = true
    setArmed(true)
    setStatus(
      captureMode === 'spindle'
        ? 'Armed — start spindle (~500 RPM). 1.5s settle, then 2.5s max-diameter sample (no flute math).'
        : 'Armed — wait for settle, then spin slowly by hand. False peaks from shake are filtered.',
    )
    if (!loopRunningRef.current) startLoop()
  }

  function resetMeasurement() {
    redTrackerRef.current.reset()
    spotSmoothRef.current.reset()
    pilotSmoothRef.current.reset()
    pilotPeaksRef.current = []
    pilotCycleMaxRef.current = 0
    spindleStartRef.current = 0
    spindleMaxSpotRef.current = 0
    spindleMaxPilotRef.current = 0
    armReadyAtRef.current = 0
    setArmed(false)
    armedRef.current = false
    setRotations(0)
    setConsensus(false)
    setResult(null)
    frozenRef.current = false
    setLiveSpotPx(0)
    setLivePilotPx(0)
    setDetectedStepCount(0)
    setYellowLine(DEFAULT_YELLOW)
    if (cameraOn) {
      videoRef.current?.play()
      if (!loopRunningRef.current) startLoop()
    }
    setStatus('Ready. Re-arm when spinning.')
  }

  function hitTest(nx, ny) {
    const y = yellowRef.current
    const pad = 0.03
    const horizontal = y.orientation === 'horizontal'
    if (horizontal) {
      const cross = y.cross ?? y.y ?? 0.5
      const shoulder = y.shoulder ?? y.xShoulder ?? 0.4
      const tip = y.tip ?? y.xTip ?? 0.12
      const nearLine = Math.abs(ny - cross) < pad
      if (nearLine && Math.abs(nx - shoulder) < pad) {
        return { target: 'yellow', mode: 'yellow-shoulder' }
      }
      if (nearLine && Math.abs(nx - tip) < pad) {
        return { target: 'yellow', mode: 'yellow-tip' }
      }
      if (
        nearLine &&
        nx >= Math.min(shoulder, tip) - pad &&
        nx <= Math.max(shoulder, tip) + pad
      ) {
        return { target: 'yellow', mode: 'yellow-move' }
      }
    } else {
      const cross = y.cross ?? y.x ?? 0.5
      const shoulder = y.shoulder ?? y.yShoulder ?? 0.4
      const tip = y.tip ?? y.yTip ?? 0.12
      const nearLine = Math.abs(nx - cross) < pad
      if (nearLine && Math.abs(ny - shoulder) < pad) {
        return { target: 'yellow', mode: 'yellow-shoulder' }
      }
      if (nearLine && Math.abs(ny - tip) < pad) {
        return { target: 'yellow', mode: 'yellow-tip' }
      }
      if (
        nearLine &&
        ny >= Math.min(shoulder, tip) - pad &&
        ny <= Math.max(shoulder, tip) + pad
      ) {
        return { target: 'yellow', mode: 'yellow-move' }
      }
    }

    const boxes = [
      { key: 'blue', box: blueRef.current },
      { key: 'red', box: redRef.current },
      { key: 'green', box: greenRef.current },
    ]
    for (const { key, box } of boxes) {
      const onRight =
        Math.abs(nx - (box.x + box.w)) < pad &&
        ny >= box.y &&
        ny <= box.y + box.h
      const onLeft =
        Math.abs(nx - box.x) < pad && ny >= box.y && ny <= box.y + box.h
      const inside =
        nx >= box.x &&
        nx <= box.x + box.w &&
        ny >= box.y &&
        ny <= box.y + box.h
      if (onRight) return { target: key, mode: 'resize-right' }
      if (onLeft) return { target: key, mode: 'resize-left' }
      if (inside) return { target: key, mode: 'move' }
    }
    return null
  }

  function pointerNorm(event) {
    const canvas = canvasRef.current
    const rect = canvas.getBoundingClientRect()
    return {
      nx: (event.clientX - rect.left) / rect.width,
      ny: (event.clientY - rect.top) / rect.height,
    }
  }

  function onPointerDown(event) {
    if (frozenRef.current) return
    const { nx, ny } = pointerNorm(event)
    const hit = hitTest(nx, ny)
    if (!hit) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      ...hit,
      startX: nx,
      startY: ny,
      green: { ...greenRef.current },
      red: { ...redRef.current },
      blue: { ...blueRef.current },
      yellow: { ...yellowRef.current },
    }
  }

  function onPointerMove(event) {
    const drag = dragRef.current
    if (!drag) return
    const { nx, ny } = pointerNorm(event)
    const dx = nx - drag.startX
    const dy = ny - drag.startY

    if (drag.target === 'yellow') {
      const src = drag.yellow
      const horizontal = src.orientation === 'horizontal'
      if (horizontal) {
        if (drag.mode === 'yellow-shoulder') {
          const shoulder = clamp(nx, 0.04, 0.96)
          setYellowLine({
            ...src,
            shoulder,
            xShoulder: shoulder,
          })
        } else if (drag.mode === 'yellow-tip') {
          const tip = clamp(nx, 0.04, 0.96)
          setYellowLine({
            ...src,
            tip,
            xTip: tip,
          })
        } else {
          const span = (src.tip ?? src.xTip) - (src.shoulder ?? src.xShoulder)
          const nextShoulder = clamp(
            (src.shoulder ?? src.xShoulder) + dx,
            0.04,
            0.96,
          )
          const cross = clamp((src.cross ?? src.y) + dy, 0.04, 0.96)
          setYellowLine({
            ...src,
            cross,
            y: cross,
            yShoulder: cross,
            yTip: cross,
            shoulder: nextShoulder,
            tip: clamp(nextShoulder + span, 0.04, 0.96),
            xShoulder: nextShoulder,
            xTip: clamp(nextShoulder + span, 0.04, 0.96),
          })
        }
      } else if (drag.mode === 'yellow-shoulder') {
        const shoulder = clamp(ny, 0.04, 0.96)
        setYellowLine({
          ...src,
          shoulder,
          yShoulder: shoulder,
        })
      } else if (drag.mode === 'yellow-tip') {
        const tip = clamp(ny, 0.04, 0.96)
        setYellowLine({
          ...src,
          tip,
          yTip: tip,
        })
      } else {
        const span = (src.tip ?? src.yTip) - (src.shoulder ?? src.yShoulder)
        const nextShoulder = clamp(
          (src.shoulder ?? src.yShoulder) + dy,
          0.04,
          0.96,
        )
        const cross = clamp((src.cross ?? src.x) + dx, 0.04, 0.96)
        setYellowLine({
          ...src,
          cross,
          x: cross,
          xShoulder: cross,
          xTip: cross,
          shoulder: nextShoulder,
          tip: clamp(nextShoulder + span, 0.04, 0.96),
          yShoulder: nextShoulder,
          yTip: clamp(nextShoulder + span, 0.04, 0.96),
        })
      }
      return
    }

    const src = drag[drag.target]
    const setter =
      drag.target === 'green'
        ? setGreenBox
        : drag.target === 'red'
          ? setRedZone
          : setBlueZone

    if (drag.mode === 'move') {
      setter({
        ...src,
        x: clamp(src.x + dx, 0.02, 0.98 - src.w),
        y: clamp(src.y + dy, 0.02, 0.98 - src.h),
      })
    } else if (drag.mode === 'resize-right') {
      setter({
        ...src,
        w: clamp(src.w + dx, 0.08, 0.95 - src.x),
      })
    } else if (drag.mode === 'resize-left') {
      const newX = clamp(src.x + dx, 0.02, src.x + src.w - 0.08)
      setter({
        ...src,
        x: newX,
        w: src.w + (src.x - newX),
      })
    }
  }

  function onPointerUp(event) {
    const drag = dragRef.current
    dragRef.current = null
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      /* ignore */
    }
    if (drag?.target === 'green' && cameraOn && !frozenRef.current) {
      // Collet box moved — re-find tip / spotface relative to the new holder.
      window.setTimeout(() => autoPlaceZones(), 40)
    }
  }

  const match = result?.match
  const nearest = result?.nearest

  return (
    <section className="optical-panel" aria-labelledby="optical-heading">
      <div className="section-copy">
        <h2 id="optical-heading">Port Form Classifier</h2>
        <p>
        Dual-diameter Point–Spin–Match: line up the green box on your collet
        nut OD, tap Auto-place zones, then Arm. Prefer spindle mode so the phone
        stays still while the tool turns.
        </p>
      </div>

      <div className="camera-actions">
        {!cameraOn ? (
          <button type="button" className="btn primary" onClick={startCamera}>
            Start live camera
          </button>
        ) : (
          <button type="button" className="btn ghost" onClick={stopCamera}>
            Stop camera
          </button>
        )}
        <button type="button" className="btn ghost" onClick={resetMeasurement}>
          Reset
        </button>
      </div>

      {error ? <p className="status error">{error}</p> : null}
      <p className={`status ${consensus ? 'save-status' : ''}`}>{status}</p>

      <div className={`optical-stage ${consensus ? 'consensus' : ''}`}>
        <video ref={videoRef} playsInline muted className="optical-video-src" />
        <canvas
          ref={canvasRef}
          className="optical-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {!cameraOn ? (
          <div className="camera-placeholder optical-placeholder">
            <span>Live viewport</span>
            <small>Green holder · Red spotface · Blue pilot · Yellow depth</small>
          </div>
        ) : null}
      </div>

      <div className="optical-dock" aria-label="Capture controls">
        <div className="optical-dock-row">
          <button
            type="button"
            className="btn ghost"
            disabled={!cameraOn || consensus || saving}
            onClick={autoPlaceZones}
          >
            Auto-place
          </button>
          <button
            type="button"
            className="btn primary arm-btn"
            disabled={
              !cameraOn || consensus || saving || holderId === CUSTOM_OPTION_ID
            }
            onClick={armCapture}
          >
            Arm Auto-Capture
          </button>
        </div>
        <div className="flute-group optical-dock-modes" role="group" aria-label="Capture mode">
          <button
            type="button"
            className={`btn ${captureMode === 'spindle' ? 'primary' : 'ghost'}`}
            onClick={() => setCaptureMode('spindle')}
          >
            Spindle
          </button>
          <button
            type="button"
            className={`btn ${captureMode === 'hand' ? 'primary' : 'ghost'}`}
            onClick={() => setCaptureMode('hand')}
          >
            Hand
          </button>
          {captureMode === 'hand'
            ? [2, 3, 4].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`btn ${flutes === n ? 'primary' : 'ghost'}`}
                  onClick={() => setFlutes(n)}
                >
                  {n}fl
                </button>
              ))
            : null}
        </div>
        <p className="rotation-progress optical-dock-progress" aria-live="polite">
          {tipDirLabel ? `tip-${tipDirLabel} · ` : ''}
          {captureMode === 'spindle'
            ? `Sample ${rotations}/3`
            : `Rots ${rotations}/3`}
          {armed ? ' · ARMED' : ''}
          {liveSpotPx || livePilotPx
            ? ` · ${liveSpotPx}/${livePilotPx}px`
            : ''}
        </p>
      </div>

      <details className="optical-settings">
        <summary>Holder &amp; options</summary>
        <div className="optical-bottom-panel">
        <label className="field">
          <span>Holder selector</span>
          <select
            value={holderId}
            onChange={(e) => {
              setHolderId(e.target.value)
              setHolderMsg('')
            }}
          >
            <optgroup label="Built-in">
              {BUILTIN_HOLDER_PRESETS.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.label}
                </option>
              ))}
            </optgroup>
            {customHolders.length > 0 ? (
              <optgroup label="Saved custom">
                {customHolders.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.label}
                  </option>
                ))}
              </optgroup>
            ) : null}
            <option value={CUSTOM_OPTION_ID}>Custom nut / collet…</option>
          </select>
        </label>

        {captureMode === 'spindle' ? (
          <p className="empty-hint">
            Spindle mode: 1.5s settle + 2.5s max-diameter sample. No flute math.
            Phone sideways is fine — Auto-place detects tip left/right/up/down.
          </p>
        ) : (
          <p className="empty-hint">
            Hand mode uses fretting filters. Prefer spindle if the phone shakes.
          </p>
        )}

        {holderId === CUSTOM_OPTION_ID ||
        customHolders.some((h) => h.id === holderId) ? (
          <div className="custom-holder-form">
            {holderId === CUSTOM_OPTION_ID ? (
              <>
                <label className="field">
                  <span>Name (e.g. ER50 nut)</span>
                  <input
                    type="text"
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="My big collet nut"
                  />
                </label>
                <label className="field">
                  <span>Nut / flange OD (inches)</span>
                  <input
                    type="number"
                    min="0.1"
                    step="0.001"
                    inputMode="decimal"
                    value={customInches}
                    onChange={(e) => setCustomInches(e.target.value)}
                    placeholder="3.150"
                  />
                </label>
                <button
                  type="button"
                  className="btn primary"
                  disabled={savingHolder}
                  onClick={handleSaveCustomHolder}
                >
                  {savingHolder ? 'Saving…' : 'Save & use'}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn ghost"
                onClick={() => handleDeleteCustom(holderId)}
              >
                Remove this saved custom
              </button>
            )}
            {holderMsg ? <p className="status">{holderMsg}</p> : null}
          </div>
        ) : null}
        </div>
      </details>

      {result ? (
        <article className="optical-result">
          <h3>Port form result</h3>
          {result.isComplexCavity ? (
            <p className="cavity-type-label">
              Type: Multi-Stage Cartridge Valve Cavity
              {result.detectedStepCount >= 3 ? ' (4-Way Spec Detected)' : ''}
            </p>
          ) : (
            <p className="cavity-type-label">Type: Standard shallow port</p>
          )}
          {match ? (
            <div className="match-card">
              <div className="match-topline">
                <strong>
                  {match.standard_name || match.name || match.short_name}
                </strong>
                <span className="confidence high">FORM MATCH</span>
              </div>
              <p className="match-spec">
                {match.specification || match.code} · size {match.size_token}
                {match.cavity_class ? ` · class ${match.cavity_class}` : ''}
              </p>
              <dl className="compare-dl">
                <div>
                  <dt>Pilot</dt>
                  <dd>
                    Measured {result.measuredPilot?.toFixed(3)}″ vs Spec{' '}
                    {Number(match.pilot_diameter).toFixed(3)}″
                    <small> Δ {match.pilotDelta?.toFixed(3)}″</small>
                  </dd>
                </div>
                <div>
                  <dt>{result.isComplexCavity ? 'Max (D₁)' : 'Spotface'}</dt>
                  <dd>
                    Measured {result.measuredSpotface?.toFixed(3)}″ vs Spec{' '}
                    {Number(
                      match.max_diameter ?? match.spotface_diameter,
                    ).toFixed(3)}
                    ″
                    <small> Δ {match.spotDelta?.toFixed(3)}″</small>
                  </dd>
                </div>
                {result.measuredDepth != null ? (
                  <div>
                    <dt>Functional depth</dt>
                    <dd>
                      Measured {result.measuredDepth.toFixed(3)}″
                      {match.functional_depth != null
                        ? ` vs Spec ${Number(match.functional_depth).toFixed(3)}″`
                        : ''}
                      <small>
                        {' '}
                        · {result.detectedStepCount} step
                        {result.detectedStepCount === 1 ? '' : 's'}
                      </small>
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
          ) : nearest ? (
            <div className="match-card">
              <div className="match-topline">
                <strong>
                  Closest: {nearest.standard_name || nearest.short_name}
                </strong>
                <span className="confidence low">OUT OF TOL</span>
              </div>
              <p className="match-spec">
                size {nearest.size_token}
                {nearest.cavity_class ? ` · class ${nearest.cavity_class}` : ''}
              </p>
              <dl className="compare-dl">
                <div>
                  <dt>Pilot</dt>
                  <dd>
                    Measured {result.measuredPilot?.toFixed(3)}″ vs Spec{' '}
                    {Number(nearest.pilot_diameter).toFixed(3)}″
                  </dd>
                </div>
                <div>
                  <dt>{result.isComplexCavity ? 'Max (D₁)' : 'Spotface'}</dt>
                  <dd>
                    Measured {result.measuredSpotface?.toFixed(3)}″ vs Spec{' '}
                    {Number(
                      nearest.max_diameter ?? nearest.spotface_diameter,
                    ).toFixed(3)}
                    ″
                  </dd>
                </div>
              </dl>
            </div>
          ) : (
            <p className="empty-hint">
              No form sizes on file yet. Add them under Shop form sizes, or
              import a chart photo.
            </p>
          )}
        </article>
      ) : null}
    </section>
  )
}
