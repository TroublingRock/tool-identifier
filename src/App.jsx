import { useCallback, useEffect, useMemo, useState } from 'react'
import FormSizeEditor from './components/FormSizeEditor'
import OpticalPresetter from './components/OpticalPresetter'
import StandardsImporter from './components/StandardsImporter'
import { FALLBACK_STANDARDS } from './data/fallbackStandards'
import { isSupabaseConfigured, portDb } from './lib/supabase'
import './App.css'

function App() {
  const [standards, setStandards] = useState([])
  const [formSizes, setFormSizes] = useState([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [source, setSource] = useState('loading')
  const [saveMessage, setSaveMessage] = useState('')
  const [saving, setSaving] = useState(false)

  const loadStandards = useCallback(async () => {
    setLoading(true)
    if (!isSupabaseConfigured) {
      setStandards(FALLBACK_STANDARDS)
      setFormSizes([])
      setSource('local')
      setLoading(false)
      return { standards: FALLBACK_STANDARDS, formSizes: [] }
    }

    const [{ data, error }, sizesRes] = await Promise.all([
      portDb()
        .from('port_standards')
        .select('*')
        .eq('is_active', true)
        .order('sort_order', { ascending: true }),
      portDb()
        .from('port_form_sizes')
        .select(
          'id, standard_id, size_token, pilot_diameter, spotface_diameter, max_diameter, functional_depth, step_count, form_category, cavity_class, notes, port_standards ( id, code, name, short_name, specification, family, seal_type, thread_form )',
        ),
    ])

    if (error || !data?.length) {
      setStandards(FALLBACK_STANDARDS)
      setFormSizes([])
      setSource('local')
      setLoading(false)
      return { standards: FALLBACK_STANDARDS, formSizes: [] }
    }

    const sizes = (sizesRes.data || []).map((row) => ({
      id: row.id,
      standard_id: row.standard_id,
      size_token: row.size_token,
      pilot_diameter: Number(row.pilot_diameter),
      spotface_diameter: Number(row.spotface_diameter),
      max_diameter:
        row.max_diameter != null
          ? Number(row.max_diameter)
          : Number(row.spotface_diameter),
      functional_depth:
        row.functional_depth != null ? Number(row.functional_depth) : null,
      step_count: row.step_count != null ? Number(row.step_count) : null,
      form_category: row.form_category || 'shallow',
      cavity_class: row.cavity_class || null,
      notes: row.notes,
      code: row.port_standards?.code,
      name: row.port_standards?.name,
      short_name: row.port_standards?.short_name,
      standard_name: row.port_standards?.name,
      specification: row.port_standards?.specification,
      family: row.port_standards?.family,
      seal_type: row.port_standards?.seal_type,
      thread_form: row.port_standards?.thread_form,
      standard: row.port_standards,
    }))

    setStandards(data)
    setFormSizes(sizes)
    setSource('supabase')
    setLoading(false)
    return { standards: data, formSizes: sizes }
  }, [])

  useEffect(() => {
    loadStandards()
  }, [loadStandards])

  const selected = useMemo(
    () => standards.find((item) => item.id === selectedId) ?? null,
    [standards, selectedId],
  )

  const selectedFormSizes = useMemo(
    () => formSizes.filter((s) => s.standard_id === selectedId),
    [formSizes, selectedId],
  )

  const families = useMemo(() => {
    const map = new Map()
    for (const item of standards) {
      if (!map.has(item.family)) map.set(item.family, [])
      map.get(item.family).push(item)
    }
    return map
  }, [standards])

  const existingCodes = useMemo(
    () => standards.map((item) => item.code),
    [standards],
  )

  async function handleOpticalResult(payload) {
    setSaveMessage('')
    const matchedStandardId =
      payload.match?.standard_id || payload.match?.standard?.id || null
    if (matchedStandardId) setSelectedId(matchedStandardId)

    setSaving(true)
    try {
      if (!isSupabaseConfigured) {
        setSaveMessage(
          payload.match
            ? `Matched ${payload.match.standard_name || payload.match.short_name} locally.`
            : 'Consensus stored locally only.',
        )
        return
      }

      const { error } = await portDb().from('tool_identifications').insert({
        standard_id: matchedStandardId,
        matched_codes: payload.match?.code
          ? [payload.match.code]
          : payload.nearest?.code
            ? [payload.nearest.code]
            : [],
        confidence: payload.match ? 'form_match' : 'form_no_match',
        answers: {
          workflow: 'port_form_classifier',
          holderId: payload.holderId,
          holderInches: payload.holderInches,
          flutes: payload.flutes,
          spotPeaksPx: payload.spotPeaksPx,
          pilotPeaksPx: payload.pilotPeaksPx,
          measuredSpotface: payload.measuredSpotface,
          measuredPilot: payload.measuredPilot,
          measuredDepth: payload.measuredDepth,
          detectedStepCount: payload.detectedStepCount,
          isComplexCavity: payload.isComplexCavity,
          searchMode: payload.searchMode,
          matchedSize: payload.match?.size_token ?? null,
          cavityClass: payload.match?.cavity_class ?? null,
          spotDelta: payload.match?.spotDelta ?? payload.nearest?.spotDelta,
          pilotDelta: payload.match?.pilotDelta ?? payload.nearest?.pilotDelta,
        },
        notes: payload.match
          ? `Form ${payload.match.short_name || payload.match.code} ${payload.match.size_token}${payload.isComplexCavity ? ' [cavity]' : ''} — pilot ${payload.measuredPilot?.toFixed(3)}" / D1 ${payload.measuredSpotface?.toFixed(3)}" / steps ${payload.detectedStepCount}`
          : `No form match — pilot ${payload.measuredPilot?.toFixed(3)}" / D1 ${payload.measuredSpotface?.toFixed(3)}" / steps ${payload.detectedStepCount}`,
        image_data_url: payload.imageDataUrl,
      })
      if (error) throw error

      setSaveMessage(
        payload.match
          ? `Saved form ID → ${payload.match.standard_name || payload.match.short_name} (${payload.match.size_token})`
          : 'Saved consensus (no dual-diameter form match).',
      )
    } catch (err) {
      setSaveMessage(err.message || 'Could not save optical identification.')
    } finally {
      setSaving(false)
    }
  }

  async function handleImported(drafts) {
    setSaveMessage('')
    setSaving(true)
    try {
      const rows = drafts.map((draft, index) => ({
        code: draft.code,
        name: draft.name,
        short_name: draft.short_name,
        family: draft.family || 'Imported',
        seal_type: draft.seal_type,
        thread_form: draft.thread_form,
        specification: draft.specification,
        description: draft.description,
        identification_tips: draft.identification_tips,
        common_sizes: draft.common_sizes || [],
        common_aliases: draft.common_aliases || [],
        sort_order: draft.sort_order ?? 500 + index,
        is_active: true,
        source: 'import',
        source_notes: draft.source_notes || null,
      }))

      if (!isSupabaseConfigured) {
        const localRows = rows.map((row, index) => ({
          ...row,
          id: `local-import-${Date.now()}-${index}`,
        }))
        setStandards((prev) => {
          const byCode = new Map(prev.map((item) => [item.code, item]))
          for (const row of localRows) byCode.set(row.code, row)
          return [...byCode.values()].sort(
            (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
          )
        })
        setSelectedId(localRows[0]?.id || '')
        setSource('local')
        setSaveMessage(`Added ${localRows.length} standard(s) locally.`)
        return
      }

      const { error } = await portDb()
        .from('port_standards')
        .upsert(rows, { onConflict: 'code' })
      if (error) throw error

      const refreshed = await loadStandards()
      const first = refreshed.standards?.find(
        (item) => item.code === rows[0]?.code,
      )
      if (first) setSelectedId(first.id)
      setSaveMessage(
        `Saved ${rows.length} standard(s) — catalog ready for optical match.`,
      )
    } catch (err) {
      setSaveMessage(err.message || 'Import save failed.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="app-shell">
      <header className="hero">
        <p className="brand">Tool Identifier</p>
        <h1>Port Form Classifier</h1>
        <p className="lede">
          Dual-diameter optical presetter — match pilot + spotface, count
          cavity steps, and classify shallow ports or multi-stage cartridge
          valve cavities (C08–C16).
        </p>
      </header>

      <OpticalPresetter
        formSizes={formSizes}
        onResult={handleOpticalResult}
        saving={saving}
      />

      {saveMessage ? <p className="status save-status">{saveMessage}</p> : null}

      <FormSizeEditor
        formSizes={formSizes}
        standards={standards}
        saving={saving}
        onChanged={async () => {
          await loadStandards()
          setSaveMessage('Shop form sizes refreshed for optical matching.')
        }}
      />

      <section className="picker" aria-labelledby="picker-heading">
        <div className="section-copy">
          <h2 id="picker-heading">Standard lookup</h2>
          <p>
            {loading
              ? 'Loading standards…'
              : source === 'supabase'
                ? `${standards.length} standards · ${formSizes.length} form sizes`
                : `Offline fallback (${standards.length})`}
          </p>
        </div>

        <label className="field" htmlFor="standard-select">
          <span>Port standard</span>
          <select
            id="standard-select"
            value={selectedId}
            disabled={loading || !standards.length}
            onChange={(e) => setSelectedId(e.target.value)}
          >
            <option value="">Select a standard…</option>
            {[...families.entries()].map(([family, items]) => (
              <optgroup key={family} label={family}>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.short_name} — {item.specification || item.code}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>

        {selected ? (
          <article className="standard-detail">
            <div className="detail-topline">
              <h3>{selected.name}</h3>
              <span className="pill">{selected.family}</span>
            </div>
            <dl>
              <div>
                <dt>Spec</dt>
                <dd>{selected.specification || '—'}</dd>
              </div>
              <div>
                <dt>Seal</dt>
                <dd>{selected.seal_type || '—'}</dd>
              </div>
              <div>
                <dt>Thread</dt>
                <dd>{selected.thread_form || '—'}</dd>
              </div>
              <div>
                <dt>Also known as</dt>
                <dd>{(selected.common_aliases || []).join(', ') || '—'}</dd>
              </div>
            </dl>
            <p>{selected.description}</p>
            <p className="tips">
              <strong>ID tip:</strong> {selected.identification_tips}
            </p>
            {(selected.common_sizes || []).length > 0 ? (
              <ul className="size-row">
                {selected.common_sizes.map((size) => (
                  <li key={size}>{size}</li>
                ))}
              </ul>
            ) : null}
            {selectedFormSizes.length > 0 ? (
              <div className="form-size-table">
                <h4>Form sizes (shop / catalog)</h4>
                <ul>
                  {selectedFormSizes.map((row) => (
                    <li key={row.id}>
                      <strong>{row.size_token}</strong> — D₁{' '}
                      {(row.max_diameter ?? row.spotface_diameter).toFixed(3)}″ /
                      pilot {row.pilot_diameter.toFixed(3)}″
                      {row.functional_depth != null
                        ? ` / depth ${row.functional_depth.toFixed(3)}″`
                        : ''}
                      {row.step_count != null
                        ? ` · ${row.step_count} step${row.step_count === 1 ? '' : 's'}`
                        : ''}
                      {row.notes ? ` · ${row.notes}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </article>
        ) : (
          <p className="empty-hint">
            Optical matches select a standard here automatically.
          </p>
        )}
      </section>

      <details className="secondary-panel">
        <summary>Add standards from PDF / chart photo</summary>
        <StandardsImporter
          existingCodes={existingCodes}
          onImported={handleImported}
          saving={saving}
        />
      </details>

      <footer className="app-footer">
        Nick Wall Design · Tool Identifier
      </footer>
    </div>
  )
}

export default App
