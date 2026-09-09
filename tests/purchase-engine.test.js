// Tests for api/_lib/purchase-engine.js: the guarantee that a paid Purchase
// Navigator report always contains all six promised sections (never a
// silent omission), that a model response missing one gets retried, and
// that a web_search-tool failure falls back to a knowledge-only call
// instead of failing the whole report. Mocks global.fetch (the Anthropic
// call) and Supabase (via the require-cache trick also used in
// tests/navigator-intake-buying.test.js) so none of this touches the
// network or a real database — and costs nothing to run.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

// purchase-engine.js reads PURCHASE_NAVIGATOR_DISABLE_WEB_SEARCH once, at
// module load, to decide whether the report call gets a web_search tool. Ten of
// the tests below are about what happens when it does.
//
// Vercel injects a project's environment variables into the BUILD as well as
// the runtime, and scripts/vercel-gate.sh runs this suite inside that build. So
// switching the flag on to run a diagnostic against a preview also switched it
// on for the gate, those ten tests failed, and four production deploys in a row
// were cancelled by a flag that was never meant to touch production.
//
// A unit test about the search path must not be at the mercy of a deploy-time
// switch. Cleared before the module is required, which is the only moment that
// matters.
delete process.env.PURCHASE_NAVIGATOR_DISABLE_WEB_SEARCH;

const supabaseAdminPath = require.resolve('../api/_lib/supabaseAdmin');
const purchaseEnginePath = require.resolve('../api/_lib/purchase-engine');

function makeFakeAdmin({ submission, reportInserts, submissionUpdates }) {
  return {
    from(table) {
      if (table === 'navigator_submissions') {
        return {
          select() {
            return {
              eq() {
                return {
                  // Returns the CURRENT (mutated) state, not a frozen
                  // snapshot — generatePurchaseReport is now called once per
                  // attempt (see purchase-engine.js), and each call must see
                  // the generation_attempts / status left by the previous
                  // one, the same way separate polls would in production.
                  single: async () => ({ data: { ...submission }, error: null }),
                };
              },
            };
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
          insert: async (row) => {
            reportInserts.push(row);
            return { data: row, error: null };
          },
        };
      }
      throw new Error(`Unexpected table in test: ${table}`);
    },
    storage: {
      from() {
        return { download: async () => ({ data: null, error: new Error('no files in this test') }) };
      },
    },
  };
}

function installFakes({ submission }) {
  const reportInserts = [];
  const submissionUpdates = [];
  const fakeAdmin = makeFakeAdmin({ submission, reportInserts, submissionUpdates });

  const fakeModule = new Module(supabaseAdminPath);
  fakeModule.exports = { getSupabaseAdmin: () => fakeAdmin };
  fakeModule.loaded = true;
  require.cache[supabaseAdminPath] = fakeModule;

  delete require.cache[purchaseEnginePath];

  return { reportInserts, submissionUpdates };
}

function uninstallFakes() {
  delete require.cache[supabaseAdminPath];
  delete require.cache[purchaseEnginePath];
}

function fakeSubmission(overrides) {
  return {
    id: 'sub-1',
    product: 'buying',
    file_paths: [],
    form_data: {
      category: 'appliance',
      item_description: 'LG 33-inch French door refrigerator',
      price_value: '2400',
      financing: 'cash',
      ownership_years: '8',
      location: '30301',
      timeline: 'this_month',
      size_constraints: '33-inch opening',
      configuration: 'French door',
    },
    ...overrides,
  };
}

function completeReportInput(overrides) {
  return {
    headline: 'A solid buy at $2,400 — total cost around $2,900 over 8 years',
    headline_tag: 'Buy',
    summary: 'This fridge is reasonably priced and the running costs are typical for its size.',
    research_notes: ['Comparable 33-inch French door fridges list for $1,800-$2,600 at major retailers.'],
    // The model gives line items and a per-year running cost; it is never
    // asked for a total. $55-$70/yr over 8 years is $440-$560, which is
    // exactly what the running line says — that agreement is what
    // tcoArithmeticProblem checks, and several tests below break it on
    // purpose.
    total_cost_of_ownership: {
      time_horizon_years: 8,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'the quoted price' },
        { label: 'Electricity', kind: 'running', per_year_low: 55, per_year_high: 70, basis: 'typical U.S. rates' },
        { label: 'Delivery and haul-away', kind: 'other', low: 100, high: 150, basis: 'typical retailer fee' },
      ],
      explanation: 'Purchase price plus roughly $440-$560 in electricity over 8 years.',
    },
    financing_impact: { applicable: false, explanation: 'Paying cash, so there is no financing cost — the $2,400 price is the full cost.' },
    maintenance_running_costs: { annual_low: 55, annual_high: 70, explanation: 'Typical electricity draw for a French door fridge this size, plus occasional minor repairs.' },
    depreciation_resale: { resale_low: 0, resale_high: 0, expected_resale_note: 'No meaningful resale market for appliances', explanation: 'Refrigerators are not typically resold for meaningful value; treat this as a sunk cost over its useful life.' },
    alternative_comparison: {
      alternative_name: 'A comparable top-freezer model',
      alternative_price_low: 1500,
      alternative_price_high: 1700,
      alternative_total_low: 2100,
      alternative_total_high: 2400,
      explanation: 'A simpler top-freezer configuration costs several hundred dollars less with slightly higher energy use, but no ice/water dispenser.',
    },
    recommendation: { verdict: 'buy', reasoning: 'Price is in the typical range and the customer already needs a replacement — no reason to wait.' },
    assumptions: [
      'Assumed a typical U.S. average electricity rate of about $0.16/kWh since no exact rate was given.',
      'Assumed roughly 550 kWh a year of draw, typical for a 33-inch French door model.',
      'Assumed no extended warranty is purchased.',
    ],
    missing_or_uncertain: [],
    ...overrides,
  };
}

// Drives generation the way the browser does: poll until a report comes back
// or the row stops moving. It takes more than one call now, because a fresh
// must-have verification hands back so the report gets an invocation of its
// own — see the 300-second ceiling in purchase-engine.js.
async function generateUntilReport(id, maxPolls = 6) {
  const { generatePurchaseReport } = require("../api/_lib/purchase-engine");
  let last = null;
  for (let i = 0; i < maxPolls; i++) {
    last = await generatePurchaseReport(id);
    if (last) return last;
  }
  return last;
}

function toolUseResponse(input) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: 'tool_use', name: 'submit_purchase_report', input }] }),
  };
}

// The engine makes two different kinds of call. A full attempt asks for
// submit_purchase_report; a targeted field repair asks for submit_field_repair
// behind a forced tool_choice, so it can refill one empty explanation without
// spending a whole retry. A fake that answers every request with a
// submit_purchase_report block starves the repair path: repairExplanationField
// finds no submit_field_repair block, logs, returns null, and the attempt falls
// through to a full retry. These helpers route on the requested tool the way
// the real API would, so a test can decide whether the repair succeeds.
function requestedTool(opts) {
  const body = JSON.parse((opts && opts.body) || '{}');
  return (body.tool_choice && body.tool_choice.name) || null;
}

// Three different repairs now share the tool name submit_field_repair —
// prose, cost model, assumptions — so a fake that wants to answer one of
// them specifically has to look at the schema it was handed.
function repairKind(opts) {
  const body = JSON.parse((opts && opts.body) || '{}');
  const tool = (body.tools || [])[0];
  const props = (tool && tool.input_schema && tool.input_schema.properties) || {};
  if (props.cost_breakdown) return 'cost_model';
  if (props.assumptions) return 'assumptions';
  if (props.value) return 'prose';
  return null;
}

// A response carrying the server-side record of searches actually run,
// which is what countSearchRounds reads.
function searchedToolUseResponse(input, rounds) {
  const content = [];
  for (let i = 0; i < rounds; i++) content.push({ type: 'server_tool_use', name: 'web_search', id: 'srvtoolu_' + i, input: { query: 'q' + i } });
  content.push({ type: 'tool_use', name: 'submit_purchase_report', input });
  return {
    ok: true,
    json: async () => ({ content, usage: { server_tool_use: { web_search_requests: rounds } } }),
  };
}

function fieldRepairResponse(value) {
  return {
    ok: true,
    json: async () => ({ content: [{ type: 'tool_use', name: 'submit_field_repair', input: { value } }] }),
  };
}

test('a complete first response produces a report with all six sections and marks the submission complete', async (t) => {
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async () => toolUseResponse(completeReportInput());
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  const sectionTitles = report.sections.map((s) => s.title);
  assert.match(sectionTitles[0], /total cost of ownership/i);
  assert.match(sectionTitles[1], /financing/i);
  assert.match(sectionTitles[2], /maintenance/i);
  assert.match(sectionTitles[3], /depreciation/i);
  assert.match(sectionTitles[4], /compares/i);
  assert.match(sectionTitles[5], /recommendation/i);
  report.sections.slice(0, 6).forEach((s) => {
    assert.ok(s.items.length > 0 && s.items[0].length > 0, `section "${s.title}" must not be empty`);
  });

  assert.equal(reportInserts.length, 1);
  assert.equal(reportInserts[0].product, 'buying');
  assert.ok(submissionUpdates.some((u) => u.status === 'processing'));
  assert.ok(submissionUpdates.some((u) => u.status === 'complete'));
  assert.ok(!submissionUpdates.some((u) => u.status === 'failed'));
});

test('a response missing a required section (financing_impact.explanation) hands back to "paid" instead of retrying inside one call, and a second call recovers', async (t) => {
  // Regression test for a real production incident: two full attempts
  // stacked inside a single generatePurchaseReport call could exceed
  // Vercel's 60s Hobby-plan function limit and get hard-killed mid-flight,
  // leaving the row stuck at status:'processing' forever with no failure
  // message. The fix makes each call attempt exactly once and, on a
  // recoverable failure, sets status back to 'paid' so the next poll (a
  // separate invocation, with its own full time budget) tries again — this
  // test drives that as two separate generatePurchaseReport('sub-1') calls,
  // the way two separate polls actually would.
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let call = 0;
  let mainCalls = 0;
  global.fetch = async (url, opts) => {
    call++;
    if (requestedTool(opts) === 'submit_field_repair') {
      // An empty repair is a failed repair: the engine stops the repair loop
      // and falls through to the hand-back path this test is about. Without
      // this branch the fake answers the repair with a submit_purchase_report
      // block, which fails for the wrong reason and hides what is being tested.
      return fieldRepairResponse('');
    }
    mainCalls++;
    if (mainCalls === 1) {
      const bad = completeReportInput({ financing_impact: { applicable: false, explanation: '' } });
      return toolUseResponse(bad);
    }
    return toolUseResponse(completeReportInput());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');

  const firstResult = await generatePurchaseReport('sub-1');
  assert.equal(firstResult, null, 'a recoverable failure with attempts remaining must not throw or return a report');
  assert.equal(submission.status, 'paid', 'must hand back to "paid" so the next poll retries, not stay stuck at "processing"');
  assert.equal(submission.generation_attempts, 1);
  assert.equal(reportInserts.length, 0);

  const report = await generatePurchaseReport('sub-1');

  assert.equal(mainCalls, 2, 'expected exactly one full Anthropic attempt per generatePurchaseReport invocation');
  assert.equal(call, 3, 'two full attempts plus the one targeted field-repair call the first attempt spent before giving up');
  assert.ok(report.sections[1].items[0].length > 0, 'financing section must be populated after the second attempt');
  assert.equal(reportInserts.length, 1);
  assert.equal(submission.generation_attempts, 2);
  assert.ok(submissionUpdates.some((u) => u.status === 'complete'));
});

test('a response missing every required section on every attempt marks the submission failed rather than storing a broken report', async (t) => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async () => toolUseResponse(completeReportInput({ recommendation: { verdict: 'buy', reasoning: '' } }));
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');

  // Drive exactly MAX_ATTEMPTS calls (whatever that's currently set to,
  // rather than hardcoding it — this bumped from 2 to 4 on 2026-08-31 and
  // a hardcoded loop count would have silently stopped testing exhaustion).
  for (let i = 1; i < __internal.MAX_ATTEMPTS; i++) {
    const result = await generatePurchaseReport('sub-1');
    assert.equal(result, null, `attempt ${i} with attempts remaining must hand back to "paid", not throw`);
    assert.equal(submission.status, 'paid');
  }
  await assert.rejects(() => generatePurchaseReport('sub-1'), 'the final attempt must throw once MAX_ATTEMPTS is reached');

  assert.equal(reportInserts.length, 0, 'an incomplete report must never be stored');
  assert.ok(submissionUpdates.some((u) => u.status === 'failed'));
  const failedUpdate = submissionUpdates.find((u) => u.status === 'failed');
  assert.ok(failedUpdate.error && failedUpdate.error.length > 0);
  assert.match(failedUpdate.error, /recommendation/, 'the failure message should name the actual empty field for diagnosability');
});

test('a submission that already exhausted MAX_ATTEMPTS is marked failed immediately without making another API call', async (t) => {
  // Guards against the stuck-processing recovery path in
  // get-navigator-submission.js re-triggering generation forever if every
  // single attempt times out — once attempts are used up, this must fail
  // fast rather than starting yet another attempt.
  const { __internal } = require('../api/_lib/purchase-engine');
  const submission = fakeSubmission({ generation_attempts: __internal.MAX_ATTEMPTS });
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = async () => { callCount++; return toolUseResponse(completeReportInput()); };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  await assert.rejects(() => generatePurchaseReport('sub-1'));

  assert.equal(callCount, 0, 'must not call the Anthropic API once attempts are exhausted');
  assert.equal(reportInserts.length, 0);
  assert.ok(submissionUpdates.some((u) => u.status === 'failed'));
});

test('a leaked tool-syntax fragment attached to otherwise-real prose is stripped in place and the report succeeds on the first attempt', async (t) => {
  // Regression test for a real production incident (2026-08-31): a live
  // vehicle+financing submission leaked the literal text
  // `<parameter name="estimate_low">` into total_cost_of_ownership.explanation
  // on 2 separate real attempts, and the OLD behavior (reject outright) both
  // times exhausted MAX_ATTEMPTS and left the customer with nothing despite
  // having paid. The fix strips tag-like fragments instead of discarding the
  // whole report over them — this must resolve in ONE attempt, not two.
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  let call = 0;
  global.fetch = async () => {
    call++;
    const contaminated = completeReportInput({
      total_cost_of_ownership: {
        time_horizon_years: 8,
        cost_breakdown: [
          { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'the quoted price' },
          { label: 'Electricity', kind: 'running', per_year_low: 55, per_year_high: 70, basis: 'typical U.S. rates' },
          { label: 'Delivery and haul-away', kind: 'other', low: 100, high: 150, basis: 'typical retailer fee' },
        ],
        explanation: 'Purchase price plus roughly $440-$560 in electricity over 8 years, using the <parameter name="estimate_low"> baseline.',
      },
    });
    return toolUseResponse(contaminated);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.equal(call, 1, 'a stray tag fragment must be repaired, not spent as a whole retry attempt');
  assert.equal(reportInserts.length, 1);
  assert.ok(submissionUpdates.some((u) => u.status === 'complete'));
  assert.equal(submission.generation_attempts, 1);
  const reportText = JSON.stringify(report);
  assert.ok(!reportText.includes('<parameter'), 'the stored report must not contain the leaked tag fragment');
  assert.ok(reportText.includes('roughly $440-$560 in electricity'), 'the real surrounding prose must survive the strip');
});

test('a leaked tag that is the entire content of a required field still triggers a retry (stripping correctly leaves it empty)', async (t) => {
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  let call = 0;
  let mainCalls = 0;
  global.fetch = async (url, opts) => {
    call++;
    if (requestedTool(opts) === 'submit_field_repair') return fieldRepairResponse('');
    mainCalls++;
    if (mainCalls === 1) {
      const bad = completeReportInput({
        financing_impact: { applicable: false, explanation: '<parameter name="estimate_low">' },
      });
      return toolUseResponse(bad);
    }
    return toolUseResponse(completeReportInput());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const firstResult = await generatePurchaseReport('sub-1');
  assert.equal(firstResult, null, 'stripping down to an empty required field must still hand back to "paid", not throw');
  assert.equal(submission.status, 'paid');

  const report = await generatePurchaseReport('sub-1');
  assert.equal(mainCalls, 2);
  assert.equal(call, 3, 'the stripped field is repairable in principle, so one repair call is attempted before the retry');
  assert.equal(reportInserts.length, 1);
  assert.ok(report.headline);
});

test('a repairable empty explanation is refilled in-call instead of spending a full retry', async (t) => {
  // The counterpart to the two tests above, and the reason their call counts
  // moved. When the targeted repair actually comes back with prose, the
  // attempt completes: no hand-back to "paid", no second poll, no extra
  // generation attempt burned on a report that was one field short.
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let mainCalls = 0;
  let repairCalls = 0;
  global.fetch = async (url, opts) => {
    if (requestedTool(opts) === 'submit_field_repair') {
      repairCalls++;
      return fieldRepairResponse('Paying cash, so the sticker price is the cost. There is no financing interest to add.');
    }
    mainCalls++;
    return toolUseResponse(completeReportInput({ financing_impact: { applicable: false, explanation: '' } }));
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.ok(report, 'a successful repair must complete the attempt rather than hand back');
  assert.equal(mainCalls, 1, 'the repair replaces a full retry — it must not trigger a second full attempt');
  assert.equal(repairCalls, 1);
  assert.equal(submission.generation_attempts, 1, 'a repaired attempt must not burn a second attempt');
  assert.equal(reportInserts.length, 1);
  assert.ok(report.sections[1].items[0].length > 0, 'the repaired financing explanation must reach the stored report');
  assert.ok(submissionUpdates.some((u) => u.status === 'complete'));
  assert.ok(!submissionUpdates.some((u) => u.status === 'paid'));
});

test('an unsupported web_search tool error steps down to the legacy variant before giving up on research', async (t) => {
  // The engine used to hold a single web_search version and drop straight
  // to knowledge-only when it was rejected. Since buying.html sells "live
  // web research", losing it is a downgrade of the product, so a rejection
  // of the current variant now tries the older one first.
  const submission = fakeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  const searchTypesTried = [];
  global.fetch = async (url, opts) => {
    const parsedBody = JSON.parse(opts.body);
    const search = (parsedBody.tools || []).find((tool) => String(tool.type || '').startsWith('web_search'));
    if (search) {
      searchTypesTried.push(search.type);
      return { ok: false, status: 400, text: async () => 'invalid_request_error: the web_search tool is not enabled for this API key' };
    }
    return toolUseResponse(completeReportInput());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport, __internal } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.deepEqual(
    searchTypesTried,
    [__internal.WEB_SEARCH_TOOL.type, __internal.WEB_SEARCH_TOOL_LEGACY.type],
    'must try the current variant, then the legacy one, before dropping search'
  );
  assert.equal(reportInserts.length, 1);
  assert.ok(report.headline);
});

test('the web_search tool is pinned to a version the report model actually supports', async () => {
  // The engine ran on claude-sonnet-5 with the tool pinned at
  // web_search_20250305 — the variant that predates that model. A paid
  // report on 2026-09-07 came back with zero searches and an empty
  // research_notes while the page told the customer it used live research.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.WEB_SEARCH_TOOL.type, 'web_search_20260209');
  assert.equal(__internal.WEB_SEARCH_TOOL_LEGACY.type, 'web_search_20250305');
  assert.notEqual(
    __internal.WEB_SEARCH_TOOL.type,
    __internal.WEB_SEARCH_TOOL_LEGACY.type,
    'the fallback must be a different version, or the step-down is a no-op'
  );
});

test('a model that only searches and summarizes in text (no tool_use on the first turn) gets one forced follow-up call', async (t) => {
  const submission = fakeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let call = 0;
  global.fetch = async (url, opts) => {
    call++;
    if (call === 1) {
      // Model responded with a thinking block plus plain text, never
      // calling submit_purchase_report.
      return {
        ok: true,
        json: async () => ({
          content: [
            { type: 'thinking', thinking: 'Let me work through the math...' },
            { type: 'text', text: 'Here is what I found from searching...' },
          ],
        }),
      };
    }
    const parsedBody = JSON.parse(opts.body);
    assert.equal(parsedBody.tool_choice.type, 'tool', 'the forced follow-up must force the submit tool');
    assert.equal(parsedBody.thinking, undefined, 'the forced follow-up must not enable thinking — incompatible with a forced tool_choice');
    const replayedAssistantTurn = parsedBody.messages.find((m) => m.role === 'assistant');
    assert.ok(
      !replayedAssistantTurn.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'),
      'thinking blocks from the first turn must be stripped before replaying it into a request where thinking is off'
    );
    return toolUseResponse(completeReportInput());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.equal(call, 2);
  assert.equal(reportInserts.length, 1);
  assert.ok(report.headline);
});

test('the first, non-forced call enables extended thinking as scratch space for the report\'s arithmetic', async (t) => {
  // Direct fix for the 2026-08-31 incident: the model reproducibly (7/7
  // live attempts) leaked a simulated tool-call fragment into
  // total_cost_of_ownership.explanation instead of just stating the
  // computed number — plausibly because it had nowhere else to "show its
  // work" for the financing/TCO arithmetic. Giving it a real thinking
  // channel is the structural fix; this locks in that the first call
  // actually requests it.
  const submission = fakeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  let firstBody = null;
  global.fetch = async (url, opts) => {
    if (!firstBody) firstBody = JSON.parse(opts.body);
    return toolUseResponse(completeReportInput());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  await generatePurchaseReport('sub-1');

  assert.equal(firstBody.tool_choice.type, 'auto', 'thinking is only valid alongside a non-forced tool_choice');
  // Adaptive, not a fixed budget. ANTHROPIC_MODEL is claude-sonnet-5, and on
  // the Claude 5 models adaptive is the only way to turn thinking on — the
  // legacy thinking:{type:'enabled',budget_tokens:N} form is rejected there,
  // so this assertion is what stops a well-meaning revert to it.
  assert.equal(firstBody.thinking.type, 'adaptive');
  // effort belongs in a top-level output_config, not inside thinking. Putting
  // it in the wrong place is a 400, not a silent downgrade.
  assert.equal(firstBody.output_config.effort, 'high');
  assert.equal(firstBody.thinking.budget_tokens, undefined, 'budget_tokens alongside adaptive is rejected');
  assert.ok(firstBody.max_tokens > 4096, 'thinking and the final output share max_tokens — leave room for both');
});

test('__internal.isReportComplete rejects a report missing any one of the six required sections', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.isReportComplete(completeReportInput()), true);

  const cases = [
    { total_cost_of_ownership: { explanation: '' } },
    { financing_impact: { applicable: false, explanation: '' } },
    { maintenance_running_costs: { explanation: '' } },
    { depreciation_resale: { explanation: '' } },
    { alternative_comparison: { alternative_name: '', explanation: 'x' } },
    { recommendation: { verdict: 'buy', reasoning: '' } },
    { recommendation: { verdict: 'not-a-real-verdict', reasoning: 'x' } },
    { headline: '' },
    { summary: '   ' },
  ];
  cases.forEach((patch) => {
    const broken = completeReportInput(patch);
    assert.equal(__internal.isReportComplete(broken), false, `expected incomplete for patch ${JSON.stringify(patch)}`);
  });
});

test('__internal.firstIncompleteField names which specific field is missing, for diagnosable failure messages', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const cases = [
    [{ headline: '' }, 'headline'],
    [{ summary: '   ' }, 'summary'],
    [{ total_cost_of_ownership: { explanation: '' } }, 'total_cost_of_ownership.explanation'],
    [{ financing_impact: { applicable: false, explanation: '' } }, 'financing_impact.explanation'],
    [{ maintenance_running_costs: { explanation: '' } }, 'maintenance_running_costs.explanation'],
    [{ depreciation_resale: { explanation: '' } }, 'depreciation_resale.explanation'],
    [{ alternative_comparison: { alternative_name: '', explanation: 'x' } }, 'alternative_comparison'],
    [{ recommendation: { verdict: 'buy', reasoning: '' } }, 'recommendation'],
  ];
  cases.forEach(([patch, expectedField]) => {
    const broken = completeReportInput(patch);
    assert.equal(__internal.firstIncompleteField(broken), expectedField, `expected "${expectedField}" for patch ${JSON.stringify(patch)}`);
  });
});

test('__internal.sanitizeReportTags strips tag-like substrings recursively but leaves normal prose and numbers untouched', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(
    __internal.sanitizeReportTags('Cost was <parameter name="estimate_low"> around $3,200 for the year.'),
    'Cost was around $3,200 for the year.'
  );
  assert.equal(
    __internal.sanitizeReportTags('A 33-inch fridge with $2,400 price and 8-year horizon.'),
    'A 33-inch fridge with $2,400 price and 8-year horizon.',
    'ordinary prose containing angle-bracket-free numbers/units must be untouched'
  );
  assert.deepEqual(
    __internal.sanitizeReportTags({ a: ['ok', '<b>bad</b> good'], b: { c: '<x>' } }),
    { a: ['ok', 'bad good'], b: { c: '' } },
    'must recurse through arrays and nested objects'
  );
  assert.equal(__internal.sanitizeReportTags(42), 42, 'non-string values must pass through unchanged');
});

test('__internal.mapToGenericReport always emits exactly six core sections in a fixed, promise-matching order', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const generic = __internal.mapToGenericReport(completeReportInput());
  const titles = generic.sections.slice(0, 6).map((s) => s.title.toLowerCase());
  assert.match(titles[0], /total cost of ownership/);
  assert.match(titles[1], /financing/);
  assert.match(titles[2], /maintenance/);
  assert.match(titles[3], /depreciation/);
  assert.match(titles[4], /compares/);
  assert.match(titles[5], /recommendation/);
});

test('__internal.buildSystemPrompt grounds the prompt in the customer\'s submitted structured fields and forbids declaring insufficiency', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const prompt = __internal.buildSystemPrompt(fakeSubmission());
  assert.match(prompt, /LG 33-inch French door refrigerator/);
  assert.match(prompt, /2400/);
  assert.match(prompt, /30301/);
  assert.match(prompt, /do not respond by asking for more information or declaring the input insufficient/i);
  // It still forbids the artifact, but no longer demonstrates it. The rule
  // used to spell out the exact token the leak reproduces, which on the
  // night of 2026-09-08 came back in nine of twelve report attempts.
  assert.match(prompt, /Do not put markup or structured call syntax of any kind/i);
  assert.deepEqual(
    prompt.match(/<[a-z/][^>]*>/gi),
    null,
    'the prompt must not contain the syntax it is telling the model not to write'
  );
});

// --- the cost model -------------------------------------------------------
//
// Everything below covers one live defect. The paid report for submission
// 29e81bc7 (2026-09-07, a 2023 RAV4 Hybrid held 7 years) put fuel at
// $9,000-$11,000 in its total-cost section and ALL running costs at
// $900-$1,100 a year — $6,300-$7,700 over the same 7 years — in its
// running-costs section three sections later. Roughly $3,000 apart on the
// same line item, with the larger figure feeding the headline range the
// customer reads first. Both paragraphs were fluent; nothing threw; every
// required field was present. The only way to notice was to sit down and
// do the arithmetic, which is the one thing this product is bought to save
// you doing.

// The real numbers from that report, in the shape the engine now requires.
// The RAV4 fixtures run over seven years; fakeSubmission is the eight-year
// appliance. Since the horizon is taken from the form rather than the model,
// a test pairing the two is testing a report for the wrong period.
function sevenYearSubmission() {
  const base = fakeSubmission();
  return fakeSubmission({ form_data: { ...base.form_data, ownership_years: '7' } });
}

function contradictoryReport() {
  return completeReportInput({
    total_cost_of_ownership: {
      time_horizon_years: 7,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 32400, high: 32400, basis: 'the quoted CPO price' },
        { label: 'Interest over 60 months', kind: 'financing', low: 5200, high: 6400, basis: '60 months at 6.5-7.5% APR' },
        // 9000-11000 over 7 years is 1286-1571 a year, against a maintenance
        // section saying 900-1100. That is the contradiction, now expressed
        // where the number actually lives.
        { label: 'Fuel', kind: 'running', per_year_low: 1286, per_year_high: 1571, basis: '12,000 mi/yr at 38-40 mpg' },
      ],
      explanation: 'Purchase price, interest and running costs over seven years.',
    },
    maintenance_running_costs: {
      annual_low: 900,
      annual_high: 1100,
      explanation: 'Fuel, insurance, tyres and scheduled servicing.',
    },
  });
}

test('__internal.tcoArithmeticProblem catches the live contradiction that shipped to a paying customer', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const problem = __internal.tcoArithmeticProblem(contradictoryReport());
  assert.ok(problem, 'a $3,000 disagreement on the same line item must be caught');
  // The message is handed straight back to the model as the repair prompt,
  // so it has to quote the figures rather than just name the fields.
  // Derived from the per-year figure now, so it lands on $9,002 rather
  // than the round number the model used to write straight into the field.
  assert.match(problem, /\$9,0\d\d/);
  assert.match(problem, /\$6,300/);
  assert.match(problem, /7 years/);
});

test('__internal.tcoArithmeticProblem passes a report whose two sections agree', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.tcoArithmeticProblem(completeReportInput()), null);
});

test('__internal.tcoArithmeticProblem tolerates ordinary rounding but not a real gap', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const nudged = (runLow, runHigh) => completeReportInput({
    total_cost_of_ownership: {
      time_horizon_years: 8,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'the quoted price' },
        { label: 'Electricity', kind: 'running', per_year_low: runLow / 8, per_year_high: runHigh / 8, basis: 'typical rates' },
        { label: 'Delivery', kind: 'other', low: 100, high: 150, basis: 'typical fee' },
      ],
      explanation: 'x',
    },
  });
  // annual 55-70 over 8 years = 440-560. The slack is the greater of 10%
  // or $200, so a $150 rounding difference is fine and a $900 one is not.
  assert.equal(__internal.tcoArithmeticProblem(nudged(500, 620)), null, 'rounding inside a range must not trip the check');
  assert.ok(__internal.tcoArithmeticProblem(nudged(1400, 1600)), 'a genuine disagreement must trip it');
});

test('__internal.tcoArithmeticProblem catches running costs missing from the breakdown entirely', () => {
  // The other way the same money goes wrong: the per-year figure is stated,
  // the customer reads it, and it is nowhere in the total they are quoted.
  const { __internal } = require('../api/_lib/purchase-engine');
  const problem = __internal.tcoArithmeticProblem(completeReportInput({
    total_cost_of_ownership: {
      time_horizon_years: 8,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'the quoted price' },
        { label: 'Delivery', kind: 'other', low: 100, high: 150, basis: 'typical fee' },
        { label: 'Installation', kind: 'other', low: 0, high: 200, basis: 'if a water line is needed' },
      ],
      explanation: 'x',
    },
  }));
  assert.match(problem, /no line of kind "running"/);
});

test('__internal.isReportComplete rejects a report that contradicts itself even though every field is filled', () => {
  // The point of the whole exercise: the report that shipped would pass any
  // check that only asks "is this field non-empty".
  const { __internal } = require('../api/_lib/purchase-engine');
  const bad = contradictoryReport();
  for (const key of ['headline', 'summary', 'recommendation', 'assumptions', 'alternative_comparison']) {
    assert.ok(bad[key], 'sanity: the fixture really is otherwise complete (' + key + ')');
  }
  assert.equal(__internal.isReportComplete(bad), false);
  assert.equal(__internal.firstIncompleteField(bad), 'total_cost_of_ownership.arithmetic');
});

test('__internal.validBreakdown refuses a breakdown that cannot be summed into an honest total', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const withItems = (items) => ({ time_horizon_years: 8, cost_breakdown: items, explanation: 'x' });
  const ok = [
    { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'quoted' },
    { label: 'Electricity', kind: 'running', per_year_low: 55, per_year_high: 70, basis: 'typical' },
    { label: 'Delivery', kind: 'other', low: 100, high: 150, basis: 'typical' },
  ];
  assert.ok(__internal.validBreakdown(withItems(ok)));
  assert.equal(__internal.validBreakdown(withItems(ok.slice(0, 2))), null, 'fewer than three line items is not a breakdown');
  assert.equal(__internal.validBreakdown(withItems(ok.slice(1))), null, 'no purchase line means the biggest cost is missing');
  assert.equal(
    __internal.validBreakdown(withItems([{ ...ok[0] }, { ...ok[1], per_year_low: -55, per_year_high: -37 }, ok[2]])),
    null,
    'a negative running cost is a mistake, not a modelling choice'
  );
  assert.equal(
    __internal.validBreakdown(withItems([ok[0], { ...ok[1], per_year_low: 900, per_year_high: 400 }, ok[2]])),
    null,
    'a range whose high is below its low cannot be summed into anything meaningful'
  );
  assert.equal(
    __internal.validBreakdown(withItems([ok[0], { ...ok[1], basis: '' }, ok[2]])),
    null,
    'a number with no stated basis is the kind of figure this product exists to avoid'
  );
  // Money coming back at the end is the one line allowed to be negative.
  assert.ok(__internal.validBreakdown(withItems(ok.concat([
    { label: 'Resale at year 8', kind: 'resale_recovery', low: -300, high: -100, basis: 'scrap value' },
  ]))));
});

test('a report that contradicts itself is rebuilt by a targeted repair instead of burning a whole attempt', async (t) => {
  const submission = sevenYearSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let mainCalls = 0;
  let costModelRepairs = 0;
  let repairPromptSeen = '';
  global.fetch = async (url, opts) => {
    if (repairKind(opts) === 'cost_model') {
      costModelRepairs++;
      repairPromptSeen = JSON.parse(opts.body).messages[0].content;
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: {
              time_horizon_years: 7,
              cost_breakdown: [
                { label: 'Purchase price', kind: 'purchase', low: 32400, high: 32400, basis: 'the quoted CPO price' },
                { label: 'Interest over 60 months', kind: 'financing', low: 5200, high: 6400, basis: '60 months at 6.5-7.5% APR' },
                { label: 'Fuel, insurance, servicing', kind: 'running', per_year_low: 900, per_year_high: 1100, basis: 'reconciled with the per-year figure' },
              ],
              annual_low: 900,
              annual_high: 1100,
              resale_low: 0,
              resale_high: 0,
            },
          }],
        }),
      };
    }
    mainCalls++;
    return toolUseResponse(contradictoryReport());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.equal(mainCalls, 1, 'a contradiction must cost one small repair call, not a whole regenerated report');
  assert.equal(costModelRepairs, 1);
  assert.equal(submission.generation_attempts, 1);
  assert.equal(reportInserts.length, 1);
  // The repair prompt has to name the contradiction. "Try again" would just
  // reproduce it: both of the original paragraphs looked right on their own.
  assert.match(repairPromptSeen, /\$9,0\d\d/);
  assert.match(repairPromptSeen, /\$6,300/);
  const total = report.key_numbers.find((n) => /total cost/i.test(n.label));
  assert.equal(total.value, '$43,900 – $46,500', 'the stored total must be the repaired line items summed');
});

test('a repair that still does not reconcile is rejected rather than shipped', async (t) => {
  const submission = sevenYearSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  global.fetch = async (url, opts) => {
    if (repairKind(opts) === 'cost_model') {
      // Splits the difference instead of picking one — still inconsistent.
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: {
              time_horizon_years: 7,
              cost_breakdown: [
                { label: 'Purchase price', kind: 'purchase', low: 32400, high: 32400, basis: 'quoted' },
                { label: 'Interest', kind: 'financing', low: 5200, high: 6400, basis: 'APR' },
                { label: 'Fuel', kind: 'running', per_year_low: 1143, per_year_high: 1357, basis: 'mpg' },
              ],
              annual_low: 900,
              annual_high: 1100,
            },
          }],
        }),
      };
    }
    return toolUseResponse(contradictoryReport());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const result = await generatePurchaseReport('sub-1');

  assert.equal(result, null, 'a repair that does not reconcile must hand back for another attempt');
  assert.equal(submission.status, 'paid');
  assert.equal(reportInserts.length, 0, 'a self-contradicting report must never reach a customer');
});

// --- the summary strip ----------------------------------------------------

test('__internal.mapToGenericReport computes the total from the line items rather than trusting a stated one', () => {
  // The old mapping read optional low_end/high_end strings. On the live
  // report the model wrote its numbers into the prose and left those blank,
  // so the summary strip at the top of the page contained exactly one
  // entry — the word "BUY" — above prose discussing $55,000-$66,000.
  const { __internal } = require('../api/_lib/purchase-engine');
  const generic = __internal.mapToGenericReport(completeReportInput());
  const labels = generic.key_numbers.map((n) => n.label);
  assert.equal(generic.key_numbers.length, 3, 'total, running cost and recommendation — this report pays cash');
  assert.match(labels[0], /Total cost of ownership \(8yr\)/);
  // 2400 + (440..560) + (100..150)
  assert.equal(generic.key_numbers[0].value, '$2,940 – $3,110');
  assert.equal(generic.key_numbers[1].value, '$55 – $70/yr');
  assert.equal(generic.key_numbers[2].value, 'BUY');
});

test('__internal.mapToGenericReport shows the interest cost when the customer is financing', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const generic = __internal.mapToGenericReport(completeReportInput({
    financing_impact: { applicable: true, explanation: 'A 60-month loan at 6.5-7.5%.' },
    total_cost_of_ownership: {
      time_horizon_years: 8,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'quoted' },
        { label: 'Interest', kind: 'financing', low: 300, high: 420, basis: '24 months at 9.9%' },
        { label: 'Electricity', kind: 'running', per_year_low: 55, per_year_high: 70, basis: 'typical' },
      ],
      explanation: 'x',
    },
  }));
  const financing = generic.key_numbers.find((n) => /interest/i.test(n.label));
  assert.equal(financing.value, '$300 – $420');
});

test('__internal.mapToGenericReport prints the line items above the total, each with its basis', () => {
  // So a customer can check the sum themselves. This is the part that makes
  // the arithmetic falsifiable rather than something to take on trust.
  const { __internal } = require('../api/_lib/purchase-engine');
  const items = __internal.mapToGenericReport(completeReportInput()).sections[0].items;
  assert.equal(items[0], 'Purchase price — $2,400 · the quoted price');
  // The per-year figure is shown alongside the period one, because it is
  // the number the model actually gave and the one the customer can check.
  assert.equal(items[1], 'Electricity — $440 – $560 ($55 – $70/yr) · typical U.S. rates');
  assert.equal(items[3], 'Total over 8 years — $2,940 – $3,110');
  assert.ok(items[4].includes('electricity over 8 years'), 'the prose explanation still follows the numbers');
});

// --- did research actually happen -----------------------------------------

test('__internal.countSearchRounds reads the response, not the model\'s claim about itself', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.countSearchRounds({ content: [{ type: 'text', text: 'I searched extensively.' }] }), 0);
  assert.equal(__internal.countSearchRounds({
    content: [
      { type: 'server_tool_use', name: 'web_search', input: {} },
      { type: 'server_tool_use', name: 'web_search', input: {} },
    ],
  }), 2);
  assert.equal(__internal.countSearchRounds({ content: [], usage: { server_tool_use: { web_search_requests: 3 } } }), 3);
});

test('a report generated without any live research says so, and its research notes are dropped', async (t) => {
  // buying.html tells the customer the analysis "uses live web research
  // where it can sharpen a figure". The live report of 2026-09-07 ran zero
  // searches and said nothing about it, so the customer had no way to know
  // the figures were training-knowledge estimates.
  const submission = fakeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async () => toolUseResponse(completeReportInput({
    research_notes: ['Current listings show similar models from $1,800-$2,600.'],
  }));
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.match(report.missing_or_uncertain[0], /No live research ran behind the cost figures/);
  assert.ok(
    !report.sections.some((s) => /live research/i.test(s.title)),
    'a research section must not appear when no search ran, whatever the model wrote in research_notes'
  );
  assert.equal(reportInserts.length, 1);
});

test('a report that did search keeps its research section and carries no disclaimer', async (t) => {
  const submission = fakeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async () => searchedToolUseResponse(completeReportInput({
    research_notes: ['Current listings show similar models from $1,800-$2,600.'],
  }), 3);
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.ok(report.sections.some((s) => /live research/i.test(s.title)));
  assert.ok(!report.missing_or_uncertain.some((m) => /No live web research/.test(m)));
});

// --- assumptions ----------------------------------------------------------

test('__internal.isReportComplete rejects an empty or near-empty assumptions list', () => {
  // This used to pass, on the reasoning that "there truly were none" is
  // sometimes honest. It never is here: the live report showed a seven-year
  // total with an empty list, so the customer saw a number whose assumed
  // fuel price, APR and insurance rate were all invisible.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.isReportComplete(completeReportInput({ assumptions: [] })), false);
  assert.equal(__internal.isReportComplete(completeReportInput({ assumptions: ['Assumed a typical electricity rate.'] })), false);
  assert.equal(__internal.isReportComplete(completeReportInput({ assumptions: ['  ', ''] })), false);
  assert.equal(__internal.firstIncompleteField(completeReportInput({ assumptions: [] })), 'assumptions');
  assert.equal(__internal.isReportComplete(completeReportInput()), true);
});

test('an empty assumptions list is refilled by a targeted repair rather than a full retry', async (t) => {
  const submission = fakeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let mainCalls = 0;
  global.fetch = async (url, opts) => {
    if (repairKind(opts) === 'assumptions') {
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: { assumptions: ['Electricity at $0.16/kWh.', 'About 550 kWh a year of draw.', 'No extended warranty.'] },
          }],
        }),
      };
    }
    mainCalls++;
    return toolUseResponse(completeReportInput({ assumptions: [] }));
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.equal(mainCalls, 1);
  assert.equal(submission.generation_attempts, 1);
  assert.equal(reportInserts.length, 1);
  const section = report.sections.find((s) => /assumptions/i.test(s.title));
  assert.equal(section.items.length, 3);
  assert.ok(section.items[0].includes('$0.16/kWh'));
});

// --- the prompt -----------------------------------------------------------

test('__internal.buildSystemPrompt tells the model the total is computed for it, and that research is expected', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const prompt = __internal.buildSystemPrompt(fakeSubmission());
  assert.match(prompt, /you should not state one/i, 'the model must be told the total is summed from its line items');
  assert.match(prompt, /checked against each other in code/i, 'and that the two running-cost figures are reconciled');
  assert.match(prompt, /Search before you write/i, 'searching is no longer framed as optional');
  assert.match(prompt, /zero is not acceptable/i);
  assert.match(prompt, /\$29/, 'the prompt still told the model the customer paid $39 after the price moved to $29');
  assert.ok(!prompt.includes('$39'));
});

test('a financing customer whose breakdown has no financing line is caught, not quietly shipped', () => {
  // "Financing cost impact" is one of the six things buying.html sells, and
  // its figure is read off the breakdown. Without a financing line the
  // promise disappears from the summary strip with nothing to show it went.
  const { __internal } = require('../api/_lib/purchase-engine');
  const noFinancingLine = completeReportInput({
    financing_impact: { applicable: true, explanation: 'A 24-month store card at 9.9%.' },
  });
  const problem = __internal.tcoArithmeticProblem(noFinancingLine);
  assert.match(problem, /no line of kind "financing"/);
  assert.equal(__internal.isReportComplete(noFinancingLine), false);

  const withFinancingLine = completeReportInput({
    financing_impact: { applicable: true, explanation: 'A 24-month store card at 9.9%.' },
    total_cost_of_ownership: {
      time_horizon_years: 8,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 2400, high: 2400, basis: 'quoted' },
        { label: 'Interest', kind: 'financing', low: 300, high: 420, basis: '24 months at 9.9%' },
        { label: 'Electricity', kind: 'running', per_year_low: 55, per_year_high: 70, basis: 'typical' },
      ],
      explanation: 'x',
    },
  });
  assert.equal(__internal.tcoArithmeticProblem(withFinancingLine), null);
  // A genuine 0% promotional loan is a real answer, as long as it is stated.
  const zeroInterest = JSON.parse(JSON.stringify(withFinancingLine));
  zeroInterest.total_cost_of_ownership.cost_breakdown[1] = {
    label: 'Interest', kind: 'financing', low: 0, high: 0, basis: '0% promotional financing for 24 months',
  };
  assert.equal(__internal.tcoArithmeticProblem(zeroInterest), null);
});

// --- the same total, in the prose -----------------------------------------
//
// Making the model give line items and summing them in code fixed the
// structured half. The first live report generated against that engine
// (2026-09-08, the same RAV4) showed it fixed only half. Its line items
// summed to $47,000-$57,700 and its running-cost cross-check reconciled
// exactly — and its headline read "~$52,000–$68,000 total 7-year cost",
// with the same invented figure repeated in three more places.
//
// The sentences below are that report, verbatim.

function ravReport(overrides) {
  return completeReportInput({
    total_cost_of_ownership: {
      time_horizon_years: 7,
      cost_breakdown: [
        { label: 'Purchase price (incl. VA sales tax/title/registration)', kind: 'purchase', low: 34300, high: 34700, basis: '$32,400 quoted plus ~$1,900-$2,300 Virginia sales tax and fees' },
        { label: 'Financing interest over 60-month loan', kind: 'financing', low: 3500, high: 4500, basis: 'typical used-auto-loan rates' },
        { label: 'Running costs', kind: 'running', per_year_low: 2600, per_year_high: 3500, basis: 'insurance, fuel and servicing' },
        { label: 'Resale recovered at year 7', kind: 'resale_recovery', low: -9000, high: -6000, basis: '25-30% of purchase price at trade-in' },
      ],
      explanation: 'Total 7-year cost of ownership is estimated at roughly $47,000-$57,700.',
    },
    maintenance_running_costs: { annual_low: 2600, annual_high: 3500, explanation: 'Insurance, fuel and routine servicing.' },
    financing_impact: { applicable: true, explanation: 'A 60-month loan at 6.5-7.5% APR.' },
    // The breakdown hands back $6,000-$9,000; the section has to say the same.
    depreciation_resale: {
      resale_low: 6000,
      resale_high: 9000,
      expected_resale_note: '25-30% of purchase price at trade-in',
      explanation: 'Toyota RAV4 Hybrids hold value well, so expect $6,000-$9,000 back at year 7.',
    },
    ...overrides,
  });
}

test('the line items sum to the total the strip shows, for the report that started all this', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const derived = __internal.deriveNumbers(ravReport());
  // 34,300 + 3,500 + 18,200 - 9,000  ..  34,700 + 4,500 + 24,500 - 6,000
  assert.equal(__internal.moneyRange(derived.total.low, derived.total.high), '$47,000 – $57,700');
  assert.equal(__internal.tcoArithmeticProblem(ravReport()), null, 'the structured half already agreed');
});

test('a total invented in the prose is caught in every place the live report put one', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const bad = ravReport({
    headline: '~$52,000–$68,000 total 7-year cost — the $32,400 CPO price itself looks fair, but financing + Fairfax-area running costs roughly double the sticker over time',
    total_cost_of_ownership: {
      ...ravReport().total_cost_of_ownership,
      explanation: 'Total 7-year cost of ownership is estimated at roughly $52,000–$68,000. That includes the $32,400 purchase price plus an estimated $3,500–$4,500 in financing interest over the 60-month loan.',
    },
    recommendation: { verdict: 'buy', reasoning: 'Shop your 60-month loan rate with an outside lender, since that is the biggest lever left to reduce the $52,000–$68,000 total cost estimate.' },
    alternative_comparison: {
      alternative_name: '2023 Honda CR-V Hybrid Sport AWD',
      alternative_price_low: 33000,
      alternative_price_high: 34500,
      alternative_total_low: 50000,
      alternative_total_high: 63000,
      explanation: 'A comparably equipped CR-V Hybrid CPO typically prices $1,000-$2,000 higher, which pushes 7-year total cost slightly above the RAV4\'s $52,000-$68,000 range once financing and running costs are included.',
    },
  });

  const paths = __internal.proseTotalConflicts(bad).map((c) => c.path).sort();
  assert.deepEqual(paths, [
    'alternative_comparison.explanation',
    'headline',
    'recommendation.reasoning',
    'total_cost_of_ownership.explanation',
  ]);
  // The quoted figure goes into the repair prompt, so it has to be the
  // actual text and not just the field name.
  // Every figure in the field that reads as a total claim, since which one
  // the sentence means is not reliably recoverable from word order.
  assert.match(__internal.proseTotalConflicts(bad)[0].quoted, /\$52,000–\$68,000/);
  assert.equal(__internal.isReportComplete(bad), false);
  assert.equal(__internal.firstIncompleteField(bad), 'total_cost_of_ownership.prose');
});

test('the check does not fire on figures that are not claims about the total', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  // Every one of these is a real sentence from the same live report.
  const innocent = ravReport({
    headline: '$47,000-$57,700 total 7-year cost — the $32,400 CPO price itself looks fair',
    summary: 'Financing $32,400 over 60 months adds roughly $5,600-$6,800 in interest, bringing the total amount paid over the loan term to about $38,000-$39,200.',
    recommendation: {
      verdict: 'buy',
      reasoning: 'Depreciation is only about $13,000-$14,500 of the total cost — a relatively small slice, since resale value lands around $18,000-$19,500 at trade-in.',
    },
  });
  assert.deepEqual(__internal.proseTotalConflicts(innocent), [], JSON.stringify(__internal.proseTotalConflicts(innocent)));
  assert.equal(__internal.isReportComplete(innocent), true);
});

test('a field that states the total correctly is not tripped by a price sitting next to it', () => {
  // "$47,000-$57,700 total 7-year cost — the $32,400 CPO price looks fair"
  // used to report the $32,400 as a rival total, because it sat within
  // thirty characters of the words "total cost".
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.deepEqual(
    __internal.proseTotalConflicts(ravReport({
      headline: '$47,000-$57,700 total 7-year cost — the $32,400 CPO price itself looks fair',
    })),
    []
  );
});

test('an invented prose total is corrected in place, and the correction is checked', async (t) => {
  const submission = sevenYearSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let mainCalls = 0;
  let proseRepairs = 0;
  let promptSeen = '';
  let fieldsAsked = [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const tool = (body.tools || [])[0];
    const props = (tool && tool.input_schema && tool.input_schema.properties) || {};
    if (props.headline || props.total_cost_of_ownership__explanation) {
      proseRepairs++;
      promptSeen = body.messages[0].content;
      fieldsAsked = Object.keys(props).sort();
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: {
              headline: '$47,000-$57,700 total 7-year cost — the $32,400 CPO price itself looks fair',
              total_cost_of_ownership__explanation: 'Total 7-year cost of ownership works out to $47,000-$57,700 once resale is netted off.',
            },
          }],
        }),
      };
    }
    mainCalls++;
    return toolUseResponse(ravReport({
      headline: '~$52,000–$68,000 total 7-year cost — the $32,400 CPO price itself looks fair',
      total_cost_of_ownership: {
        ...ravReport().total_cost_of_ownership,
        explanation: 'Total 7-year cost of ownership is estimated at roughly $52,000–$68,000.',
      },
    }));
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.equal(mainCalls, 1, 'a wrong number in prose must not cost a whole regenerated report');
  assert.equal(proseRepairs, 1);
  assert.deepEqual(fieldsAsked, ['headline', 'total_cost_of_ownership__explanation'], 'only the fields that were wrong get rewritten');
  // The model could not have got this right first time — it wrote the
  // headline before anything had added up its line items — so the repair
  // has to hand it the computed figure rather than ask it to try again.
  assert.match(promptSeen, /\$47,000 – \$57,700/);
  assert.ok(report.headline.includes('$47,000-$57,700'));
  assert.equal(reportInserts.length, 1);
});

test('a prose repair that keeps the wrong total is rejected rather than shipped', async (t) => {
  const submission = sevenYearSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const props = ((body.tools || [])[0] || {}).input_schema;
    if (props && props.properties && props.properties.headline) {
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: { headline: 'Still ~$52,000–$68,000 total 7-year cost, reworded' },
          }],
        }),
      };
    }
    return toolUseResponse(ravReport({
      headline: '~$52,000–$68,000 total 7-year cost — the $32,400 CPO price looks fair',
    }));
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const result = await generatePurchaseReport('sub-1');

  assert.equal(result, null, 'a repair that did not fix the number must hand back for another attempt');
  assert.equal(submission.status, 'paid');
  assert.equal(reportInserts.length, 0);
});

// --- resale: the last quantity that lived in two places --------------------
//
// The report generated on the fixed engine (submission 95216657,
// 2026-09-08) reconciled perfectly on every check that existed: its line
// items summed to the $49,280-$61,880 in the summary strip, and its
// running-cost line was exactly seven times its per-year figure. Two
// numbers were still wrong, both of them a quantity stated twice.
//
//   - the breakdown took $6,000-$8,000 off the total as resale, and the
//     assumptions list said 22-31% of $32,400 (so $7,100-$10,000) — while
//     the depreciation section, the one a customer reads FOR that number,
//     said "a resale/trade-in value in the ballpark of $16,000-$18,000".
//     Two of the three agreed; the prose was out by a factor of two.
//
//   - the headline read "roughly $51,000–$65,000 in true 7-year cost"
//     directly above a strip reading $49,280 – $61,880. The prose check
//     waved it through twice over: the tolerance was 10% (it is 3.5% and
//     5.0% out), and the pattern required the literal word "total", which
//     "true 7-year cost" does not contain.

function ravBreakdown() {
  return [
    { label: 'Purchase price (vehicle)', kind: 'purchase', low: 32400, high: 32400, basis: 'Quoted CPO price' },
    { label: 'Financing interest over 60-month loan', kind: 'financing', low: 5700, high: 9300, basis: '6.5% to 11.4% APR' },
    { label: 'Fuel, insurance, maintenance, VA taxes', kind: 'running', per_year_low: 2740, per_year_high: 3740, basis: 'Fairfax rates' },
    { label: 'Estimated resale value at end of 7 years', kind: 'resale_recovery', low: -8000, high: -6000, basis: '20-25% of original value retained' },
  ];
}

function ravLive(overrides) {
  return completeReportInput({
    headline: 'About $32,400 upfront becomes roughly $49,280–$61,880 in true 7-year cost — the car itself is a smart pick',
    total_cost_of_ownership: {
      time_horizon_years: 7,
      cost_breakdown: ravBreakdown(),
      explanation: 'Total cost of ownership over 7 years is estimated at $49,280 – $61,880.',
    },
    financing_impact: { applicable: true, explanation: 'A 60-month loan at 6.5-11.4% APR.' },
    maintenance_running_costs: { annual_low: 2740, annual_high: 3740, explanation: 'Fuel, insurance and servicing.' },
    depreciation_resale: {
      resale_low: 6000,
      resale_high: 8000,
      expected_resale_note: 'roughly 20-25% of original value retained after 7 years',
      explanation: 'Toyota RAV4 Hybrids hold their value well, so expect $6,000-$8,000 back at trade-in.',
    },
    ...overrides,
  });
}

test('the live report reconciles once its two remaining figures are right', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const derived = __internal.deriveNumbers(ravLive());
  assert.equal(__internal.moneyRange(derived.total.low, derived.total.high), '$49,280 – $61,880');
  assert.equal(__internal.tcoArithmeticProblem(ravLive()), null);
  assert.deepEqual(__internal.proseTotalConflicts(ravLive()), []);
  assert.equal(__internal.isReportComplete(ravLive()), true);
});

test('the resale figure must match the money the total actually takes off', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  // The breakdown nets off $6,000-$8,000; the section claims $16,000-$18,000.
  const problem = __internal.tcoArithmeticProblem(ravLive({
    depreciation_resale: { resale_low: 16000, resale_high: 18000, expected_resale_note: 'x', explanation: 'y' },
  }));
  assert.match(problem, /\$6,000/);
  assert.match(problem, /\$16,000/);
  assert.match(problem, /same number and must agree/);
});

test('a resale figure with no line taking it off the total is caught', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const problem = __internal.tcoArithmeticProblem(ravLive({
    total_cost_of_ownership: {
      time_horizon_years: 7,
      cost_breakdown: ravBreakdown().filter((i) => i.kind !== 'resale_recovery'),
      explanation: 'x',
    },
  }));
  assert.match(problem, /no line of kind "resale_recovery"/);
});

test('a category with no resale market is a real answer, not a contradiction', () => {
  // The appliance fixture: zero back at the end, and no resale line.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.tcoArithmeticProblem(completeReportInput()), null);
  assert.equal(__internal.isReportComplete(completeReportInput()), true);
  assert.deepEqual(__internal.proseTotalConflicts(completeReportInput()), []);
});

test('a resale figure invented in the prose is caught, in the section written for it', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const conflicts = __internal.proseTotalConflicts(ravLive({
    depreciation_resale: {
      resale_low: 6000,
      resale_high: 8000,
      expected_resale_note: 'roughly 20-25% of original value retained after 7 years',
      explanation: 'Expect it to retain roughly 50-55% of its current value after 7 years, meaning a resale/trade-in value in the ballpark of $16,000-$18,000 at the end of your ownership period.',
    },
  }));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'depreciation_resale.explanation');
  assert.equal(conflicts[0].quoted, '$16,000-$18,000');
  // The repair prompt names the right figure per field, not one global total.
  assert.equal(conflicts[0].correct, '$6,000 – $8,000');
});

test('a percentage of the purchase price in the resale section is not a rival figure', () => {
  // "retain roughly 50-55% of its value" and "$32,400 purchase price" both
  // sit in this section constantly and are not claims about resale value.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.deepEqual(__internal.proseTotalConflicts(ravLive({
    depreciation_resale: {
      resale_low: 6000,
      resale_high: 8000,
      expected_resale_note: 'roughly 20-25% of original value retained after 7 years',
      explanation: 'Starting from the $32,400 purchase price, expect it to retain roughly 20-25% after 7 years — around $6,000-$8,000 at trade-in.',
    },
  })), []);
});

test('a total claim written without the word "total" is still a total claim', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const phrasings = [
    'becomes roughly $51,000–$65,000 in true 7-year cost',
    'the all-in cost lands at $51,000–$65,000',
    'a 7-year cost of $51,000–$65,000',
    'total cost of ownership runs $51,000–$65,000',
  ];
  for (const headline of phrasings) {
    const conflicts = __internal.proseTotalConflicts(ravLive({ headline }));
    assert.equal(conflicts.length, 1, `"${headline}" should have been caught`);
    assert.equal(conflicts[0].path, 'headline');
  }
});

test('prose is held to a tighter tolerance than the structural cross-checks', () => {
  // $51,000 against a computed $49,280 is 3.5% out — inside the 10% used
  // for the running-cost reconciliation, and a visibly different number
  // sitting inches above the real one. An honest round still passes.
  const { __internal } = require('../api/_lib/purchase-engine');
  const at = (headline) => __internal.proseTotalConflicts(ravLive({ headline })).length;
  assert.equal(at('a true 7-year cost of $49,000–$62,000'), 0, 'rounding the computed figure must pass');
  assert.equal(at('a true 7-year cost of $51,000–$65,000'), 1, 'a second number for the same thing must not');
});

test('the resale figure reaches the customer in the summary strip', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const generic = __internal.mapToGenericReport(ravLive());
  const resale = generic.key_numbers.find((n) => /worth at year/i.test(n.label));
  assert.equal(resale.label, 'Worth at year 7');
  assert.equal(resale.value, '$6,000 – $8,000');
  // And is absent where there is no resale market, rather than showing $0.
  assert.equal(
    __internal.mapToGenericReport(completeReportInput()).key_numbers.some((n) => /worth at year/i.test(n.label)),
    false
  );
});

// --- the appliance run ----------------------------------------------------
//
// Submission 9852136c (2026-09-08): an LG counter-depth fridge, $2,899,
// cash, kept 12 years, in Fairfax. The first non-vehicle report, and the
// first to exercise two branches nothing had run live — paying cash, and a
// category with no resale market. Both worked. Its line items summed to
// $4,983-$6,153 exactly, and its running lines reconciled with its per-year
// figure exactly.
//
// Every COMPONENT still disagreed with itself, which is where the
// contradiction had moved:
//
//   electricity   line $50-$70/yr | prose $120-$180/yr | assumptions gave
//                 the EnergyGuide rating and the Dominion rate, which work
//                 out to $102-$123/yr
//   water filter  line $40-$60 each | prose $50-$60 | assumptions $25-$40
//   lifetime cost computed $4,983-$6,153 | financing section $5,300-$7,500
//
// The line item was the one that was wrong, and it made the headline total
// about $600 too low.

function fridgeReport(overrides) {
  return completeReportInput({
    headline: 'Total 12-year cost: about $4,983–$6,149 for the LG counter-depth French door fridge',
    total_cost_of_ownership: {
      time_horizon_years: 12,
      cost_breakdown: [
        { label: 'Purchase price plus VA sales tax and delivery', kind: 'purchase', low: 3123, high: 3173, basis: '$2,899 plus ~6% VA tax and delivery' },
        { label: 'Electricity', kind: 'running', per_year_low: 50, per_year_high: 70, basis: 'ENERGY STAR rated compressor' },
        { label: 'Water filter replacements', kind: 'running', per_year_low: 80, per_year_high: 120, basis: 'two changes a year' },
        { label: 'Out-of-warranty repairs', kind: 'running', per_year_low: 25, per_year_high: 58, basis: 'allowance for years 6-12, averaged' },
        { label: 'Resale value at end of 12 years', kind: 'resale_recovery', low: 0, high: 0, basis: 'negligible after 12 years' },
      ],
      explanation: 'Purchase price plus twelve years of electricity, filters and out-of-warranty repairs.',
    },
    financing_impact: { applicable: false, explanation: 'Paying cash, so there is no interest to add.' },
    maintenance_running_costs: {
      annual_low: 155,
      annual_high: 248,
      explanation: 'Electricity runs about $50–$70/year for this ENERGY STAR model, plus roughly $80–$120/year in water filters and an allowance of $25–$58/year for repairs once the warranty lapses.',
    },
    depreciation_resale: { resale_low: 0, resale_high: 0, expected_resale_note: 'no meaningful resale market', explanation: 'Appliances fetch essentially nothing after twelve years.' },
    ...overrides,
  });
}

test('the two branches the vehicle runs never touched both work', () => {
  // Paying cash means no financing line is demanded, and a category with no
  // resale market means a zero resale line is a real answer.
  const { __internal } = require('../api/_lib/purchase-engine');
  const r = fridgeReport();
  assert.equal(__internal.tcoArithmeticProblem(r), null);
  assert.deepEqual(__internal.proseTotalConflicts(r), []);
  assert.equal(__internal.isReportComplete(r), true);
  const generic = __internal.mapToGenericReport(r);
  assert.equal(generic.key_numbers[0].value, '$4,983 – $6,149');
  assert.equal(
    generic.key_numbers.some((n) => /worth at year/i.test(n.label)),
    false,
    'a $0 resale market must not show a "worth at year 12: $0" row'
  );
});

test('a running cost is stated once, per year, and the period figure is worked out from it', () => {
  // The model used to write the per-year figure, the whole-period figure and
  // a basis string describing both, and the fridge report put three
  // different electricity numbers in those three places. The whole-period
  // field is now ignored on a running line, so it cannot disagree.
  const { __internal } = require('../api/_lib/purchase-engine');
  const lying = fridgeReport();
  lying.total_cost_of_ownership.cost_breakdown[1].low = 99999;
  lying.total_cost_of_ownership.cost_breakdown[1].high = 99999;
  const derived = __internal.deriveNumbers(lying);
  assert.equal(__internal.moneyRange(derived.total.low, derived.total.high), '$4,983 – $6,149',
    'a whole-period figure written on a running line must have no effect at all');
  assert.deepEqual(__internal.itemRange(lying.total_cost_of_ownership.cost_breakdown[1], 12), { low: 600, high: 840 });
});

test('a running line with no per-year figure is not a usable breakdown', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const r = fridgeReport();
  delete r.total_cost_of_ownership.cost_breakdown[1].per_year_low;
  assert.equal(__internal.validBreakdown(r.total_cost_of_ownership), null);
  assert.equal(__internal.firstIncompleteField(r), 'total_cost_of_ownership.cost_model');
});

test('a per-year figure in the prose must be one the report actually uses', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const conflict = __internal.proseRunningConflict(fridgeReport({
    maintenance_running_costs: {
      annual_low: 155,
      annual_high: 248,
      explanation: 'Expect roughly $10–$15/month in electricity (about $120–$180/year), plus about $50–$60 every 6 months for replacement water filters.',
    },
  }));
  assert.equal(conflict.path, 'maintenance_running_costs.explanation');
  assert.equal(conflict.quoted, '$120–$180/year');
  // It names the line the figure was describing, not a menu of every
  // figure in the report — being right about the wrong line is the
  // failure mode this check exists to catch.
  assert.match(conflict.correct, /\$50 – \$70\/yr/);
  assert.match(conflict.correct, /Electricity. line says/);
});

test('the per-year check tolerates the figures the report does use', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  // Each of these is one of the line items or the aggregate, rounded.
  for (const explanation of [
    'Electricity is about $50–$70/year and filters about $80–$120 per year.',
    'All in, running costs come to roughly $155–$248 a year.',
    'Repairs average $25–$58 annually once the warranty lapses.',
    'Coil cleaning is DIY and costs nothing, and a service call runs $150–$600 per incident.',
  ]) {
    assert.equal(
      __internal.proseRunningConflict(fridgeReport({
        maintenance_running_costs: { annual_low: 155, annual_high: 248, explanation },
      })),
      null,
      explanation
    );
  }
});

test('the financing section cannot state a lifetime total of its own', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const conflicts = __internal.proseTotalConflicts(fridgeReport({
    financing_impact: {
      applicable: false,
      explanation: 'Paying cash is the most cost-efficient route, since even a 0% promotional plan would offer no savings, while any interest-bearing plan would only add to the $5,300–$7,500 lifetime cost estimate.',
    },
  }));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'financing_impact.explanation');
  assert.equal(conflicts[0].quoted, '$5,300–$7,500');
});

test('a loan total in the financing section is still allowed to be itself', () => {
  // This section was left out of the prose scan for a reason: the amount
  // paid over a loan term is a legitimately different quantity that lives
  // here, and flagging it would send an honest sentence back for rewriting.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.deepEqual(__internal.proseTotalConflicts(fridgeReport({
    financing_impact: {
      applicable: true,
      explanation: 'At 6.5% you would pay roughly $5,700 in interest, bringing your all-in vehicle cost to about $38,100 and the total amount paid over the loan term to $38,000-$39,200.',
    },
  })), []);
});

test('the alternative has to be costed, not just named', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  // The fridge report named a Samsung Bespoke with an internal dispenser and
  // then compared "a similar fridge WITHOUT an internal water dispenser",
  // giving no price for either. Nothing there could be compared.
  const vague = fridgeReport({
    alternative_comparison: {
      alternative_name: 'Samsung RF24BB6600AC Bespoke, internal dispenser',
      explanation: 'A model without the dispenser and filter system would likely cost somewhat less over its lifetime.',
    },
  });
  assert.equal(__internal.isReportComplete(vague), false);
  assert.equal(__internal.firstIncompleteField(vague), 'alternative_comparison');

  const costed = fridgeReport({
    alternative_comparison: {
      alternative_name: 'Samsung RF24BB6600AC Bespoke, internal dispenser',
      alternative_price_low: 2600,
      alternative_price_high: 2900,
      alternative_total_low: 4600,
      alternative_total_high: 5800,
      explanation: 'It costs a little less up front and runs slightly cheaper on filters.',
    },
  });
  assert.equal(__internal.isReportComplete(costed), true);
  const section = __internal.mapToGenericReport(costed).sections.find((x) => /compares/i.test(x.title));
  assert.equal(section.items[0], 'Price — $2,600 – $2,900');
  assert.match(section.items[1], /^Total over 12 years — \$4,600 – \$5,800 \(this one: \$4,983 – \$6,149\)$/,
    'the two totals have to sit side by side, or it is not a comparison');
});

test('an alternative whose total is below its own price is rejected', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.isReportComplete(fridgeReport({
    alternative_comparison: {
      alternative_name: 'x', alternative_price_low: 2600, alternative_price_high: 2900,
      alternative_total_low: 1000, alternative_total_high: 5800, explanation: 'y',
    },
  })), false);
});

test('research that ran is asked for rather than dropped', async (t) => {
  // The fridge report searched — its assumptions cite Dominion territory,
  // the 2026-27 Virginia rate case, the EnergyGuide rating and LG's filter
  // guidance — and returned an empty research_notes, so the customer's
  // report carried no research section at all.
  const submission = fakeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let asked = 0;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const props = (((body.tools || [])[0] || {}).input_schema || {}).properties || {};
    if (props.research_notes) {
      asked++;
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: { research_notes: ['Dominion Energy residential rates currently run $0.15-$0.18/kWh.'] },
          }],
        }),
      };
    }
    return searchedToolUseResponse(completeReportInput({ research_notes: [] }), 3);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.equal(asked, 1);
  const section = report.sections.find((x) => /live research/i.test(x.title));
  assert.match(section.items[0], /Dominion/);
});

test('if the notes cannot be recovered the customer is told, not left guessing', async (t) => {
  const submission = fakeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const props = (((body.tools || [])[0] || {}).input_schema || {}).properties || {};
    if (props.research_notes) return { ok: true, json: async () => ({ content: [] }) };
    return searchedToolUseResponse(completeReportInput({ research_notes: [] }), 3);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  // A missing research section must not cost the customer their whole
  // analysis — but it must not pass silently either.
  assert.ok(report.headline, 'the report still ships');
  assert.ok(report.missing_or_uncertain.some((m) => /could not be summarised/i.test(m)));
});

// --- what the second appliance run found ----------------------------------

test('both tools that build a breakdown actually require the per-year fields', () => {
  // Not a style point. On submission 50921a02 the cost-model repair omitted
  // per_year on its running lines — the schema only mentioned they were
  // needed in a description, while the required array still listed the old
  // five fields — so validBreakdown rejected the repair, the loop broke, and
  // a whole generation attempt was spent proving that the schema and the
  // validator disagreed with each other. The log line was "Cost-model repair
  // returned an unusable breakdown".
  const { __internal } = require('../api/_lib/purchase-engine');
  const itemSchemaOf = (tool) => {
    const props = tool.input_schema.properties;
    const breakdown = props.cost_breakdown || props.total_cost_of_ownership.properties.cost_breakdown;
    return breakdown.items;
  };
  for (const [name, tool] of [['submit_purchase_report', __internal.REPORT_TOOL], ['the cost-model repair', __internal.COST_MODEL_REPAIR_TOOL]]) {
    const item = itemSchemaOf(tool);
    for (const field of ['label', 'kind', 'low', 'high', 'per_year_low', 'per_year_high', 'basis']) {
      assert.ok(
        item.required.includes(field),
        `${name} must require ${field} on a line item — a field the description calls required and the schema does not is how the repair produced a breakdown the validator threw away`
      );
    }
  }
});

test('searching and finding nothing usable is an answer the model can give', async (t) => {
  // The repair added earlier that day told the model "you ran 5 searches,
  // the notes did not reach us", which leaves no room for the honest reply.
  // The report that came back said in its own prose that "a fresh price
  // check could not be completed this session" AND carried five notes
  // describing retailer listings and utility rates. The logs showed five
  // real search rounds and no notes recorded from them, so at least one of
  // those two statements was written to fill the gap the prompt left.
  const submission = fakeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let promptSeen = '';
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const props = (((body.tools || [])[0] || {}).input_schema || {}).properties || {};
    if (props.research_notes) {
      promptSeen = body.messages[0].content;
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'tool_use', name: 'submit_field_repair', input: { found_nothing_usable: true, research_notes: [] } }],
        }),
      };
    }
    return searchedToolUseResponse(completeReportInput({ research_notes: [] }), 5);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.match(promptSeen, /Do NOT reconstruct findings/i, 'the prompt has to offer the honest answer, not just ask for notes');
  assert.equal(
    report.sections.some((x) => /live research/i.test(x.title)),
    false,
    'no research section may be conjured out of searches that found nothing'
  );
  assert.match(report.missing_or_uncertain[0], /searches run for the cost figures did not turn up anything/i);
});

test('notes are still used when the model says it actually found something', async (t) => {
  const submission = fakeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const props = (((body.tools || [])[0] || {}).input_schema || {}).properties || {};
    if (props.research_notes) {
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: { found_nothing_usable: false, research_notes: ['Dominion Energy residential rates run $0.13-$0.15/kWh.'] },
          }],
        }),
      };
    }
    return searchedToolUseResponse(completeReportInput({ research_notes: [] }), 5);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  const section = report.sections.find((x) => /live research/i.test(x.title));
  assert.match(section.items[0], /Dominion/);
  assert.equal(report.missing_or_uncertain.some((m) => /did not turn up/i.test(m)), false);
});

// --- the must-haves -------------------------------------------------------
//
// Three runs of one appliance submission — an LG LRFXC2416S whose stated
// must-haves included "no external door dispenser" — produced three
// different verdicts:
//
//   WAIT        over the fridge's 70.25" height against a 70" clearance
//   RECONSIDER  having found the external door dispenser
//   BUY         asserting the model has "no external dispenser" and
//               "already matches your must-haves"
//
// The first two are true and checkable. The third is false: LG's own
// product page lists a Tall Ice & Water Dispenser on that model, and Lowe's
// sells it as "with Dual Ice Maker, Water and Ice Dispenser". That report
// told a customer their deal-breaker was satisfied, as a reason to buy.
//
// It passed every check in this file. Its arithmetic reconciled to the
// dollar, its prose quoted no rival totals, its assumptions matched its
// line items. The defect was not a contradiction — it was a confident
// memory — so no further validation of the kind above would ever have
// caught it.

const MUST_HAVES = 'internal ice maker, no external door dispenser, must fit a 36-inch opening';

// The must-haves are graded in their own request now (see verifyMustHaves),
// so a fake has to answer two different calls.
function isVerifyCall(opts) {
  const body = JSON.parse((opts && opts.body) || '{}');
  return (body.tools || []).some((t) => t.name === 'submit_must_have_checks');
}

function mustHaveResponse(checks, rounds) {
  const content = [];
  for (let i = 0; i < (rounds || 0); i++) {
    content.push({ type: 'server_tool_use', name: 'web_search', id: 'srv_' + i, input: { query: 'spec' } });
  }
  content.push({ type: 'tool_use', name: 'submit_must_have_checks', input: { must_have_checks: checks } });
  return {
    ok: true,
    json: async () => ({ content, usage: { server_tool_use: { web_search_requests: rounds || 0 } } }),
  };
}

function fridgeSubmission() {
  return fakeSubmission({
    form_data: { ...fakeSubmission().form_data, must_have_features: MUST_HAVES },
  });
}

// published_value is the figure the verdict rests on, quoted rather than
// paraphrased, and the size requirement carries the two numbers so its
// verdict is computed rather than judged.
const LG_CHECKS = () => ([
  { requirement: 'internal ice maker', verdict: 'confirmed', finding: 'Ships with a Dual Ice Maker including Craft Ice.', published_value: 'Dual Ice Maker with Craft Ice', source: "LG's product page" },
  { requirement: 'no external door dispenser', verdict: 'contradicted', finding: 'Has a Tall Ice & Water Dispenser built into the door.', published_value: 'Tall Ice & Water Dispenser with Measured Fill', source: "LG's product page" },
  {
    requirement: 'must fit a 36-inch opening',
    verdict: 'confirmed',
    finding: 'Listed at 35.75 inches wide.',
    published_value: '35 3/4 in W',
    measurement: { value: 35.75, limit: 36, unit: 'inches', comparison: 'at_most' },
    source: 'LG spec sheet',
  },
]);

function checkedReport(overrides) {
  return completeReportInput({
    must_have_checks: LG_CHECKS(),
    recommendation: { verdict: 'reconsider', reasoning: 'The model has the door dispenser you called a deal-breaker.' },
    ...overrides,
  });
}

test('__internal.mustHaveFragments splits the ways people actually write a list', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.deepEqual(
    __internal.mustHaveFragments(fridgeSubmission()),
    ['internal ice maker', 'no external door dispenser', 'must fit a 36-inch opening']
  );
  assert.deepEqual(
    __internal.mustHaveFragments(fakeSubmission({ form_data: { must_have_features: 'AWD, Apple CarPlay and roof rails' } })),
    ['AWD', 'Apple CarPlay', 'roof rails']
  );
  assert.deepEqual(__internal.mustHaveFragments(fakeSubmission()), [], 'no must-haves is not a problem to report');
});

test('a report that claims compliance without checking anything is incomplete', () => {
  // Exactly what shipped: must_have_checks empty, and the recommendation
  // asserting in prose that the item matches.
  const { __internal } = require('../api/_lib/purchase-engine');
  const claimed = completeReportInput({
    must_have_checks: [],
    recommendation: { verdict: 'buy', reasoning: 'It has an internal ice maker, no external dispenser, and fits a 36-inch opening.' },
  });
  const problem = __internal.mustHaveProblem(claimed, fridgeSubmission());
  assert.match(problem, /named 3 must-haves/);
  assert.match(problem, /checks none of them/);
  assert.equal(__internal.isReportComplete(claimed, fridgeSubmission()), false);
  assert.equal(__internal.firstIncompleteField(claimed, fridgeSubmission()), 'must_have_checks');
});

test('a failed deal-breaker cannot sit under a BUY', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const buying = checkedReport({ recommendation: { verdict: 'buy', reasoning: 'r' } });
  assert.match(
    __internal.mustHaveProblem(buying, fridgeSubmission()),
    /fails "no external door dispenser" and then recommends buying it/
  );
  assert.equal(__internal.isReportComplete(buying, fridgeSubmission()), false);
  // The same finding under a reconsider is the correct report.
  assert.equal(__internal.mustHaveProblem(checkedReport(), fridgeSubmission()), null);
  assert.equal(__internal.isReportComplete(checkedReport(), fridgeSubmission()), true);
});

test('a graded verdict has to name what it was checked against', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  for (const source of ['general knowledge', 'not checked', 'n/a', 'unknown', 'training data']) {
    const checks = LG_CHECKS();
    checks[0].source = source;
    assert.match(
      __internal.mustHaveProblem(checkedReport({ must_have_checks: checks }), fridgeSubmission()),
      /names no source it was checked against/,
      source
    );
  }
  // "not checked" is the honest answer, and is fine alongside unverified.
  const honest = LG_CHECKS();
  honest[0] = { requirement: 'internal ice maker', verdict: 'unverified', finding: 'Could not confirm the ice maker location.', source: 'not checked' };
  assert.equal(__internal.mustHaveProblem(checkedReport({ must_have_checks: honest }), fridgeSubmission()), null);
});

test('every must-have the customer named has to be answered', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.match(
    __internal.mustHaveProblem(checkedReport({ must_have_checks: LG_CHECKS().slice(0, 2) }), fridgeSubmission()),
    /asked for "must fit a 36-inch opening" and the report never says/
  );
});

test('with no research behind them, every spec verdict is downgraded to unverified', async (t) => {
  // The deterministic half. A model that remembers a product having a
  // feature is not a model that checked, and the BUY report was confident,
  // consistent and wrong. This cannot invent a problem — it can only stop
  // one being ruled out on nothing.
  const submission = fridgeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  // Verification answers with confident verdicts and no searches behind them.
  global.fetch = async (url, opts) =>
    (isVerifyCall(opts) ? mustHaveResponse(LG_CHECKS(), 0) : toolUseResponse(checkedReport()));
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generateUntilReport('sub-1');

  const section = report.sections[0];
  assert.match(section.title, /must-haves/i, 'the must-haves come before the money');
  for (const line of section.items) {
    assert.match(line, /^\?/, 'every verdict must be unverified when nothing was looked up: ' + line);
    assert.match(line, /no live lookup ran/);
  }
  assert.equal(reportInserts.length, 1);
});

test('a graded verdict survives when research did run', async (t) => {
  const submission = fridgeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => (isVerifyCall(opts)
    ? mustHaveResponse(LG_CHECKS(), 3)
    : searchedToolUseResponse(checkedReport({ research_notes: ['LG product page lists a Tall Ice & Water Dispenser.'] }), 4));
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generateUntilReport('sub-1');

  const section = report.sections[0];
  // The published figure the verdict rests on now travels with it.
  assert.equal(section.items[0], '✓ internal ice maker — Ships with a Dual Ice Maker including Craft Ice. [published: Dual Ice Maker with Craft Ice] (LG\'s product page)');
  assert.equal(section.items[1], '✗ no external door dispenser — Has a Tall Ice & Water Dispenser built into the door. [published: Tall Ice & Water Dispenser with Measured Fill] (LG\'s product page)');
  const strip = report.key_numbers.find((n) => /must-haves/i.test(n.label));
  assert.equal(strip.value, '1 of 3 NOT met', 'a failed deal-breaker belongs in the strip, not three screens down');
});

test('anything left unverified is put in front of the customer as a thing to check', async (t) => {
  const submission = fridgeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  const partly = LG_CHECKS();
  partly[2] = { requirement: 'must fit a 36-inch opening', verdict: 'unverified', finding: 'Could not find a published width.', source: 'not checked' };
  global.fetch = async (url, opts) => (isVerifyCall(opts)
    ? mustHaveResponse(partly, 3)
    : searchedToolUseResponse(checkedReport(), 4));
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generateUntilReport('sub-1');

  assert.ok(report.missing_or_uncertain.some((m) => /must fit a 36-inch opening.*could not be verified/i.test(m)));
});

test('an unanswered must-have is repaired rather than costing a whole attempt', async (t) => {
  const submission = fridgeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let mainCalls = 0;
  let promptSeen = '';
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    // Verification comes back a requirement short, which is a thing the
    // repair can fix without another full report.
    if (isVerifyCall(opts)) return mustHaveResponse(LG_CHECKS().slice(0, 2), 3);
    const props = (((body.tools || [])[0] || {}).input_schema || {}).properties || {};
    if (props.must_have_checks) {
      promptSeen = body.messages[0].content;
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: {
              must_have_checks: LG_CHECKS(),
              verdict: 'reconsider',
              reasoning: 'This model has the external door dispenser you called a deal-breaker, so it is not the right unit whatever the price says.',
            },
          }],
        }),
      };
    }
    mainCalls++;
    return searchedToolUseResponse(completeReportInput({
      recommendation: { verdict: 'buy', reasoning: 'It looks like a good fit.' },
    }), 4);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generateUntilReport('sub-1');

  assert.equal(mainCalls, 1, 'an unchecked must-have must not cost a whole regenerated report');
  assert.match(promptSeen, /no external door dispenser/, 'the repair has to be told what the customer actually asked for');
  assert.match(promptSeen, /unverified/, 'and that not knowing is an allowed answer');
  // The repair moved the verdict off "buy", which is the point: grading the
  // deal-breaker without letting the recommendation follow would just
  // reproduce the conflict.
  assert.match(report.sections.find((x) => /^Recommendation/.test(x.title)).title, /RECONSIDER/);
  assert.equal(reportInserts.length, 1);
});

test('a repair that still recommends buying a failed deal-breaker is rejected', async (t) => {
  const submission = fridgeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (isVerifyCall(opts)) return mustHaveResponse(LG_CHECKS(), 3);
    const props = (((body.tools || [])[0] || {}).input_schema || {}).properties || {};
    if (props.must_have_checks) {
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: { must_have_checks: LG_CHECKS(), verdict: 'buy', reasoning: 'Still recommending it.' },
          }],
        }),
      };
    }
    return searchedToolUseResponse(completeReportInput({ recommendation: { verdict: 'buy', reasoning: 'r' } }), 4);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const result = await generatePurchaseReport('sub-1');

  assert.equal(result, null, 'must hand back for another attempt rather than ship it');
  assert.equal(reportInserts.length, 0);
});

test('a submission with no must-haves is not held to a check it cannot fail', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.mustHaveProblem(completeReportInput({ must_have_checks: [] }), fakeSubmission()), null);
  assert.equal(__internal.isReportComplete(completeReportInput({ must_have_checks: [] }), fakeSubmission()), true);
  // And the section is omitted rather than rendered empty.
  const generic = __internal.mapToGenericReport(completeReportInput({ must_have_checks: [] }));
  assert.equal(generic.sections.some((x) => /must-haves/i.test(x.title)), false);
  assert.equal(generic.key_numbers.some((n) => /must-haves/i.test(n.label)), false);
});

// --- and why it is a separate request -------------------------------------
//
// Grading the must-haves inside submit_purchase_report meant one request had
// to research prices, research rates, look up the product's specification for
// each requirement, do the arithmetic and write six sections. The first live
// run after that shipped had two consecutive attempts killed by Vercel at the
// 300-second ceiling, with no engine output at all — the model call never
// returned. Three earlier runs of the same submission finished a first
// attempt in about 160 seconds, and the spec lookups were the only change.

test('the report call is not asked to check the specification', () => {
  // The report tool used to carry must_have_checks, which is what put the
  // lookups on the critical path. It must not come back.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(
    __internal.REPORT_TOOL.input_schema.properties.must_have_checks,
    undefined,
    'grading the must-haves belongs in its own request, not on the report call'
  );
  assert.equal(__internal.REPORT_TOOL.input_schema.required.includes('must_have_checks'), false);
  // With nothing established, it is told not to guess.
  assert.match(
    __internal.buildSystemPrompt(fridgeSubmission()),
    /Do not assert that the item does or does not have a given feature/i
  );
});

test('the report is written knowing which must-haves failed', () => {
  // The reorder, and the reason for it. Verification used to run after the
  // report, so the recommendation was composed before anyone knew the answer
  // and could only be patched afterwards. On submission a62f2dd1 that
  // produced a RECONSIDER whose reasoning read "It hits every stated
  // requirement — 36-inch fit, counter-depth, internal ice maker, no
  // external dispenser — so there's no functional reason to keep shopping",
  // three inches under a check marked ✗ on exactly that dispenser.
  const { __internal } = require('../api/_lib/purchase-engine');
  const prompt = __internal.buildSystemPrompt(fridgeSubmission(), LG_CHECKS());

  assert.match(prompt, /already been checked against the product's published specification/i);
  assert.match(prompt, /no external door dispenser — NOT MET/);
  assert.match(prompt, /internal ice maker — MET/);
  assert.match(prompt, /Tall Ice & Water Dispenser/, 'the finding travels with the verdict');
  assert.match(prompt, /cannot be "buy"/i);
  assert.match(prompt, /lead with it/i, 'and the reasoning has to be built on it, not around it');
});

test('an unestablished must-have is passed on as unknown, never as met', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const prompt = __internal.buildSystemPrompt(fridgeSubmission(), __internal.unverifiedChecks(fridgeSubmission()));
  assert.match(prompt, /NOT ESTABLISHED/);
  assert.match(prompt, /it is unknown, not met/i);
  assert.equal(/cannot be "buy"/i.test(prompt), false, 'nothing was contradicted, so nothing is ruled out');
});

test('every repair sees the same findings the report was written from', () => {
  // A repair prompt that does not carry them can quietly reintroduce the
  // claim the verification just disproved.
  const { __internal } = require('../api/_lib/purchase-engine');
  const prompt = __internal.buildRepairSystemPrompt(fridgeSubmission(), LG_CHECKS());
  assert.match(prompt, /no external door dispenser — NOT MET/);
});

test('verification is one small request that searches and grades', async (t) => {
  const originalFetch = global.fetch;
  const bodies = [];
  global.fetch = async (url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return mustHaveResponse(LG_CHECKS(), 2);
  };
  t.after(() => { global.fetch = originalFetch; });

  const { __internal } = require('../api/_lib/purchase-engine');
  const result = await __internal.verifyMustHaves({
    apiKey: 'test-key', submission: fridgeSubmission(), submissionId: 'sub-1', allowSearch: true,
  });

  assert.equal(bodies.length, 1, 'one request, not a conversation');
  const body = bodies[0];
  assert.ok((body.tools || []).some((x) => String(x.type || '').startsWith('web_search')), 'it has to be able to look things up');
  assert.equal(body.thinking, undefined, 'no extended thinking — this is a lookup, not a calculation');
  assert.ok(body.max_tokens <= 3000, 'kept small enough to fit beside a full report call');
  // The buyer's own words reach it, so the entries come back matchable.
  assert.match(body.messages[0].content, /no external door dispenser/);
  assert.match(body.system, /LG 33-inch French door refrigerator/, 'and the product it is meant to look up');
  assert.match(body.system, /33-inch opening/, 'with the size constraint, which is often the thing that decides it');
  assert.equal(result.searchRounds, 2);
  assert.equal(result.checks.length, 3);
});

test('a verification that fails leaves the requirements marked unchecked, not answered', async (t) => {
  // A failure here must cost the customer certainty, never their report —
  // and must never leave a must-have looking satisfied.
  const submission = fridgeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (isVerifyCall(opts)) return { ok: false, status: 500, text: async () => 'upstream exploded' };
    return searchedToolUseResponse(completeReportInput(), 4);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.equal(reportInserts.length, 1, 'the customer still gets their analysis');
  const section = report.sections[0];
  assert.equal(section.items.length, 3, 'every requirement they typed is still listed');
  for (const line of section.items) assert.match(line, /^\?/, line);
  assert.equal(report.key_numbers.find((n) => /must-haves/i.test(n.label)).value, '0 of 3 confirmed');
  assert.equal(
    report.missing_or_uncertain.filter((m) => /could not be verified/i.test(m)).length,
    3,
    'and each one is put in front of them as something to confirm before buying'
  );
});

test('__internal.unverifiedChecks turns the buyer\'s own words into honest placeholders', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const checks = __internal.unverifiedChecks(fridgeSubmission());
  assert.deepEqual(checks.map((c) => c.requirement), ['internal ice maker', 'no external door dispenser', 'must fit a 36-inch opening']);
  assert.ok(checks.every((c) => c.verdict === 'unverified' && c.source === 'not checked'));
  assert.deepEqual(__internal.unverifiedChecks(fakeSubmission()), []);
});

test('no must-haves means no verification request at all', async (t) => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return mustHaveResponse([], 0); };
  t.after(() => { global.fetch = originalFetch; });

  const { __internal } = require('../api/_lib/purchase-engine');
  const result = await __internal.verifyMustHaves({
    apiKey: 'test-key', submission: fakeSubmission(), submissionId: 'sub-1', allowSearch: true,
  });
  assert.equal(calls, 0, 'nothing to check is not a reason to spend a request');
  assert.deepEqual(result, { checks: [], searchRounds: 0 });
});

test('the safety-net repair rewrites the argument, not just the verdict', async (t) => {
  // What went wrong when it did not. On submission a62f2dd1 this repair
  // fired, moved the verdict from "buy" to "reconsider", and left the
  // reasoning reading "It hits every stated requirement — ... no external
  // dispenser — so there's no functional reason to keep shopping...
  // proceeding now is the sound move." A customer who reads the
  // recommendation gets the disproved claim back.
  const submission = fridgeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (isVerifyCall(opts)) return mustHaveResponse(LG_CHECKS().slice(0, 2), 3);
    const props = (((body.tools || [])[0] || {}).input_schema || {}).properties || {};
    if (props.must_have_checks) {
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: {
              must_have_checks: LG_CHECKS(),
              verdict: 'reconsider',
              reasoning: 'This model ships with the external door dispenser you called a deal-breaker, so it is the wrong unit whatever the price says.',
            },
          }],
        }),
      };
    }
    return searchedToolUseResponse(completeReportInput({
      recommendation: { verdict: 'buy', reasoning: 'It hits every stated requirement, so there is no reason to keep shopping.' },
    }), 4);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generateUntilReport('sub-1');

  const rec = report.sections.find((x) => /^Recommendation/.test(x.title));
  assert.match(rec.title, /RECONSIDER/);
  assert.match(rec.items[0], /external door dispenser/, 'the reasoning has to follow the verdict it now sits under');
  assert.equal(
    /hits every stated requirement/.test(rec.items[0]),
    false,
    'the argument for buying must not survive under a verdict that says do not'
  );
});

test('a repair that supplies a verdict with no reasoning is rejected', async (t) => {
  const submission = fridgeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (isVerifyCall(opts)) return mustHaveResponse(LG_CHECKS().slice(0, 2), 3);
    const props = (((body.tools || [])[0] || {}).input_schema || {}).properties || {};
    if (props.must_have_checks) {
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'tool_use', name: 'submit_field_repair', input: { must_have_checks: LG_CHECKS(), verdict: 'reconsider', reasoning: '   ' } }],
        }),
      };
    }
    return searchedToolUseResponse(completeReportInput({ recommendation: { verdict: 'buy', reasoning: 'r' } }), 4);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  assert.equal(await generatePurchaseReport('sub-1'), null);
  assert.equal(reportInserts.length, 0);
});

// --- the three that survived the reorder -----------------------------------
//
// Submission 9109cb06 got the must-haves right and the arithmetic exact, and
// still stated a total of $4,900-$6,300 in three sections against a computed
// $5,323-$5,995, and put "$40-$60 a year" for water filters against a line
// item reading $100/yr. Each slipped through for its own reason.

function lgReport(overrides) {
  return completeReportInput({
    headline: 'Fails your stated deal-breaker: this LG has an external door dispenser',
    total_cost_of_ownership: {
      time_horizon_years: 12,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 2899, high: 2899, per_year_low: 0, per_year_high: 0, basis: 'quoted big-box price' },
        { label: 'Electricity', kind: 'running', low: 0, high: 0, per_year_low: 60, per_year_high: 75, basis: 'EnergyGuide estimate' },
        { label: 'Water filter replacements', kind: 'running', low: 0, high: 0, per_year_low: 100, per_year_high: 100, basis: 'two filters a year at about $50' },
        { label: 'Repairs after warranty', kind: 'running', low: 0, high: 0, per_year_low: 42, per_year_high: 83, basis: '$500-$1,000 over 12 years, averaged' },
      ],
      explanation: 'Purchase price plus twelve years of electricity, filters and repairs.',
    },
    financing_impact: { applicable: false, explanation: 'Paying cash, so no interest applies.' },
    maintenance_running_costs: {
      annual_low: 202,
      annual_high: 258,
      explanation: 'Electricity runs about $60–$75 a year, water filters about $100 per year, and repairs average $42–$83 annually once the warranty lapses.',
    },
    depreciation_resale: { resale_low: 0, resale_high: 0, expected_resale_note: 'negligible after 12 years', explanation: 'Appliances fetch essentially nothing at this age.' },
    ...overrides,
  });
}

test('the computed total for the live report is what the strip shows', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const d = __internal.deriveNumbers(lgReport());
  assert.equal(__internal.moneyRange(d.total.low, d.total.high), '$5,323 – $5,995');
  assert.equal(__internal.tcoArithmeticProblem(lgReport()), null);
  assert.deepEqual(__internal.proseTotalConflicts(lgReport()), []);
});

test('a total claim is caught however far back the words that make it one sit', () => {
  // The exact sentence that got through: the phrase "total cost of ownership"
  // is 103 characters before the figure, and the window reached 60.
  const { __internal } = require('../api/_lib/purchase-engine');
  const conflicts = __internal.proseTotalConflicts(lgReport({
    recommendation: {
      verdict: 'reconsider',
      reasoning: 'Setting the dispenser aside, the $2,899 quote is fair, and over 12 years the total cost of ownership including energy, filters, and repairs would likely land near $4,900-$6,300, which is reasonable long-term value.',
    },
  }));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'recommendation.reasoning');
  assert.match(conflicts[0].quoted, /\$4,900-\$6,300$/, 'and no trailing comma from the clause it sat in');
});

test('a total claim is caught when it never says the word "cost"', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  for (const headline of [
    'About $4,900–$6,300 total over 12 years for a fairly priced fridge',
    'Budgeting a repair reserve brings the all-in total to about $4,900-$6,300',
  ]) {
    const conflicts = __internal.proseTotalConflicts(lgReport({ headline }));
    assert.equal(conflicts.length, 1, headline);
    assert.equal(conflicts[0].path, 'headline');
  }
});

test('a per-year figure is matched against the line it is describing', () => {
  // "$40-$60 a year" for water filters used to pass because it is near enough
  // the ELECTRICITY line's $60-$75 to satisfy set membership. Being right
  // about the wrong line is the failure this now catches.
  const { __internal } = require('../api/_lib/purchase-engine');
  const conflict = __internal.proseRunningConflict(lgReport({
    maintenance_running_costs: {
      annual_low: 202,
      annual_high: 258,
      explanation: 'Expect about $70-$95 a year in electricity, plus water filter replacements every six months (roughly $40–$60 a year).',
    },
  }));
  assert.ok(conflict);
  assert.equal(conflict.quoted, '$70-$95 a year', 'the first wrong figure is reported');
  assert.match(conflict.correct, /Electricity. line says/);
  assert.match(conflict.correct, /\$60 – \$75\/yr/);

  // And the filter figure on its own, so the wrong-line case is covered
  // rather than shadowed by the electricity one.
  const filtersOnly = __internal.proseRunningConflict(lgReport({
    maintenance_running_costs: {
      annual_low: 202,
      annual_high: 258,
      explanation: 'Water filter replacements run roughly $40–$60 a year, which is the main recurring cost besides power.',
    },
  }));
  assert.equal(filtersOnly.quoted, '$40–$60 a year');
  assert.match(filtersOnly.correct, /Water filter replacements. line says/);
  assert.match(filtersOnly.correct, /\$100\/yr/);
});

test('naming two lines in one sentence still attributes each figure correctly', () => {
  // Both labels sit within a few words of both figures, so a check that only
  // asks whether the window contains a label gets half of them wrong.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(
    __internal.proseRunningConflict(lgReport({
      maintenance_running_costs: {
        annual_low: 202, annual_high: 258,
        explanation: 'Electricity is about $60–$75/year and water filters about $100 per year.',
      },
    })),
    null,
    'both figures match their own line, so nothing is wrong here'
  );
  const swapped = __internal.proseRunningConflict(lgReport({
    maintenance_running_costs: {
      annual_low: 202, annual_high: 258,
      explanation: 'Electricity is about $100/year and water filters about $60–$75 per year.',
    },
  }));
  assert.ok(swapped, 'the same two figures against the wrong lines is a real contradiction');
});

test('a whole-period figure in the maintenance section is checked too', () => {
  // Not only per-year ones. On submission a62f2dd1 the filter cost was
  // stated as "$960-$1,320 over 12 years" against a line of $156-$252, and
  // nothing looked at it because it carried no per-year marker.
  const { __internal } = require('../api/_lib/purchase-engine');
  const conflict = __internal.proseRunningConflict(lgReport({
    maintenance_running_costs: {
      annual_low: 202, annual_high: 258,
      explanation: 'Water filter replacements come to roughly $960–$1,320 over 12 years.',
    },
  }));
  assert.ok(conflict);
  assert.match(conflict.correct, /over 12 years/);
  assert.match(conflict.correct, /\$1,200/, '100/yr across 12 years is $1,200');

  assert.equal(
    __internal.proseRunningConflict(lgReport({
      maintenance_running_costs: {
        annual_low: 202, annual_high: 258,
        explanation: 'Water filter replacements come to roughly $1,200 over 12 years.',
      },
    })),
    null
  );
});

test('a figure with no scale attached is left alone', () => {
  // "$150-$600 per incident" and "$50 each" are not claims about a line item.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(
    __internal.proseRunningConflict(lgReport({
      maintenance_running_costs: {
        annual_low: 202, annual_high: 258,
        explanation: 'A service call runs $150–$600 per incident, and filters are about $50 each. Coil cleaning is free.',
      },
    })),
    null
  );
});

test('the tolerance floor no longer swallows a per-year quantity whole', () => {
  // $200 then $25; both were larger than the figures they were guarding.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.proseFigureMatches({ low: 40, high: 60 }, { low: 100, high: 100 }), false);
  assert.equal(__internal.proseFigureMatches({ low: 70, high: 95 }, { low: 60, high: 75 }), false);
  // A genuine round still passes, at both scales.
  assert.equal(__internal.proseFigureMatches({ low: 60, high: 75 }, { low: 60, high: 75 }), true);
  assert.equal(__internal.proseFigureMatches({ low: 49000, high: 62000 }, { low: 49280, high: 61880 }), true);
});

test('the resale check still works with the wider total window', () => {
  // Widening the shared window to 150 swept "retain roughly 50-55%" into the
  // resale window, where a "%" is an exclusion, and silenced the check. It
  // has its own tighter window now.
  const { __internal } = require('../api/_lib/purchase-engine');
  const conflict = __internal.proseResaleConflict(completeReportInput({
    total_cost_of_ownership: {
      time_horizon_years: 7,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 32400, high: 32400, per_year_low: 0, per_year_high: 0, basis: 'quoted' },
        { label: 'Running costs', kind: 'running', low: 0, high: 0, per_year_low: 2600, per_year_high: 3500, basis: 'insurance and fuel' },
        { label: 'Resale at year 7', kind: 'resale_recovery', low: -8000, high: -6000, per_year_low: 0, per_year_high: 0, basis: 'retained value' },
      ],
      explanation: 'x',
    },
    maintenance_running_costs: { annual_low: 2600, annual_high: 3500, explanation: 'Running costs.' },
    depreciation_resale: {
      resale_low: 6000,
      resale_high: 8000,
      expected_resale_note: '20-25% retained',
      explanation: 'Expect it to retain roughly 50-55% of its current value after 7 years, meaning a resale value in the ballpark of $16,000-$18,000 at trade-in.',
    },
  }));
  assert.ok(conflict, 'the resale contradiction must still be caught');
  assert.equal(conflict.quoted, '$16,000-$18,000');
});

// --- the leak -------------------------------------------------------------
//
// First seen 2026-08-31, and by 2026-09-08 settled into one reproducible
// shape: total_cost_of_ownership arrives not as an object but as the string
//
//     "\n<parameter name=\"time_horizon_years\">12"
//
// — the model writing the nested object out in tool-call syntax instead of
// JSON. Four of six appliance runs, none of three vehicle ones. Two earlier
// attempts to prevent it (a prompt instruction, then renaming the field it
// kept naming) both failed, and the rename moved the leak to the new name.
// So this bounds the damage rather than trying a third time to stop it.

test('__internal.salvageLeakedObject recovers the object from the leaked string', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.deepEqual(
    __internal.salvageLeakedObject('\n<parameter name="time_horizon_years">12'),
    { time_horizon_years: 12 }
  );
  assert.deepEqual(
    __internal.salvageLeakedObject('<parameter name="annual_low">55<parameter name="explanation">Typical draw for this size.'),
    { annual_low: 55, explanation: 'Typical draw for this size.' }
  );
  assert.deepEqual(__internal.salvageLeakedObject({ already: 'an object' }), null);
  assert.deepEqual(__internal.salvageLeakedObject('no tags here at all'), {});
});

test('a leaked nested object costs a repair, not a whole attempt', async (t) => {
  // Before this, sanitizeReportTags reduced the string to "12", the
  // explanation repair spread a string into an object ({0:'1',1:'2'}), and
  // the attempt was spent discovering that the result was unusable.
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let mainCalls = 0;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const props = (((body.tools || [])[0] || {}).input_schema || {}).properties || {};
    if (props.cost_breakdown && props.annual_low) {
      // The cost-model repair rebuilds what the leak destroyed.
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use',
            name: 'submit_field_repair',
            input: {
              cost_breakdown: completeReportInput().total_cost_of_ownership.cost_breakdown,
              annual_low: 55, annual_high: 70, resale_low: 0, resale_high: 0,
            },
          }],
        }),
      };
    }
    if (props.value) return fieldRepairResponse('Purchase price plus eight years of electricity and a delivery fee.');
    mainCalls++;
    const leaked = completeReportInput();
    leaked.total_cost_of_ownership = '\n<parameter name="time_horizon_years">8';
    return toolUseResponse(leaked);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');

  assert.equal(mainCalls, 1, 'the leak must not cost a whole regenerated report');
  assert.equal(submission.generation_attempts, 1);
  assert.equal(reportInserts.length, 1);
  assert.ok(!submissionUpdates.some((u) => u.status === 'paid'), 'and must not hand back for a retry');
  assert.equal(report.key_numbers[0].value, '$2,940 – $3,110', 'the rebuilt cost model reaches the customer');
});

test('the ownership period comes from the customer, not the model', async (t) => {
  // It was a required field of the report schema — asking the model to
  // repeat a number the intake form already collects and the pre-payment
  // gate already requires for every category.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(
    __internal.REPORT_TOOL.input_schema.properties.total_cost_of_ownership.properties.time_horizon_years,
    undefined
  );
  assert.equal(__internal.horizonYears(fakeSubmission()), 8);
  assert.equal(__internal.horizonYears(sevenYearSubmission()), 7);
  assert.equal(__internal.horizonYears({ form_data: {} }), null);

  // And a report whose model-supplied horizon disagrees is overridden.
  const submission = fakeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  const wrong = completeReportInput();
  wrong.total_cost_of_ownership.time_horizon_years = 99;
  global.fetch = async () => toolUseResponse(wrong);
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');
  assert.match(report.key_numbers[0].label, /\(8yr\)/, 'the form says 8 years, so the report does');
});

// --- an exclusion belongs to the figure, not the paragraph -----------------
//
// Submission a9655d25's alternative section quoted a rival total for the
// REVIEWED product — "$4,900-$5,900 for the LRFXC2416S" against a computed
// $4,624-$7,099, 17% out at the top end — and the check passed it, because
// a "/year" attached to a different figure 90 characters away sat inside the
// same 150-character window and disqualified it.

function dispenserReport(overrides) {
  return completeReportInput({
    headline: 'Skip this unit — it has the external door dispenser you said was a deal-breaker',
    // fakeSubmission lists no must-haves, so an empty set is the right answer.
    must_have_checks: [],
    total_cost_of_ownership: {
      time_horizon_years: 12,
      cost_breakdown: [
        { label: 'Purchase price', kind: 'purchase', low: 2899, high: 2899, per_year_low: 0, per_year_high: 0, basis: 'quoted big-box price' },
        { label: 'Energy, filters and prorated repairs', kind: 'running', low: 0, high: 0, per_year_low: 150, per_year_high: 350, basis: '650-700 kWh/yr plus filters and an out-of-warranty allowance' },
        { label: 'Salvage value at year 12', kind: 'resale_recovery', low: -75, high: 0, per_year_low: 0, per_year_high: 0, basis: 'scrap or give-away only' },
      ],
      explanation: 'Purchase price plus twelve years of running costs, less a token salvage value.',
    },
    financing_impact: { applicable: false, explanation: 'Paying cash, so no interest applies.' },
    maintenance_running_costs: { annual_low: 150, annual_high: 350, explanation: 'Energy, filters and an allowance for out-of-warranty repairs.' },
    depreciation_resale: { resale_low: 0, resale_high: 75, expected_resale_note: 'scrap value only', explanation: 'Refrigerators are worth essentially nothing after twelve years.' },
    alternative_comparison: {
      alternative_name: 'LG LRFDS3006S, internal-only dispenser',
      alternative_price_low: 2299,
      alternative_price_high: 2599,
      alternative_total_low: 3400,
      alternative_total_high: 3900,
      explanation: 'It keeps dispensing inside the compartment, so it meets all three must-haves. Over 12 years of ownership (purchase price plus roughly $90-$120/year in electricity) total cost lands around $3,400-$3,900.',
    },
    ...overrides,
  });
}

test('the computed total for the eighth appliance run is what the strip shows', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const d = __internal.deriveNumbers(dispenserReport());
  assert.equal(__internal.moneyRange(d.total.low, d.total.high), '$4,624 – $7,099');
  assert.equal(__internal.tcoArithmeticProblem(dispenserReport()), null);
});

test('a per-year figure elsewhere in the sentence no longer silences a real total claim', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const alt = dispenserReport().alternative_comparison;
  const conflicts = __internal.proseTotalConflicts(dispenserReport({
    alternative_comparison: {
      ...alt,
      explanation: alt.explanation + ', versus an estimated $4,900-$5,900 for the LRFXC2416S over the same period — a saving of roughly $1,500-$2,000.',
    },
  }));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'alternative_comparison.explanation');
  assert.match(conflicts[0].quoted, /\$4,900-\$5,900/);
});

test('an exclusion still works when it is attached to the figure itself', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  // Each of these is a real sentence the check must NOT fire on.
  for (const explanation of [
    'Insurance alone runs $5,000-$6,000 per year, which dominates the total cost of ownership.',
    'Depreciation is only about $4,700-$5,000 of the total cost across the period.',
  ]) {
    assert.deepEqual(
      __internal.proseTotalConflicts(dispenserReport({
        alternative_comparison: { ...dispenserReport().alternative_comparison, explanation },
      })),
      [],
      explanation
    );
  }
});

test('the alternative may quote its own total without being called a contradiction', () => {
  // That section exists to compare two whole-period costs. The alternative's
  // is a different number from this item's by design, and before this it was
  // reported as a rival claim about the reviewed product.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.deepEqual(__internal.proseTotalConflicts(dispenserReport()), []);
  assert.equal(__internal.isReportComplete(dispenserReport(), fakeSubmission()), true);

  // But a figure matching neither total is still caught.
  const alt = dispenserReport().alternative_comparison;
  const conflicts = __internal.proseTotalConflicts(dispenserReport({
    alternative_comparison: { ...alt, explanation: 'Its total cost of ownership over 12 years lands around $8,800-$9,400.' },
  }));
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0].quoted, /\$8,800-\$9,400/);
});

// --- components restated inside the total-cost explanation -----------------
//
// The Peloton report (submission 95bd1598, the first run of the "other"
// category) had an exact strip and an exact total, and its total-cost
// explanation contradicted its own line items three times:
//
//   interest      prose $150-$300   | line $0-$670
//   maintenance   prose $200-$400   | line $360-$1,080
//   resale        prose $600-$900   | line $200-$450
//
// Nothing looked. The resale check reads the depreciation section, the
// per-year check reads the maintenance section, the total check reads the
// total; a component restated in the total-cost explanation was in none of
// them.

function pelotonReport(explanation) {
  return completeReportInput({
    headline: 'Roughly $5,700–$7,800 total over 6 years',
    must_have_checks: [],
    total_cost_of_ownership: {
      time_horizon_years: 6,
      cost_breakdown: [
        { label: 'Bike+ purchase price', kind: 'purchase', low: 2495, high: 2495, per_year_low: 0, per_year_high: 0, basis: 'quoted new price' },
        { label: 'Sales tax + delivery/assembly', kind: 'other', low: 150, high: 250, per_year_low: 0, per_year_high: 0, basis: '~6% VA tax plus setup' },
        { label: 'Interest on 39-month financing', kind: 'financing', low: 0, high: 670, per_year_low: 0, per_year_high: 0, basis: '0% promotional to ~15% APR' },
        { label: 'All-Access membership', kind: 'running', low: 0, high: 0, per_year_low: 528, per_year_high: 588, basis: '~$44/month household fee' },
        { label: 'Maintenance, parts, minor repairs, electricity', kind: 'running', low: 0, high: 0, per_year_low: 60, per_year_high: 180, basis: 'cleats, cleaning, repair allowance' },
        { label: 'Resale value recovered at 6 years', kind: 'resale_recovery', low: -450, high: -200, per_year_low: 0, per_year_high: 0, basis: 'secondhand value' },
      ],
      explanation,
    },
    financing_impact: { applicable: true, explanation: 'A 39-month plan at anywhere from 0% to about 15% APR.' },
    maintenance_running_costs: { annual_low: 588, annual_high: 768, explanation: 'Membership, cleats and an allowance for repairs.' },
    depreciation_resale: { resale_low: 200, resale_high: 450, expected_resale_note: 'modest secondhand value', explanation: 'Connected fitness hardware holds little value at six years.' },
    alternative_comparison: {
      alternative_name: 'NordicTrack Commercial S22i',
      alternative_price_low: 1799, alternative_price_high: 2299,
      alternative_total_low: 5000, alternative_total_high: 7000,
      explanation: 'A similar bike with its own subscription.',
    },
    recommendation: { verdict: 'buy', reasoning: 'Used four or five times a week, it earns its keep.' },
  });
}

test('the Peloton line items sum to the total the strip showed', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const d = __internal.deriveNumbers(pelotonReport('x'));
  assert.equal(__internal.moneyRange(d.total.low, d.total.high), '$5,723 – $7,823');
});

test('a component restated in the total-cost explanation is held to its own line items', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const wrong = [
    ['interest', 'The $2,495 bike financed over 39 months typically adds roughly $150–$300 in interest.', '$150–$300'],
    ['maintenance', 'Modest maintenance costs of perhaps $200–$400 over the period.', '$200–$400'],
    ['resale', 'Netting out an expected resale value of $600–$900 after 6 years.', '$600–$900'],
  ];
  for (const [what, explanation, quoted] of wrong) {
    const conflict = __internal.proseComponentConflict(pelotonReport(explanation));
    assert.ok(conflict, `the ${what} figure must be caught`);
    assert.equal(conflict.path, 'total_cost_of_ownership.explanation');
    assert.equal(conflict.quoted, quoted);
    assert.match(conflict.correct, /a figure this report actually uses/);
  }
});

test('every figure the Peloton report got right is left alone', () => {
  // Each of these is a real sentence from that report, and each quotes a
  // figure some line item actually carries — at whatever scale it is written.
  const { __internal } = require('../api/_lib/purchase-engine');
  for (const explanation of [
    'Total cost of ownership starts with the $2,495 bike financed over 39 months.',
    'Plus sales tax and delivery fees of around $150–$250.',
    'The dominant cost is the mandatory All-Access membership at $44/month.',
    'The All-Access membership runs $528–$588 a year.',
    'Maintenance, parts and minor repairs run $60–$180 per year.',
    'Netting out an expected resale value of $200–$450 after 6 years.',
    'The all-in total lands around $5,700–$7,800.',
    'Interest runs anywhere from $0 to $670 depending on the APR you qualify for.',
  ]) {
    assert.equal(__internal.proseComponentConflict(pelotonReport(explanation)), null, explanation);
  }
});

test('the financing section is not held to the line items', () => {
  // It talks about quantities that are real and are not line items — the
  // amount paid over a loan term, the item's cost plus its interest. A
  // membership test would report every one of them.
  const { __internal } = require('../api/_lib/purchase-engine');
  const r = pelotonReport('The bike, the membership and upkeep over six years.');
  r.financing_impact.explanation =
    'At 0% the bike costs $2,495; at 15% the total paid over the 39-month term is about $3,165, or roughly $81 a month.';
  assert.equal(__internal.proseComponentConflict(r), null);
});

test('a field is asked about once, however many checks it trips', () => {
  // A total-cost explanation that invents a total is also quoting a figure no
  // line item carries. The repair rewrites a field once, so it is asked once.
  const { __internal } = require('../api/_lib/purchase-engine');
  const conflicts = __internal.proseTotalConflicts(
    pelotonReport('The all-in total over six years lands around $9,100–$11,400.')
  );
  assert.equal(conflicts.filter((c) => c.path === 'total_cost_of_ownership.explanation').length, 1);
});

// --- the timeout ----------------------------------------------------------

test('the report call no longer competes with the verification for searches', () => {
  // Two live runs were killed at Vercel's 300-second ceiling with no output —
  // submission 7d2aa0fb twice and 95bd1598 once, all financed submissions,
  // where the rate research is heaviest. verifyMustHaves now runs first, in
  // the same invocation, and does its own searching.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.WEB_SEARCH_TOOL.max_uses, 3);
});

test('a verification already done is not done again on the next attempt', async (t) => {
  const submission = fridgeSubmission();
  const { submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;

  let verifyCalls = 0;
  global.fetch = async (url, opts) => {
    if (isVerifyCall(opts)) { verifyCalls++; return mustHaveResponse(LG_CHECKS(), 3); }
    return searchedToolUseResponse(completeReportInput({
      recommendation: { verdict: 'reconsider', reasoning: 'The dispenser is a deal-breaker.' },
    }), 3);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport, __internal } = require('../api/_lib/purchase-engine');
  await generatePurchaseReport('sub-1');
  assert.equal(verifyCalls, 1);

  // It is on the row, so a second attempt spends its 300 seconds on the
  // report rather than re-establishing a specification that has not changed.
  const cached = __internal.readCachedVerification(submission);
  assert.equal(cached.checks.length, 3);
  assert.equal(cached.searchRounds, 3);
  assert.ok(
    submissionUpdates.some((u) => u.job_state && u.job_state.must_have_verification),
    'and it is written to job_state, not held in memory'
  );

  await generatePurchaseReport('sub-1');
  assert.equal(verifyCalls, 1, 'the second attempt must not verify again');
});

test('a row with no cached verification reads as none, not as an empty result', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.equal(__internal.readCachedVerification(fakeSubmission()), null);
  assert.equal(__internal.readCachedVerification({ job_state: {} }), null);
  assert.equal(__internal.readCachedVerification({ job_state: { must_have_verification: {} } }), null);
});

// --- what the disclaimer actually covers ----------------------------------
//
// searchRounds counts the REPORT call's searches. The must-have verification
// is a separate request with its own searching, and on submission 2a2b3a24 it
// succeeded — the spec checks cite Peloton's own product pages three times —
// while the report call searched seven times, hit its usage limit and
// reported finding nothing it relied on. Both were true. The disclaimer said
// "the web searches run for this report did not turn up anything", which
// reads as covering the whole page, including the citations directly above
// it.

async function reportWithNoUsableResearch(t, mustHaveChecks) {
  const submission = mustHaveChecks.length ? fridgeSubmission() : fakeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (isVerifyCall(opts)) return mustHaveResponse(mustHaveChecks, mustHaveChecks.length ? 3 : 0);
    const props = (((JSON.parse(opts.body).tools || [])[0] || {}).input_schema || {}).properties || {};
    if (props.research_notes) {
      return {
        ok: true,
        json: async () => ({
          content: [{ type: 'tool_use', name: 'submit_field_repair', input: { found_nothing_usable: true, research_notes: [] } }],
        }),
      };
    }
    return searchedToolUseResponse(completeReportInput({
      research_notes: [],
      recommendation: { verdict: 'reconsider', reasoning: 'The dispenser is a deal-breaker.' },
    }), 7);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });
  return generateUntilReport('sub-1');
}

test('the disclaimer covers the cost figures, not the spec checks that did get looked up', async (t) => {
  const report = await reportWithNoUsableResearch(t, LG_CHECKS());
  const note = report.missing_or_uncertain[0];
  assert.match(note, /searches run for the cost figures/i, 'it has to name what it covers');
  assert.match(note, /checked separately/i, 'and say the must-haves were not part of it');
  // The spec checks are still there, still citing their sources.
  const section = report.sections[0];
  assert.match(section.title, /must-haves/i);
  assert.match(section.items[0], /LG's product page/);
});

test('with nothing looked up anywhere, the disclaimer claims no separate check', async (t) => {
  const report = await reportWithNoUsableResearch(t, []);
  const note = report.missing_or_uncertain[0];
  assert.match(note, /cost figures/i);
  assert.equal(
    /checked separately/i.test(note),
    false,
    'there was no separate check to point at, so it must not claim one'
  );
});

test('an unverified spec check does not count as having been looked up', async (t) => {
  // Nothing looked up means no published figure and no measurement either —
  // a measurement left behind would have its verdict recomputed.
  const unverified = LG_CHECKS().map((c) => {
    const { measurement, published_value, ...rest } = c;
    return { ...rest, verdict: 'unverified', source: 'not checked' };
  });
  const report = await reportWithNoUsableResearch(t, unverified);
  assert.equal(/checked separately/i.test(report.missing_or_uncertain[0]), false);
});

// --- the eighth field ------------------------------------------------------
//
// Three runs on 2026-09-08, one per category, checked against the rendered
// reports rather than the engine's own view of them. Every structural
// invariant held in all three — line items to printed total, strip to
// breakdown, per-year to running lines, resale across all three places it
// appears. One contradiction survived, in the Peloton report (submission
// 05d61ecb), and it was in the one field the total check had never been
// pointed at:
//
//   "...already folded into the $5,700-$7,800 total-cost-of-ownership
//    estimate above."
//
// The estimate above was $5,943-$7,533. Out by 4.1% and 3.5%.
//
// maintenance_running_costs.explanation was read by proseRunningConflict for
// per-year and whole-period COMPONENT figures, and by nothing at all for a
// claim about the whole.

function pelotonRunTwo(maintenanceExplanation) {
  return completeReportInput({
    headline: 'Roughly $5,900–$7,500 over 6 years',
    must_have_checks: [],
    total_cost_of_ownership: {
      time_horizon_years: 6,
      cost_breakdown: [
        { label: 'Bike+ purchase price', kind: 'purchase', low: 2495, high: 2495, per_year_low: 0, per_year_high: 0, basis: 'quoted new price' },
        { label: 'Interest over 39-month financing', kind: 'financing', low: 250, high: 450, per_year_low: 0, per_year_high: 0, basis: '0% to ~15% APR' },
        { label: 'All-Access membership (required for classes)', kind: 'running', low: 0, high: 0, per_year_low: 528, per_year_high: 588, basis: '$44-$49/month' },
        { label: 'Electricity for console/touchscreen', kind: 'running', low: 0, high: 0, per_year_low: 5, per_year_high: 10, basis: 'negligible draw' },
        { label: 'Maintenance, parts & occasional repairs', kind: 'running', low: 0, high: 0, per_year_low: 75, per_year_high: 200, basis: 'cleats, belts, post-warranty repair' },
        { label: 'Expected resale value at year 6', kind: 'resale_recovery', low: -450, high: -200, per_year_low: 0, per_year_high: 0, basis: 'secondhand value' },
      ],
      explanation: 'The membership dominates the total; the bike itself is the smaller part.',
    },
    financing_impact: { applicable: true, explanation: 'A 39-month plan at 0% to about 15% APR.' },
    maintenance_running_costs: { annual_low: 608, annual_high: 798, explanation: maintenanceExplanation },
    depreciation_resale: { resale_low: 200, resale_high: 450, expected_resale_note: 'modest', explanation: 'Connected fitness hardware depreciates fast.' },
    alternative_comparison: {
      alternative_name: 'NordicTrack Commercial S22i',
      alternative_price_low: 1699, alternative_price_high: 2199,
      alternative_total_low: 4800, alternative_total_high: 6500,
      explanation: 'Cheaper hardware and a cheaper subscription.',
    },
    recommendation: { verdict: 'buy', reasoning: 'Used four or five times a week it earns its keep.' },
  });
}

test('the Peloton run-two line items sum to what the strip showed', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const d = __internal.deriveNumbers(pelotonRunTwo('x'));
  assert.equal(__internal.moneyRange(d.total.low, d.total.high), '$5,943 – $7,533');
});

test('a total stated in the maintenance section is caught', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const conflicts = __internal.proseTotalConflicts(pelotonRunTwo(
    'The membership runs about $44/month, and you should budget $150-$300 for consumables. These are already folded into the $5,700-$7,800 total-cost-of-ownership estimate above.'
  ));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].path, 'maintenance_running_costs.explanation');
  assert.match(conflicts[0].quoted, /\$5,700-\$7,800/);
});

test('the same section may still quote its own components freely', () => {
  // Its business IS components, so every line item's figure is set aside at
  // both scales before anything is judged — otherwise adding this field to
  // the total check would report every per-year and whole-period figure it
  // was written to contain.
  const { __internal } = require('../api/_lib/purchase-engine');
  for (const explanation of [
    'The All-Access membership runs $528–$588 a year, or roughly $3,168 over six years.',
    'Maintenance, parts and occasional repairs come to $75–$200 a year, or $450 – $1,200 over the six years.',
    'All told, running costs are $608–$798 a year.',
    'These are already folded into the $5,943-$7,533 total-cost-of-ownership estimate above.',
  ]) {
    assert.deepEqual(__internal.proseTotalConflicts(pelotonRunTwo(explanation)), [], explanation);
  }
});

test('a field is still asked about once when it trips both checks', () => {
  // A wrong total here is also a figure no line item carries, so the
  // component check and the total check both have something to say. The
  // repair rewrites the field once.
  const { __internal } = require('../api/_lib/purchase-engine');
  const conflicts = __internal.proseTotalConflicts(pelotonRunTwo(
    'Everything above is folded into the $9,100-$11,400 total cost of ownership.'
  ));
  assert.equal(conflicts.filter((c) => c.path === 'maintenance_running_costs.explanation').length, 1);
});

// --- a size requirement is arithmetic, not a judgement ---------------------
//
// Two runs of the same Peloton submission disagreed about the same fact. The
// requirement was "must fit a 4ft by 2ft floor space". One answered CONFIRMED,
// citing Peloton's shop page and its "compact 4' x 2' footprint"; the other
// answered NOT MET. Both had read Peloton. The Bike+ is 59 inches long, which
// is 4.9 feet — the marketing line and the spec sheet describe the same object
// and only one of them answers the question.
//
// Three LG runs disagreed the same way about an external door dispenser. With
// the arithmetic stable for a while, this was the largest remaining source of
// variance in the product.

test('__internal.verdictFromMeasurement decides a size requirement by the numbers', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const v = __internal.verdictFromMeasurement;
  // The Peloton disagreement, both ways round.
  assert.equal(v({ value: 59, limit: 48, unit: 'inches', comparison: 'at_most' }), 'contradicted');
  assert.equal(v({ value: 48, limit: 48, unit: 'inches', comparison: 'at_most' }), 'confirmed');
  // The LG fridge: 35.75 into a 36-inch opening fits; 70.25 into 70 does not.
  assert.equal(v({ value: 35.75, limit: 36, unit: 'inches', comparison: 'at_most' }), 'confirmed');
  assert.equal(v({ value: 70.25, limit: 70, unit: 'inches', comparison: 'at_most' }), 'contradicted');
  assert.equal(v({ value: 24, limit: 22, unit: 'cu ft', comparison: 'at_least' }), 'confirmed');
  assert.equal(v({ value: 20, limit: 22, unit: 'cu ft', comparison: 'at_least' }), 'contradicted');
});

test('a requirement with no numbers is left as the judgement it is', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const v = __internal.verdictFromMeasurement;
  assert.equal(v(undefined), null);
  assert.equal(v(null), null);
  assert.equal(v({ value: 59, unit: 'inches', comparison: 'at_most' }), null, 'no limit');
  assert.equal(v({ value: 59, limit: 48, unit: 'inches' }), null, 'no comparison');
  assert.equal(v({ value: 'fifty-nine', limit: 48, comparison: 'at_most' }), null, 'not a number');
});

test('the figures override the verdict the model reached, and show their working', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const checks = [{
    requirement: 'must fit a 4ft by 2ft floor space',
    verdict: 'confirmed',
    finding: 'Peloton describes a compact 4ft by 2ft footprint.',
    published_value: '59.0 in L x 22.0 in W',
    source: 'Peloton spec sheet',
    measurement: { value: 59, limit: 48, unit: 'inches', comparison: 'at_most' },
  }];
  __internal.applyMeasuredVerdicts(checks, 'sub-1');
  assert.equal(checks[0].verdict, 'contradicted', 'its own figures say it does not fit');
  assert.match(checks[0].finding, /59 inches against 48 inches/, 'and the customer sees the comparison');
  assert.match(checks[0].finding, /compact 4ft by 2ft footprint/, 'without losing what was found');
});

test('a verdict the figures agree with is left alone, and not annotated twice', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const checks = [{
    requirement: 'must fit a 36-inch opening',
    verdict: 'confirmed',
    finding: 'Listed at 35.75 inches wide, inside a 36-inch opening.',
    published_value: '35 3/4 in W',
    source: 'LG spec sheet',
    measurement: { value: 35.75, limit: 36, unit: 'inches', comparison: 'at_most' },
  }];
  const before = checks[0].finding;
  __internal.applyMeasuredVerdicts(checks, 'sub-1');
  assert.equal(checks[0].verdict, 'confirmed');
  assert.equal(checks[0].finding, before, 'the figure is already in the finding, so it is not restated');
});

test('a graded verdict has to quote the published figure it rests on', () => {
  // Where "compact 4' x 2' footprint" and "59 inches long" stop being
  // distinguishable is exactly where a paraphrase is allowed.
  const { __internal } = require('../api/_lib/purchase-engine');
  const noValue = LG_CHECKS();
  delete noValue[0].published_value;
  assert.match(
    __internal.mustHaveProblem(checkedReport({ must_have_checks: noValue }), fridgeSubmission()),
    /without quoting the published figure it rests on/
  );
  // Unverified needs none, because there is nothing to quote.
  const unver = LG_CHECKS();
  unver[0] = { requirement: 'internal ice maker', verdict: 'unverified', finding: 'Could not establish it.', source: 'not checked' };
  assert.equal(__internal.mustHaveProblem(checkedReport({ must_have_checks: unver }), fridgeSubmission()), null);
});

test('both tools ask for the published figure, and the size numbers', () => {
  const { __internal } = require('../api/_lib/purchase-engine');
  const item = __internal.MUST_HAVE_TOOL.input_schema.properties.must_have_checks.items;
  assert.ok(item.required.includes('published_value'), 'the quote is required');
  assert.ok(item.properties.measurement, 'and the numbers are available when the requirement is a size');
  for (const f of ['value', 'limit', 'unit', 'comparison']) {
    assert.ok(item.properties.measurement.required.includes(f), `measurement.${f}`);
  }
  assert.match(item.properties.published_value.description, /marketing summary is not a published value/i);
});

test('a downgraded check keeps no figures that could resurrect it', async (t) => {
  // The searchRounds downgrade takes a verdict away because nothing was
  // looked up. A measurement left behind would let a later pass compute it
  // straight back.
  const submission = fridgeSubmission();
  installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) =>
    (isVerifyCall(opts) ? mustHaveResponse(LG_CHECKS(), 0) : toolUseResponse(checkedReport()));
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generateUntilReport('sub-1');
  for (const line of report.sections[0].items) {
    assert.match(line, /^\?/, line);
    assert.equal(/\[published:/.test(line), false, 'and no published figure is shown for it');
  }
});

// --- one job per invocation ------------------------------------------------
//
// Caching the verification stopped the SECOND attempt redoing it and left the
// first doing both jobs inside one 300-second budget. Submission 87e1bc2b was
// killed at the ceiling on attempt 1 for that reason, after 95bd1598 and
// 7d2aa0fb before it.

test('a fresh verification hands back rather than starting the report in what is left', async (t) => {
  const submission = fridgeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  let verifyCalls = 0, reportCalls = 0;
  global.fetch = async (url, opts) => {
    if (isVerifyCall(opts)) { verifyCalls++; return mustHaveResponse(LG_CHECKS(), 3); }
    reportCalls++;
    return searchedToolUseResponse(checkedReport(), 3);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');

  const first = await generatePurchaseReport('sub-1');
  assert.equal(first, null, 'the verifying invocation produces no report');
  assert.equal(verifyCalls, 1);
  assert.equal(reportCalls, 0, 'and does not start the report inside the same budget');
  assert.equal(submission.status, 'paid', 'it hands back for the next poll');
  assert.equal(submission.generation_attempts, 0, 'and gives the attempt back — nothing was attempted');

  const second = await generatePurchaseReport('sub-1');
  assert.ok(second, 'the next poll gets an uncontended invocation and produces the report');
  assert.equal(verifyCalls, 1, 'reusing what the first one established');
  assert.equal(reportCalls, 1);
  assert.equal(reportInserts.length, 1);
  assert.ok(submissionUpdates.some((u) => u.status === 'complete'));
});

test('a submission with no must-haves is not split in two', () => {
  // Nothing to verify means nothing to hand back for.
  const { __internal } = require('../api/_lib/purchase-engine');
  assert.deepEqual(__internal.mustHaveFragments(fakeSubmission()), []);
});

test('a verification that fails does not hand back, or it would never stop', async (t) => {
  // A failure caches nothing, so handing back would run it again, fail again
  // and hand back again — the customer polling forever. It cost little when
  // it failed, so the report proceeds in the same invocation.
  const submission = fridgeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (isVerifyCall(opts)) return { ok: false, status: 500, text: async () => 'upstream exploded' };
    return searchedToolUseResponse(completeReportInput(), 3);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generatePurchaseReport('sub-1');
  assert.ok(report, 'one call, one report');
  assert.equal(reportInserts.length, 1);
});

// --- a response that came back as tag text ---------------------------------
//
// On submission 87e1bc2b attempt 2, all six nested objects arrived as strings
// carrying one parameter-tag fragment each. The salvage recovered a sixth of
// each section and the repairs then spent two more requests establishing that
// what was left was unusable. That report took four attempts and twelve
// minutes.

function allSectionsLeaked() {
  const bad = completeReportInput();
  for (const key of ['total_cost_of_ownership', 'financing_impact', 'maintenance_running_costs',
    'depreciation_resale', 'alternative_comparison', 'recommendation']) {
    bad[key] = '\n<parameter name="explanation">a fragment';
  }
  return bad;
}

test('several sections arriving as tag text is refused, not repaired', async (t) => {
  const submission = fakeSubmission();
  const { reportInserts, submissionUpdates } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  let repairCalls = 0, mainCalls = 0;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.tool_choice && body.tool_choice.name === 'submit_field_repair') { repairCalls++; return fieldRepairResponse('x'); }
    mainCalls++;
    return toolUseResponse(allSectionsLeaked());
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const result = await generatePurchaseReport('sub-1');

  assert.equal(result, null);
  assert.equal(repairCalls, 0, 'there is nothing in it to repair, so nothing is spent trying');
  assert.equal(mainCalls, 1);
  assert.equal(submission.status, 'paid', 'it asks again immediately');
  assert.equal(submission.generation_attempts, 0, 'and does not spend an attempt on a malformed response');
  assert.equal(reportInserts.length, 0);
  assert.match(submissionUpdates[submissionUpdates.length - 1].error, /tool-call text/);
});

test('one leaked section is still a field to repair, not a refusal', async (t) => {
  const submission = fakeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const props = (((body.tools || [])[0] || {}).input_schema || {}).properties || {};
    if (props.cost_breakdown && props.annual_low) {
      return {
        ok: true,
        json: async () => ({
          content: [{
            type: 'tool_use', name: 'submit_field_repair',
            input: {
              cost_breakdown: completeReportInput().total_cost_of_ownership.cost_breakdown,
              annual_low: 55, annual_high: 70, resale_low: 0, resale_high: 0,
            },
          }],
        }),
      };
    }
    if (props.value) return fieldRepairResponse('Purchase price plus eight years of electricity and a delivery fee.');
    const one = completeReportInput();
    one.total_cost_of_ownership = '\n<parameter name="time_horizon_years">8';
    return toolUseResponse(one);
  };
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  const report = await generateUntilReport('sub-1');
  assert.ok(report, 'a single leaked section is recoverable in-call');
  assert.equal(reportInserts.length, 1);
});

test('a model stuck returning tag text still terminates', async (t) => {
  // The free retries are bounded, or the row would poll forever.
  const { __internal } = require('../api/_lib/purchase-engine');
  // One, not two. A forgiven retry is free of attempts and not of money —
  // at two, a troubled submission made up to six paid calls instead of four.
  assert.equal(__internal.MAX_MALFORMED_RETRIES, 1);

  const submission = fakeSubmission();
  const { reportInserts } = installFakes({ submission });
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const originalFetch = global.fetch;
  global.fetch = async () => toolUseResponse(allSectionsLeaked());
  t.after(() => { global.fetch = originalFetch; uninstallFakes(); });

  const { generatePurchaseReport } = require('../api/_lib/purchase-engine');
  for (let i = 0; i < __internal.MAX_MALFORMED_RETRIES; i++) {
    assert.equal(await generatePurchaseReport('sub-1'), null);
    assert.equal(submission.generation_attempts, 0, 'the first two are forgiven');
  }
  await generatePurchaseReport('sub-1');
  assert.equal(submission.generation_attempts, 1, 'after that they start costing attempts');
  assert.equal(reportInserts.length, 0);
});
