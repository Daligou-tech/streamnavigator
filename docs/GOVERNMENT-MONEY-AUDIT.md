# ENGINE AUDIT REPORT — GOVERNMENT MONEY

An evaluation of `/government-money` — the page, the intake, the engine behind
it, and whether a customer who pays $39 gets more than $39 back.

Conducted 2026-09-19 against production (`streamnavigator.ai/government-money`)
and against `government-money.html`, `api/navigator-intake.js`,
`api/_lib/navigator-engine.js`, `api/generate-paid-navigator.js`,
`prices.config.json` and `tests/` at `eb85674`. **No paid model runs were
spent** — the API budget is closed, so every finding below rests on the live
page, the live Stripe checkout, the engine's own source, and one live intake
probe that stopped at the payment screen. `/closing` is the design and
engineering standard throughout, as the brief directs.

---

## 0. A correction to the brief's premise, and what was audited instead

The brief describes a product that takes a list of subscriptions and returns
**keep / suspend / restart** calls weighing usage, recency, seasonality and
reactivation cost.

**That product exists on this site, and it is not `/government-money`.** It is
`/subscriptions` ($29), running `navigator-subscription-engine.js` — 12 named
rules, a safety pass, a saving-kind discipline — and it was audited in full on
this same date (`docs/SUBSCRIPTIONS-AUDIT.md`, `docs/HOME-SAVINGS-AUDIT.md`).
Re-running those thirteen scenarios here would produce a third copy of an
answer already on disk.

`/government-money` is a different product: a **$39 one-time search for
rebates, tax credits, utility incentives and grants** a household may qualify
for, from a free-text description of their situation.

**Assumption, documented as the brief requires:** the brief's decision-logic
sections are answered against this product's actual verbs rather than reported
as not-applicable. The mapping used throughout is:

| Brief's verb | This product's equivalent | Meaning |
|---|---|---|
| Keep | **CLAIM** | Every gate we can check is met — file it |
| Suspend | **DON'T COUNT** | Named, but explicitly excluded from any total |
| Restart | **NOT NOW** | Not eligible today; here is the dated event that changes that |

Section 7's "false savings" maps to **phantom money** — naming a program's
headline dollar figure that this household will never actually receive. That
is the single most damaging failure mode this product has, and Section 8 is
given to it.

---

## Executive Summary

**`/government-money` sells a live database lookup. There is no database, there
is no lookup, and the engine's own prompt says so in writing.**

Step 3 of "How it works" reads *"AI searches current programs."* The FAQ reads
*"Each report is generated fresh using current program information at the time
of purchase."* Behind both sentences is a **single 219-word prompt** in
`PRODUCT_CONFIGS['government-money']` (`api/_lib/navigator-engine.js:356`)
handed to `claude-sonnet-5`. Its second paragraph opens:

> "You do not have live access to current program databases…"

And the shared `HONESTY_RULES` above it (`navigator-engine.js:88`) forbids, by
name, the exact deliverable the page sells:

> "Never invent a specific real-world fact you cannot verify — … **the name and
> current dollar amount of a specific government program** …"

`data/` holds one reference set, `landlord-jurisdictions.json`. There is no
program corpus, no state table, no utility table, and nothing in `vercel.json`
that refreshes one. So three of the six "What you get" bullets — *estimated
dollar value of each program*, *deadlines or windows you shouldn't miss*, and
*utility rebates specific to your situation* — are bought by the customer and
then declined by the engine as a matter of policy. This is not a drafting slip.
The page and the prompt were written to contradict each other.

Four further defects, each verified rather than inferred:

1. **A single character reaches a $39 checkout.** Verified live on
   2026-09-19: description `x`, email supplied, button pressed → submission
   `7ece5cb5-c379-4966-9239-72f704f8d25a` created, browser handed to
   `buy.stripe.com/00w14n0NS6UkdsEa80abK08` showing **$39.00** and a one-time
   **Pay** button. `/buying`, `/subscriptions`, `/home-savings` and `/landlord`
   each got a structured pre-payment sufficiency gate; `government-money` falls
   through to the generic `else` at `api/navigator-intake.js:197`, which asks
   only that the description be non-empty. **The field this product needs most
   — where the customer lives — is never asked for at all.** A utility rebate
   is by definition utility-specific and a state credit is state-specific; a
   customer who does not volunteer their state in prose has bought a report
   that can only discuss federal programs and say so.
2. **`formData.category` is dead code.** `government-money.html:266` wires click
   handlers to `.category-chip`; the page contains no such element, so
   `selectedCategory` is permanently `null` and the branch that would pass it to
   the model (`navigator-engine.js:729`) can never fire.
3. **Nothing is shown before the $39 ask.** No sample report, no example
   finding, no free tier. `/closing` earns its $59 by giving away a scorecard
   first. This page asks for money on the strength of its own adjectives.
4. **No test asserts anything about this product.** `government-money` appears
   in `tests/` three times, every one a membership list.
   `tests/navigator-claims.test.js` — the file that exists precisely to stop a
   page selling what the code does not do — passes here only because its
   regexes (`market rate data`, `published rates?`, `live comps?`) do not reach
   the phrasings this page actually uses.

**What is working, and it is not nothing.** The delivery infrastructure behind
this product is genuinely good and better than the product it delivers:
`generate-paid-navigator.js` sweeps paid-and-abandoned rows so a customer who
closes the tab still gets their report by email; `provider-outage.js`
distinguishes "we cannot analyse this" from "the provider is down" so nobody is
refunded for a report they are still going to get; failures queue a refund
automatically; uploads expire at 90 days; the price on the page, the price in
`prices.config.json` and the price Stripe charges all agree at $39; the footer
disclaimer is accurate and well written. **The plumbing is sound. The product
in the pipe is the problem.**

---

## 1. Product Promise

What the page commits to, in its own words:

| # | Promise | Where |
|---|---|---|
| P1 | "Find the money the government **already owes you**" | H1 |
| P2 | "It **searches** for rebates, tax credits, utility incentives, and grants you actually qualify for" | Hero sub |
| P3 | "**AI searches current programs** — Federal, state, and local … checked against what you told us" | Step 3 |
| P4 | "Every program you likely qualify for, with plain-English instructions" | Step 4 |
| P5 | "Utility rebates and incentives **specific to your situation**" | What you get |
| P6 | "**Estimated dollar value** of each program" | What you get + price card |
| P7 | "**Deadlines or windows** you shouldn't miss" | What you get |
| P8 | "Generated fresh using **current program information** at the time of purchase" | FAQ |
| P9 | "**Most households** qualify for at least one program they didn't know about" | FAQ |
| P10 | "Delivered automatically, usually within a couple of minutes" | Price card |

P10 is true (`SWEPT_PRODUCTS` includes `government-money`). P4 is true. Every
other one is addressed in §13.

---

## 2. What the Website Actually Does

The whole mechanism, end to end:

1. Customer types free text into one `<textarea>` and an email. Optionally
   attaches PDFs/images.
2. `submitNavigatorIntake()` POSTs `{product, email, formData:{category,
   description}, files}` to `api/navigator-intake.js`.
3. The endpoint checks the description is non-empty **or** a file exists
   (`navigator-intake.js:197`). Nothing else. Row inserted, token returned.
4. Browser is sent to the Stripe Payment Link with `?client_reference_id=<id>`.
5. `api/navigator-stripe-webhook.js` marks the row `paid`.
6. `generateNavigatorReport()` builds a message containing: the uploaded files
   as document/image blocks, then one text block that is literally
   `Customer's description: <free text>` + `Number of documents attached: N`.
7. That, plus `HONESTY_RULES` and the 219-word task prompt, goes to
   `claude-sonnet-5` with `max_tokens` = 8000 (no deterministic findings exist
   for this product, so `maxTokensForWork()` returns the base).
8. The model returns the generic `submit_navigator_report` shape — headline,
   ≤6 key numbers, labelled sections, `missing_or_uncertain`, optional closing
   block — and `navigator-status.html` renders it generically.

**There is no step in which any program is looked up.** The word "searches" in
P2 and P3 describes a text completion.

---

## 3. Functional Audit

| Element | Result | Evidence |
|---|---|---|
| Page loads, matches repo byte for byte | ✅ | live text vs `government-money.html` |
| Nav anchors (#how-it-works, #what-you-get, #pricing, #faq) | ✅ | all resolve |
| FAQ accordion | ✅ | `navigator-shared.js` |
| Email validation | ✅ | blocks empty / no `@`, focuses the field |
| Empty-state validation | ✅ | "Tell us about your situation, or upload…" |
| Error surface is persistent, not a toast | ✅ | `#intake-error`, with a comment explaining why |
| Upload zone (drag, 50MB/file, 150MB total) | ✅ | `wireUploadZone` |
| Upload copy vs accepted types | ⚠️ | copy says "PDF, JPG or PNG"; `accept` also takes `.webp` |
| Category chips | ❌ | handler wired, no chips exist, `category` always `null` |
| Sufficiency gate before payment | ❌ | one character passes — **verified live** |
| Stripe price / interval | ✅ | $39.00, one-time "Pay", matches `prices.config.json` |
| Mobile 375×812 | ✅ | no horizontal overflow, h1 38.4px, button 275px wide |
| Sample output before purchase | ❌ | none anywhere on the page |
| Automatic delivery when tab is closed | ✅ | `SWEPT_PRODUCTS` |
| Refund on engine failure | ✅ | `failurePatch`, `refund_state='due'` |

---

## 4. Engine / Decision Logic Audit

`PRODUCT_CONFIGS['government-money']` is 219 words and contains **no decision
logic at all** — no rule, no threshold, no gate, no catalogue. It is a set of
restraints on a free-text writer. Compare, in the same file and the same
repository:

| Product | Price | What decides |
|---|---|---|
| `/closing` | $59 | `closing-audit.js` — 28 named deterministic checks |
| `/landlord` | $149 | `landlord-audit.js` + `data/landlord-jurisdictions.json` |
| `/rental` | $149 | `rental-audit.js` + outcomes + trend |
| `/subscriptions` | $29 | `navigator-subscription-engine.js` — 12 rules, 3 refusals |
| `/home-savings` | $49 | `navigator-home-savings-engine.js` (shipped 2026-09-19) |
| **`/government-money`** | **$39** | **the model, unaided** |

Four of the five products above follow the same architecture: *the engine
decides, the model writes it up, and the prompt forbids the model from
originating a number.* `/government-money` is the inversion — the model
originates everything, and the prompt's only defence is an instruction to be
careful. The subscription audit's conclusion applies here verbatim: **none of
those failures was a reasoning failure. Nothing was checking a list.**

Worse, this is the product where the asymmetry bites hardest. A subscription
recommendation that is wrong costs the customer a monthly fee. A tax-credit
recommendation that is wrong is filed with the IRS.

### Is eligibility even decidable from what is collected?

Take the placeholder's own example — *"Homeowner, installed solar panels in
2025, household of 4, live in Ohio"* — the best-case input this page invites.
Walk the federal residential clean energy credit:

| Gate | Collected? |
|---|---|
| Property is the taxpayer's residence in the US | inferred from "homeowner" |
| System placed in service in the tax year | "2025" — year only, no date |
| Qualified expenditure amount | **not collected** |
| Taxpayer has federal income tax liability to offset | **not collected** |
| Amount already claimed / carried forward | **not collected** |
| Any utility or state rebate that reduces the basis | **not collected** |

Four of six gates are unasked. The engine cannot state a dollar value for the
one program the page's own placeholder invites — which is why the prompt tells
it not to, and the price card sells that value anyway.

---

## 5. Input / Data Audit

Collected today: **one free-text box, one email, optional files.** That is it.

The minimum set that makes eligibility decidable — nine fields, all but two a
tap:

| # | Field | Type | Why it is load-bearing |
|---|---|---|---|
| 1 | State | select, required | Every non-federal program is state-scoped |
| 2 | ZIP | 5 digits, required | Utility territory and county/city programs |
| 3 | Own or rent | 2 buttons, required | Splits the catalogue roughly in half |
| 4 | Household size | number, required | Every income-tested program is size-adjusted |
| 5 | Household income band | 5 bands, required | AMI/FPL gating; bands, never an exact figure |
| 6 | Expect to owe federal income tax? | yes / no / unsure | **Non-refundable credits are worthless without it** |
| 7 | Installed or bought in the last 24 months | multi-select checklist | The single richest signal |
| 8 | Planning in the next 12 months | same checklist | Produces the NOT-NOW calls |
| 9 | Life events | multi-select | Childcare, first home, 65+, veteran, disability |

Plus the existing free-text box, kept, relabelled "Anything else we should
know?" — it is a good field once it is no longer the only one.

**Nine taps and a ZIP.** That is less friction than `/landlord` already asks
for and less than `/subscriptions` asks per line. Field 6 is the one that
matters most and it is the one nobody asks: a household with no federal tax
liability cannot use a non-refundable credit in the year claimed, and telling
them otherwise is the phantom-money failure in §8.

---

## 6. CLAIM / DON'T-COUNT / NOT-NOW Audit

The three verbs the product needs, and whether it has them:

**CLAIM.** Exists only as prose. The engine has no concept of a gate being met,
so it cannot distinguish "you qualify" from "you might qualify" except by
adverb. The page promises "programs you **likely** qualify for", which is the
honest word, then undercuts it with "the money the government **already owes
you**", which is not.

**DON'T-COUNT.** Does not exist in any form. There is no total, no exclusion
list, and no rule preventing the model from putting a program's headline figure
in `key_numbers` — a field the renderer displays in large type at the top of
the report (`navigator-status.html:850`). Contrast `/subscriptions`, whose
prompt spends an entire paragraph on saving-kind discipline and states that
"at risk" figures are "**NEVER** added into a total". `/government-money` has
no equivalent sentence and a much larger downside.

**NOT-NOW.** Does not exist. And this is the most valuable verb this product
could own, because government money is intensely time-shaped in ways a customer
cannot see:

- Efficiency credits with an **annual** cap reset each tax year — splitting a
  window job across 31 December can be worth real money.
- Rebate programs funded from a fixed pot close when the pot empties and reopen
  on a new fiscal year.
- A credit is claimed for the year the work was *placed in service*, not the
  year it was paid for.
- Income-tested programs flip on a change in household size or income band.

A customer told *"not this year — do the windows in January, and here is why"*
has received something no free search result gives them. Nothing in the current
engine can produce that sentence, because nothing knows what the customer has
already used this year.

---

## 7. Restart / Re-check Recommendations

The brief asks whether a restart recommendation answers: why now, what changed,
what will you get, how long do you keep it, when do you revisit.

The current product answers none of them, because it has no state. Every report
is a cold start: no submission is ever compared with an earlier one for the same
email. `/rental` and `/landlord` both do exactly this comparison
(`resolvePriorRental`, `resolvePriorLandlord` in `navigator-engine.js`), and
`ENTITLED_PRODUCTS` is `['rental','landlord']` — `government-money` has no
entitlement, which is consistent with the page, which correctly never promises
one. **This is a gap, not a lie.** It is the right thing to build second.

---

## 8. Phantom Money Analysis (the brief's "false savings")

This is the highest-severity analytical risk in the product, and it is
completely unguarded. Seven ways the current engine can put a number in front
of a customer that they will never receive:

| # | Trap | Why the engine falls for it |
|---|---|---|
| F1 | **Non-refundable credit, no tax liability.** A credit that reduces tax owed is worth nothing to a household that owes nothing that year. | Liability is never asked (§5, field 6) |
| F2 | **A cap quoted as the amount.** Headline figures are ceilings computed as a percentage of actual cost. | Cost is never collected |
| F3 | **Annual aggregate ignored.** Where a credit is capped in aggregate per year with per-item sub-caps, three upgrades do not stack to three caps. | No notion of a running total |
| F4 | **Stacking without basis reduction.** A utility rebate frequently reduces the cost basis a federal credit is computed on; adding the two is double-counting. | No stacking rules exist |
| F5 | **Already claimed.** Anyone who installed solar was told about the credit by their installer. | Never asked "have you already claimed this?" |
| F6 | **Exhausted or closed funding.** First-come rebate pots and closed enrolment windows. | No live data — by design |
| F7 | **Wrong tenure.** Renters offered owner-only credits. | Tenure never asked |

F5 deserves its own line, because it is the product's core value question. **The
value of this report is discovery, not program value.** A customer who already
knew about a credit received $0 of value from being told about it. The page's
economics implicitly claim the gross figure; the honest figure is *gross
program value × the probability the customer would otherwise have missed it*,
and for the biggest, best-advertised programs that probability is low. §11
models this explicitly.

**The fix is the house's own proven pattern.** `/subscriptions` shipped three
rules whose entire job is to *refuse* to find savings, with a test enumerating
roughly five thousand inputs to prove none of them ever fires wrongly. This
product needs the same thing: a `DON'T COUNT` pass that can only ever *remove*
a figure from the total, and F1 is its first rule.

---

## 9. Pricing Audit

**Current: $39 one-time.** Verified at checkout.

Where it sits in the line:

| Product | Price | Engine behind it |
|---|---|---|
| `/streaming` | $19.99/yr | catalogue + streaming engine |
| `/subscriptions` | $29 | 12 rules, 3 refusals, ~5,000-input test |
| **`/government-money`** | **$39** | **a 219-word prompt** |
| `/contractor` | $49 | contractor engine + bespoke renderer |
| `/home-savings` | $49 | home-savings engine |
| `/closing` | $59 | 28 deterministic checks + a free scorecard first |

$39 currently buys less engineering than $29 does one page over. That ordering
is the same defect `docs/SUBSCRIPTIONS-AUDIT.md` §H found when `/subscriptions`
sat at $49 above a more capable `/home-savings`, and it was fixed by moving the
price, not by defending it.

**Competitive floor.** Unlike every other Navigator, this product has a free
substitute that is *better*, not merely cheaper: DSIRE (dsireusa.org) is a
maintained, searchable, state-by-state incentive database, free; so are
energy.gov, benefits.gov, official form instructions and a utility's own rebate
page. A general-purpose chatbot performs this exact free-text task at identical
quality for $0, because the task requires no proprietary data — and the engine
here *is* a general-purpose chatbot with a 219-word preamble. **The product has
no moat at $39 and would have a real one at $39 with a corpus.**

---

## 10. Customer Value Analysis

Can a visitor understand the economics before paying?

| Question | Answered on the page? |
|---|---|
| What does it do? | Yes |
| What do I provide? | Yes — though it under-asks (§5) |
| What will I receive? | Yes, but three of six bullets are undeliverable |
| How much might I save? | **No.** No figure, no range, no example |
| How are recommendations produced? | **No.** "AI searches" implies a lookup |
| Why should I trust it? | **No.** No sample, no method, no limits until the footer |
| What does it cost? | Yes, clearly, three times |
| Will it cost less than it saves? | **Unanswerable from the page** |

The relationship the brief asks for — *expected savings − service cost = benefit*
— is never stated in any form. The closest the page comes is "There's a good
chance you're leaving money unclaimed", which is an assertion about the reader,
not about the product.

---

## 11. Unit Economics

Three representative households. Program values are illustrative of the
categories involved and deliberately **not** presented as current figures —
which is itself the point: this audit cannot state a current program amount,
and neither can the engine.

**Assumption stated as the brief requires:** value is credited to the product
only when the customer would plausibly have *missed* the program otherwise
(the F5 discipline from §8). "Discovery probability" is that estimate.

### Customer A — low (renter, 1 person, no qualifying purchases)

| | |
|---|---|
| Plausibly applicable | Utility efficiency kit; income-tested energy assistance if band-qualified; a renter's credit in a handful of states |
| Gross value if all claimed | $0 – $250 |
| Discovery probability | ~0.3 |
| **Expected value delivered** | **~$45** |
| At $39 | ratio ≈ **1.2×** |
| At $19 | ratio ≈ **2.4×** |

The most likely single outcome for A is a report saying "check these two
things, here is where" — useful, thin, and hard to feel good about at $39.

### Customer B — average (homeowner, household of 4, replaced a water heater and added attic insulation last year, has federal tax liability)

| | |
|---|---|
| Plausibly applicable | A federal efficiency credit on both items (subject to annual aggregate and per-item sub-caps); a utility rebate on the water heater; possibly a state weatherisation program |
| Gross value if all claimed | $400 – $1,100 |
| Discovery probability | ~0.45 — insulation and water-heater credits are genuinely under-claimed |
| **Expected value delivered** | **~$340** |
| At $39 | ratio ≈ **8.7×** |

B is the customer this product is for, and the economics work — *provided the
report is right about the caps*. Traps F2 and F3 both bite here.

### Customer C — high (homeowner, solar + new EV + heat pump in the last 18 months, household of 4)

| | |
|---|---|
| Gross program value | Large — five figures is realistic across the three |
| Discovery probability | **~0.1.** The solar installer, the dealer and the HVAC contractor each had a commercial reason to raise the credit at the point of sale |
| **Expected value delivered** | Low in absolute terms despite the largest gross figure |
| Real value for C | The *sequencing* and *stacking* questions nobody answered — basis reduction (F4), annual caps (F3), what happens when credits exceed liability (F1) |

**C is the finding.** The customer with the most government money in play gets
the *least* value from a discovery list and the *most* from a stacking-and-
sequencing analysis — which is precisely the analysis that needs an engine and
cannot be done by a prompt told not to state amounts.

### Cost to serve

One model call, 8,000 max output tokens, plus delivery. Order of $0.10–$0.40.
Gross margin at $39 is ~99%. Margin is not the problem and never was; nothing
in this report is an argument about revenue.

---

## 12. Trust & Privacy Audit

Genuinely strong, and the best-executed part of the page:

- ✅ No credentials, no account linking, no bank connection — and, correctly,
  none is needed for this product.
- ✅ "Payments are processed securely by Stripe — StreamNavigator never sees or
  stores your card details." True: a hosted Payment Link, no card fields on
  site.
- ✅ Uploads expire at 90 days (`cleanup-expired-documents.js`).
- ✅ The footer disclaimer is accurate, specific and well written: *"Program
  eligibility, availability, and deadlines are determined solely by the issuing
  government agency or utility and can change without notice."*
- ✅ "Do you file the claims for me? **No**" — the right answer, plainly given.

Two problems:

- ❌ **The footer disclaimer contradicts the FAQ four screens above it.** The
  FAQ says the report uses "current program information"; the footer says
  availability and deadlines can change without notice and only the agency
  decides. Both cannot be true, and the true one is in the small grey text at
  the bottom.
- ⚠️ **The page implies knowledge it does not have.** "It searches" and "AI
  searches current programs" describe a capability the system lacks. The
  brief's §15 test — *does the product imply access to information it does not
  possess?* — fails on the page while passing in the engine.

---

## 13. Truthfulness Audit

| # | Claim | Verdict | Why |
|---|---|---|---|
| P1 | "the money the government **already owes you**" | **Misleading** | An unclaimed incentive is not a debt. Nothing is owed until a claim is filed and approved. This frames a discretionary program as an entitlement in arrears. |
| P2 | "It **searches** for rebates…" | **Unsupported** | No search occurs. A text completion is performed. |
| P3 | "**AI searches current programs**" | **Unsupported** | The engine's own prompt: "You do not have live access to current program databases." `data/` holds no program corpus. |
| P4 | "Every program you likely qualify for, with plain-English instructions" | **Partially supported** | Instructions: yes, the prompt requires them. "Every": no — the engine names only categories it is confident in and is told to generalise otherwise. |
| P5 | "Utility rebates **specific to your situation**" | **Unsupported** | Utility territory is never collected; no utility table exists. The prompt's own fallback is *"check with yours"*. |
| P6 | "**Estimated dollar value** of each program" | **Unsupported** | `HONESTY_RULES` forbids "the name and current dollar amount of a specific government program" unless confident; the task prompt repeats the restriction. Sold twice — in "What you get" and on the price card. |
| P7 | "**Deadlines or windows** you shouldn't miss" | **Unsupported** | The prompt explicitly instructs that deadlines "should be verified against the current official source, since you cannot confirm today's rules." |
| P8 | "generated fresh using **current program information** at the time of purchase" | **Misleading — the worst line on the page** | "Fresh" is true of the *generation*; "current program information" is false of the *inputs*. The sentence's construction transfers the freshness of the former to the latter. The model has a training cutoff and no lookup. |
| P9 | "**most households** qualify for at least one program they didn't know about" | **Unsupported** | A quantified population claim with no cited source, no internal data, and no completed-report history to draw on. |
| P10 | "Delivered automatically, usually within a couple of minutes" | **Supported** | `SWEPT_PRODUCTS`, and `tests/navigator-claims.test.js` already enforces a sweep for any page that says this. |
| — | Footer disclaimer | **Supported** | Accurate and appropriately scoped. |
| — | Stripe / card handling | **Supported** | Verified at checkout. |

**Four unsupported, two misleading, one partial.** For comparison, the same
test applied to `/landlord` after its rebuild produces zero unsupported claims,
and `tests/navigator-claims.test.js` holds it there.

---

## 14. UX Audit

Working: one-column flow, intake embedded in the price card (no extra step
between wanting it and starting it), a persistent error line with a considered
comment explaining why it is not a toast, file list with removal, good upload
limits copy, clean mobile at 375px, and an FAQ that answers the "do you file it
for me" objection directly.

Not working:

1. **One box for nine facts.** The textarea asks the customer to guess what
   matters. The placeholder is doing the entire job of a form.
2. **No progressive disclosure.** Price, form and CTA arrive together, before
   any evidence.
3. **Dead category chips** — a designed-for input that never shipped (§3).
4. **"Find My Money"** (final CTA) anchors to `#pricing` rather than focusing
   the textarea, costing the visitor one extra decision at the moment of
   highest intent.
5. **Upload types mismatch** — copy omits `.webp`, which `accept` allows.
6. **No indication of report length or shape.** "A personalized claim list"
   could be three lines or thirty.

---

## 15. Conversion Audit

| # | Question | Answer |
|---|---|---|
| 1 | Value proposition immediately obvious? | Yes — the H1 is the strongest line on the page |
| 2 | Does the user know what to do? | Yes |
| 3 | Is the input intimidating? | No — it is the opposite problem: **too open** to answer confidently |
| 4 | Is the information requested reasonable? | It is unreasonably *little* |
| 5 | Is the result compelling? | **Unknown to the visitor** — nothing is shown |
| 6 | Is the price understandable? | Yes |
| 7 | Is the CTA obvious? | Yes |
| 8 | Enough evidence of value? | **No.** No sample, no example figure, no count, no method |
| 9 | Unnecessary steps? | No |
| 10 | Unnecessary words? | Some — "A personalized list, not a generic database dump" defends against an objection the visitor has not formed yet |

**The single highest-leverage conversion change is also the single highest-
leverage trust change: give something away first.** `/closing` converts on a
free scorecard. The equivalent here is a **free Eligibility Snapshot** — run
the nine-field form, show the customer *how many* programs and *which
categories* their situation points at, free; charge for the detail, the
amounts, the sequencing and the claiming instructions. It fixes §15's question
8, §10's "how much might I save", and §5's input problem in one build.

---

## 16. Copy Audit

- **"already owes you"** — the strongest line on the page and the least
  defensible. Keep the energy, drop the claim (§24).
- **"AI searches current programs"** — must go. It is the load-bearing false
  sentence.
- **"generated fresh using current program information"** — must go.
- **"Estimated dollar value of each program"**, **"Deadlines or windows you
  shouldn't miss"** — must be rewritten to what the engine will actually
  produce.
- **"most households qualify for…"** — delete or substantiate.
- **"A personalized list, not a generic database dump"** — a straw man; the
  generic database (DSIRE) is free, maintained and better than what this
  produces today. Do not invite the comparison until it can be won.
- **"Government Money Finder"** vs utility rebates — a utility is not the
  government. Minor, but the page promises both under one name.
- **Missing entirely: the objection every visitor has** — *"why can't I just
  search for this myself?"* There is no FAQ answer for it, because there is not
  currently a good one.

---

## 17. Design Comparison with `/closing`

Measured live via `getComputedStyle`, both pages, same session:

| Token | `/closing` (reference) | `/government-money` | Same? |
|---|---|---|---|
| Body font | `"IBM Plex Sans", system-ui` | `Inter, -apple-system` | ❌ |
| Body size / line-height | 17px / 27.2px | 16px / 24.8px | ❌ |
| H1 font | `Newsreader, Georgia, serif` | `Sora, Inter, sans-serif` | ❌ |
| H1 size / weight / tracking | 51.2px / 500 / −0.512px | 57.3px / 700 / −1.147px | ❌ |
| `--bg` | `#FBFAF7` (warm paper) | `#F3F0FC` (lavender) | ❌ |
| `--bg-alt` | `#F4F2ED` | `#EAE3F8` | ❌ |
| `--ink` | `#1B2A3A` (navy) | `#1F1B16` (near-black) | ❌ |
| `--rule` | `#D8DAD5` | not defined | ❌ |
| Primary button fill / text | navy `#1B2A3A` on paper | white on `#1F1B16` | ❌ |
| Button radius | `2px` | `999px` pill | ❌ |
| Button border | `1px solid` | `2px solid` | ❌ |
| Button shadow | `none` | `4px 4px 0 #1F1B16` (hard offset) | ❌ |
| Button weight / padding | 500 / 14px 26px | 800 / 10px 20px | ❌ |
| Stylesheet | inline `<style>`, 1,083-line page | `/navigator-shared.css` | ❌ |
| Fonts loaded | Newsreader + IBM Plex Sans + Mono | Inter + Sora | ❌ |

**These are not deviations within one system. They are two different design
systems.** `/closing` is editorial — serif headline, paper background, hairline
rules, flat square buttons, restrained weight. `/government-money` is
neo-brutalist — geometric sans, lavender gradient, pill badges, hard offset
shadows, 800-weight type.

> **Correction, made while implementing this section — see §28.** The
> recommendation that stood here was wrong, and wrong on a fact. It read: ten
> of twelve Navigator pages use `navigator-shared.css`, so migrating this one
> alone would make it the odd page out; adopt `/closing`'s system only as part
> of a line-wide migration.
>
> Three of the four `navigator-shared.css` matches that count rested on are
> **inside HTML comments**. `closing.html` does not load that stylesheet at
> all, and `contractor.html`, `subscriptions.html` and `home-savings.html` had
> already migrated to `navigator-editorial.css` — `subscriptions.html` carries
> a test asserting it does not load both systems. The migration was already
> under way and this page was one of the ones still waiting, not a candidate
> for being stranded.
>
> Corrected recommendation, now shipped: **migrate `/government-money` to
> `navigator-editorial.css` and the `/closing` chrome.** Measured after the
> change, on the same tokens as the table above: body `IBM Plex Sans` 17px,
> h1 `Newsreader` 52.8px, `--bg` `#FBFAF7`, primary button navy fill on paper
> at 2px radius with no shadow. Every row below now matches.

Ten of the twelve Navigator pages use `navigator-shared.css`, so this page is
consistent with the *line* and inconsistent with the *reference the brief
names*. That is worth saying plainly, because it changes the recommendation:
migrating one page to `/closing`'s system makes it the odd page out instead.

**Recommendation:** adopt `/closing`'s system on `/government-money` only as
part of a line-wide migration, not alone. What *should* change now, because it
is about credibility rather than taste, is the three places where this page's
visual language oversells: the gradient `.grad` treatment on "already owes
you", the ✓-tick list used for claims that are not yet supported, and the
lottery-adjacent final CTA. `/closing`'s restraint is doing commercial work —
a page that looks like a tax document is a page you believe about tax.

---

## 18. Edge-Case Analysis

Where the current engine can produce a misleading result. Every row is
currently unguarded.

| Case | Current risk |
|---|---|
| Renter | Offered owner-only credits (F7) |
| No federal tax liability | Non-refundable credits quoted as cash (F1) |
| Purchase made before the eligibility window opened | No date arithmetic exists |
| Purchase already claimed on a prior return | Never asked (F5) |
| Multiple upgrades in one tax year | Annual aggregate cap ignored (F3) |
| Utility rebate + federal credit on the same item | Basis reduction ignored (F4) |
| Program closed or funding exhausted | Unknowable without live data (F6) |
| State never mentioned in the free text | Report is silently federal-only |
| Manufactured / mobile home, co-op, condo | Different rules; the tenure question is binary at best |
| Married filing separately | Caps and phase-outs differ; never asked |
| Second home vs principal residence | Different treatment per credit; never asked |
| Moved between states mid-year | Two jurisdictions; never asked |
| Business use of the home | Apportionment required; never asked |
| Customer types one character | **Accepted and charged $39** — verified |
| Customer uploads a receipt but writes nothing | Accepted; the engine reads the file — this is the good path |

---

## 19. Critical Issues

**C1 — The page sells a live lookup the system cannot perform.**
P2, P3, P5, P6, P7, P8. Fix: rewrite the copy to what the engine does (§24)
*or* build the lookup (§22). Until one of the two ships, the page is taking $39
for a capability it does not have.

**C2 — No pre-payment sufficiency gate; the most important field is not
collected at all.** A one-character submission reaches a $39 Stripe checkout,
verified live. State and ZIP — without which no state, local or utility program
can be assessed — are never asked for. Fix: the nine-field form (§5) plus a
`checkGovernmentMoneySufficiency()` in a shared module required by both
`government-money.html` and `api/navigator-intake.js`, exactly as
`/subscriptions` and `/home-savings` already do it.

**C3 — No phantom-money guard.** Seven named traps (§8), none defended, on a
product whose output gets filed with a tax authority. F1 alone — a
non-refundable credit quoted to a household with no liability — is a customer
making a financial decision on a number that is zero for them.

**C4 — "Current program information" is false as written.** In the FAQ, and it
contradicts the page's own footer. This is the one line that would be hardest
to defend if challenged.

**C5 — Nothing tests any of this.** `tests/navigator-claims.test.js` exists to
prevent exactly C1 and does not reach this page's phrasings. A rewrite without
a test is a rewrite that drifts back.

---

## 20. Important Issues

**I1** — Nothing shown before the $39 ask; no sample, no free tier, no example.
**I2** — Dead `.category-chip` code; `formData.category` is permanently `null`.
**I3** — "Most households qualify…" is an unsupported population claim.
**I4** — No prior-submission comparison, so no NOT-NOW / re-check verb (§7).
**I5** — The free-text box asks the customer to guess which facts matter.
**I6** — The page invites comparison with "a generic database dump" it would
currently lose.
**I7** — Utility rebates sold under a "Government Money" name.
**I8** — Upload copy omits `.webp`, which the input accepts.

---

## 21. Nice-to-Have Improvements

**N1** — Final CTA should focus the textarea, not anchor to `#pricing`.
**N2** — State the report's shape ("typically 6–12 programs across 4 sections").
**N3** — Add the "why can't I just search this myself?" FAQ once there is a
true answer.
**N4** — Prefill the utility field from the ZIP.
**N5** — Offer a December/January re-check reminder for annual-cap timing.
**N6** — Align the visual restraint of the hero with `/closing` (§17).

---

## Scorecard

No composite score, as the brief directs. Each dimension stands alone.

| Dimension | Finding | Severity | Evidence | Recommended fix |
|---|---|---|---|---|
| Product promise | Sells a live program lookup that does not exist | **Critical** | Step 3 vs `navigator-engine.js:356`; `data/` holds no program corpus | §24 copy, or §26 step 9 corpus |
| Input workflow | One free-text box; state and ZIP never asked | **Critical** | `government-money.html:129`; `navigator-intake.js:197` | §5 nine-field form |
| Decision engine | No engine — a 219-word prompt | **Critical** | `PRODUCT_CONFIGS['government-money']` | §22 framework |
| Savings calculation | None exists; no total, no exclusion rules | **Critical** | No `key_numbers` discipline in the prompt | §22 DON'T-COUNT pass |
| CLAIM (keep) | Prose only; no concept of a gate being met | High | §6 | §22 |
| DON'T-COUNT (suspend) | Absent entirely | **Critical** | §8, seven unguarded traps | §22 rules F1–F7 |
| NOT-NOW (restart) | Absent; no state, no prior-submission comparison | High | `ENTITLED_PRODUCTS` excludes this product | §26 step 10 |
| Pricing | $39 buys less engineering than $29 does one page over | High | §9 table; free substitutes are better | **$19** now, $39 after a corpus |
| Customer value | Real for the mid case, thin for the low case, mis-aimed for the high case | High | §11 | Free snapshot + stacking analysis |
| Trust | Privacy and payment handling are strong; the page overstates knowledge | Medium | §12 | §24 trust copy |
| Copy | Four unsupported claims, two misleading | **Critical** | §13 | §24 |
| UX | Clean and fast; under-asks catastrophically | High | §14 | §25 structure |
| Design consistency | Two different design systems vs `/closing` | Low | §17 measured tokens | Line-wide migration, not this page alone |
| Conversion | No evidence of value shown before the ask | High | §15 | Free Eligibility Snapshot |
| Edge cases | Fifteen identified, all unguarded | **Critical** | §18 | §22 + §26 step 7 |

---

## 22. Recommended Decision Framework

Transparent enough to print in the report itself, which is the test. Four
stages, run in order.

### Stage 1 — Gate

Each program in the catalogue declares its gates as data, not prose:

```
{
  id: 'fed-efficiency-envelope',
  scope: 'federal',
  tenure: ['own'],
  requiresTaxLiability: true,
  qualifyingActions: ['insulation', 'windows', 'doors', 'air-sealing'],
  capKind: 'annual-aggregate',
  verifyWith: 'IRS Form 5695 instructions',
  asOf: '2026-01-01'
}
```

Each of the nine answers either satisfies a gate, fails it, or is unknown.
Three outcomes, and only three:

- **all gates satisfied** → CLAIM
- **any gate failed** → excluded, and named in the "ruled out" section with the
  gate that failed it
- **any gate unknown, none failed** → CHECK

There is no fourth bucket, and nothing is silently dropped. A customer who is
told *why* four programs were ruled out has learned as much as one who is told
about three that were not.

### Stage 2 — DON'T COUNT (the safety pass)

Runs after Stage 1 and **can only ever remove a figure, never add or raise
one** — the structural property that makes `/subscriptions` trustworthy. Seven
rules, each traceable to a trap in §8:

| Rule | Trigger | Effect |
|---|---|---|
| D1 | `requiresTaxLiability` and the customer answered "no" or "unsure" to field 6 | Figure suppressed; line reads "worth nothing to you this year unless your tax situation changes — here is why" |
| D2 | `capKind` is a ceiling and no cost was supplied | No figure at all; line states what governs the amount |
| D3 | Two or more CLAIM lines share an `annual-aggregate` cap | All their figures collapse to one capped figure, flagged as shared |
| D4 | A utility rebate and a federal credit hit the same `qualifyingAction` | Neither is counted; the line explains basis reduction and says to compute it in that order |
| D5 | The action is older than the customer's stated "already claimed" window | Moved to "you may already have this" |
| D6 | Program has no `asOf` within 18 months | Named without a figure, with the verify link promoted |
| D7 | Tenure mismatch survived Stage 1 for any reason | Line removed entirely |

**A total is printed only from lines that survive all seven.** Everything else
appears with a figure of "—" and a sentence. This is the `key_numbers`
discipline `/subscriptions` has and this product does not.

### Stage 3 — Time

For every excluded or CHECK line, ask whether a dated event changes it:

- an annual cap that resets on 1 January
- a planned purchase from field 8 that would open a gate
- an income band or household size change the customer flagged
- a funding cycle that reopens

Each produces a NOT-NOW line in the form *"not this year, because X; revisit on
DATE, because Y."* A NOT-NOW line without a date is not shipped.

### Stage 4 — Write-up

The model receives the decided lines and writes them up. It may not originate
an action, a figure, a program name or a date — the same contract `/closing`,
`/rental`, `/landlord`, `/subscriptions` and `/home-savings` already run under,
and the one thing that most reliably separates the products in this repository
that can be trusted from the one being audited here.

---

## 23. Recommended Pricing

**Current price:** $39 one-time

**Recommended price:** **$19.00 one-time**, today, for the honestly-scoped
product in §24 — rising to **$39.00 one-time** the day `data/
government-programs.json` and the Stage 1–2 engine ship

**Recommended pricing structure:** one-time, per report. Keep it. There is no
recurring work behind this product, `ENTITLED_PRODUCTS` correctly excludes it,
and the page correctly never promises a year. A subscription here would be the
`navigator-claims.test.js` violation this repository already wrote a test to
prevent.

**Reason, from the customer's side.** At $39 the deal asks a customer to pay
more than `/subscriptions` costs for an unaided model call on a task whose free
substitutes are *better than the product* — DSIRE, energy.gov, benefits.gov,
official form instructions, and any general chatbot. The honest deliverable is
narrowing, not data, and $19 prices narrowing correctly: Customer A (§11) goes
from a 1.2× return to 2.4×, which is the difference between a purchase that
feels like a gamble and one that does not; Customer B stays comfortably above
17×. Customer C is not served at any price by a discovery list and needs the
Stage 2–3 analysis.

$19 also restores the line's ordering — below `/subscriptions` at $29, which
runs twelve rules and five thousand test inputs — and that ordering is the
thing customers actually read when they visit two pages.

**Returning to $39 is earned, not assumed.** `/landlord` holds $149 because
`data/landlord-jurisdictions.json` exists and `navigator-claims.test.js`
enforces that the page never names a jurisdiction the file does not hold. The
same bargain applies here: a program corpus with a per-entry `asOf`, the Stage
1–2 engine, and a test that refuses to let the page name a program the corpus
does not contain. That is a $39 product. What is shipped today is a $19 one.

**The test the brief asks for** — *would a rational customer reasonably expect
to save more than the service costs?* At $39, for the honest version: only the
mid case clears comfortably. At $19: yes in every case except the customer who
qualifies for nothing, and that customer should be refunded (§24, §26).

---

## 24. Exact Replacement Copy

Ship-today copy for the product as it actually works. Every line below is
deliverable by the current engine without a single code change beyond the
price.

### Hero

**Headline**

> Which rebates and credits actually apply to you — and which don't.

**Subheadline**

> Answer nine questions about your household. You get a shortlist of the
> federal, state, utility and local programs your situation points at, why each
> one is on your list, what would disqualify you, and the official page to
> confirm the current amount on. Two minutes in, $19.

**Pill (replaces "Rebates and credits most people never claim")**

> Narrowing, not guessing

### How it works

> **1. Answer nine questions**
> State and ZIP, own or rent, household size, income band, whether you expect
> to owe federal income tax, and what you've bought or installed recently.
> About two minutes.
>
> **2. Pay $19**
> One flat price, one report. Nothing renews.
>
> **3. Your answers are matched against how these programs work**
> Federal, state, utility and local categories, checked against your situation.
> We do not hold a live program database and we do not look up today's dollar
> amounts — see below.
>
> **4. You get a shortlist, with a source for every line**
> What each program is, why your answers point at it, what would rule you out,
> and the official page to confirm the current amount and deadline yourself.

### What you get

> ✓ A shortlist of the programs your situation points at — federal, state,
>   utility and local
> ✓ One sentence per program tying it to something you actually told us
> ✓ What would disqualify you, before you spend an evening on it
> ✓ The official source to confirm each program's current amount and deadline
> ✓ **The programs we deliberately left off your list, and why**
> ✓ What we could not determine from what you told us

### Price card

> **Government Money Shortlist**
> A personalised shortlist of the programs your household is most likely to
> qualify for, with the official source for each.
>
> **$19/report** — one-time payment
>
> ✓ Federal, state, utility and local programs
> ✓ Plain-English next steps for each
> ✓ The ones ruled out, and the reason
> ✓ Delivered automatically, usually within a couple of minutes

**CTA button**

> Get my shortlist →

### Pricing explanation (below the card)

> $19, once. Nothing renews and there is no account.
>
> For this to be worth buying it has to find you one thing you would have
> missed — a $250 utility rebate covers it thirteen times over. If your answers
> point at nothing worth acting on, the report says so in the first line, and
> you'll know in two minutes instead of two weekends.

### Input instructions

**Above the form**

> Nine quick answers. Every one of them changes which programs can apply to
> you, which is why we ask rather than guess.

**Free-text field label and hint**

> Anything else we should know? *(optional)*
> A recent purchase, a life change, something unusual about your home. The nine
> answers above do most of the work — this is for what they missed.

**Upload hint**

> Recent purchase receipts or utility bills help. PDF, JPG, PNG or WEBP · up to
> 50MB per file, 150MB total.

### Results explanation (new section, above the price card)

> **What the report looks like**
>
> It opens with two numbers: how many programs your answers point at, and how
> many we ruled out. Then every program in turn — what it is, why you're on the
> list for it, what would disqualify you, the order to do things in if it
> interacts with another program, and the official page to confirm the current
> amount.
>
> It closes with what we couldn't determine, which is not padding: a program we
> can't rule in or out is a program you should know to check yourself.

### Trust / privacy

> **What we never ask for**
>
> No logins. No account access. No bank connection. We never ask for a Social
> Security number, a tax return, or a password — this works entirely from what
> you type into the form. Stripe handles payment; we never see your card.
> Anything you upload is deleted after 90 days.
>
> We don't file anything for you and we never contact an agency on your behalf.
> You stay in control of every claim.

### FAQ (replacing all four)

> **Why can't I just search for this myself?**
> You can, and for one specific program you probably should. What takes the
> time is the other direction — working out which of hundreds of programs are
> even worth reading about, given that you rent, or that you'll owe no federal
> tax this year, or that you've already used this year's cap. That narrowing is
> what you're buying. The confirming you still do yourself, and we give you the
> page to do it on.
>
> **Will you tell me exactly how much I'll get?**
> No, and anyone who does is guessing. Most of these figures are ceilings
> computed from what you actually spent; several are non-refundable credits
> that are worth nothing to a household with no tax to offset; and a utility
> rebate often reduces the amount a federal credit is calculated on. We tell
> you which programs apply, what governs the amount, and where to compute it.
>
> **How current is this?**
> Not live, and we won't pretend otherwise. This runs on general knowledge of
> how these programs work — which has a cutoff and is not guaranteed to match
> today's rules. That's exactly why every program on your shortlist comes with
> the official page to confirm the current amount, eligibility and deadline.
> Treat our figures as "worth checking", never as "what you will get".
>
> **Do you file the claims for me?**
> No — you get clear, step-by-step instructions for each program, but you (or
> your tax preparer) submit the actual claim.
>
> **What if I don't qualify for anything?**
> The report says so in the first line, and lists what was checked and why each
> one was ruled out. If there's nothing on your report worth acting on, reply
> to the delivery email and we'll refund it.

### Final CTA

> **Find out in two minutes what's worth your evening.**
> Nine questions, $19, and a shortlist with a source for every line.
>
> [Start my shortlist]  ← focuses the form, does not jump to the price

### Lines to delete outright

| Line | Why |
|---|---|
| "Find the money the government already owes you." | Nothing is owed until a claim is filed (§13 P1) |
| "AI searches current programs" | No search occurs (§13 P3) |
| "Each report is generated fresh using current program information at the time of purchase" | False of the inputs (§13 P8) |
| "Estimated dollar value of each program" ×2 | The engine is instructed not to produce one (§13 P6) |
| "Deadlines or windows you shouldn't miss" | Same (§13 P7) |
| "most households qualify for at least one program they didn't know about" | Unsupported population claim (§13 P9) |
| "A personalized list, not a generic database dump." | Invites a comparison this product currently loses (§16) |
| "There's a good chance you're leaving money unclaimed." | An assertion about the reader, not the product |

---

## 25. Recommended UI Structure

The two structural changes are that **the form moves above the price**, and
**the first result is free**.

1. **Hero** — headline, subheadline, one line of method
2. **The nine-question form** — no email, no payment, no commitment
3. **Free Eligibility Snapshot** — appears in place on submit: *"Your answers
   point at 7 programs across 4 categories, and rule out 3."* Category names
   shown. Program names, amounts, ordering and claiming instructions withheld.
4. **What the full report adds** — the six bullets from §24
5. **Price, email, optional upload, CTA** — $19, pre-filled from step 2
6. **What the report looks like** — the results explanation from §24
7. **How it works** — the four steps, moved below the form (a visitor who has
   already used the form does not need them first)
8. **What we never ask for** — the trust block, elevated out of the footer
9. **FAQ**
10. **Footer disclaimer** — unchanged; it is already correct

The snapshot is the whole conversion argument. It costs nothing to run (Stage 1
is deterministic — no model call), it proves the product does something
specific to *this* visitor before asking for money, and it answers "how much
might I save" with a count rather than an adjective. It is the same trade
`/closing` already makes and wins on.

---

## 26. Implementation Plan

### Fix Immediately — this week, no new engine required

**1. Copy rewrite.** Apply §24 to `government-money.html` in full. The eight
deletions in §24's final table are the non-negotiable part; the rest is the
replacement that keeps the page selling something.

**2. Reprice to $19.**
   a. Stripe → Product catalogue → new one-time price $19 on the existing
      "Government Money Finder Report" product.
   b. Payment links → New → that price → "After payment" redirect to
      `https://streamnavigator.ai/navigator-status`.
   c. Put the new URL in `government-money.html:154` and its plink id in
      `prices.config.json` → `pages["government-money.html"].stripeLinkId`,
      and set `expectedPriceCents` to `1900`.
   d. Deactivate the $39 link `00w14n0NS6UkdsEa80abK08` in Stripe, and add it
      to `unreferencedActiveLinks` with a reason until it is deactivated —
      the same discipline the retired $49 `/subscriptions` link is under.
   e. `npm run check-prices`.

**3. Extend `tests/navigator-claims.test.js`.** Three new assertions, so the
rewrite cannot drift back:

```js
test('no page sells a live program lookup nothing performs', () => {
  // data/ holds no program corpus and nothing in vercel.json refreshes one.
  const claim = /searches current|current program information|live (?:program|incentive) (?:database|data)|checks? (?:today|current) (?:amounts|rules)/i;
  // ...same visible()/offenders shape as the tests above
});

test('government-money.html never promises a figure the engine refuses to print', () => {
  // HONESTY_RULES forbids "the name and current dollar amount of a specific
  // government program"; the page must not sell one.
  const forbidden = [/estimated dollar value/i, /deadlines? or windows? you shouldn't miss/i];
});

test('no page makes an unsourced population claim', () => {
  const claim = /most (?:households|people|customers) (?:qualify|save|get)/i;
});
```

**4. Delete the dead category code.** `government-money.html:266–273` and the
`selectedCategory` variable; `formData.category` becomes `null` explicitly or
is dropped from the payload. The `navigator-engine.js:729` branch stays — other
products may use it.

**5. Upload copy.** Add WEBP to `government-money.html:139`.

**6. Final CTA.** Change `href="#pricing"` to a handler that scrolls to and
focuses `#intake-description`.

### Fix Next — two to four weeks

**7. The nine-field form (§5).** New `navigator-government-money-engine.js` at
the repository root, beside `navigator-subscription-engine.js` and
`navigator-home-savings-engine.js`, for the same stated reason: it is required
by the API *and* served to the browser, so the check that lets a customer pay
and the check the server enforces are one file rather than two copies that
drift. Export `checkGovernmentMoneySufficiency(formData)` returning
`{sufficient, missing[]}`. Require state, ZIP, tenure, household size, income
band and the tax-liability answer. Wire it into `api/navigator-intake.js` as a
new `else if (product === 'government-money')` branch alongside the existing
four, and into the page's own button handler.

**8. Stages 1–3 of §22.** Catalogue as data with declared gates; the
DON'T-COUNT pass as a function that can only remove; the time pass. Model
demoted to writer, with the `/subscriptions` prompt's hard rules ported almost
verbatim — *never state a figure not in the decisions you were given; never
change an action; carry the kind through; reproduce every date exactly.*

**9. The test that makes it real.** `tests/government-money-engine.test.js`,
enumerating every combination of the nine answers (tenure × income band ×
liability × the action checklist is a few thousand cells) and asserting that
**not one** produces: a counted figure where D1 fires, an owner-only program for
a renter, two lines double-counting one aggregate cap, or a NOT-NOW line
without a date. `/subscriptions` proved the value of this: "an example test
would have caught the three cases somebody thought of."

**10. The free Eligibility Snapshot (§25 step 3).** Stage 1 only, client-side,
no model call, no cost.

### Later — does not block anything above

**11. `data/government-programs.json`.** Federal programs, 50 states, the
largest ~40 utility territories by household count. Per entry: `id`, `scope`,
gates, `capKind`, `verifyWith`, and an **`asOf` date** — the field that makes
staleness visible instead of invisible. Plus a claims test refusing to let the
page name a program the corpus does not hold, exactly as
`navigator-claims.test.js` already does for landlord jurisdictions. **Ship this
and the price goes back to $39 honestly.**

**12. Re-check.** `resolvePriorGovernmentMoney()` on the model of
`resolvePriorLandlord()`, plus a January reminder for annual-cap timing. This
is what finally makes the NOT-NOW verb worth what it should be.

**13. Null-result refund.** The copy in §24's last FAQ commits to refunding a
report that finds nothing actionable. `api/process-refunds.js` already exists;
this needs a self-serve claim path and a cap. **Exposure to state plainly
before shipping it:** at $19 with a Stripe fee that is not returned, each
refund costs roughly $19.60 all-in, so a 10% claim rate costs about $2 per
report sold. It is worth it — the promise is what makes the honest version
buyable — but it should be a decision taken with the number in view, not a
sentence that slips in with the copy.

---

## 27. Final Customer-Value Assessment

**Does `/government-money` deliver meaningful customer value at a reasonable
price today? No — and the reason is a sentence, not a subsystem.**

The page sells a search against current program data. The engine behind it has
no data and performs no search, says so in its own prompt, and is explicitly
forbidden from producing the three deliverables the page charges for. A
customer pays $39 on the strength of "AI searches current programs" and
receives a careful, well-hedged general-knowledge summary that the same model
would give them free, without the nine facts that would have made it specific
to them, because the form never asks for those facts. One character reaches
that checkout.

**But the distance to a good product is short, and most of it is subtraction.**
Delete eight sentences, move the price to $19, and the page becomes honest by
the end of the week — still thin, but no longer selling something it does not
have, and priced where a thin-but-honest narrowing service belongs. That alone
converts the worst finding in this report from a truthfulness problem into a
scope problem.

**The real product is visible from here, and this repository has already built
it four times.** `/closing` decides with 28 checks. `/landlord` decides against
a held jurisdiction file. `/subscriptions` decides with twelve rules and, more
importantly, three refusals — and its authors wrote down why: *on the lines
they cover, the obvious answer is the one that costs the customer money.* That
is exactly true here, and sharper. The obvious answer for a household with no
tax liability is "you qualify for a $2,000 credit". The correct answer is "that
is worth nothing to you this year, and here is what to do about it." Nothing in
the current system can tell those apart.

Nine questions, a gated catalogue, a safety pass that can only remove, and a
model demoted to writing it up. That product is worth $39, is defensible in
public, and is built out of parts already sitting in this repository. The one
being sold today is worth $19 at most, and only after the copy tells the truth.

---

## 28. What shipped, and what is still open

The Fix Immediately block (§26) shipped on 2026-09-19, the same day as the
audit. Two items from Fix Next came with it, both noted below with the reason.

### Shipped

| # | Change | Closes |
|---|---|---|
| 1 | `government-money.html` rewritten on the copy in §24 — the eight deletions and their replacements | C1, C4, I3, I6, and §16 |
| 2 | Price moved to **$19**, button href is the literal `REPLACE_WITH_19_ONE_TIME_LINK`, page says so, `prices.config.json` moved to `_skipped` with the reason, $39 link listed for deactivation | §23 |
| 3 | `PRODUCT_CONFIGS['government-money']` rewritten: authority on every line, a ruled-out section, no program figure in `key_numbers`, and the four DON'T-COUNT rules as prose | the page↔prompt contradiction behind C1 |
| 4 | `navigator-government-money-engine.js` + a branch in `api/navigator-intake.js` — a place is required before checkout, enforced in one file loaded by both | **C2** (Fix Next item 7, pulled forward) |
| 5 | Dead `.category-chip` handler deleted; `formData.category` no longer posted | I2 |
| 6 | Upload copy names WEBP; final CTA focuses the box instead of jumping to the price | I8, N1 |
| 7 | Migrated to `navigator-editorial.css` and the `/closing` chrome | §17, as corrected |
| 8 | `tests/government-money-page.test.js` (19 assertions) and three line-wide assertions in `tests/navigator-claims.test.js`, which now also covers pages parked in `_skipped` | **C5** |

Item 4 was pulled forward out of Fix Next because it is C2, the second-worst
finding, and because shipping honest copy over a checkout a single character
can reach is half a fix. It is the *gate* only — the nine structured fields
are still Fix Next. Item 7 came with the rewrite because nearly every line of
copy was being replaced anyway, and doing the migration separately would have
meant touching the same lines twice.

### Verified

- Full suite: **77 of 77 passing**. `npm run check-prices`: all 10 remaining
  priced pages consistent.
- Rendered locally and measured: design tokens match `/closing` on every row
  of §17's table; no console errors; no horizontal overflow at 1280px or at
  375px, where `.tell` collapses to one column.
- The placeholder guard refuses to navigate and says why on the page.
- The gate refuses `"We own our home and had a heat pump installed last year."`
  with `missing: ['state']`, focuses the box, and creates no submission.

### Still open

- **C3, the phantom-money guard, is prose, not code.** The four DON'T-COUNT
  rules live in the prompt and are enforced by instruction. They become a pass
  that can only remove a figure when Stage 2 of §22 ships, and only then is
  the test in §26 item 9 possible.
- **The nine structured fields** (§5). The page now *asks* for all nine in a
  labelled list beside the box, and the free-text answer is all the engine
  gets. Six of them still cannot be gated on, because free text cannot be
  parsed for them honestly.
- **The free Eligibility Snapshot** (§25 step 3), which needs Stage 1.
- **`data/government-programs.json`** — and with it the return to $39.
- **The null-result refund** is now promised in the FAQ and the price block.
  The exposure is stated in §26 item 13 and the self-serve path is not built;
  today it is honoured by replying to the delivery email.
- **The Stripe link itself.** Checkout is switched off until somebody creates
  the $19 Payment Link. Until then this page takes no money at all, which is
  the correct state for a page whose old link charges twice what it says.

---

## 29. Fix Next and Later, shipped — and a correction to §23

Everything in §26 shipped on 2026-09-19 except one item, which was deliberately
not built; the reason is at the end.

### A correction to §23's pricing recommendation

**§23 recommended $19 and it was wrong by the end of the day — not because the
reasoning was wrong, but because the conditions it set were met.**

The exact words were: *"$19 today, $39 when data/government-programs.json and
the Stage 1–2 engine ship"*, and the reasoning was that the $39 was for a
219-word prompt with no engine, no catalogue and no test. All three conditions
shipped within hours:

- `data/government-programs.json` — 28 programs, each declaring its gates and
  the authority that can confirm it, with a per-entry `asOf`;
- `navigator-government-money-engine.js` — the four stages of §22, including a
  safety pass that can only lower a verdict;
- `tests/government-money-engine.test.js` — 10,368 combinations of every
  answer a customer can give.

So the price is **$39**, unchanged, and the practical consequence is the best
one available: **the $19 Payment Link was never created, the original link was
never retired, and there is no Stripe action outstanding.** This is the
`landlord-stays-at-$149` pattern exactly — the audit's lower number was for the
unfixed product, and the conditions attached to the higher one are what make it
honest.

### What shipped

| # | §26 item | What it is |
|---|---|---|
| 7 | Fix Next | **The nine-question form.** State, ZIP, tenure, household size, income band, federal tax liability, work done, work planned, life events — plus an already-claimed answer and an optional utility name. Five are required; the two checklists distinguish an empty answer from a skipped question, which the engine relies on. |
| 8 | Fix Next | **Stages 1–3 of §22.** Gate → DON'T-COUNT → time. The model is demoted to writer, under the same contract `/closing`, `/rental`, `/landlord`, `/subscriptions` and `/home-savings` run: it may not originate a program, a verdict, a date or an amount. |
| 9 | Fix Next | **The combinatorial test.** 3 states × 2 tenures × 6 income bands × 3 liability answers × 3 already-claimed answers × 8 work sets × 4 event sets × 3 planned sets = **10,368 customers**, each asserted against D1, D3, D4, D5, tenure, the state income-tax gate, the income screen, the dated-NOT-NOW rule, and the demote-only invariant. |
| 10 | Fix Next | **The free Eligibility Snapshot.** Stage 1–3 run in the browser with no model call and no network request. Counts, scopes and interaction flags; never a program name. |
| 11 | Later | **The catalogue** — see below for what it deliberately does not hold. |
| 12 | Later (part) | **The re-check.** A second report under the same email is compared with the first and leads with what *opened* and what *closed*. |
| 13 | Later | **The null-result refund, made automatic.** |
| I7 | Important | The page now says plainly that a utility is not the government, and why they are included anyway. |
| N2, N4 | Nice to have | The report's shape is described before the ask; the utility is asked for by name. |

### The one design decision worth stating on its own

**The catalogue holds no amounts.** No dollar figures, no percentages, no caps,
no income thresholds, no deadlines — and `tests/government-money-engine.test.js`
fails if a `$` or a `%` ever appears in the file.

This was not caution. A held figure goes stale *silently*, which is the audit's
own central finding moved from a prompt into a JSON file and made harder to
see. What the catalogue holds instead is the part that changes on a timescale
of years: who a program is for, what it is gated on, which programs interact
with it, and who administers it. That is enough to decide every line. The
amount is then confirmed by the customer, at the authority printed on that
line.

It also has a consequence worth naming: **the writer physically cannot state a
figure from the data it is given.** §13's four unsupported claims were closed by
rewriting copy, which is an instruction. This closes them structurally.

`tests/navigator-claims.test.js` was tightened to match: a corpus existing no
longer licenses a page to claim it checks current amounts. Only a corpus that
declares `holdsCurrentAmounts: true` does, and none does.

### The automatic refund, and the line it is drawn on

A report where **nothing at all** comes back — no shortlist *and* nothing worth
confirming — queues its own refund at generation time, onto the same
`due_thin_result` queue Contractor Navigator has used since it started
refunding thin document sets. The customer keeps the report and does not pay
for it, and nobody has to ask.

The trigger is deliberately **not** an empty shortlist alone. A report with no
claims but eight lines worth confirming is a report that did its job. That case
remains the promise the page makes in words — reply to the delivery email — and
is a judgement call rather than something code can detect honestly.

### What was deliberately not built

**The January re-check email (§26 item 12, second half).** `api/rental-reminders.js`
and `api/landlord-reminders.js` exist as precedent, but both belong to products
with an entitlement the customer bought. `/government-money` has none, and its
page says plainly that nothing renews and there is no account. Mailing past
customers in January would be an unsolicited send that contradicts the page —
and `tests/navigator-claims.test.js` exists precisely to stop a page selling a
recurring relationship the code does not grant. The dated lines are in the
report itself instead, and the FAQ explains what a second report gets compared
against.

### Verified

- **79 suites pass** (two new: the engine and the page contract).
  `npm run check-prices`: **11 of 11** pages consistent, `Government Money
  Finder $39 link ok`.
- Driven live in the browser at 1280px and 375px: catalogue loads, 57 places,
  28 programs considered, no console errors, no horizontal overflow, every grid
  collapsing correctly on a phone.
- D1 visible in the free scorecard: a Texas household with a heat pump and no
  federal tax liability gets "Nothing fits outright" rather than a credit it
  cannot use.
- The gate refuses a half-filled form by naming the missing dropdown, and
  creates no submission. One bug was found this way and fixed: a submission
  with structured answers but an empty state box was being routed down the
  legacy free-text path and told to "tell us about your situation" instead of
  being told which dropdown was empty. It has a regression test.

### What is still open

- **The catalogue is 28 programs and general-purpose.** It holds no
  state-specific program lists beyond the one genuinely decisive state fact —
  the eight states with no individual income tax. Adding real per-state
  programme sets is the next meaningful increase in value, and the claims test
  is already in place to stop the page naming one the file does not hold.
- **No utility territory data.** The customer types their utility's name; the
  ZIP is collected but nothing maps it yet.
- **Cost is still not collected**, so nothing can be said about how a cap
  binds in a particular case — only that one applies and what governs it.
