# TruthLens Claim Model (LIAR specialist)

`v1.1.0-liar-claim`

This document describes the **claim model** only. It is a different model, on a
different corpus, solving a different task from the ISOT **article model**, and
the two numbers are never combined.

| | Article model | Claim model | Evidence engine |
|---|---|---|---|
| Corpus | ISOT | LIAR | live retrieval |
| Input | full article body | one short claim | one short claim |
| Output | REAL / FAKE probability | TRUE / FALSE probability | SUPPORT / CONTRADICT / UNCLEAR |
| Endpoint | `/api/analyze` | `/api/claim/predict` | `/api/evidence/verify` |
| Metrics | `/api/models/metrics` → `article_model` | `/api/claim/metrics` | per-request |

---

## 1. Data and split policy

LIAR ships six ordinal labels. The claim model is binary, so the two ambiguous
middle classes are **excluded from every split** rather than collapsed into a
pole (collapsing them injects label noise):

- `TRUE`  = `true`, `mostly-true`
- `FALSE` = `false`, `pants-fire`
- excluded = `half-true`, `barely-true`

Split construction (`scripts/liar_common.py::build_splits`):

| Step | TRAIN | VALID | TEST |
|---|---|---|---|
| binary label filter | yes | yes | yes |
| intra-split statement de-duplication | yes (9 rows) | no | no |
| drop rows whose statement also occurs in a held-out split | yes (9 rows) | no | no |
| **final n** | **6,471** | **799** | **802** |

**No row is ever removed from VALID or TEST.** Every held-out claim that
survives the binary label filter is evaluated. The leakage guard only ever
removes rows from TRAIN.

## 2. Protocol

- Feature space: sublinear TF-IDF, unigrams + bigrams, `min_df=2`, L2 norm,
  vocabulary fitted on TRAIN only (10,248 terms).
- Classifier: `LinearSVC` with `class_weight="balanced"`; the `C` grid is
  searched **on VALID macro-F1 only**.
- Calibration: Platt sigmoid fitted on the **disjoint VALID split**.
- Decision threshold: **fixed at 0.50**, never tuned against TEST.
- TEST is read **exactly once**, after selection and calibration are frozen.

Never done, at any point: training on test, tuning on test, deleting difficult
samples, rewriting labels, fabricating metrics, or moving the threshold to
inflate a score.

## 3. Results (held-out LIAR TEST, n = 802)

| Variant | Accuracy | Macro-F1 | ROC-AUC | Served? |
|---|---|---|---|---|
| `text_only` — statement text only | **0.6272** | **0.6153** | 0.6797 | yes, default |
| `text_meta` — text + de-leaked speaker credit history | **0.6584** | **0.6470** | 0.7184 | only with real metadata |
| `text_meta_raw_credit` — **diagnostic only** | 0.8005 | 0.7968 | 0.8739 | **never** |

(Exact figures, including VALID numbers and confusion matrices, live in
`docs/claim_model_report.json` and are served from `/api/claim/metrics`.)

## 4. The credit-history leak — why "LIAR ≈ 76%" is not a real result

LIAR's five speaker credit-history columns count that speaker's past rulings.
**They already include the verdict of the statement they accompany.** Left
untouched, the target label is literally present in the feature vector.

Measured on this split:

- text + **raw** credit counts → **0.8005** TEST accuracy
- **metadata only, no text at all**, raw counts → **0.7635** VALID accuracy
- text + **de-leaked** credit counts → **0.6584** TEST accuracy

A model that reads none of the claim text reaches ~0.76 purely from the leak.
Any reported LIAR accuracy in the mid-to-high 70s that uses these columns
as-shipped is measuring the leak, not claim understanding.

**Mitigation.** `liar_common.meta_features(rec, remove_self=True)` subtracts the
current statement's own contribution from its bucket before any feature is
built. This is applied in training and required of API callers. The
`text_meta_raw_credit` variant is trained solely to quantify the leak; it is
never written to the runtime artifact and cannot be served.

Residual limitation: counts still aggregate a speaker's other statements across
splits. `text_meta` numbers must be read as *metadata-conditioned*, not as
text-understanding performance.

## 5. Metadata handling at inference — the honesty rule

`text_meta` was trained with a metadata block. Serving it with zero-filled
metadata would be a **mis-specified model**, and its reported accuracy would not
apply to that call. So:

- **No usable metadata** → `text_only` is served, `metadata_available: false`,
  and the response carries an explicit limitation saying why the metadata
  variant was withheld.
- **Partial metadata** (e.g. party but no credit history) → treated as *no*
  metadata. All five credit counts are required together
  (`hasUsableClaimMetadata`).
- **Complete metadata** → `text_meta` is served, the used fields are listed, and
  the response warns that the current claim must not be inside those counts.
- **No in-vocabulary term, or fewer than 3 words** → `INSUFFICIENT CONTEXT`,
  probabilities `null`. An empty feature vector would only return the training
  prior; that is withheld rather than dressed up as a prediction.

Request shape:

```jsonc
POST /api/claim/predict
{
  "claim": "The unemployment rate for college graduates is 4.4 percent.",
  "metadata": {                        // optional
    "speaker": "rick-santorum",
    "party": "republican",
    "credit_history": {                // all five required together,
      "barely_true_count": 12,         // EXCLUDING this claim's own verdict
      "false_count": 16,
      "half_true_count": 13,
      "mostly_true_count": 7,
      "pants_on_fire_count": 5
    }
  }
}
```

## 6. Python ↔ Node parity

`server/claimModel.ts` re-implements the scorer for the Node runtime. The
tokenizer is a byte-for-byte mirror of `scripts/liar_common.py::analyzer`, so
parity is exact by construction rather than by tolerance-fitting.

`npm run test:claim-parity` re-scores **every** TEST row in both variants
against the sklearn oracle probabilities emitted during training:

```
rows compared        : 802 / 802   (text_only)   +  802 / 802 (text_meta)
max |p_py - p_node|  : 2.220e-16   (tolerance 1e-9)
label flips @ 0.50   : 0
accuracy / macro-F1 drift vs artifact : 0
```

Any drift between the two implementations fails the check.

## 7. Reproducing

```bash
python3 -m venv .venv && .venv/bin/pip install scikit-learn numpy scipy
.venv/bin/python scripts/train_liar_claim.py     # writes artifact + fixtures + report
npm run test:claim                               # 79 contract/integrity tests
npm run test:claim-parity                        # 802-row Python/Node parity
.venv/bin/python scripts/experiment_liar_claim.py  # VALID-only experiments, never reads TEST
```

Artifacts:

- `data/claim_model_artifacts.json` — runtime artifact (served variants only)
- `data/claim_parity_fixtures.json` — sklearn oracle probabilities for TEST
- `docs/claim_model_report.json` — full metrics, protocol, leakage audit

## 8. Known limitations

1. **This is a weak-signal task.** Short political claims carry little lexical
   evidence of veracity. 0.6272 text-only accuracy against a 57.4% majority-class
   baseline is a genuine but modest signal. The score is a prior, not a verdict.
2. Domain: US political fact-checking, 2007–2016. Anything outside that is out
   of distribution.
3. `half-true` / `barely-true` claims have no correct output class here.
4. `text_meta` is metadata-conditioned; residual cross-split speaker information
   remains in the credit counts.
5. Explored on VALID and rejected as within noise: char_wb n-grams (+1.1 macro-F1
   points), word+char unions, subject/context channels, logistic regression.
   Kept the simpler word model because the gains were not separable from noise
   on 799 validation rows and the word tokenizer gives exact Node parity. See
   `scripts/experiment_liar_claim.py`.
