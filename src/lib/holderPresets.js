import { isSupabaseConfigured, portDb } from './supabase'

export const BUILTIN_HOLDER_PRESETS = [
  { id: 'er20', label: 'ER20 Collet Nut = 1.339″', inches: 1.339, builtin: true },
  { id: 'er25', label: 'ER25 Collet Nut = 1.654″', inches: 1.654, builtin: true },
  { id: 'er32', label: 'ER32 Collet Nut = 1.968″', inches: 1.968, builtin: true },
  { id: 'er40', label: 'ER40 Collet Nut = 2.480″', inches: 2.48, builtin: true },
  { id: 'er50', label: 'ER50 Collet Nut ≈ 3.071″', inches: 3.071, builtin: true },
  { id: 'cat40', label: 'CAT40 Flange ≈ 2.750″', inches: 2.75, builtin: true },
  { id: 'cat50', label: 'CAT50 Flange ≈ 3.875″', inches: 3.875, builtin: true },
]

export const CUSTOM_OPTION_ID = '__custom__'
const LOCAL_KEY = 'tool-identifier.custom-holders.v1'

function slugCode(label, inches) {
  const base = String(label || 'custom')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 28)
  const inchPart = Number(inches).toFixed(4).replace('.', 'p')
  return `CUSTOM_${base || 'HOLDER'}_${inchPart}`
}

export function formatHolderLabel(name, inches) {
  const n = Number(inches)
  return `${name.trim()} = ${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}″`
}

export function loadLocalCustomHolders() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((h) => h && h.id && Number(h.inches) > 0)
      .map((h) => ({
        id: h.id,
        code: h.code || h.id,
        label: h.label,
        inches: Number(h.inches),
        builtin: false,
        custom: true,
      }))
  } catch {
    return []
  }
}

export function saveLocalCustomHolders(holders) {
  const payload = holders.map((h) => ({
    id: h.id,
    code: h.code || h.id,
    label: h.label,
    inches: Number(h.inches),
  }))
  localStorage.setItem(LOCAL_KEY, JSON.stringify(payload))
}

/**
 * Load builtins + local customs + Supabase customs (port_calculator only).
 */
export async function loadAllHolders() {
  const local = loadLocalCustomHolders()
  let remote = []

  if (isSupabaseConfigured) {
    try {
      const { data, error } = await portDb()
        .from('holder_presets')
        .select('id, code, label, inches')
        .order('inches', { ascending: true })
      if (!error && data?.length) {
        remote = data.map((row) => ({
          id: row.code || row.id,
          code: row.code,
          label: row.label,
          inches: Number(row.inches),
          builtin: false,
          custom: true,
          remoteId: row.id,
        }))
      }
    } catch {
      /* offline / schema not exposed yet */
    }
  }

  const byId = new Map()
  for (const h of [...local, ...remote]) byId.set(h.id, h)

  return {
    builtins: BUILTIN_HOLDER_PRESETS,
    customs: [...byId.values()].sort((a, b) => a.inches - b.inches),
  }
}

/**
 * Persist a custom holder locally and to port_calculator.holder_presets.
 */
export async function saveCustomHolder({ name, inches }) {
  const value = Number(inches)
  if (!name?.trim()) throw new Error('Enter a name for this nut/holder.')
  if (!(value > 0)) throw new Error('Enter a valid diameter in inches.')

  const label = formatHolderLabel(name, value)
  const code = slugCode(name, value)
  const entry = {
    id: code,
    code,
    label,
    inches: value,
    builtin: false,
    custom: true,
  }

  const existing = loadLocalCustomHolders().filter((h) => h.id !== code)
  existing.push(entry)
  existing.sort((a, b) => a.inches - b.inches)
  saveLocalCustomHolders(existing)

  if (isSupabaseConfigured) {
    const { error } = await portDb()
      .from('holder_presets')
      .upsert(
        {
          code,
          label,
          inches: value,
          is_custom: true,
        },
        { onConflict: 'code' },
      )
    if (error) {
      // Local save succeeded — surface remote issue without failing UX
      return { holder: entry, remoteError: error.message }
    }
  }

  return { holder: entry, remoteError: null }
}

export async function deleteCustomHolder(id) {
  const next = loadLocalCustomHolders().filter((h) => h.id !== id)
  saveLocalCustomHolders(next)

  if (isSupabaseConfigured) {
    await portDb().from('holder_presets').delete().eq('code', id)
  }
}
