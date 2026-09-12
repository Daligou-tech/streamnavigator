'use strict';

// Reading a registration certificate the landlord uploaded.
//
// The intake asks for a registration expiry date because two things depend on
// it: the renewal check in api/_lib/landlord-audit.js, and the reminder in
// api/landlord-reminders.js that fires 45 days before it. A landlord who leaves
// it blank loses both — and the date is usually printed on the licence sitting
// in the folder they just uploaded.
//
// So this reads it off the document. What it does NOT do is override anything
// the landlord typed: a date they entered themselves is the one they will
// recognise in a reminder, and a document can be last year's copy. It only
// fills a field left empty, and it records that it did, so the report and the
// reminder can say where the date came from rather than presenting it as the
// customer's own answer.
//
// Fail-safe by construction. Every failure path returns no dates at all, and
// the caller carries on with exactly what the landlord typed — an unreadable
// licence must cost the extra date, never the report.

const ANTHROPIC_MODEL = 'claude-sonnet-5';

const EXTRACT_TOOL = {
  name: 'record_landlord_licences',
  description: 'Record the registration or licence details printed on the uploaded documents. Record only what is legibly printed.',
  input_schema: {
    type: 'object',
    properties: {
      licences: {
        type: 'array',
        description: 'One entry per registration, licence or certificate found. Empty if the documents are not registrations — a lease, an inspection report or a photograph of a building is not one.',
        items: {
          type: 'object',
          properties: {
            property_hint: {
              type: 'string',
              description: 'The address or property name printed on the document, exactly as printed. Used to match it to a property the landlord entered.',
            },
            city: { type: 'string', description: 'City printed on the document, if any.' },
            state: { type: 'string', description: 'Two-letter state printed on the document, if any.' },
            licence_number: { type: 'string', description: 'The registration or licence number, exactly as printed. Omit if not printed.' },
            expires_on: {
              type: 'string',
              description: 'The expiry, renewal or valid-until date, as YYYY-MM-DD. Omit unless a date is actually printed on the document — never infer one from an issue date.',
            },
            issuing_authority: { type: 'string', description: 'The office named on the document, if any.' },
          },
          required: ['property_hint'],
        },
      },
      unreadable: {
        type: 'array',
        items: { type: 'string' },
        description: 'Documents that could not be read, named as the customer would recognise them.',
      },
    },
    required: ['licences'],
  },
};

const SYSTEM = `You are reading documents a landlord uploaded alongside a rental compliance review, looking for one thing: a registration, licence or certificate that has an expiry date printed on it.

Record only what is legibly printed. Do not infer an expiry from an issue date, do not assume a one-year term, and do not convert a partial date into a full one. If the document is not a registration — a lease, an inspection report, a photograph — record nothing for it.

An invented expiry date is worse than no date, because it drives a reminder the landlord will act on.`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function usableDate(value) {
  const text = String(value || '').slice(0, 10);
  if (!ISO_DATE.test(text)) return null;
  const d = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return null;
  // A registration that expired years ago tells us nothing actionable, and a
  // date decades out is a misread. Both are more likely errors than facts.
  const years = (d.getTime() - Date.now()) / (365.25 * 86400000);
  if (years < -5 || years > 10) return null;
  return text;
}

function norm(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Matching a document to one of the properties the landlord entered. Both
// directions of containment, because a certificate prints "1412 Cedar Street"
// and the landlord typed "Cedar St".
function matchProperty(licence, properties) {
  const hint = norm(`${licence.property_hint || ''} ${licence.city || ''}`);
  if (!hint) return -1;
  const state = String(licence.state || '').trim().toUpperCase();

  let best = -1;
  let bestScore = 0;
  properties.forEach((p, i) => {
    if (state && String(p.state || '').toUpperCase() && state !== String(p.state).toUpperCase()) return;
    for (const candidate of [p.label, p.line1, p.city]) {
      const c = norm(candidate);
      if (!c || c.length < 3) continue;
      const score = hint.includes(c) ? c.length : (c.includes(hint) && hint.length >= 3 ? hint.length : 0);
      if (score > bestScore) { bestScore = score; best = i; }
    }
  });
  return best;
}

// Fills registration_expires on properties that have none. Returns a new array
// plus a note of what was filled, so the caller can tell the writer where the
// date came from. Never mutates the input and never overwrites a typed value.
function applyLicences(properties, licences) {
  const out = (properties || []).map((p) => ({ ...p }));
  const filled = [];

  for (const licence of licences || []) {
    const expires = usableDate(licence.expires_on);
    if (!expires) continue;
    const at = matchProperty(licence, out);
    if (at === -1) continue;
    if (String(out[at].registration_expires || '').trim()) continue;   // they typed one

    out[at].registration_expires = expires;
    out[at].registration_expires_source = 'document';
    if (!String(out[at].registered || '').trim()) out[at].registered = 'yes';
    if (licence.licence_number) out[at].licence_number = String(licence.licence_number).slice(0, 60);
    filled.push({
      property: out[at].label || out[at].line1 || out[at].city || `property ${at + 1}`,
      expires,
      from: licence.property_hint || 'an uploaded document',
    });
  }
  return { properties: out, filled };
}

async function extractLandlordLicences(apiKey, contentBlocks) {
  if (!apiKey || !Array.isArray(contentBlocks) || !contentBlocks.length) return { licences: [], unreadable: [] };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      // A licence is a short document and this records a handful of fields.
      max_tokens: 2000,
      system: SYSTEM,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'record_landlord_licences' },
      messages: [{ role: 'user', content: contentBlocks }],
    }),
  });

  if (!response.ok) throw new Error(`Anthropic API error ${response.status}`);
  const data = await response.json();
  if (data.stop_reason === 'max_tokens') throw new Error('Licence extraction was truncated');

  const toolUse = (data.content || []).find((b) => b.type === 'tool_use' && b.name === 'record_landlord_licences');
  if (!toolUse) throw new Error('No structured licence extraction returned');

  const input = toolUse.input || {};
  return {
    licences: Array.isArray(input.licences) ? input.licences : [],
    unreadable: Array.isArray(input.unreadable) ? input.unreadable : [],
  };
}

module.exports = {
  extractLandlordLicences,
  applyLicences,
  __internal: { usableDate, matchProperty, norm, EXTRACT_TOOL },
};
