# ENGINE AUDIT REPORT — HOME MAINTENANCE

An evaluation of `/home-maintenance` — the page, the intake, the engine
behind it, and whether a customer who pays $59 gets more than $59 back.

Conducted 2026-09-20 against `home-maintenance.html`,
`api/_lib/navigator-engine.js`, `prices.config.json` and `tests/` at the
repository's current `main`. No paid model runs were spent — the API budget
is closed (see `docs/INSURANCE-AUDIT.md`'s Executive Summary and
`[[no-api-credit-topups]]`), so this rests on the live page and the engine's
own source. Found as a direct consequence of auditing `/insurance`: checking
every other product for the same defect class turned up two more, of which
this is the first fixed.

---

## Executive Summary

**Home Maintenance Navigator sold a repair-vs-replace verdict "grounded in
real numbers," and delivered a single model call told to reason from
"general knowledge of typical lifespans and typical cost ranges."**

`api/_lib/navigator-engine.js`'s `PRODUCT_CONFIGS['home-maintenance']` task,
verbatim: *"Weigh expected remaining life if repaired vs. replaced using
general knowledge of typical lifespans and typical cost ranges for that
system and repair type."* That is the identical unverifiable claim
`docs/INSURANCE-AUDIT.md` found and removed from Insurance Navigator, and the
identical one this codebase's earlier audits had already banned from Home
Savings and Government Money — this codebase holds no price table for what a
roof, an HVAC system, or a water heater "usually" costs to repair or replace,
and repair/replacement cost depends on the specific unit, the contractor and
the region far more than any general-knowledge guess could responsibly
account for.

Two structural defects compounded it. First, the intake was a single free-text
box plus an optional file upload — nothing forced a customer to supply the one
input a real financial comparison needs (their own repair and replacement
figures), so a customer could pay $59 having typed a single sentence and
received exactly the ungrounded guess the page implicitly promised not to be.
Second, nothing on the page or in the prompt treated a safety hazard
differently from ordinary wear — a gas smell or a sparking outlet was just
more input for the same cost-weighing prompt, when the honest answer to "is
this worth repairing" is "stop and call someone now," not a dollar comparison.

**Both are fixed.** `navigator-home-maintenance-engine.js` is a deterministic
decision engine: it never compares to a "typical" cost, it will not render a
financial verdict without the customer's own repair and/or replacement
quotes, and a flagged safety concern short-circuits straight to urgent
guidance before any cost math runs, unconditionally. The intake now collects
structured age, symptom and quote fields instead of free text, gated
server-side the same way Buying, Home Savings, Government Money, Landlord and
Insurance already are.

**One deliberate, disclosed exception exists in the new engine**, and it is
worth stating plainly rather than leaving implicit: a small curated table of
typical service-LIFE ranges, in years, by system category. This is not a
relapse into the banned pattern. A current repair or replacement COST is a
market price with no stable source; a system's typical SERVICE LIFE is a
slow-moving engineering fact, commonly published by manufacturers and
standards bodies, that does not reprice itself by region or quarter. It is
used only as context — where does this system's age sit on a normal range —
never to produce or imply a dollar figure, and every statement of it carries
its own caveat about material and regional variation. The file header
documents the distinction explicitly so it can be checked, not just trusted.

---

## Promise vs. Delivery

| Promise | What the Product Delivered (Before) | Gap | Severity | Fix |
|---|---|---|---|---|
| "Get a clear repair-vs-replace recommendation grounded in real numbers" | A model call reasoning from its own general knowledge of typical costs — not the customer's numbers, because the intake never required any | The word "real" described the opposite of what the prompt instructed | **Critical** | `navigator-home-maintenance-engine.js`: verdict is arithmetic on the customer's own quotes, or an explicit request for what's missing — never a guess |
| "Typical cost ranges for this system and repair/replacement type" (What You Get) | The exact banned claim, asserted as a feature | This is the claim `docs/INSURANCE-AUDIT.md`, `HOME-SAVINGS-AUDIT.md` and `GOVERNMENT-MONEY-AUDIT.md` each independently found and removed elsewhere | **Critical** | Bullet removed from the page; the prompt now forbids stating any cost that is not the customer's own quote |
| "Efficiency and cost-of-ownership differences" | Nothing computed this; the model was simply asked to mention it | A promise with no mechanism behind it at all | High | Removed from the page rather than built on a guess — see Required Changes |
| "Warning signs it's time to stop patching and replace" | Generic, ungrounded prose | Plausible but not tied to anything the customer actually told the product | Medium | Now driven by the deterministic `cautions` array (e.g. a system already past its typical service-life range) |
| Intake: a free-text box, files optional | A customer could submit a single sentence and reach checkout | No structured gate meant no guaranteed inputs for the "real numbers" the page promised | **Critical** | Structured fields (age, symptoms, both quotes) with a server-side sufficiency gate matching the pattern already used on five other products |
| (Implicit) a safety hazard is handled like ordinary wear | The same cost-weighing prompt ran regardless of what prompted the decision | A gas smell treated as a data point in a cost comparison is the one outcome this kind of product must never produce | **Critical** | `applySafetyOverride()` — an unconditional short-circuit, tested directly, that cost math can never reach if `safety_concern` is flagged |

---

## Fixes Shipped

**Critical**
1. Deterministic decision engine (`navigator-home-maintenance-engine.js`) —
   no "typical cost" claim anywhere in its logic or its output.
2. Structured intake replacing the free-text box, with a server-side
   sufficiency gate (`api/navigator-intake.js`) matching Buying/Home
   Savings/Government Money/Landlord/Insurance.
3. An unconditional safety override that cost comparison can never reach.

**High**
4. "Efficiency and cost-of-ownership differences" removed from the page
   rather than built on an ungrounded estimate — the audit's own standard
   (`docs/INSURANCE-AUDIT.md` §13, "identify bad features too") applied here
   directly: a feature with no honest mechanism behind it should be cut, not
   faked.
5. The write-up prompt (`PRODUCT_CONFIGS['home-maintenance'].task`) now
   forbids originating any dollar figure, any lifespan claim beyond the
   engine's own caveated range, or any softening of a safety verdict.

**Medium**
6. Hero example-finding card added, proving the mechanism (the FAQ's own
   original placeholder scenario — a 14-year-old water heater, $1,400 repair
   vs. $2,600 replace) before a visitor pays.
7. FAQ and footer disclaimer corrected to describe what the product actually
   does — that a quote is not strictly required to submit, but is required
   for a financial verdict, and that no cost data is held or estimated.

20 new tests (`tests/home-maintenance-engine.test.js`,
`tests/navigator-intake-home-maintenance.test.js`) pin every verdict path —
safety override, both-quotes comparison at and around the 50% threshold,
each single-missing-quote case, the no-baseline case, and the sufficiency
gate — against known answers. All 83 suites in the repository pass.

---

## Pricing

**Current price: $59, one-time.** No change recommended, on the same terms
`docs/INSURANCE-AUDIT.md` set for Insurance and this codebase already applied
to Landlord and Government Money: the price stands once its conditions are
met, and they now are — a real deterministic engine exists, the "typical
cost" claim is gone, and the intake requires the inputs the verdict actually
needs. `prices.config.json` carries a note recording this.

---

## What Remains Unverifiable

The same shape as Insurance's remaining gap, and smaller: this engine needs
no model call to reach a verdict at all — `analyze()` is pure arithmetic on
structured form fields, fully covered by `tests/home-maintenance-engine.test.js`
without spending anything. The only unverified piece is the WRITE-UP: does
the model, handed the computed verdict as data, present it without inventing
a figure or softening a safety verdict, in a real generation? That is
downstream of the same blocked Anthropic credit balance
`docs/INSURANCE-AUDIT-FOLLOWUP.md` documents, not something more engine work
can close.
