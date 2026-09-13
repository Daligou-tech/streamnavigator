'use strict';

// Reads contractor estimates into structured numbers. It does not judge them.
//
// This is the first half of the arrangement api/_lib/rental-audit.js and
// api/_lib/closing-audit.js already describe, brought to the one product that
// never had it. Until now Contractor Navigator made a single model call that
// read the estimate and wrote the verdict in the same breath. That is the
// arrangement rental proved unreliable: a model asked to read AND judge will
// report what caught its eye and stay silent about what did not, and on an
// estimate that means the $4,000 deposit gets mentioned on one run and not the
// next, because nothing is working through a list.
//
// So the rules here are narrow: copy what is printed, classify it into a fixed
// vocabulary, and leave anything not found as null. A null costs the customer
// one skipped check, named in their report. A guess costs them a finding built
// on a number nobody wrote down — and on this product the findings are things
// they are going to say out loud to a contractor, so a wrong one is worse than
// a missing one.

const EXTRACT_MODEL = 'claude-sonnet-5';

const CATEGORIES = ['HVAC', 'Roofing', 'Windows', 'Plumbing', 'Electrical', 'Other'];

const PRESENCE = ['included', 'excluded', 'owner_responsibility', 'not_mentioned'];

const lineItem = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'Copied from the document, not summarised.' },
    quantity: { type: 'number' },
    unit: { type: 'string', description: 'e.g. "each", "sq ft", "square", "hour", "ton".' },
    unit_price: { type: 'number' },
    amount: { type: 'number', description: 'The extended dollar amount printed on this line.' },
    is_allowance: { type: 'boolean', description: 'True only if the document itself calls this an allowance or budget figure.' },
    is_optional: { type: 'boolean', description: 'True only if the document marks this optional, an add-on, or an upgrade not included in the total.' },
  },
  required: ['description'],
};

const QUOTE_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string', description: 'e.g. "Quote 1". Always set.' },
    contractor_name: { type: 'string' },
    license_number: { type: 'string', description: 'Exactly as printed, including any prefix letters. Null if absent.' },
    quote_date: { type: 'string', description: 'ISO date if legible.' },
    quote_expires: { type: 'string', description: 'ISO date the quote says it expires or the price is held until.' },

    total_price: { type: 'number', description: 'The bottom-line contract price the homeowner would sign for.' },
    subtotal: { type: 'number', description: 'The pre-tax subtotal if one is printed separately.' },
    tax_amount: { type: 'number' },
    tax_rate_stated: { type: 'number', description: 'As a percentage, e.g. 8.25, only if the document prints a rate.' },
    discount_amount: { type: 'number', description: 'Any discount, rebate or credit subtracted on the document.' },

    line_items: { type: 'array', items: lineItem },
    line_items_are_priced: {
      type: 'boolean',
      description: 'True only if the line items carry their own dollar amounts. False for a scope list with one lump-sum price.',
    },
    line_items_complete: {
      type: 'boolean',
      description: 'True only if you transcribed EVERY priced line on the document. False if any was cut off, illegible, or omitted for length.',
    },

    deposit_amount: { type: 'number', description: 'Money due at signing or before work starts.' },
    deposit_percent_stated: { type: 'number' },
    payment_schedule: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          trigger: { type: 'string', description: 'What causes this payment, copied from the document.' },
          amount: { type: 'number' },
          percent: { type: 'number' },
          is_before_work_starts: { type: 'boolean' },
        },
      },
    },

    start_date_stated: { type: 'boolean' },
    completion_date_stated: { type: 'boolean' },
    permit: { type: 'string', enum: PRESENCE },
    haul_away_disposal: { type: 'string', enum: PRESENCE },

    warranty_labor_years: { type: 'number' },
    warranty_materials_years: { type: 'number', description: 'The manufacturer warranty on parts or materials.' },
    warranty_text: { type: 'string', description: 'Copied, not summarised. Null if the document says nothing about warranty.' },

    exclusions: { type: 'array', items: { type: 'string' }, description: 'Copied from any exclusions or "not included" section.' },
    change_order_clause: {
      type: 'string',
      enum: ['written_approval_required', 'mentioned_without_terms', 'absent'],
    },
    lien_waiver_mentioned: { type: 'boolean' },
    insurance_evidence_mentioned: { type: 'boolean', description: 'Does the document state liability insurance or workers compensation coverage?' },
    right_to_cancel_notice: { type: 'boolean', description: 'Does the document carry a three-day right-to-cancel notice?' },

    financing_offered: { type: 'boolean' },
    financing_apr_stated: { type: 'number' },
    financing_promo_text: { type: 'string', description: 'e.g. "0% for 18 months", copied.' },
    tax_credit_claims: {
      type: 'array',
      items: { type: 'string' },
      description: 'Any claim on the document that the homeowner will receive a federal or state tax credit or rebate. Copied verbatim.',
    },
    pressure_language: {
      type: 'array',
      items: { type: 'string' },
      description: 'Copied phrases that condition the price on signing quickly — "today only", "this price expires tonight". Empty if none.',
    },

    hvac: {
      type: 'object',
      properties: {
        tons: { type: 'number', description: 'Cooling capacity in tons. 36,000 BTU is 3 tons.' },
        seer2: { type: 'number' },
        seer_legacy: { type: 'number', description: 'Only if the document prints SEER rather than SEER2.' },
        hspf2: { type: 'number' },
        refrigerant: { type: 'string', description: 'e.g. "R-410A", "R-454B", "R-32".' },
        system_type: { type: 'string', description: 'e.g. "split system AC", "heat pump", "packaged unit", "furnace only", "mini split".' },
        indoor_unit_included: { type: 'boolean', description: 'Is the evaporator coil, air handler or furnace being replaced too?' },
        ductwork: { type: 'string', enum: PRESENCE },
        line_set: { type: 'string', enum: ['replaced', 'reused', 'flushed', 'not_mentioned'] },
        load_calculation_mentioned: { type: 'boolean', description: 'Does the document mention a Manual J or load calculation?' },
        brand: { type: 'string' },
        model_numbers: { type: 'array', items: { type: 'string' } },
      },
    },
    roofing: {
      type: 'object',
      properties: {
        squares: { type: 'number', description: 'Roofing squares. 1 square is 100 sq ft.' },
        roof_area_sqft: { type: 'number' },
        tear_off: { type: 'string', enum: ['full_tear_off', 'overlay', 'not_mentioned'] },
        layers_removed: { type: 'number' },
        shingle_type: { type: 'string' },
        underlayment: { type: 'string', enum: PRESENCE },
        ice_water_shield: { type: 'string', enum: PRESENCE },
        drip_edge: { type: 'string', enum: PRESENCE },
        ventilation: { type: 'string', enum: PRESENCE },
        flashing: { type: 'string', enum: ['new', 'reused', 'not_mentioned'] },
        decking_terms: { type: 'string', description: 'Copied wording about replacing rotten decking and what it costs per sheet.' },
      },
    },
    windows: {
      type: 'object',
      properties: {
        window_count: { type: 'number' },
        install_type: { type: 'string', enum: ['insert', 'full_frame', 'not_stated'] },
        frame_material: { type: 'string' },
        u_factor: { type: 'number' },
        shgc: { type: 'number' },
        interior_trim: { type: 'string', enum: PRESENCE },
        exterior_capping: { type: 'string', enum: PRESENCE },
      },
    },
    plumbing: {
      type: 'object',
      properties: {
        work_type: { type: 'string', description: 'e.g. "water heater replacement", "repipe", "sewer line".' },
        water_heater_type: { type: 'string', enum: ['tank', 'tankless', 'heat_pump', 'not_applicable'] },
        water_heater_gallons: { type: 'number' },
        expansion_tank: { type: 'string', enum: PRESENCE },
      },
    },
    electrical: {
      type: 'object',
      properties: {
        work_type: { type: 'string', description: 'e.g. "200A panel upgrade", "rewire", "EV charger circuit".' },
        panel_amps: { type: 'number' },
        inspection_included: { type: 'string', enum: PRESENCE },
      },
    },
  },
  required: ['label'],
};

const EXTRACT_TOOL = {
  name: 'record_contractor_estimates',
  description: 'Record what each estimate document says, without interpreting it.',
  input_schema: {
    type: 'object',
    properties: {
      category: { type: 'string', enum: CATEGORIES, description: 'The trade this work belongs to, from the documents.' },
      documents_seen: {
        type: 'array',
        items: { type: 'string' },
        description: 'One short line per document you were shown, saying what it is.',
      },
      quotes: { type: 'array', items: QUOTE_SCHEMA },
      scope_lines: {
        type: 'array',
        items: { type: 'string' },
        description: 'The work described, copied plainly, one line per distinct piece of scope across all quotes.',
      },
      unreadable: {
        type: 'array',
        items: { type: 'string' },
        description: 'Anything you could not read: a cut-off page, a blurred total, a handwritten figure. Name the document and what was lost.',
      },
    },
    required: ['quotes'],
  },
};

const EXTRACT_SYSTEM = `You are transcribing home improvement estimates for Contractor Navigator. Your only job \
is to record what is printed. Something else decides what it means.

Rules, in order of importance:

1. Never write a number that is not on the document. If a figure is not printed, leave the field out. A missing \
field costs the homeowner one named check. An invented field costs them a false accusation they will repeat to \
a contractor's face.

2. Do not compute. Do not add the line items to fill in a missing total, do not derive a deposit percentage, do \
not convert BTU to tons unless the document prints BTU and you are filling the tons field — say so is fine, but \
never fill subtotal, tax, or total by arithmetic. The audit does its own arithmetic and needs to compare your \
transcription against the document's own totals; filling a gap yourself destroys exactly the comparison it makes.

3. line_items_complete is a promise. Set it true only if every priced line on that document is in your array. If \
you skipped, merged, summarised or could not read even one, set it false. Several checks are switched off by a \
false here, which is the correct outcome — a subtotal check on a partial list produces a fake discrepancy.

4. is_allowance and is_optional are true only when the document uses that language itself. Do not infer.

5. Enumerated fields: use "not_mentioned" when the document is silent. "excluded" means the document says it is \
not included. These are different findings and must not be blurred.

6. One entry in quotes per estimate document. If a single contractor supplied two pages of one estimate, that is \
one quote. If one page carries two priced options, record the option the homeowner would be signing for and put \
the other in exclusions or line_items marked is_optional.

7. Copy contractor names and licence numbers exactly, including prefix letters and punctuation. A licence number \
retyped wrong is worse than none, because it sends the homeowner to an empty search result.

Respond only by calling record_contractor_estimates.`;

// Models occasionally hand back a nested object as a JSON string. The content
// is right and only the container is wrong, so open it rather than discard it —
// the same fix api/_lib/rental-extract.js documents.
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  const opener = trimmed.charAt(0);
  if (opener !== '{' && opener !== '[') return value;
  const close = trimmed.lastIndexOf(opener === '{' ? '}' : ']');
  if (close <= 0) return value;
  try {
    return JSON.parse(trimmed.slice(0, close + 1));
  } catch (err) {
    return value;
  }
}

const QUOTE_OBJECT_FIELDS = ['hvac', 'roofing', 'windows', 'plumbing', 'electrical'];
const QUOTE_ARRAY_FIELDS = ['line_items', 'payment_schedule', 'exclusions', 'tax_credit_claims', 'pressure_language'];

function normalizeQuote(raw, index) {
  const q = Object.assign({}, raw || {});
  if (!q.label) q.label = `Quote ${index + 1}`;

  for (const key of QUOTE_OBJECT_FIELDS) {
    const value = parseMaybeJson(q[key]);
    q[key] = (value && typeof value === 'object' && !Array.isArray(value)) ? value : undefined;
  }
  for (const key of QUOTE_ARRAY_FIELDS) {
    const value = parseMaybeJson(q[key]);
    q[key] = Array.isArray(value) ? value : [];
  }
  return q;
}

function normalizeExtraction(raw) {
  const x = Object.assign({}, raw || {});
  const quotes = parseMaybeJson(x.quotes);
  x.quotes = (Array.isArray(quotes) ? quotes : []).map(normalizeQuote);
  for (const key of ['documents_seen', 'scope_lines', 'unreadable']) {
    const value = parseMaybeJson(x[key]);
    x[key] = Array.isArray(value) ? value : [];
  }
  return x;
}

// Two attempts, because a truncated or missing tool call is worth one retry
// before a paying customer's report falls back to a thinner analysis.
async function extractContractorEstimates(apiKey, contentBlocks, options) {
  const opts = options || {};
  const fetchImpl = opts.fetch || fetch;
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        // A three-quote comparison with full line items is a long
        // transcription. The old engine ran the whole product at 4,096 and
        // would have silently truncated one.
        max_tokens: 12000,
        system: EXTRACT_SYSTEM,
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'tool', name: 'record_contractor_estimates' },
        messages: [{ role: 'user', content: contentBlocks }],
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 500)}`);
    }

    const data = await response.json();
    // A truncated tool call still parses into a plausible-looking object with
    // its later fields missing. Storing that silently switches off whichever
    // checks depend on whatever got cut off.
    if (data.stop_reason === 'max_tokens') {
      lastError = new Error('Estimate extraction was truncated');
      continue;
    }
    const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'record_contractor_estimates');
    if (!toolUse) {
      lastError = new Error('Extraction returned no structured result');
      continue;
    }
    return normalizeExtraction(toolUse.input);
  }

  throw lastError || new Error('Estimate extraction failed');
}

module.exports = {
  extractContractorEstimates,
  normalizeExtraction,
  normalizeQuote,
  EXTRACT_TOOL,
  EXTRACT_SYSTEM,
  EXTRACT_MODEL,
  CATEGORIES,
  QUOTE_SCHEMA,
};
