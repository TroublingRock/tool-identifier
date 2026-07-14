import { useMemo, useState } from 'react'
import { isSupabaseConfigured, portDb } from '../lib/supabase'

const EMPTY = {
  id: null,
  standard_id: '',
  size_token: '',
  form_category: 'cartridge',
  cavity_class: '',
  step_count: '4',
  max_diameter: '',
  pilot_diameter: '',
  spotface_diameter: '',
  functional_depth: '',
  notes: 'Shop measured',
  display_name: '',
}

function parseTokenHints(token) {
  const t = String(token || '').trim().toUpperCase()
  const classMatch = t.match(/^(C\d{2})/)
  const wayMatch = t.match(/-(\d+)$/)
  return {
    cavity_class: classMatch ? classMatch[1] : '',
    step_count: wayMatch ? wayMatch[1] : '',
    looksCartridge: Boolean(classMatch),
  }
}

function toNum(v) {
  if (v === '' || v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function shopCodeFromToken(token) {
  const clean = String(token || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
  return `SHOP_${clean || 'FORM'}`
}

export default function FormSizeEditor({
  formSizes = [],
  standards = [],
  onChanged,
  saving: parentSaving,
}) {
  const [filter, setFilter] = useState('all')
  const [draft, setDraft] = useState(EMPTY)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const rows = useMemo(() => {
    const list = [...formSizes]
    list.sort((a, b) => {
      const ca = `${a.cavity_class || ''}${a.size_token}`
      const cb = `${b.cavity_class || ''}${b.size_token}`
      return ca.localeCompare(cb)
    })
    if (filter === 'cartridge') {
      return list.filter((r) => r.form_category === 'cartridge')
    }
    if (filter === 'shallow') {
      return list.filter((r) => r.form_category !== 'cartridge')
    }
    return list
  }, [formSizes, filter])

  function startNew() {
    setMsg('')
    setDraft({ ...EMPTY })
  }

  function applyTokenHints(token) {
    const hints = parseTokenHints(token)
    if (!hints.looksCartridge) return
    setDraft((prev) => ({
      ...prev,
      size_token: token,
      form_category: 'cartridge',
      cavity_class: prev.cavity_class || hints.cavity_class,
      step_count: prev.step_count || hints.step_count || prev.step_count,
      display_name:
        prev.display_name ||
        (hints.cavity_class
          ? `Shop cavity ${String(token).trim().toUpperCase()}`
          : prev.display_name),
    }))
  }

  function startEdit(row) {
    setMsg('')
    setDraft({
      id: row.id,
      standard_id: row.standard_id || '',
      size_token: row.size_token || '',
      form_category: row.form_category || 'shallow',
      cavity_class: row.cavity_class || '',
      step_count:
        row.step_count != null ? String(row.step_count) : '1',
      max_diameter:
        row.max_diameter != null
          ? String(row.max_diameter)
          : String(row.spotface_diameter ?? ''),
      pilot_diameter:
        row.pilot_diameter != null ? String(row.pilot_diameter) : '',
      spotface_diameter:
        row.spotface_diameter != null ? String(row.spotface_diameter) : '',
      functional_depth:
        row.functional_depth != null ? String(row.functional_depth) : '',
      notes: row.notes || 'Shop measured',
      display_name: row.standard_name || row.short_name || row.size_token,
    })
  }

  function setField(key, value) {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  async function handleSave(event) {
    event.preventDefault()
    setMsg('')

    const sizeToken = draft.size_token.trim().toUpperCase()
    const pilot = toNum(draft.pilot_diameter)
    const spot =
      toNum(draft.spotface_diameter) ?? toNum(draft.max_diameter)
    const maxDia = toNum(draft.max_diameter) ?? spot
    const depth = toNum(draft.functional_depth)
    const steps = Number(draft.step_count)

    if (!sizeToken) {
      setMsg('Size label is required (e.g. C16-4).')
      return
    }
    if (pilot == null || spot == null) {
      setMsg('Pilot and max/spotface diameters are required.')
      return
    }
    if (!Number.isFinite(steps) || steps < 1) {
      setMsg('Step count must be at least 1.')
      return
    }

    if (!isSupabaseConfigured) {
      setMsg('Cloud sync is not configured — cannot save shop sizes.')
      return
    }

    setBusy(true)
    try {
      let standardId = draft.standard_id || null

      if (draft.id && standardId) {
        const { error: stdErr } = await portDb()
          .from('port_standards')
          .update({
            name:
              draft.display_name.trim() ||
              `Shop cavity ${sizeToken}`,
            short_name: sizeToken,
            family:
              draft.form_category === 'cartridge'
                ? 'Cartridge Cavity'
                : 'Shop Port',
            specification: `Shop-defined ${sizeToken}`,
            source: 'shop_measured',
            source_notes: 'Operator-entered dimensions (not OEM chart data)',
            is_active: true,
          })
          .eq('id', standardId)
        if (stdErr) throw stdErr
      } else if (!draft.id) {
        const existingSameLabel = formSizes.find(
          (r) =>
            String(r.size_token).toUpperCase() === sizeToken &&
            (!draft.id || r.id !== draft.id),
        )
        if (existingSameLabel) {
          setMsg(
            `${sizeToken} already exists — select it in the list to edit, or pick a different label.`,
          )
          setBusy(false)
          startEdit(existingSameLabel)
          return
        }

        const code = shopCodeFromToken(sizeToken)
        const name =
          draft.display_name.trim() || `Shop cavity ${sizeToken}`
        const { data: upserted, error: stdErr } = await portDb()
          .from('port_standards')
          .upsert(
            {
              code,
              name,
              short_name: sizeToken,
              family:
                draft.form_category === 'cartridge'
                  ? 'Cartridge Cavity'
                  : 'Shop Port',
              seal_type: null,
              thread_form: null,
              specification: `Shop-defined ${sizeToken}`,
              description:
                'Operator-defined tooling dimensions for optical matching. Not sourced from OEM proprietary charts.',
              identification_tips:
                'Match by max diameter, pilot, step count, and functional depth from shop micrometer / optical peak measurements.',
              common_sizes: [sizeToken],
              common_aliases: [sizeToken],
              sort_order: 800,
              is_active: true,
              source: 'shop_measured',
              source_notes:
                'Operator-entered dimensions (not OEM chart data)',
            },
            { onConflict: 'code' },
          )
          .select('id')
          .single()
        if (stdErr) throw stdErr
        standardId = upserted.id
      }

      if (!standardId) throw new Error('Could not resolve standard row.')

      const payload = {
        standard_id: standardId,
        size_token: sizeToken,
        pilot_diameter: pilot,
        spotface_diameter: spot,
        max_diameter: maxDia,
        functional_depth: depth,
        step_count: steps,
        form_category: draft.form_category || 'shallow',
        cavity_class:
          draft.form_category === 'cartridge'
            ? (draft.cavity_class || parseTokenHints(sizeToken).cavity_class || null)
            : null,
        notes: draft.notes?.trim() || 'Shop measured',
      }

      if (draft.id) {
        const { error } = await portDb()
          .from('port_form_sizes')
          .update(payload)
          .eq('id', draft.id)
        if (error) throw error
        setMsg(`Updated ${sizeToken}.`)
      } else {
        const { error } = await portDb().from('port_form_sizes').insert(payload)
        if (error) throw error
        setMsg(`Added ${sizeToken} as shop-defined form size.`)
      }

      await onChanged?.()
      startNew()
    } catch (err) {
      setMsg(err.message || 'Save failed.')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete() {
    if (!draft.id) return
    if (
      !window.confirm(
        `Delete shop form size ${draft.size_token}? This removes it from optical matching.`,
      )
    ) {
      return
    }

    setBusy(true)
    setMsg('')
    try {
      const { error } = await portDb()
        .from('port_form_sizes')
        .delete()
        .eq('id', draft.id)
      if (error) throw error
      setMsg(`Deleted ${draft.size_token}.`)
      await onChanged?.()
      startNew()
    } catch (err) {
      setMsg(err.message || 'Delete failed.')
    } finally {
      setBusy(false)
    }
  }

  const disabled = busy || parentSaving

  return (
    <section className="form-editor" aria-labelledby="form-editor-heading">
      <div className="section-copy">
        <h2 id="form-editor-heading">Shop form sizes</h2>
        <p>
          Manually define diameters, depth, and step count for tools you
          measure in-house (e.g. C16-4). These are shop values for matching —
          not OEM chart imports.
        </p>
      </div>

      <div className="form-editor-filters" role="group" aria-label="Filter sizes">
        {[
          ['all', 'All'],
          ['cartridge', 'Cartridge'],
          ['shallow', 'Shallow'],
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`btn ${filter === id ? 'primary' : 'ghost'}`}
            onClick={() => setFilter(id)}
          >
            {label}
          </button>
        ))}
        <button type="button" className="btn ghost" onClick={startNew}>
          New size
        </button>
      </div>

      <div className="form-editor-layout">
        <div className="form-editor-list">
          {rows.length === 0 ? (
            <p className="empty-hint">No form sizes in this filter.</p>
          ) : (
            <ul>
              {rows.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    className={
                      draft.id === row.id ? 'form-row-btn active' : 'form-row-btn'
                    }
                    onClick={() => startEdit(row)}
                  >
                    <strong>{row.size_token}</strong>
                    <span>
                      D₁ {(row.max_diameter ?? row.spotface_diameter).toFixed(3)}″ ·
                      pilot {row.pilot_diameter.toFixed(3)}″
                      {row.step_count != null ? ` · ${row.step_count} step` : ''}
                      {row.step_count === 1 ? '' : row.step_count != null ? 's' : ''}
                    </span>
                    <small>
                      {row.form_category}
                      {row.notes ? ` · ${row.notes}` : ''}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form className="form-editor-panel" onSubmit={handleSave}>
          <h3>{draft.id ? `Edit ${draft.size_token}` : 'Add shop size'}</h3>

          <label className="field">
            <span>Size label</span>
            <input
              value={draft.size_token}
              onChange={(e) => setField('size_token', e.target.value)}
              onBlur={(e) => {
                if (!draft.id) applyTokenHints(e.target.value)
              }}
              placeholder="C16-4"
              disabled={disabled}
              required
            />
          </label>

          <label className="field">
            <span>Display name</span>
            <input
              value={draft.display_name}
              onChange={(e) => setField('display_name', e.target.value)}
              placeholder="Shop cavity C16-4"
              disabled={disabled}
            />
          </label>

          <div className="form-editor-grid">
            <label className="field">
              <span>Category</span>
              <select
                value={draft.form_category}
                onChange={(e) => setField('form_category', e.target.value)}
                disabled={disabled}
              >
                <option value="cartridge">Cartridge cavity</option>
                <option value="shallow">Shallow port</option>
              </select>
            </label>

            <label className="field">
              <span>Cavity class</span>
              <input
                value={draft.cavity_class}
                onChange={(e) => setField('cavity_class', e.target.value)}
                placeholder="C16"
                disabled={disabled || draft.form_category !== 'cartridge'}
              />
            </label>

            <label className="field">
              <span>Step count</span>
              <input
                type="number"
                min="1"
                step="1"
                value={draft.step_count}
                onChange={(e) => setField('step_count', e.target.value)}
                disabled={disabled}
                required
              />
            </label>
          </div>

          <div className="form-editor-grid">
            <label className="field">
              <span>Max diameter D₁ (in)</span>
              <input
                type="number"
                min="0.01"
                step="0.0001"
                inputMode="decimal"
                value={draft.max_diameter}
                onChange={(e) => {
                  setField('max_diameter', e.target.value)
                  if (!draft.spotface_diameter) {
                    setField('spotface_diameter', e.target.value)
                  }
                }}
                disabled={disabled}
                required
              />
            </label>

            <label className="field">
              <span>Pilot / tip (in)</span>
              <input
                type="number"
                min="0.01"
                step="0.0001"
                inputMode="decimal"
                value={draft.pilot_diameter}
                onChange={(e) => setField('pilot_diameter', e.target.value)}
                disabled={disabled}
                required
              />
            </label>

            <label className="field">
              <span>Spotface / major (in)</span>
              <input
                type="number"
                min="0.01"
                step="0.0001"
                inputMode="decimal"
                value={draft.spotface_diameter}
                onChange={(e) => setField('spotface_diameter', e.target.value)}
                disabled={disabled}
              />
            </label>

            <label className="field">
              <span>Functional depth (in)</span>
              <input
                type="number"
                min="0"
                step="0.0001"
                inputMode="decimal"
                value={draft.functional_depth}
                onChange={(e) => setField('functional_depth', e.target.value)}
                disabled={disabled}
              />
            </label>
          </div>

          <label className="field">
            <span>Notes</span>
            <input
              value={draft.notes}
              onChange={(e) => setField('notes', e.target.value)}
              placeholder="Shop measured from known good tool"
              disabled={disabled}
            />
          </label>

          <div className="form-editor-actions">
            <button
              type="submit"
              className="btn primary"
              disabled={disabled}
            >
              {busy ? 'Saving…' : draft.id ? 'Save changes' : 'Add size'}
            </button>
            {draft.id ? (
              <button
                type="button"
                className="btn ghost"
                disabled={disabled}
                onClick={handleDelete}
              >
                Delete
              </button>
            ) : null}
            {draft.id || draft.size_token ? (
              <button
                type="button"
                className="btn ghost"
                disabled={disabled}
                onClick={startNew}
              >
                Clear
              </button>
            ) : null}
          </div>

          {msg ? <p className="status save-status">{msg}</p> : null}

          {!isSupabaseConfigured ? (
            <p className="status error">
              Cloud sync is not configured — sizes cannot be saved yet.
            </p>
          ) : null}

          <p className="empty-hint">
            New labels are saved as shop standards for optical matching on this
            device and your connected catalog.
          </p>
        </form>
      </div>
    </section>
  )
}
