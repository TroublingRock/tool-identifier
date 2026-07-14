import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

export const isSupabaseConfigured = Boolean(url && anonKey)

export const supabase = isSupabaseConfigured
  ? createClient(url, anonKey, {
      db: { schema: 'port_calculator' },
    })
  : null

/** Always query Port Tool tables via the isolated schema. Never use public/ShopQuote. */
export function portDb() {
  if (!supabase) {
    throw new Error('Supabase is not configured')
  }
  return supabase.schema('port_calculator')
}
