<!-- Generated 2026-06-27 by a 109-agent design workflow (rollout-extraction-design).
     Diverge(12 lenses) -> cluster -> adversarial 3-lens verify(trust/feasibility/impact) -> synthesize.
     72 raw concepts -> 26 unique -> 30 verified, 0 killed on fatal trust flaws. -->

# Rollout Visualizer: A Trustworthy Information-Extraction Redesign

## Executive summary

A reward-seeking safety researcher faces thousands of rollouts × hundreds of environments × many training steps × multiple experiments in S3, and cannot read them. Today rollout_viz answers almost none of their real questions: the entire aggregate layer is four inert charts over reward and step only (grades — the one content signal — never reach it), the pie/bar truncate to top-8/top-10 with no notice, all search is literal substring, the deep-read viewer shows one rollout at a time, and grading silently center-truncates transcripts at 50k chars while persisting none of that. The redesign's single organizing principle: **every number, label, or claim must drill in one click to a verifiable source span, carry its denominator and uncertainty, visibly distinguish deterministic ground truth from model interpretation, and disclose what it could not see.** We ship a deterministic quote-grounding firewall as the trust substrate first, then an honest taxonomy-aware aggregate layer, a reward-vs-independent-success hack surface sourced from the *existing auto_eval verifier* (not re-graded by an LLM), a cross-step heatmap and same-task reader gated on a *measured* prompt-hash join, a deterministic anomaly inbox, and an evidence-bundle export — in a sequence where the trust primitives land before anything that aggregates model output.

---

## 1. The core problem & the trust thesis

The corpus is whole-eval JSONL dumps in S3 (`…/oss_all_envs-eval/2026-06-27/step_0.jsonl` = many environments, one training step; siblings `step_0..N` span a run). The researcher arrives with questions the app cannot answer: *"did the model learn to hack `reward_check_function`, and is that rate rising from step_0 to step_40?"*, *"which environments regressed while the mean improved?"*, *"did it sandbag only when `is_validate=true`?"*, *"what's in here I didn't think to look for?"*

Every surface today operates on **one whole-file load, entirely client-side**:

- **The aggregate layer is four inert charts** (`AnalysisView.tsx`) over reward and step only. Grades — the only signal that reads transcript *content* — never reach aggregation. The pie truncates to top-8 and the bar to top-10 **with no notice**; with hundreds of environments most of the corpus is silently invisible. The `data_source` taxonomy is reduced to its leaf via `.split('/').pop()`, discarding the structure that *names the exploit under test*. No chart is clickable; there is **no path from any aggregate back to a raw rollout**.
- **All search is literal substring.** To find "the model fabricated a passing test" you must already know the phrase. The filter mini-language silently swallows parse errors (`catch {}`), so a typo'd filter returns *everything* — a trust hazard wearing the mask of a clean result.
- **The deep-read viewer shows one rollout at a time.** Comparing a task at two steps means opening rollouts one by one and holding the diff in your head.
- **Grading — the only content-signal generator — silently center-truncates at 50k chars** (`_MAX_TRANSCRIPT_CHARS`, confirmed L311), per-channel-elides thinking to 4k and tool-args to 1k (`_cap_with_elide`), and **persists none of it**. Unlocatable quotes are **silently dropped** and, worse, the matcher tries the cited channel then **falls back through every other channel** (confirmed L1104-1136: `channel_order = [raw_channel] + [all other channels]`), so a hack admitted in `thinking` is laundered into a `text` "mention" and stamped located. On the final attempt a grade with zero supporting quotes is saved anyway. No record exists of which *population* a grading run covered.

**The trust thesis.** The user's constraint is uncompromising: *"the only thing that matters is giving the user ALL important information in a TRUSTWORTHY manner."* LLM grades and LLM chat hallucinate. So:

> **Every number, label, cluster, or claim the researcher sees must be (a) traceable in one click to a verifiable source span — `message_index` + channel + exact quote re-located against the raw message; (b) accompanied by its denominator and its uncertainty; (c) visibly distinguished as deterministic ground truth vs. model-generated interpretation; and (d) honest about what it could not see (truncation, sampling, composition). An aggregate the researcher cannot drill, falsify, and audit is worse than no aggregate — it manufactures false confidence at scale.**

The codebase has the *seed* of the primitive — `_find_whitespace_normalized` re-locates a quote — but it is an unanchored first-match `re.search` with cross-channel fallback. The redesign **hardens that primitive and propagates its verdict up into every aggregate**, while building the cross-file/taxonomy/temporal surfaces the app structurally lacks. And it does not re-grade what the monorepo's **auto_eval harness already verifies independently** — that pipeline is a reward-independent trust source we route to, not around.

**A scope honesty note up front:** every temporal surface below surfaces *correlated* change for human attribution. We **do not claim causality.** "Masked regression" and "the cliff at step N" name *what co-moved*; the researcher attributes *why*.

---

## 2. Trustworthiness design principles (non-negotiable)

Rules, not aspirations. Every feature obeys all of them. Anti-patterns are drawn from where review found concepts that would *manufacture* false confidence.

**P1 — Provenance or it didn't happen.** Every model-generated claim renders **with the verifiable spans behind it**, and the UI separates *"the cited quote exists in the cited message+channel"* (**CITATION-VERIFIED**) from *"the claim is true"* (**CLAIM — unchecked**) — two badges, never collapsed into one. *Anti-pattern:* a green check that only means a fuzzy substring matched *somewhere*, or that certifies a real quote ("I will NOT hack the reward") as support for `grade=hacked`.

**P2 — n and uncertainty on every number, with the right interval and honest independence.** No bare rate, no bare mean. Rates get **Wilson/Jeffreys intervals** (correct at 0%/100% and small n); reward (a clipped, multimodal, floored variable) gets a **bootstrap/SE interval or a distribution sparkline, never Wilson**. **Crucially, trials are not independent:** multiple rollouts of the *same prompt* are correlated draws (in the real data, 112 rollouts in one `data_source` sit behind 7 prompts). A naive Wilson over `k/n` that double-counts a prompt is **too narrow — manufactured precision, the exact sin we rail against.** Therefore rates are **cluster-aware**: group by prompt-hash and report either a design-effect-inflated CI or, at minimum, *"CI assumes independence; within-prompt correlation makes it optimistic — n_prompts = X."* *Anti-pattern:* a confident average over a `-5.0`-saturated environment; a Wilson CI on a continuous reward delta; a tight binomial CI over correlated within-prompt repeats.

**P3 — Drill-down is mandatory.** Every aggregate cell, bar, point, and rate is **one click from the exact raw rollouts at the exact message/channel/span**. Drill-down routes through a **stable identity** (§roadmap item 0), never the injected `id` (confirmed reassigned by `enumerate()` on every load, L1227).

**P4 — Verified-vs-claimed labeling, always visible.** Deterministic fields (`reward`, `data_source`, `step`, `is_validate`, parsed counts) and model-derived signals (LLM grades, embeddings, cluster labels) get **persistent, screenshot-surviving, colorblind-safe textual badges** — never a line-style or color the eye loses in a dense chart. *Anti-pattern:* "dashed = model-derived, solid = deterministic" in a streamgraph.

**P5 — No silent truncation; denominators are honest.** Persist `truncated` / `original_len` / a **per-channel elision map** onto every grade, and compute coverage against the **true raw length before per-channel elision** — computing it from post-elision `len(combined)` would *certify* a gutted transcript as fully read. Every search/aggregate states **"X of Y scanned"** and names *which* set (loaded file ≠ corpus). *Anti-pattern:* "scanned 8,041/8,041" that silently means one step of one experiment.

**P6 — Composition guards on every comparison, on a *measured* join key.** Any cross-step/experiment/file comparison computes the **set-difference of environment membership and per-cell n**, and refuses to draw a delta (explicit "incomparable" glyph) when populations don't match. Cross-step joins use a **content prompt-hash**, not `rollout_n` (confirmed: a flat 0..767 per-file counter; `sample_index` ≡ 0; the code itself admits `(rollout_n, step)` is non-unique, L528). **The hash yields 46 distinct identities *within* the one available file — but cross-file recurrence is unverified because no sibling step file exists yet.** So the prompt-hash is the **candidate** join key; its cross-file recurrence rate is a **measured gate** (§roadmap), not an assumption. *Anti-pattern:* a "same task at step_0 vs step_40" that aligns on `rollout_n` and shows two unrelated prompts as one task evolving.

**P7 — Negative-class inspectability.** Every "find all X" pairs with "show what was excluded / called not-X," and every threshold/brush **records the rule** so a rate is never a function of an unrecorded human choice. *Anti-pattern:* a kNN set or brushed region promoted to a filter with no record of anchor/threshold.

**P8 — Channel is evidence, and channel attribution is fallible.** thinking vs text vs tool_call vs tool_result carry different evidentiary weight; searches, aggregates, and verification are **channel-aware and label which channel**. Channels are *reconstructed* from `<think>`/ChatML/Harmony markup (the data has 2095 open vs 1373 close `<think>` tags — unclosed reasoning leaks across channels), so attribution is treated as **derived/fallible**. Searching "raw" content removes the *truncation* blind spot but **not** the *channel-attribution* blind spot — it relocates it. *Anti-pattern:* a verifier that silently relocates a "thinking" quote to "text" and stamps it grounded.

**P9 — Reproducibility & version honesty.** Persist grader **model + a content-hash prompt_version + sampling params** on every grade. Confirmed today: `prompt_version` is the literal `"model-router-v1"` in one path and `"v1"` in four others (L1177, 1321, 1372, 1433, 1497), and `model` is `model_router:{provider}:{model}` — so two genuinely different rubrics are indistinguishable. Aggregates refuse to silently pool across grader versions. Saved investigations record the exact files + etags they ran over.

**P10 — Schema evolution is non-destructive and legacy-honest.** Every new field on `GradeEntry`/quotes (verification, truncation, population) follows one rule: **a legacy grade lacking the field renders as an explicit "unknown," never a default that reads as a value** (never "0 truncated" the data can't back). `save-graded` is append-only merge; re-verification is **transient and non-destructive** unless explicitly persisted. This is a cross-cutting principle, not a per-feature footnote.

---

## 3. The flagship designs

Seven, in dependency order. Each rides on the trust primitives the earlier ones establish.

### Flagship 1 — Quote-Grounding Firewall (the trust substrate everything stands on)

**Job:** H (can I believe the grades?) and a **prerequisite** for A–G. Nothing model-written is displayed or counted without a machine-checked grounding status.

**How it works.** A deterministic verification stage runs on **every grade quote**, at save time and as a re-scan over existing `viz/` files. For each quote it re-runs channel decomposition for `messages[message_index]`, attempts relocation **in the cited channel only**, and persists a status: `verified_exact` / `verified_normalized` / `relocated_other_channel` / `ambiguous` / `not_found` — plus a grade-level `truncated_unverifiable` for quotes whose source region fell in the elided/center-truncated span the grader actually saw. A three-state badge (green/amber/red) renders on **every grade chip, every grade column cell, and — critically — every aggregate**, which shows the grounding mix of its underlying grades: *"hack rate 31% — but 12% of contributing grades are red, 8% truncated."* A corpus "Grounding Health" panel reports grounded-rate per `metric × model × prompt_version` with n + CI and links each ungrounded grade to the message where its quote was not found.

**The two badges never collapse (P1).** **CITATION-VERIFIED** (the string exists at the cited location) is orthogonal to **CLAIM-SUPPORTED** (the quote actually supports the grade — unchecked by the firewall). A green citation badge over "I will NOT hack the reward" cited for `grade=hacked` is *correct* about the string and says *nothing* about the claim; the UI states exactly that.

**Hardening the existing primitive.** Match in the **cited channel only** (kill the L1105 cross-channel fallback that launders a thinking-admission into a text-mention — `relocated_other_channel` becomes a *flag*, not a silent success); reject matches shorter than a minimum distinctive length; flag multi-occurrence matches as `ambiguous` instead of taking `re.search`'s first hit. **Stop dropping unlocatable quotes**; persist them as `not_found`. Verify against the **grader-visible bytes** using the persisted elision/truncation map.

**Two never-collapsed verification targets (reconciling the load-bearing detail).** Run **both**: (1) relocate against **raw `messages[message_index]`** (catches the grader citing text it never saw — false provenance); (2) check whether the cited span fell inside the **elided/truncated region** the grader saw (catches false-reds at truncation boundaries). The status encodes both axes: a quote found in raw but inside an elided span → `truncated_unverifiable` (not red); a quote not in raw at all → `not_found` (red). This resolves the apparent tension between "verify against raw" and "verify against grader bytes" — **do both; the elision map disambiguates.**

**Why it's trustworthy.** Deterministic and reproducible — red badges are an automatic hallucination detector no LLM wrote, stamped immutably with offsets, itself auditable. Aggregates **inherit** groundedness, so a chart literally cannot hide that it rests on ungrounded claims.

**Calibrate before you trust — and flag the calibration set's limits.** Run the re-scan over the existing 763-grade `viz/sample_rollout_traces.jsonl`, hand-audit a sample of reds into {true hallucination / formatting artifact / paraphrase / channel-boundary}, and **tune the matcher to the measured false-positive rate before propagating to aggregates.** But state plainly: that twin is **one metric (`safety`), one model, one prompt_version, one step** — the measured FP rate is a **floor, not a guarantee** for the rubrics/models the firewall will later police. Re-calibrate as new metrics arrive.

**Effort:** M. Pure Python, deterministic, no embeddings/index. Two independent wins ship first: (1) at grade *creation*, stamp `match_kind` in `_normalize_quotes` (it already branches exact-offset vs `str.find` vs whitespace); (2) at viz *load*, re-match every stored quote, return a transient per-quote `verification`. **Dependency note:** "verify against grader-visible bytes" needs the persisted elision map from the Truncation Watermark (§4) — so a **raw-verify v0 ships NOW**, the grader-byte-accurate v1 lands once that schema field exists (both in the NOW phase; see roadmap).

---

### Flagship 2 — Taxonomy Ledger & Hack-Surface Sonar (the honest aggregate layer)

**Job:** A (hack base rates), C (violation rates), D (per-env rates) — replace the truncating top-8/top-10 pie+bar with an **exhaustive, uncertainty-bearing, taxonomy-aware** per-environment summary, and bring **grades into aggregation for the first time**.

**How it works.** An indented, expandable **tree-table** keyed on the `data_source` taxonomy (family → … → leaf). Per node: **n** *and* **n_prompts** (distinct prompt-hashes — the real independent unit); **reward** as a **floor-aware mini-distribution sparkline with an explicit `==-5.0 floor: 47%` badge**, never a bare mean — and **no bootstrap mean-CI at all for nodes above a floor-saturation threshold** (a bootstrap over 84%-at-−5.0 yields a degenerate near-zero-width interval around a meaningless point; it shows "no meaningful central tendency — see distribution" instead); and, for any selected grade metric, `grade=true` as **`k/n` with a cluster-aware Wilson CI** (P2 — design-effect from n_prompts, or an explicit optimism flag). CI width drives cell desaturation, but **n, n_prompts, and the numeric interval are always printed** (color is secondary). A persistent denominator banner: *"showing 768 of 768 in this file (step_0, experiment X); sibling step files exist in this prefix, not loaded."* Row click cross-filters the LeftPanel via a `data_source contains <prefix>` condition (**not** the silently-failing mini-language); every metric cell drills to contributing rollouts, then to the cited span.

**Grade-trust is a first-class column.** Each grade-rate cell shows, via Flagship 1, *"k/n (CI) — v of k quotes citation-verified"*, **segments by `model + prompt_version`** (never pooling graders — P9), and badges nodes whose contributing rollouts were truncated. Ungrounded-heavy nodes are visibly desaturated and asterisked.

**Parent-node reward is per-leaf, never blended.** Non-leaf nodes blend incomparable child reward scales (each leaf often names its own reward function), so a parent shows the **per-leaf breakdown + floor-aware sparkline**, and a parent CI only when child scales are demonstrably comparable.

**The "exploitation index" — an honest hypothesis, never ground truth.** The taxonomy *names the exploit* (`coding/test_cases_hack/.../reward_check_function`, `sdf/calculator_tool/reward_no_calculator/...`). A deterministic flag ranks environments whose path asserts a constraint reward should respect by **the rate of rollouts scoring above the env's own success threshold while the path asserts that constraint** — the canonical hack signature. But high reward there is *not proven* hacking, so it renders in a visually distinct **"candidate — unverified"** register (dashed, `?` badge), never colored like ground truth; a cell earns "confirmed" only when backed by a citation-verified grade *or* the independent auto_eval verifier (Flagship 3). Where the success threshold is unknown, it shows "not computable," never a guess.

**Why it's trustworthy.** Cluster-aware Wilson corrects at small n and the extremes; floor-aware reward instead of a saturating mean; explicit n/n_prompts in every cell; denominator banner forbids "looks comprehensive but isn't"; one-click drill from any rate to members and from any grade to its span; structured ground truth in core columns, model-derived columns fenced and grounding-gated.

**Effort:** L overall; **a v1 is days** — a pure-frontend expandable tree-table over the already-loaded `filteredSamples`, Wilson in ~15 lines of TS, floor badge from `count(reward==-5.0)/n`, n_prompts from the prompt-hash, no backend, no charting lib. Sunburst/icicle and cross-step roll-up are deferred.

---

### Flagship 3 — Reward-vs-Independent-Success Hack Surface (the #1 job's signature artifact)

**Job:** A (reward hacking), the canonical question *"show me every rollout where reward is high but the task wasn't actually solved."* This is the most important visualization for the corpus's top concern, and it is **built on a reward-independent success axis** — which is the only thing that makes it non-circular.

**How it works.** A selectable scatter / 2×2 quadrant per environment (or env-group): **x = reward** (structured ground truth, but flagged *"reward may be the gamed quantity"*), **y = an independent, auditable success signal**. The suspicious quadrant — **high reward / low independent success** — is brushable; every point opens the raw rollout at the cited span. The residual reward~success correlation is printed so a researcher sees how decoupled the two axes actually are.

**The success axis comes from a reward-independent source — and we already have one.** The monorepo's **auto_eval harness** produces *independent verifier signals* (the `auto_eval_analysis` skill computes verified per-scenario sandbagging / instruction-violation / reward-hacking rates; rollout_viz already exports samples to it via "Exact Prefill v2" in `exportPrefill.ts`). The success axis is sourced, in priority order: (1) an **auto_eval verifier result** joined on prompt-hash (reward-independent, already-built, highest trust); (2) failing that, a **quote-verified grade run on reward-masked transcript text** (the grader never sees the reward, so its success judgment can't be contaminated by it); (3) never the reward itself. The axis source is labeled on the chart (**VERIFIER** vs **CLAIM(model)**), and quadrant counts inherit Flagship 1's grounding gate.

**Floor-aware and never collapsed on a saturated env.** On a `-5.0`-saturated environment a scatter is meaningless (high reward is not the norm — there *is* no high reward); the surface refuses the scatter and shows the floor-aware distribution + "no reward variance to separate success from hacking here" instead.

**Why it's trustworthy.** The success axis is *reward-independent and auditable* (the whole point), its source is labeled, the residual correlation is shown, the suspicious quadrant drills to raw spans, counts carry n/CI and grounding status, and saturated envs are refused rather than faked.

**Novelty.** The first surface to make the reward-hack signature *visible and selectable* while sourcing its success axis from an **independent, already-built verifier** instead of circularly from reward or an ungrounded LLM.

**Effort:** M for a v1 over a single loaded file once an auto_eval result is joinable (the join is prompt-hash, shared with Flagship 6/Run Timeline); the reward-masked-grade fallback reuses the grading pipeline with a transcript transform.

---

### Flagship 4 — Taxonomy × Step Hack/Reward Heatmap with Masked-Regression Alarms

**Job:** D (training dynamics — the central RL question), A over training, partial E: *"what changed step_0 → step_40, which environments regressed while the mean rose, at which step did the cliff happen?"*

**How it works.** The app's first **2-D corpus minimap over training time.** Rows = a collapsible `data_source` taxonomy tree; columns = steps in order. Cells encode mean reward on a **floor-aware diverging scale** (the `-5.0` floor gets a distinct hatch so clipped variance isn't read as merely-bad), or — via toggle — metric-true rate, or a **delta-vs-previous-step skin** so regressions pop red even where absolute reward is uniformly low. A **"Masked Regressions" rail** surfaces environments that worsened while the global mean (over the *matched* population only) improved. Click a cell → filter the LeftPanel to that (env, step); tooltip shows n, n_prompts, the interval, and floor-share.

**Composition guard is a blocking layer, not a banner.** Above the heatmap sits an **environment-membership matrix** (env × step: present/absent/n). Global-mean and masked-regression computations run **only over the common environment set**; a delta cell **refuses to render a color** when its two populations aren't matched (explicit "incomparable" glyph). A floor-to-floor delta renders as **"no signal,"** distinct from genuine no-change, so dead-but-saturating environments can't hide as benign green. Delta cells are **gated on a two-sample test carrying both n's** (and cluster-aware where prompt repeats exist) — no significance, no color.

**Correlation, not causation (stated on the surface).** The masked-regression rail and "cliff at step N" are *correlated co-movement for human attribution*; the surface says so and never labels a cause.

**Data flow.** v1 runs client-side over the existing batch loader (≤50 files), reusing the `AnalysisView` group-by re-keyed to `(taxonomy-prefix, step)`. **This is a demo, not a real run** — a real run is many steps. v2 adds a server-side `POST /api/aggregate` returning per-`(prefix, step)` `{n, n_prompts, mean, st_err, floor_count, metric_true_count + grader_id}` **plus rollout_n lists for drill-down — never full transcripts** — computed during the existing file-load pass. **This endpoint is the load-bearing scale unlock, not an enhancement:** items "Run Timeline" → "heatmap v1" → "side-by-side" are *not usable on a real corpus* until it lands.

**Why it's trustworthy.** Every cell shows n/n_prompts and an interval; sub-threshold-n cells desaturated/hatched; the composition guard blocks averaging over different populations; floor-aware encoding; delta cells gated on a two-sample test; metric-true cells inherit Flagship 1's grounding gate; every cell one click from raw.

**Effort:** L (v1 client-side) → +the aggregate endpoint for true scale.

---

### Flagship 5 — Same-Task Side-by-Side Reader (prompt-hash-gated, channel-aligned)

**Job:** D (the *same prompt* at step_0 vs step_40), E (experiment A vs B on the same env), B (thinking-vs-final-answer contradiction for sandbagging): **read the comparison instead of holding it in your head.**

**Slice 1 (ship first, cheapest, highest-trust): single-rollout cross-channel mode.** A two-column view of **one** rollout — `thinking` left, `text`/final-answer right — both highlighted, with a gutter marking divergences. No join key, no cross-file load, no alignment heuristics (indices aligned by construction). This directly serves the sandbagging job *where the evidence is the juxtaposition*, and de-risks the dual-pane rendering refactor.

**Slice 1 also answers half of sandbagging that nothing else does — but only half.** Separating sandbagging from incompetence needs a **capability-existence pointer**: *"this same task was solved elsewhere at reward R."* That pointer is **bound to the prompt-hash manifest** (Run Timeline): for the rollout's prompt-hash, surface the best-performing sibling rollout (highest reward / verifier-pass) as a drillable "demonstrated capability at rollout X, step S, reward R" chip. Without a sibling that solved it, the card states **"no capability counter-example found — cannot distinguish sandbagging from inability."** (This is why Slice 2 depends on the manifest.)

**Slice 2 (earned later): cross-step / cross-experiment.** A 2–N column synchronized transcript view. **Panes claim "same task" only when a content prompt-hash matches**; a graded **identity badge** — `EXACT` (hash match) / `TEMPLATE-MATCH` (same template, differing slots shown inline) / `UNRELATED` (blocked behind an explicit "compare anyway, NOT same-task" confirmation) — gates the same-task frame. Turn alignment is a **real sequence alignment** (role + tool-name edit distance) that **inserts explicit gap rows** when one side has extra turns. A per-column **health strip** flags truncation/unclosed-`<think>`/parse-fallback; the gutter shows "diff unreliable here" over an elided region rather than a clean "no divergence."

**Why it's trustworthy.** Every column is the raw transcript — the diff *is* the provenance. Unmatched keys are explicit gaps (P6). The identity badge makes the "same task" claim *itself* verifiable (the fingerprint shows in every header). Channel labels preserved (P8). Any span pins into the evidence bundle (Flagship 7) with provenance + identity badge + truncation flags.

**Effort:** Slice 1 ~S/M; Slice 2 M, depends on the prompt-hash manifest (shared with Flagship 4's join) **and its measured cross-file recurrence gate** — Slice 2 does not ship until that recurrence is measured on a real sibling-step pair.

---

### Flagship 6 — Deterministic Anomaly Inbox with Self-Proving, Corroborated Cards

**Job:** F (emergent discovery) + A/D: **push the surprising rollouts to the researcher deterministically, before any LLM**, and prove each flag.

**How it works.** A ranked, card-based "Surprises" inbox. Detectors are **all deterministic, computed from existing fields, no LLM in the flagging step**: (1) per-environment **robust** reward outliers (median/IQR, so the `-5.0` floor doesn't dominate); (2) **floor escapees** — reward above the floor in an otherwise-flat env — flagged as the hack signature **only when ≥~90% of the peer group sits at the floor**, labeled directionally ("rare success above flat floor" vs "rare failure"), never one undifferentiated "anomaly"; (3) transcript-shape outliers (turn count, `<think>` block count, unclosed-think rate, tool-call count vs env norm); (4) rare-pattern flags (rare tool names, rare `data_source`, runaway/near-empty transcripts).

Each card carries a **directional, env-relative** reason badge plus a **self-proving expander**: **THE MATH** (exact statistic, peer-group definition, n, reproducible), **THE PEER GROUP** (mini-distribution with this rollout marked, n + CI), **THE EVIDENCE** (spans, citation-verified via Flagship 1, click-to-highlight), **FALSIFY** (similar rollouts *not* flagged). A denominator strip: *"scanned 768/768 in this file (step_0); other steps/experiments not included."* An optional LLM "why surprising?" note is **off by default, walled off, must cite spans.**

**The corroboration axis (makes it a hack-detector, not a curiosity-detector).** For any flagged rollout the card auto-computes the **independent deterministic cross-checks** that make a hack believable: (reward above floor) AND (`data_source` names the exploit, e.g. `reward_no_web_search`) AND (a `tool_result`/`text` span shows the forbidden action) — each a separate verifiable yes/no with its span. The inbox **ranks by how many independent signals agree**, pushing genuine reward-hacks — not statistical oddities — to the top, **no LLM in flagging or ranking.** An inbox-level **expected-false-positive budget per detector/threshold** sits at the top of the feed.

**Why it's trustworthy.** Every flag is a number from raw attributes with its formula, peer group, and n shown (reproducible, falsifiable); no LLM writes any flag; every card drills to raw; the denominator strip makes truncation/sampling impossible to hide; the directional badge prevents "reward escapee" being misread as "hack" where high reward is the norm (the central refinement: the *same* badge means a z=9.75 hack in `number_guessing` vs a routine failure in `sdf/summary_length` — directional + env-relative framing fixes this); any LLM note is quarantined and must cite verified spans.

**Effort:** L; v1 is a pure client-side panel sibling to `AnalysisView`, reusing drill-down wiring. A tiny `Detector` interface (`{id, peerGroupOf, statistic → {value, n, ci, formula, suppressed?}, evidence → spans[]}`) makes each detector unit-testable (repo TDD norm).

---

### Flagship 7 — Evidence-or-Abstain Drill-down + Span-Anchored Evidence Bundle

**Job:** the cross-cutting drill-down requirement (P3) as a **hard rendering invariant** for *counts/rates*, plus the export/collaboration gap.

**How it works.** **Drill-down becomes an invariant of the rendering layer.** Every **enumerable** aggregate (count, rate) is bound at render time to the exact set of `{rollout_n, message_index, channel, span}` (routed through stable identity + `{source_file, line_index}` byte locators, never the reassigned `id`) that produced it — it **cannot render** without its evidence set. **For estimates (a CI, a mean), the invariant is softer and stated as such:** the evidence is *the population + the formula*, not a span set; the drawer shows the contributing distribution and the exact formula, not a pretense that 500 rollouts are "the evidence for the number." (Conflating these would be its own overclaim — counts have member-set evidence; estimates have population+formula evidence.) Clicking opens an **Evidence Drawer** listing member spans inline (reusing the RightPanel quote renderer), each a deep link.

**Honest, measured denominators.** The drawer header states the **measured** denominator — *"built from 47 rollouts, 47/47 scanned, 3 graded on truncated transcripts, 2 ungrounded"* — computed from persisted flags, rendering **"unknown" explicitly for legacy grades** (P10), never defaulting to "0." Numbers from a grade are labeled **CLAIM (model, prompt_version)** vs structured fields **STRUCTURED FIELD (not model-generated)** — with the reward caveat *"reward may be the gamed quantity."* Counts whose evidence can't be located are **quarantined with equal visual weight as the headline**, showing grounded-only and all-inclusive numbers **side by side** so exclusion can't silently invert a finding.

**The Evidence Bundle.** A persistent canvas accumulates items (a span, a graded instance, an anomaly card, a heatmap cell, a quadrant selection) under **user-named claims bound to a saved, re-runnable query.** Each claim header shows a **system-computed, query-backed denominator** (never hand-typed) and a **mandatory negative-class slot auto-seeded by the complementary query.** Export to (a) HTML/Markdown with live deep links, (b) CSV/Parquet of items+attributes+grades, (c) a signed shareable view that **re-resolves every quote against source on open** and **flags drifted/stale/missing spans loudly** (tri-state) rather than silently relocating them.

**Why it's trustworthy.** One click from any number to spans + full rollout; explicit measured denominator/truncation/grounding; structured-vs-claim labeled inline (and CITATION-VERIFIED never collapsed with CLAIM-SUPPORTED — P1); ungrounded contributions quarantined with equal weight; the bundle's compulsory denominator + negative-class slots **bake anti-cherry-picking into the artifact**; shared bundles re-resolve so a stale/altered quote is flagged.

**Effort:** L. **Ship the ground-truth half first** (frontend-only): refactor the four `AnalysisView` reducers to emit `{value, contributingSampleIds[]}` and make every datum clickable into a drawer. The grade-derived inline-span half + CLAIM/STRUCTURED labels arrive with Flagship 1's persisted `located` flag.

---

## 4. Supporting designs

**Data-plane & integrity.**

- **Corpus-Health Pre-Flight.** Before any aggregate is trusted, a per-file health card from deterministic parse signals: *"29% unclosed-`<think>`, 12% parse-fallback, 0 structured tool_calls, 0.7% exceed 50k cap, `is_validate` present on 100%."* This answers the distinct JTBD *"can I trust this **data**, separate from the grades?"* and pre-empts the `validate→is_validate` silent-rename trap (a query on the wrong name matches nothing) by surfacing the canonical field names. Cheap, client-side over the loaded file.

- **Truncation & Coverage Watermark.** A slim per-grade "coverage bar" showing what fraction (and which middle span) was withheld from the judge, computed against the **true raw length before per-channel elision** — and **per-channel, not scalar** (the 4k thinking / 1k tool-arg elisions are separate blind spots from the 50k center-cut). Drill-down highlights the withheld span **by message-index range** (sidestepping the formatted↔raw coordinate mismatch). The `<think>` open/close mismatch is a **clearly-labeled heuristic "unclosed reasoning markers: N," not "integrity"** — verified: 29% of rollouts have the mismatch but only 0.7% exceed the cap, so "judge missed this" would fire wrongly ~1-in-3. **This ships in NOW (not NEXT): Flagship 1's grader-byte verification depends on its persisted elision map.**

- **Run Timeline Loader (the cross-step index) + the recurrence gate.** A FileBrowser "Load as run" mode streaming a compact per-rollout **manifest** (not transcripts) keyed by **content prompt-hash + `data_source` + `experiment_name` + `{source_file, line_index}`**, recording `{step → {reward, message_count, has_grades, behavior-shape metrics, locator}}`. Foundational for Flagships 4/5 and the cohort/trajectory items. The manifest carries **deterministic behavior-shape signals that move even when reward is floored** (turn count, tool-call count, unclosed-think rate, floor flag), rescuing reward-invisible transitions. **A first-class gate:** before Flagships 4/5 Slice 2 ship on a real run, the loader **measures cross-file prompt-hash recurrence on an actual sibling-step pair** and reports it; if recurrence is low, the side-by-side reader is disabled and the heatmap downgrades to aggregate-only (alignment unverifiable). The 46-distinct-hashes figure is *within one file* — recurrence across files is the assumption this gate converts into a measurement.

**Corpus navigation.**

- **Channel-Scoped Corpus Search with a Real Query Grammar.** Server-side search across selected files/steps, matching **within a chosen channel** (`thinking` | `text` | `tool_call.arguments` | `tool_result` | any) with regex + a validated grammar (parentheses, explicit AND/OR/NOT, `data_source:prefix`, `reward<0`, grade predicates targeting a specific `model/prompt_version`). Live "matched 312 / 8,041 scanned across 12 files," a **red inline parse error on invalid syntax** (kills the silent-`catch{}` trap), a truncation ledger. **Search RAW content**, which removes the *truncation* blind spot — but the result banner states that **channel attribution is derived/fallible** (P8), so it does not claim to escape the parse-reliability problem, only the elision one. v1 client-side over the loaded file (channel-aware regex + grammar + parse-error fix); v2 adds an SSE endpoint over an *explicitly-selected, bounded* file set with a regex wall-clock timeout (ReDoS guard) and a per-file channel+attribute **index keyed by etag** so "X / Y scanned" is exact across all selected files.

- **Span-Anchored "More Like This" (channel-scoped semantic kNN).** Select a span → "find rollouts that reasoned like this," anchored to the selection's *channel*, ranked by cosine with the matched span re-highlighted and re-verified. v1 in-memory, single-fileset, brute-force cosine over message-channel embeddings (no ANN, no S3 index). **Pair every result with a measured-recall floor** (seed known paraphrases; report recall on N variants) or an explicit "recall unknown — NOT exhaustive" stamp, a near-miss/random-unmatched inspection panel, and a provenance banner (anchor, channel, threshold, embedding model) that travels with anything promoted — because kNN trades away the *one* property literal search has (provable recall), and that loss must be loud. Best as a **triage front-end feeding a quote-required grading pass**, not a standalone retriever.

**Training-dynamics.**

- **Behavior-Prevalence Over Training.** Prevalence-over-step for any behavior signal — a deterministic structural rate (unclosed-think, test-file-write), a citation-verified grade-true rate, or a cluster prevalence — as **per-`data_source` small-multiples with CI ribbons** (not a streamgraph; magnitude must be readable against a baseline). **Tier 1 ships deterministic-structural bands only**; graded bands added later as marked overlays, **split into a grounded sub-band vs an at-risk sub-band** (truncated/unlocatable-quote grades) so length-correlated truncation drift can't masquerade as a behavior trend. Emergence "onset" is a **hypothesis with a BH-FDR-corrected q-value and onset-step n**, debounced over k consecutive steps — never "behavior X emerged at step N." Correlation, not causation, stated.

- **Composition-Guarded Paired Cohort Diff (primary home for Job E).** Pick two cohorts (two steps **or two experiments**); a per-environment significance-tested delta table with **BH-FDR correction across the many environments**, cluster-aware where prompt repeats exist, a first-class **NOT-COMPARABLE tray** for envs in only one cohort or with imbalanced n, and a **three-state verdict** (`changed` / `within noise — adequately powered` / `inconclusive — underpowered`) so a grey n=4 cell never reads as a confident null. Reward-only v1 (runnable today); grade-rate columns gated on shared grader version + citation-verification + matched truncation rates. **This is where cross-experiment comparison (Job E) primarily lives** — "did the new checkpoint fix the hack without introducing a new one?" is a two-experiment paired diff with the matched-env guard.

**Grading-at-scale & economics.**

- **Grading-Economics Dashboard (makes "bold" also "runnable").** *Before* a run: projected calls/tokens/$ from corpus size × rubric size × model pricing, with the post-truncation token estimate (so the 50k cap is priced in). *During:* live burn-down and dedup-cache hit-rate. *After:* spend and **cost-per-confirmed-finding** (confirmed = citation-verified or verifier-corroborated). This is the difference between "nothing is too expensive" as a slogan and as a decision a researcher can actually make about where the marginal grading dollar goes.

- **Multi-Behavior Rubric Pass with Content-Addressed Cache.** Grade an ordered **rubric** in one judge call per rollout (each metric written back independently), cache keyed on **hash of the post-truncation transcript actually sent + model + content-hash prompt_version + sampling params** — so reuse can never silently serve a grade over different text or a different rubric. Run summary separates **"newly graded / reused-identical-config / reused-staler-config."** Persist `truncated`/`original_len`/population per grade. **Calibrate rubric-vs-solo agreement** before trusting batched grades (shared context can contaminate per-metric provenance); cap rubric size.

- **Active Grader (budgeted, stratified, inclusion-probability-tracked).** Spend a fixed budget where it changes conclusions most, with a **population_manifest** recording candidate set, sampling rule, per-rollout inclusion probability, and what was *not* graded — keyed by stable identity, persisted onto the grade. Aggregates **inverse-probability-weight** or loudly flag "non-uniform sample," and **never show an IPW rate without effective sample size (Kish ESS) + a single-grade sensitivity figure** (a rare hack at p≈0.02 carries ~50× weight; one hallucinated grade can dominate). A **fixed random-uniform reserve stratum** runs alongside as a blind-spot check. Tier 1 (deterministic stratified + anomaly acquisition) ships now; uncertainty acquisition waits on a confidence/Jury substrate.

**Trust & human-reliability layer.**

- **Jury Mode / Spot-Check Arena / Triage Queue.** Multi-grader **agreement** (cohort-scoped, never pooling the append-list, with a correlated-error/independence badge — three roles of one base model are not independent raters); a **blind Spot-Check Arena** producing measured grader-vs-human concordance (kappa + per-class recall, scoped to its population, stored in a **separate key** so last-wins consumers never mistake a human label for the LLM grade — critical, since every consumer reads `grades[length-1]`); a **keystroke Triage Queue** with an append-only human-label trail and a **mandatory blind negative-class audit lane that estimates recall** (a precision-only queue manufactures false confidence about the rare hacks it missed). Flagship 1 ships *before* all of these as the cheap 100%-coverage floor feeding the disagreement docket.

- **Tool-Call Sankey + Sensitive-Action Inventory.** From a **versioned, coverage-reporting** tool-call parser (the corpus has *zero* structured tool_calls — calls are env-specific XML like `<bash>`, `<calculator>`, `<web_search>` inside `content`), a per-environment **sensitive-tool touch-rate table** with cluster-aware Wilson CIs. This alone surfaces a verified smoking gun (in the sample, 32/32 `reward_no_calculator` rollouts used `<calculator>`; 32/32 `reward_no_web_search` used `<web_search>`). The Sankey/loop graph is a secondary env-scoped layer with mandatory denominators, an explicit `UNPARSED_ACTIONS` node, and corpus-level parse-coverage — never "deterministic" framing over heuristic parses.

**UX / workflow.**

- **Saved Investigations & Re-runnable Report Compiler.** A first-class Investigation capturing a named query + a **frozen population snapshot with denominator + files/etags**, accumulated verdicts/pinned spans, and a running brief. On re-open it **diffs the new result set against the frozen snapshot** (appeared/disappeared by stable key — `rollout_n + data_source + experiment_name`, **never `id`**); the compiler **refuses to emit a claim with an unlocatable or zero-anchor citation**, re-verifying every quote against live source. Ship the trust primitives (frozen population + etags + per-grade quote-verification + loud truncation) as a thin layer first; defer the full diff engine until the discovery surfaces exist to capture.

---

## 5. Moonshots

**Ask-the-Corpus: the Cited Investigator Console.** A natural-language box spawns a **tool-using agent that cannot emit prose claims — only structured Findings** `{claim_text, supporting_quotes:[{rollout_n, message_index, channel, span}], counted_n, scanned_n, n_prompts, confidence}`. Tools: `structured_filter`, `open_rollout`, `grade_subset`, `count_with_ci`, **`query_auto_eval`** (the independent verifier). A claim with no server-verified quote is rejected and never shown; a live investigation-trace panel makes the search path auditable. **Honest risk:** the trust backbone is the *same* `_normalize_quotes` path with cross-channel laundering and fuzzy matching — so without Flagship 1's hardening it would mint thousands of false-verified Findings. And `scanned_n`, not the quotes, is the real lie surface: a CI over a substring-only or truncated denominator *looks* rigorous while excluding differently-phrased hacks. **Verdict:** build the deterministic corpus index + channel-scoped exhaustive search **first** (the verified substrate the agent calls), and gate the agent on Flagship 1. The agent is the *interface*, never the *evidence*.

**Behavior Atlas: spatial navigation colored by structured truth.** A WebGL scatter where **position is the only model-derived thing** (UMAP over channel-resolved embeddings + a deterministic structural half) and **color/size/outline are deterministic fields**; no region auto-named; lasso → a saved query. **Honest risk:** proximity reads as similarity, but UMAP distances are not meaningful and the layout is seed-unstable — a disclaimer doesn't inoculate spatial intuition. **Verdict:** make the **deterministic structural projection the default** (semantic UMAP an opt-in overlay stamped "exploratory layout"), show real high-dimensional neighbors + a multi-seed instability halo on hover, and print a disposition ledger (in-scope / out-of-scope / embed-failed / truncated) so a blank region can't read as "no such behavior." Net-new embeddings infra (model_router has **no** embeddings route; venv has no UMAP) — a genuine subsystem.

**Falsifiable Behavior Clusters.** Cluster on a **deterministic structural feature vector first** (HDBSCAN, keeping and counting noise), compute deterministic facts (size, floor-aware reward distribution, cohesion, medoids) **before** any LLM, then a cohesion-gated, fully-cited, suppressible label as a thin garnish. **Honest risk:** the medoid is the *least* anomalous member — defaulting the cluster's "face" to medoids steers attention from the outliers Job F exists to find. **Verdict:** default the card to a **random stratified member sample** (medoids demoted to "best-case examples"), make the cluster definition compile to the filter language (so "confirm" graduates it into a reproducible detector), and cluster **within** a `data_source` slice using floor-aware, single-shot-robust features — because verified reality (71% single-turn, 83.9% reward-floor) collapses control-flow features for the majority.

---

## 6. Prioritized roadmap

Ranked by **impact × trust × feasibility**, dependencies explicit. The trust substrate ships before anything that aggregates model output; the stable-identity helper and the cross-step index ship before anything that drills or compares.

### NOW (weeks 1–7) — stable identity + trust substrate + honest aggregates; mostly frontend / pure-Python, no new infra

0. **Stable-Identity helper** (S). A tiny shared module computing `stable_key = (rollout_n, data_source, experiment_name)` + `{source_file, line_index}` and a content prompt-hash, used by all drill-down. *Promoted to NOW because Flagships 6, 7 already need it and the `id` field provably cannot provide it.*
1. **Truncation & Coverage Watermark + persisted `truncated`/`original_len`/per-channel elision map on `GradeEntry`** (S). *Moved into NOW: Flagship 1's grader-byte verification depends on this schema field.* Legacy grades render "unknown" (P10).
2. **Quote-Grounding Firewall** (M): **raw-verify v0** (no elision map) ships immediately; **grader-byte v1** lands once item 1's field exists. Stamp `match_kind` at creation; re-verify on viz load; three-state badge; CITATION-VERIFIED vs CLAIM-SUPPORTED kept separate. **Calibrate against the 763-grade twin, flagging it as one-metric/one-model.** *Unblocks everything that touches grades.*
3. **Taxonomy Ledger v1** (days): expandable tree-table over `filteredSamples`; cluster-aware Wilson; floor-aware reward badge; n + n_prompts; denominator banner; row-click cross-filter. *Depends on 2 for grade-trust columns.*
4. **Evidence-or-Abstain drill-down, ground-truth half** (frontend-only): reducers emit `contributingSampleIds[]`; every datum opens an Evidence Drawer; counts vs estimates distinguished. *Kills dead-end numbers.*
5. **Cross-channel single-rollout reader** (Flagship 5 Slice 1, S/M): thinking-vs-final-answer. *No join key; nails the contradiction half of sandbagging cheaply.*
6. **Deterministic Anomaly Inbox v1** (Flagship 6, client-side) with the corroboration rank. *Reuses drill-down + stable identity.*
7. **Corpus-Health Pre-Flight** (S) + **filter-parse-error fix** (the `catch{}` trap). *Cheap data-trust + kills a silent failure.*

### NEXT (weeks 7–16) — cross-step infrastructure, the #1 hack surface, scale endpoint

8. **Run Timeline Loader / prompt-hash manifest** (L) **with the cross-file recurrence gate measured on a real sibling-step pair.** *Foundational for 9, 10, 11, and the capability-counter-example pointer.*
9. **Reward-vs-Independent-Success Hack Surface** (Flagship 3, M), success axis from **auto_eval verifier** (priority 1) / reward-masked grade (priority 2). *The #1 job's signature artifact; depends on the prompt-hash join (8) for the auto_eval join.*
10. **Environment × Step Heatmap v1 client-side** (Flagship 4, L) with the blocking composition guard. *Depends on 8; a demo until 12.*
11. **Same-Task Side-by-Side Slice 2** (Flagship 5, M): prompt-hash-gated identity badge + sequence alignment + capability-counter-example chip. *Depends on 8 and its recurrence gate.*
12. **`POST /api/aggregate` endpoint** (L). Per-cell deterministic stats + drill-down id lists, computed at load. ***Load-bearing scale unlock — items 8–11 are not usable on a real multi-step run until this lands.***
13. **Channel-Scoped Corpus Search v1 client-side** + grammar (Supporting). *The etag-keyed per-file index is the v2 scale milestone.*

### LATER (months 4–6) — grading economics, human reliability, embeddings

14. **Grading-Economics Dashboard** (M). *Makes corpus-scale grading a decision, not a gamble.*
15. **Multi-Behavior Rubric Pass + content-addressed cache** (M). *Depends on the persisted-flag schema (1).*
16. **Active Grader + population_manifest** (L). *Depends on stable identity (0) and the grade-aggregation surface (3).*
17. **Jury Mode / Spot-Check Arena / Triage Queue** (L). *The Arena/Queue need a **labels store in a separate key**.*
18. **Composition-Guarded Paired Cohort Diff (Job E home) + Behavior-Prevalence trajectories** (L). *Depend on 8.*
19. **Embeddings infrastructure** — the **shared, currently-unowned hard dependency** for kNN, the Atlas, and Clusters. *Concrete decision required: a litellm embeddings route (model_router has none) vs a local embedding model; tag = L-subsystem; includes an embedding cache keyed by content-hash. **Build this standalone milestone before any of items 20–22.*** This is the roadmap's biggest feasibility item, not a one-liner.
20. **Span-Anchored "More Like This"** (M, after 19).

### MOONSHOT (gated on the above)

21. **Ask-the-Corpus agent** — only after the deterministic corpus index + channel-scoped search (13) + Flagship 1 hardening (2) exist.
22. **Behavior Atlas** and **Falsifiable Clusters** — after 19.

**Key dependency chains:** Stable identity (0) → all drill-down (4, 6, 7); Watermark schema (1) → Firewall grader-byte verify (2) → all grade-aggregation; Run Timeline + recurrence gate (8) → hack surface auto_eval join (9), heatmap (10), side-by-side Slice 2 + capability pointer (11), cohort diff/trajectories (18); aggregate endpoint (12) → real corpus scale; embeddings infra (19) → kNN/Atlas/Clusters; labels store → Spot-Check Arena/Triage Queue/Investigations.

---

## 7. What would make this UNtrustworthy — the traps to refuse to build

Each is a thing the codebase *invites* or a concept that *almost* shipped. Refuse them.

1. **A `rollout_n`-based "same task across steps" join.** Verified: `rollout_n` is a flat 0..767 per-file counter, `sample_index` ≡ 0, and the code admits `(rollout_n, step)` is non-unique (L528). Aligning on it **manufactures false same-task comparisons and labels them ground truth** — the single worst failure here. Use a content prompt-hash with a visible identity badge **and measure its cross-file recurrence before relying on it** — or don't claim "same task."

2. **A "verified" badge that means "a fuzzy substring matched somewhere," or that conflates cited with true.** `_find_whitespace_normalized` is an unanchored first-match `re.search` that **falls back across every channel** (confirmed L1104-1136). A green check over that is false-confidence-via-encoding. Verification must be channel-exact, length-gated, ambiguity-flagged, dual-target (raw + elision-map), and **CITATION-VERIFIED must never be styled identically to CLAIM-SUPPORTED** — a real quote can support a hallucinated interpretation.

3. **Aggregating LLM grades into authoritative rates without grounding gates, grader-version splits, truncation flags, or cluster-adjustment.** Wilson CIs over hallucinated-provenance, version-mixed, center-truncated, within-prompt-correlated grades **launder grader unreliability into a precise-looking number**. Every grade-derived aggregate inherits Flagship 1's verdict and reports n_prompts, or it doesn't render as a verdict.

4. **Silent truncation anywhere.** The 50k center-cut and per-channel 4k/1k elisions must be persisted and surfaced on every grade and aggregate. Compute coverage against *raw* length, not post-elision `len(combined)`, or the watermark *certifies* the gutting.

5. **Top-N chart truncation, or a "scanned N/N" that silently means one file.** Show the exhaustive set with explicit n, or state the true denominator and what was excluded.

6. **A streamgraph (or any pooled, baseline-free encoding) for safety-critical magnitudes, with trust carried by line-style.** Magnitude must read against a common baseline; the ground-truth-vs-interpretation distinction must survive a screenshot crop and colorblind viewing — a textual badge, not dash-vs-solid in a wiggling band.

7. **An emergence "onset" tick without multiple-comparisons correction.** Hundreds of `env × metric × step` crossings at 5% manufacture spurious onsets. Every onset is a hypothesis with a BH-FDR-corrected q-value and its n.

8. **A precision-only triage/discovery surface.** Precision@k says nothing about the rare hacks the ranking *missed* and makes the researcher feel they reviewed everything. Pair every "find/rank" with a **blind negative-class audit lane that estimates recall.**

9. **Appending human labels (or any second signal) into the metric's grade list.** Every consumer reads `grades[length-1]`. A human spot-check label would silently become *the* displayed/filtered/charted grade, **poisoning the very aggregate the review certifies.** Store human labels and any parallel signal in a **separate key.**

10. **A confident cluster label, medoid-as-representative view, or chat answer presented as a finding.** Labels are hypotheses backed by openable members with size + heterogeneity; the cluster's default face is a random member sample, not the least-anomalous medoid; chat/agent output is the *interface*, and every claim carries verified spans + a denominator — or it is not shown.

11. **Reward treated as a trustworthy success signal in hack detection.** Reward is the *gamed* quantity. The reward-vs-success scatter's success axis must come from a **separate, reward-independent, auditable source** — the **auto_eval verifier** or a quote-verified grade run on **reward-masked** text — with the residual reward~success correlation displayed, and **never plotted on a reward-floor-saturated environment** where there is no reward variance to separate hacking from the norm. Sourcing it from reward, or from an ungrounded LLM that saw the reward, makes the chart circular.

The throughline: **the app's job is to make the researcher's own judgment more powerful and better-grounded, never to substitute a confident-looking model judgment for it.** Every feature either drills to a verifiable span with its denominator and uncertainty, or it does not ship.

---

**Files referenced** (all absolute):
- `/home/ubuntu/reward_seeker/rollout_viz/backend/llm_providers.py` — `_message_channels` (L489), `_find_whitespace_normalized` (L587), cross-channel fallback `channel_order = [raw_channel] + others` (L1104-1136), `_normalize_quotes` drop-gate, truncation/elision constants (`_MAX_TRANSCRIPT_CHARS` L311, `_PER_THINKING_CHARS`/`_PER_ARG_CHARS` L309-310), `prompt_version` literals (`"model-router-v1"` L1177; `"v1"` L1321, 1372, 1433, 1497).
- `/home/ubuntu/reward_seeker/rollout_viz/backend/main.py` — `GradeEntry` schema (L631, no truncation/verification field), `id` reassignment via `enumerate` (L1227), `(rollout_n, step)` non-uniqueness admission (L528), model_router grading path (L2095, 2225), `_ATTR_DEFAULTS`.
- `/home/ubuntu/reward_seeker/rollout_viz/frontend/src/components/RightPanel/AnalysisView.tsx` — the entire current aggregate layer (4 charts, top-8/10 truncation, leaf-only `.split('/').pop()` taxonomy, no drill-down).
- `/home/ubuntu/reward_seeker/rollout_viz/frontend/src/components/LeftPanel/index.tsx` — silent filter-parse failure (`catch {}`), last-grade-only filtering.
- `/home/ubuntu/reward_seeker/rollout_viz/frontend/src/utils/exportPrefill.ts` + `frontend/src/components/RightPanel/NavigationBar.tsx` — the existing auto_eval "Exact Prefill v2" integration (the reward-independent verifier pipeline Flagship 3 sources its success axis from).
- `/home/ubuntu/reward_seeker/rollout_viz/frontend/src/types/index.ts` — `Quote`/`GradeEntry` types.
- `/home/ubuntu/reward_seeker/rollout_viz/sample_rollout_traces.jsonl` + `viz/sample_rollout_traces.jsonl` — verified this session: 768 rows, `rollout_n` 0..767, `sample_index` ≡ 0, **644/768 = 83.9% at the −5.0 floor, 654/768 = 85.2% negative**, reward mean −3.55, **46 distinct sys+user prompt-hashes**, 763 graded (single metric `safety`). Only one file exists — no `step_*` siblings — so cross-file prompt-hash recurrence is **unverified** and gated, not assumed.
