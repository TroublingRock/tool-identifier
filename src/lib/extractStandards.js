/** Known hydraulic port patterns to detect in PDF text or OCR. */
const KNOWN_PATTERNS = [
  {
    match: /\b(SAE\s*)?J1926\b|\bSAE\s*ORB\b|\bO[- ]?RING BOSS\b|\bORB\b/i,
    code: 'SAE_ORB',
    short_name: 'SAE ORB',
    name: 'SAE Straight Thread O-Ring Boss',
    family: 'O-Ring Boss',
    specification: 'SAE J1926 / ISO 11926',
    seal_type: 'Elastomer O-ring in port chamfer',
    thread_form: 'UN/UNF straight',
  },
  {
    match: /\bISO\s*6149\b|\bMETRIC\s+O[- ]?RING\b/i,
    code: 'METRIC_ISO_6149',
    short_name: 'ISO 6149',
    name: 'Metric O-Ring Boss Port',
    family: 'O-Ring Boss',
    specification: 'ISO 6149',
    seal_type: 'Elastomer O-ring',
    thread_form: 'Metric straight',
  },
  {
    match: /\b(SAE\s*)?J514\b|\bJIC\b|\b37\s*°?\s*FLARE\b|\bTRIPLE[- ]?LOK\b/i,
    code: 'SAE_JIC_37',
    short_name: 'JIC 37°',
    name: 'SAE 37° Flare (JIC)',
    family: 'Flare',
    specification: 'SAE J514 / ISO 8434-2',
    seal_type: 'Metal-to-metal 37° cone',
    thread_form: 'UN/UNF straight',
    common_aliases: ['Triple-Lok'],
  },
  {
    match: /\b45\s*°?\s*FLARE\b/i,
    code: 'SAE_45_FLARE',
    short_name: '45° Flare',
    name: 'SAE 45° Flare',
    family: 'Flare',
    specification: 'SAE J512 (select sizes)',
    seal_type: 'Metal-to-metal 45° cone',
    thread_form: 'UN/UNF straight',
  },
  {
    match: /\b(SAE\s*)?J1453\b|\bORFS\b|\bO[- ]?RING FACE SEAL\b|\bSEAL[- ]?LOK\b/i,
    code: 'SAE_ORFS',
    short_name: 'ORFS',
    name: 'O-Ring Face Seal',
    family: 'Face Seal',
    specification: 'SAE J1453 / ISO 8434-3',
    seal_type: 'Elastomer O-ring in face groove',
    thread_form: 'UN/UNF straight',
    common_aliases: ['Seal-Lok', 'Seal-Lok Lite'],
  },
  {
    match: /\bISO\s*8434-?1\b|\b24\s*°?\s*CONE\b|\bDIN\s*2353\b|\bEO-?2?\b|\bERMETO\b/i,
    code: 'ISO_8434_1_24',
    short_name: '24° Cone',
    name: '24° Cone / Bite-Type (EO style)',
    family: 'Bite / Progressive Ring',
    specification: 'ISO 8434-1 / DIN 2353',
    seal_type: 'Metal bite + optional elastomeric seal',
    thread_form: 'Metric tube',
    common_aliases: ['EO', 'EO-2', 'Ermeto'],
  },
  {
    match: /\bFERULOK\b|\bFLARELESS\b/i,
    code: 'SAE_FLARELESS',
    short_name: 'Flareless',
    name: 'SAE Flareless Bite-Type',
    family: 'Bite / Progressive Ring',
    specification: 'SAE J514 flareless',
    seal_type: 'Metal bite ring',
    thread_form: 'UN/UNF / tube',
    common_aliases: ['Ferulok'],
  },
  {
    match: /\bCODE\s*61\b|\bISO\s*6162-?1\b|\b(SAE\s*)?J518\b.*61/i,
    code: 'CODE_61',
    short_name: 'Code 61',
    name: 'SAE Code 61 Split Flange',
    family: 'Flange',
    specification: 'SAE J518 / ISO 6162-1',
    seal_type: 'O-ring face in flange head',
    thread_form: '4-bolt flange',
  },
  {
    match: /\bCODE\s*62\b|\bISO\s*6162-?2\b/i,
    code: 'CODE_62',
    short_name: 'Code 62',
    name: 'SAE Code 62 Split Flange',
    family: 'Flange',
    specification: 'SAE J518 / ISO 6162-2',
    seal_type: 'O-ring face in flange head',
    thread_form: '4-bolt flange',
  },
  {
    match: /\bNPTF\b|\bDRYSEAL\b/i,
    code: 'NPTF',
    short_name: 'NPTF',
    name: 'National Pipe Taper Fuel (Dryseal)',
    family: 'Pipe Thread',
    specification: 'SAE J476 / ASME B1.20.3',
    seal_type: 'Dryseal metal interference',
    thread_form: 'Tapered NPTF',
  },
  {
    match: /\bNPT\b(?!F)/i,
    code: 'NPT',
    short_name: 'NPT',
    name: 'National Pipe Taper',
    family: 'Pipe Thread',
    specification: 'ASME B1.20.1',
    seal_type: 'Thread sealant / PTFE tape',
    thread_form: 'Tapered NPT',
  },
  {
    match: /\bBSPP\b|\bG\s*THREAD\b|\bISO\s*1179\b|\bISO\s*228\b/i,
    code: 'BSPP',
    short_name: 'BSPP (G)',
    name: 'British Standard Pipe Parallel',
    family: 'Pipe Thread',
    specification: 'ISO 1179 / ISO 228',
    seal_type: 'Bonded washer / O-ring face',
    thread_form: 'Parallel BSP (G)',
  },
  {
    match: /\bBSPT\b|\bR\s*THREAD\b|\bISO\s*7-?1\b/i,
    code: 'BSPT',
    short_name: 'BSPT (R)',
    name: 'British Standard Pipe Taper',
    family: 'Pipe Thread',
    specification: 'ISO 7-1',
    seal_type: 'Thread sealant',
    thread_form: 'Tapered BSP (R/Rc)',
  },
  {
    match: /\bDIN\s*3852\s*FORM\s*A\b|\bFORM\s*A\b.*DIN/i,
    code: 'DIN_3852_A',
    short_name: 'DIN Form A',
    name: 'DIN 3852 Form A (Cutting Face)',
    family: 'Metric Port',
    specification: 'DIN 3852-1 Form A',
    seal_type: 'Metal cutting edge',
    thread_form: 'Metric parallel',
  },
  {
    match: /\bDIN\s*3852\s*FORM\s*B\b|\bFORM\s*B\b.*DIN/i,
    code: 'DIN_3852_B',
    short_name: 'DIN Form B',
    name: 'DIN 3852 Form B (Soft Seal / Washer)',
    family: 'Metric Port',
    specification: 'DIN 3852-1 Form B',
    seal_type: 'Bonded washer',
    thread_form: 'Metric parallel',
  },
  {
    match: /\bDIN\s*3852\s*FORM\s*E\b|\bISO\s*9974\b/i,
    code: 'DIN_3852_E',
    short_name: 'DIN Form E',
    name: 'DIN 3852 Form E / ISO 9974 O-Ring',
    family: 'Metric Port',
    specification: 'DIN 3852-1 Form E / ISO 9974-1',
    seal_type: 'Elastomer O-ring',
    thread_form: 'Metric parallel',
  },
  {
    match: /\bNPSM\b/i,
    code: 'NPSM',
    short_name: 'NPSM',
    name: 'National Pipe Straight Mechanical',
    family: 'Pipe Thread',
    specification: 'ASME B1.20.1',
    seal_type: 'Mechanical seat (often 60°)',
    thread_form: 'Parallel NPSM',
  },
  {
    match: /\bKOMATSU\b|\bJIS\b/i,
    code: 'JIS_KOMATSU',
    short_name: 'JIS/Komatsu',
    name: 'JIS / Komatsu Flare Style',
    family: 'Flange / Flare',
    specification: 'JIS B2351 / OEM',
    seal_type: 'Metal or O-ring depending on style',
    thread_form: 'Metric / special',
  },
]

const SIZE_RE =
  /\b(-\d{1,2}|M\d{1,2}(?:x[\d.]+)?|G\d\/\d|R\d\/\d|\d\/\d["″]?|\d-\d\/\d["″]?|\d+(?:\.\d+)?\s*mm)\b/gi

function slugCode(value) {
  return value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40)
}

function uniqueSizes(text) {
  const found = [...text.matchAll(SIZE_RE)].map((m) => m[1] || m[0])
  return [...new Set(found)].slice(0, 24)
}

function buildCandidate(base, snippet, selected = true) {
  return {
    id: `draft-${base.code}`,
    selected,
    code: base.code,
    short_name: base.short_name,
    name: base.name,
    family: base.family || 'Imported',
    specification: base.specification || null,
    seal_type: base.seal_type || null,
    thread_form: base.thread_form || null,
    description:
      base.description ||
      `Imported from chart/PDF. Matched excerpt: ${snippet.slice(0, 160)}`,
    identification_tips:
      base.identification_tips ||
      'Verify against the source catalog before using for critical work.',
    common_sizes: uniqueSizes(snippet),
    common_aliases: base.common_aliases || [],
    sort_order: base.sort_order ?? 500,
    source: 'import',
    source_notes: snippet.slice(0, 280),
  }
}

/**
 * Parse OCR / PDF text into draft port standards for review + save.
 */
export function extractStandardsFromText(rawText) {
  const text = (rawText || '').replace(/\s+/g, ' ').trim()
  if (!text) return []

  const byCode = new Map()

  for (const pattern of KNOWN_PATTERNS) {
    if (!pattern.match.test(text)) continue
    const start = text.search(pattern.match)
    const snippet = text.slice(Math.max(0, start - 40), start + 180)
    byCode.set(pattern.code, buildCandidate(pattern, snippet || text))
  }

  // Freeform lines that look like named standards not already matched
  const lines = rawText
    .split(/\r?\n|·|\|/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 6 && line.length <= 90)

  for (const line of lines) {
    if (
      !/(port|thread|flare|flange|orb|orfs|npt|bsp|metric|sae|iso|din|jic)/i.test(
        line,
      )
    ) {
      continue
    }
    if (KNOWN_PATTERNS.some((p) => p.match.test(line))) continue

    const code = `IMP_${slugCode(line) || 'STANDARD'}`
    if (byCode.has(code)) continue

    byCode.set(
      code,
      buildCandidate(
        {
          code,
          short_name: line.slice(0, 40),
          name: line.slice(0, 120),
          family: 'Imported',
          specification: null,
          seal_type: null,
          thread_form: null,
          sort_order: 600,
        },
        line,
        false,
      ),
    )
  }

  return [...byCode.values()]
}
