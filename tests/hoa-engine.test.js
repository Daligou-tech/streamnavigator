// Tests for api/_lib/hoa-engine.js.
//
// The thing worth protecting here is the citation trust guarantee. The HOA
// product page promises "Every finding cites the page it came from", and
// the engine only actually honours that because page numbers are copied
// out of citations the API generated from the source document — never read
// from anything the model wrote into a tool call. These tests pin that
// down: that citations are harvested from the response, that an evidence
// index the model invented is dropped rather than rendered, and that
// evidence_ids never survive into a stored report.
//
// Mocks both Supabase and @anthropic-ai/sdk through Module._load, so this
// touches no network, no database, and no API key, costs nothing to run,
// and works before `npm install` has fetched the SDK. The live end-to-end
// check is the separate, deliberately manual api/generate-hoa-report.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const hoaEnginePath = require.resolve('../api/_lib/hoa-engine');
const supabaseAdminPath = require.resolve('../api/_lib/supabaseAdmin');

// ---------------------------------------------------------------------------
// Module interception
// ---------------------------------------------------------------------------

const originalLoad = Module._load;
let sdkStub = null;

Module._load = function (request, parent, isMain) {
  if (request === '@anthropic-ai/sdk' && sdkStub) return sdkStub;
  return originalLoad.apply(this, arguments);
};

// A minimal stand-in for the SDK surface the engine actually uses:
// new Anthropic({apiKey}), client.files.upload/delete, and
// client.messages.stream(req).finalMessage().
function makeSdkStub({ responses, calls, uploads, deletes }) {
  class FakeAnthropic {
    constructor() {
      this.files = {
        upload: async ({ file }) => {
          const id = `file_${uploads.length}`;
          uploads.push({ id, file });
          return { id };
        },
        delete: async (id) => {
          deletes.push(id);
          return { id, deleted: true };
        },
      };
      this.messages = {
        stream: (request) => {
          calls.push(request);
          const response = responses[calls.length - 1];
          if (!response) throw new Error(`No stubbed response for call ${calls.length}`);
          return { finalMessage: async () => response };
        },
      };
    }
  }
  return {
    default: FakeAnthropic,
    toFile: async (buffer, filename, opts) => ({ buffer, filename, opts }),
  };
}

function loadEngine(stub) {
  sdkStub = stub;
  delete require.cache[hoaEnginePath];
  return require('../api/_lib/hoa-engine');
}

// Loaded with a stub present so the pure helpers are importable.
const engine = loadEngine(makeSdkStub({ responses: [], calls: [], uploads: [], deletes: [] }));
const { harvestCitations, attachCitations, formatEvidenceTable, REPORT_TOOL, RISK_LEVELS } = engine;

function citedBlock(text, citations) {
  return { type: 'text', text, citations };
}

function pageCitation(overrides) {
  return Object.assign({
    type: 'page_location',
    document_index: 0,
    document_title: 'Reserve Study 2026.pdf',
    start_page_number: 12,
    end_page_number: 12,
    cited_text: 'The association is 28% funded as of the study date.',
  }, overrides);
}

// ---------------------------------------------------------------------------
// harvestCitations
// ---------------------------------------------------------------------------

test('harvestCitations pulls page citations off text blocks', () => {
  const evidence = harvestCitations([
    { type: 'thinking', thinking: 'ignored' },
    citedBlock('Reserves are weak.', [pageCitation()]),
  ]);

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].document_title, 'Reserve Study 2026.pdf');
  assert.equal(evidence[0].page_start, 12);
  assert.equal(evidence[0].cited_text, 'The association is 28% funded as of the study date.');
});

test('harvestCitations deduplicates the same passage cited repeatedly', () => {
  const evidence = harvestCitations([
    citedBlock('Weak reserves.', [pageCitation()]),
    citedBlock('Which also drives assessment risk.', [pageCitation()]),
    citedBlock('And a separate point.', [pageCitation({ start_page_number: 40, end_page_number: 41, cited_text: 'Roof replacement is scheduled for 2027.' })]),
  ]);

  assert.equal(evidence.length, 2, 'the repeated passage should collapse to one entry');
  assert.equal(evidence[1].page_start, 40);
  assert.equal(evidence[1].page_end, 41);
});

test('harvestCitations ignores blocks with no citations and non-text blocks', () => {
  const evidence = harvestCitations([
    { type: 'text', text: 'Uncited prose.' },
    { type: 'tool_use', name: 'code_execution', input: {} },
    { type: 'text', text: 'Also uncited.', citations: [] },
  ]);
  assert.deepEqual(evidence, []);
});

// ---------------------------------------------------------------------------
// attachCitations — the trust guarantee
// ---------------------------------------------------------------------------

test('attachCitations resolves evidence_ids to the harvested citations', () => {
  const evidence = [
    { document_title: 'Budget.pdf', page_start: 3, page_end: 3, cited_text: 'Operating deficit of $41,000.' },
    { document_title: 'Minutes.pdf', page_start: 2, page_end: 2, cited_text: 'The board discussed a special assessment.' },
  ];
  const report = {
    findings: [
      { concern: 'Operating deficit', evidence_ids: [0] },
      { concern: 'Assessment discussed', evidence_ids: [1, 0] },
    ],
  };

  const { report: out, droppedCitationRefs } = attachCitations(report, evidence);

  assert.equal(droppedCitationRefs, 0);
  assert.equal(out.findings[0].citations[0].page_start, 3);
  assert.equal(out.findings[1].citations.length, 2);
  assert.equal(out.findings[1].citations[0].cited_text, 'The board discussed a special assessment.');
});

test('attachCitations drops an evidence index the model invented', () => {
  const evidence = [
    { document_title: 'Budget.pdf', page_start: 3, page_end: 3, cited_text: 'Operating deficit of $41,000.' },
  ];
  const report = {
    findings: [{ concern: 'Made-up citation', evidence_ids: [0, 7, 99] }],
  };

  const { report: out, droppedCitationRefs } = attachCitations(report, evidence);

  assert.equal(droppedCitationRefs, 2, 'both out-of-range indices should be dropped');
  assert.equal(out.findings[0].citations.length, 1);
  assert.equal(out.findings[0].citations[0].page_start, 3);
});

test('attachCitations strips evidence_ids everywhere so none reach the customer', () => {
  const evidence = [{ document_title: 'A.pdf', page_start: 1, page_end: 1, cited_text: 'x' }];
  const report = {
    short_term_risk: { likelihood: 'Likely', evidence_ids: [0] },
    mid_term_risk: { likelihood: 'Possible', evidence_ids: [] },
    reserve_health: { percent_funded: '28%', evidence_ids: [0] },
    findings: [{ concern: 'c', evidence_ids: [0] }],
  };

  const { report: out } = attachCitations(report, evidence);

  const serialized = JSON.stringify(out);
  assert.ok(!serialized.includes('evidence_ids'), 'evidence_ids must not survive into the stored report');
  assert.equal(out.short_term_risk.citations.length, 1);
  assert.deepEqual(out.mid_term_risk.citations, []);
  assert.equal(out.reserve_health.citations[0].document_title, 'A.pdf');
});

// ---------------------------------------------------------------------------
// formatEvidenceTable
// ---------------------------------------------------------------------------

test('formatEvidenceTable numbers rows by array position', () => {
  // The indices the model sees must be exactly the indices attachCitations
  // resolves against, or every citation in the report points at the wrong
  // passage. This is the seam between the two passes.
  const evidence = [
    { document_title: 'A.pdf', page_start: 1, page_end: 1, cited_text: 'first' },
    { document_title: 'B.pdf', page_start: 5, page_end: 7, cited_text: 'second' },
  ];
  const table = formatEvidenceTable(evidence);

  assert.match(table, /\[0\] A\.pdf \(p\. 1\)/);
  assert.match(table, /\[1\] B\.pdf \(pp\. 5-7\)/);
});

test('formatEvidenceTable tells the model not to cite when nothing was captured', () => {
  const table = formatEvidenceTable([]);
  assert.match(table, /leave every evidence_ids array empty/);
});

// ---------------------------------------------------------------------------
// Schema invariants
// ---------------------------------------------------------------------------

test('REPORT_TOOL satisfies the strict-mode contract', () => {
  assert.equal(REPORT_TOOL.strict, true);

  // strict:true requires additionalProperties:false and every property
  // present in `required` — a property left out is a 400 at request time,
  // which would only surface in production.
  function checkObject(schema, path) {
    if (schema.type !== 'object') return;
    assert.equal(schema.additionalProperties, false, `${path} must set additionalProperties:false`);
    const props = Object.keys(schema.properties || {});
    const required = schema.required || [];
    assert.deepEqual(
      props.slice().sort(),
      required.slice().sort(),
      `${path}: every property must be listed in required`,
    );
    for (const [key, child] of Object.entries(schema.properties || {})) {
      checkObject(child, `${path}.${key}`);
      if (child.type === 'array' && child.items) checkObject(child.items, `${path}.${key}[]`);
    }
  }

  checkObject(REPORT_TOOL.input_schema, 'input_schema');
});

test('risk_score is a typed enum, not free text', () => {
  assert.deepEqual(REPORT_TOOL.input_schema.properties.risk_score.enum, RISK_LEVELS);
  assert.deepEqual(
    REPORT_TOOL.input_schema.properties.findings.items.properties.severity.enum,
    RISK_LEVELS,
  );
});

test('the report schema still carries the fields the generic renderer reads', () => {
  // navigator-status.html renders headline / headline_tag / summary /
  // key_numbers / sections / missing_or_uncertain / closing_*. The HOA
  // schema is a superset so that renderer keeps working untouched.
  const props = REPORT_TOOL.input_schema.properties;
  for (const field of ['headline', 'headline_tag', 'summary', 'key_numbers', 'sections', 'missing_or_uncertain', 'closing_title', 'closing_body']) {
    assert.ok(props[field], `generic renderer field "${field}" is missing from the HOA schema`);
  }
});

// ---------------------------------------------------------------------------
// generateHoaReport — the two-pass pipeline
// ---------------------------------------------------------------------------

function makeFakeAdmin({ submission, reportInserts, submissionUpdates }) {
  return {
    from(table) {
      if (table === 'navigator_submissions') {
        return {
          select() {
            return { eq() { return { single: async () => ({ data: { ...submission }, error: null }) }; } };
          },
          update(patch) {
            submissionUpdates.push(patch);
            Object.assign(submission, patch);
            return { eq: async () => ({ data: null, error: null }) };
          },
        };
      }
      if (table === 'navigator_reports') {
        return {
          insert: async (row) => { reportInserts.push(row); return { data: null, error: null }; },
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
    storage: {
      from() {
        return {
          download: async () => ({
            data: { arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 fake').buffer },
            error: null,
          }),
        };
      },
    },
  };
}

function runPipeline({ reportToolInput, evidenceContent }) {
  const submission = {
    id: 'sub-1',
    product: 'hoa',
    status: 'paid',
    file_paths: ['uploads/reserve-study.pdf', 'uploads/minutes.pdf'],
    form_data: { address: '12 Example Ct' },
  };
  const reportInserts = [];
  const submissionUpdates = [];
  const calls = [];
  const uploads = [];
  const deletes = [];

  const responses = [
    { stop_reason: 'end_turn', content: evidenceContent },
    {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'submit_hoa_report', input: reportToolInput }],
    },
  ];

  const stub = makeSdkStub({ responses, calls, uploads, deletes });

  delete require.cache[supabaseAdminPath];
  require.cache[supabaseAdminPath] = {
    id: supabaseAdminPath,
    filename: supabaseAdminPath,
    loaded: true,
    exports: { getSupabaseAdmin: () => makeFakeAdmin({ submission, reportInserts, submissionUpdates }) },
  };

  const { generateHoaReport } = loadEngine(stub);
  process.env.ANTHROPIC_API_KEY = 'test-key';

  return { generateHoaReport, calls, uploads, deletes, reportInserts, submissionUpdates, submission };
}

test('generateHoaReport runs both passes and ships API-generated page numbers', async () => {
  const ctx = runPipeline({
    evidenceContent: [
      citedBlock('The association is badly underfunded.', [pageCitation()]),
      citedBlock('A roof replacement is coming.', [pageCitation({
        document_title: 'Minutes.pdf',
        document_index: 1,
        start_page_number: 4,
        end_page_number: 4,
        cited_text: 'Board reviewed roof bids; funding options include a special assessment.',
      })]),
    ],
    reportToolInput: {
      risk_score: 'High',
      findings: [
        // Index 1 is real; index 5 is invented and must be dropped.
        { concern: 'Roof unfunded', severity: 'High', detail: 'Bids reviewed, no funding in place.', evidence_ids: [1, 5] },
      ],
      short_term_risk: { likelihood: 'Likely', evidence_ids: [0] },
      headline: 'Reserves are thin and a roof is due.',
    },
  });

  const report = await ctx.generateHoaReport('sub-1');

  // Two passes, in order.
  assert.equal(ctx.calls.length, 2);

  const evidencePass = ctx.calls[0];
  const reportPass = ctx.calls[1];

  // Pass 1: documents attached by file_id with citations enabled, and a
  // calculator available. No report tool.
  const docBlocks = evidencePass.messages[0].content.filter((b) => b.type === 'document');
  assert.equal(docBlocks.length, 2);
  for (const block of docBlocks) {
    assert.deepEqual(block.citations, { enabled: true }, 'citations must be enabled or no page numbers exist to harvest');
    assert.equal(block.source.type, 'file');
  }
  assert.ok(evidencePass.tools.some((t) => t.type === 'code_execution_20260521'));
  assert.ok(!evidencePass.tools.some((t) => t.name === 'submit_hoa_report'));

  // Pass 2: the report tool, never forced (forcing conflicts with thinking).
  assert.equal(reportPass.tools[0].name, 'submit_hoa_report');
  assert.deepEqual(reportPass.tool_choice, { type: 'auto' });
  assert.match(reportPass.messages[0].content, /EVIDENCE TABLE/);

  // The shipped finding carries the API's page number, and the invented
  // index is gone.
  assert.equal(report.findings[0].citations.length, 1);
  assert.equal(report.findings[0].citations[0].page_start, 4);
  assert.equal(report.findings[0].citations[0].document_title, 'Minutes.pdf');
  assert.ok(!JSON.stringify(report).includes('evidence_ids'));

  // Stored, marked complete, and the buyer's documents cleaned up.
  assert.equal(ctx.reportInserts.length, 1);
  assert.equal(ctx.reportInserts[0].product, 'hoa');
  assert.equal(ctx.reportInserts[0].model, 'claude-opus-5');
  assert.equal(ctx.submission.status, 'complete');
  assert.deepEqual(ctx.deletes.sort(), ctx.uploads.map((u) => u.id).sort());
});

test('generateHoaReport deletes uploaded documents even when the run fails', async () => {
  const ctx = runPipeline({
    evidenceContent: [], // no text -> engine throws after uploading
    reportToolInput: {},
  });

  await assert.rejects(ctx.generateHoaReport('sub-1'), /produced no analysis text/);

  assert.equal(ctx.uploads.length, 2);
  assert.deepEqual(ctx.deletes.sort(), ctx.uploads.map((u) => u.id).sort());
  assert.equal(ctx.submission.status, 'failed');
  assert.match(ctx.submission.error, /produced no analysis text/);
});

test('generateHoaReport refuses a submission with no documents', async () => {
  const ctx = runPipeline({ evidenceContent: [], reportToolInput: {} });
  ctx.submission.file_paths = [];

  await assert.rejects(ctx.generateHoaReport('sub-1'), /requires at least one uploaded document/);
  assert.equal(ctx.submission.status, 'failed');
});

test.after(() => { Module._load = originalLoad; });
