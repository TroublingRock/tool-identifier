import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { createWorker } from 'tesseract.js'
import { extractStandardsFromText } from '../lib/extractStandards'

GlobalWorkerOptions.workerSrc = pdfWorker

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.onload = () => resolve(reader.result)
    reader.readAsDataURL(file)
  })
}

function compressImageDataUrl(dataUrl, maxWidth = 1600, quality = 0.75) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onerror = () => reject(new Error('Could not load image'))
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(img.width * scale)
      canvas.height = Math.round(img.height * scale)
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
      resolve(canvas.toDataURL('image/jpeg', quality))
    }
    img.src = dataUrl
  })
}

async function extractTextFromPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer())
  const pdf = await getDocument({ data }).promise
  const maxPages = Math.min(pdf.numPages, 8)
  const chunks = []

  for (let pageNum = 1; pageNum <= maxPages; pageNum += 1) {
    const page = await pdf.getPage(pageNum)
    const content = await page.getTextContent()
    const pageText = content.items.map((item) => item.str).join(' ')
    chunks.push(pageText)

    if (pageText.replace(/\s+/g, '').length < 40) {
      const viewport = page.getViewport({ scale: 1.6 })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      await page.render({
        canvasContext: canvas.getContext('2d'),
        viewport,
      }).promise
      const ocrText = await extractTextFromImage(
        canvas.toDataURL('image/jpeg', 0.85),
      )
      chunks.push(ocrText)
    }
  }

  return chunks.join('\n')
}

async function extractTextFromImage(dataUrl) {
  const worker = await createWorker('eng')
  try {
    const {
      data: { text },
    } = await worker.recognize(dataUrl)
    return text || ''
  } finally {
    await worker.terminate()
  }
}

export default function StandardsImporter({
  existingCodes = [],
  onImported,
  saving,
}) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const imageInputRef = useRef(null)
  const pdfInputRef = useRef(null)

  const [live, setLive] = useState(false)
  const [preview, setPreview] = useState(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [rawText, setRawText] = useState('')
  const [drafts, setDrafts] = useState([])

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  async function startCamera() {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setLive(true)
    } catch {
      setError('Camera blocked. Use photo upload or PDF instead.')
      imageInputRef.current?.click()
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setLive(false)
  }

  async function runExtraction(text, imagePreview = null) {
    const found = extractStandardsFromText(text).map((draft) => ({
      ...draft,
      selected: !existingCodes.includes(draft.code),
      alreadyExists: existingCodes.includes(draft.code),
    }))
    setRawText(text)
    setDrafts(found)
    if (imagePreview) setPreview(imagePreview)
    setStatus(
      found.length
        ? `Found ${found.length} standard(s). Review, then add to dropdown.`
        : 'No standards detected. Try a clearer photo or a text PDF page.',
    )
  }

  async function processImageDataUrl(dataUrl) {
    setBusy(true)
    setError('')
    setStatus('Reading chart with OCR…')
    try {
      const compressed = await compressImageDataUrl(dataUrl)
      const text = await extractTextFromImage(compressed)
      await runExtraction(text, compressed)
    } catch (err) {
      setError(err.message || 'Could not read that image.')
    } finally {
      setBusy(false)
    }
  }

  function snapPhoto() {
    const video = videoRef.current
    if (!video) return
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 1600 / video.videoWidth)
    canvas.width = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    stopCamera()
    processImageDataUrl(canvas.toDataURL('image/jpeg', 0.8))
  }

  async function onImageChange(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const dataUrl = await fileToDataUrl(file)
      stopCamera()
      await processImageDataUrl(dataUrl)
    } catch (err) {
      setError(err.message || 'Could not process image.')
    }
  }

  async function onPdfChange(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true)
    setError('')
    setPreview(null)
    setStatus('Reading PDF…')
    try {
      const text = await extractTextFromPdf(file)
      await runExtraction(text)
    } catch (err) {
      setError(err.message || 'Could not read that PDF.')
    } finally {
      setBusy(false)
    }
  }

  function updateDraft(id, patch) {
    setDrafts((prev) =>
      prev.map((draft) => (draft.id === id ? { ...draft, ...patch } : draft)),
    )
  }

  async function handleAddSelected() {
    const selected = drafts.filter((d) => d.selected)
    if (!selected.length) {
      setError('Select at least one standard to add.')
      return
    }
    await onImported(selected)
    setDrafts([])
    setRawText('')
    setPreview(null)
    setStatus('Standards added to the dropdown.')
  }

  return (
    <section className="camera-panel" aria-labelledby="import-heading">
      <div className="section-copy">
        <h2 id="import-heading">Add standards from PDF or camera</h2>
        <p>
          Upload a catalog chart PDF or photograph a page. Detected standards are
          reviewed here, saved into <code>port_calculator.port_standards</code>,
          and appear in the dropdown — no SQL Editor.
        </p>
      </div>

      <div className="camera-actions">
        {!live ? (
          <button
            type="button"
            className="btn primary"
            disabled={busy || saving}
            onClick={startCamera}
          >
            Open camera
          </button>
        ) : (
          <>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={snapPhoto}
            >
              Capture &amp; extract
            </button>
            <button type="button" className="btn ghost" onClick={stopCamera}>
              Close camera
            </button>
          </>
        )}
        <button
          type="button"
          className="btn ghost"
          disabled={busy || saving}
          onClick={() => imageInputRef.current?.click()}
        >
          Upload photo
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={busy || saving}
          onClick={() => pdfInputRef.current?.click()}
        >
          Upload PDF
        </button>
        <input
          ref={imageInputRef}
          className="sr-only"
          type="file"
          accept="image/*"
          capture="environment"
          onChange={onImageChange}
        />
        <input
          ref={pdfInputRef}
          className="sr-only"
          type="file"
          accept="application/pdf,.pdf"
          onChange={onPdfChange}
        />
      </div>

      {status ? <p className="status">{status}</p> : null}
      {error ? <p className="status error">{error}</p> : null}

      <div className="camera-stage">
        {live ? (
          <video ref={videoRef} playsInline muted className="camera-feed" />
        ) : preview ? (
          <img
            src={preview}
            alt="Chart capture preview"
            className="camera-feed"
          />
        ) : (
          <div className="camera-placeholder">
            <span>{busy ? 'Working…' : 'No chart loaded'}</span>
            <small>PDF upload or camera photo of a standards page</small>
          </div>
        )}
      </div>

      {drafts.length > 0 ? (
        <div className="import-review">
          <h3>Review before adding to dropdown</h3>
          <ul className="import-list">
            {drafts.map((draft) => (
              <li key={draft.id}>
                <label className="import-row">
                  <input
                    type="checkbox"
                    checked={draft.selected}
                    onChange={(e) =>
                      updateDraft(draft.id, { selected: e.target.checked })
                    }
                  />
                  <span className="import-fields">
                    <input
                      value={draft.short_name}
                      onChange={(e) =>
                        updateDraft(draft.id, { short_name: e.target.value })
                      }
                      aria-label="Short name"
                    />
                    <input
                      value={draft.name}
                      onChange={(e) =>
                        updateDraft(draft.id, { name: e.target.value })
                      }
                      aria-label="Full name"
                    />
                    <input
                      value={draft.family}
                      onChange={(e) =>
                        updateDraft(draft.id, { family: e.target.value })
                      }
                      aria-label="Family"
                    />
                    <small>
                      {draft.code}
                      {draft.alreadyExists
                        ? ' · already in DB (will update)'
                        : ''}
                    </small>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="camera-actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy || saving}
              onClick={handleAddSelected}
            >
              {saving ? 'Saving…' : 'Add selected to dropdown'}
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => {
                setDrafts([])
                setRawText('')
                setPreview(null)
                setStatus('')
              }}
            >
              Discard
            </button>
          </div>
          {rawText ? (
            <details className="raw-text">
              <summary>Extracted text</summary>
              <pre>{rawText.slice(0, 4000)}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
