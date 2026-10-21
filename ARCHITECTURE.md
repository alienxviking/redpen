# Architecture

## The problem this shape solves

An AI marking tool fails in three characteristic ways: it produces a score nobody can
check, it puts feedback in the wrong place on the page, and it fails silently — returning
a confident number when the model was unreachable, confused, or wrong. Nearly every
structural decision here is aimed at one of those three.

---

## Flow

```
   PDF upload
       │
       ▼
┌──────────────────┐   text + a bounding box for every run of characters,
│  extractText.ts  │   plus offsets into the flat text
└──────────────────┘
       │  ExtractedDocument
       ▼
┌──────────────────┐   blank? → short-circuit, zero, flagged, no model call
│    grader.ts     │───────────────────────────────────────────────┐
└──────────────────┘                                               │
       │  GradeRequest (rubric + text + the PDF itself)             │
       ▼                                                           │
┌──────────────────┐   AnthropicGrader ──fails──▶ MockGrader       │
│   llm/provider   │   (structured output)        (deterministic)   │
└──────────────────┘                                               │
       │  raw text / parsed object                                 │
       ▼                                                           │
┌──────────────────┐   tolerant parse → one repair round-trip      │
│   validate.ts    │   → clamp, fill, recompute, discard unknowns  │
└──────────────────┘                                               │
       │  Reconciled                                               │
       ▼                                                           │
┌──────────────────┐   evidence quote → char span → tokens → rects │
│    anchor.ts     │                                               │
└──────────────────┘                                               │
       │                                                           │
       ▼                                                           ▼
┌──────────────────┐                                   ┌────────────────────┐
│  assertInvariants│◀──────────────────────────────────│   GradeResult      │
└──────────────────┘   throws rather than return wrong └────────────────────┘
       │
       ├──▶ store.ts       grade + annotations, persisted separately
       └──▶ annotatePdf.ts a new PDF; the original is only ever read
```

---

## The five decisions that matter

### 1. Extraction keeps positions, not just text

`extractText.ts` returns, for every run pdf.js reports, its bounding box **and** the
offsets of that run inside the flat document text. Those offsets are the join key for the
whole annotation feature: a quote is found in the text, the character span maps to tokens,
and the tokens become rectangles.

The alternative — asking the model for coordinates — does not work. Models do not know
where text sits on a page, and a hallucinated rectangle is worse than no rectangle,
because it looks correct.

### 2. Quotes are anchored by search, with a reported match score

Models return quotes they believe are verbatim. In practice quotes drift: whitespace
collapses, a misspelling gets silently corrected, a clause is trimmed. Worse, extracted
PDF text breaks mid-phrase wherever a line wrapped, so "For example" can arrive as
`For\nexample` and an exact search fails on text that is genuinely there.

So `anchor.ts` searches in three widening steps against a whitespace-flattened,
lower-cased copy, mapping every result back to real offsets:

1. exact match after normalisation — the common case, score 1.0;
2. a word-window scan scored by edit distance, with a cheap length prefilter;
3. a fallback that anchors on the quote's most distinctive word.

Below 0.55 similarity it **reports failure**. That is the important part: an unanchored
quote lowers the paper's confidence and raises `unanchored_evidence`, rather than being
placed approximately. Guessing a position would put a red box around innocent text.

The same normalisation module is what makes the offline grader spelling-tolerant: it
matches against a spell-corrected copy but reports evidence from what the student actually
wrote, so a correct point is never lost to a typo and a quote never contains words the
student did not write.

### 3. The model's judgement is trusted; its arithmetic is not

`validate.ts` treats the model as an examiner, not as a calculator. Marks are clamped to
each rubric point's maximum, negative marks are floored, skipped rubric points are filled
in as zero with an explicit "a teacher must mark this manually", unknown rubric ids are
discarded, and **every total is recomputed** from the rubric points rather than read from
the response.

Every departure from what the model said is recorded in `warnings[]` and surfaced in the
UI, so a teacher can see what was adjusted rather than having it quietly corrected.

`assertInvariants()` then re-checks the guarantees on the way out and *throws* on breach.
That is deliberate: at that point a violation is a bug in this codebase, not bad model
output, and returning a wrong mark is worse than returning an error.

### 4. Annotations are a separate layer from the grade

`GradingRecord = { result, annotations }`, persisted as two independent things. This is
what makes "editable without re-grading" true by construction rather than by discipline:
the annotation routes have no access to marks, and there is no code path from an
annotation edit to a model call.

It also gives the honest ordering for the export: `origin: "model" | "user"` and `edited`
travel with each annotation, so an exported paper shows what the tool proposed and what
the teacher changed.

In the UI the same separation shows up as the PDF being painted to a canvas with
annotations as absolutely-positioned DOM elements on top. Boxes are never baked into the
rendered page — only into the exported copy. Coordinate conversion (PDF's bottom-left
origin ↔ the DOM's top-left) is confined to `toScreen`/`toPdf` in `PdfViewer.tsx`.

### 5. Failure degrades in a labelled way

The `GraderProvider` interface has four implementations. `AnthropicGrader` uses structured
output (`output_config.format` with a Zod schema) and adaptive thinking, and sends the
answer PDF as a document block so the model can see the circuit diagram and the graph.
`GeminiGrader` does the same over REST against Google's free tier. `GroqGrader` speaks the
OpenAI chat-completions format - free and much faster, but text-only. `MockGrader` is a
deterministic rule grader.

Each new provider touched four files and no logic: a provider, a config branch, and two
type unions. That is the interface earning its keep.

Two details worth noting, because both are cases of the existing machinery absorbing a
weaker provider rather than the provider forcing a redesign:

- `GeminiGrader` sends **no** response schema. Gemini's schema dialect does not cleanly
  express the nullable fields this grade shape needs, and forcing it would mean weakening
  the contract. It asks for JSON and leans on the tolerant parser and the repair
  round-trip instead - machinery that exists precisely for this.
- `GroqGrader` deliberately **drops the answer PDF**, because no OpenAI-compatible
  endpoint can read one. Dropping it is not so much a loss of information as an admission
  of one: it switches `buildUserPrompt` to the branch that tells the model it cannot see
  the diagrams, and instructs it to say so, lower its confidence and flag those questions
  for human review. A text-only grader therefore returns a lower, clearly-reasoned score
  rather than a confident guess about a drawing it was never shown. Two tests assert
  exactly this, because it is the difference between degrading and lying.

The mock is not only a test double — it is the fallback that keeps the product usable when
there is no API key or the API is down. The ladder is: model → repair round-trip → offline
grader, and *every* rung below the first leaves a flag on the result and sets
`grader.degraded`. The UI shows this in the header and on the exported summary sheet.

The mock is honest about what it is: it reports 0.55 confidence, below the review
threshold, so every offline grade lands in front of a human.

---

## Module map

| Module | Responsibility |
|---|---|
| `domain/types.ts` | The vocabulary: rects, tokens, rubric, results, annotations |
| `domain/schema.ts` | Zod schemas — the model's output contract and the API's edit contracts |
| `domain/rubric.ts` | Loads and validates the rubric, including its arithmetic |
| `services/pdf/extractText.ts` | PDF → positioned tokens + flat text |
| `services/pdf/annotatePdf.ts` | Annotated copy: boxes, margin notes, summary sheet |
| `services/text/normalise.ts` | Flattening, spell-tolerant matching, index mapping |
| `services/grading/prompt.ts` | System and user prompts; stable cache prefix |
| `services/grading/anchor.ts` | Quote → rectangles, with a match score |
| `services/grading/validate.ts` | Tolerant parsing, clamping, reconciliation, confidence |
| `services/grading/grader.ts` | The pipeline and the degradation ladder |
| `services/llm/*` | Provider interface, Anthropic / Gemini / Groq clients, offline grader |
| `services/store/store.ts` | JSON index + one file per PDF and per extraction |
| `routes/*` | HTTP surface; thin, with all logic in services |

---

## Notes on specific choices

**Why send the PDF to the model as well as the text?** Two of the three questions are
marked partly on a drawing. Text extraction cannot see that the voltmeter is wired in
series or that the axes are swapped. Sending the PDF as a document block gets the model
those pixels without adding a rasterisation dependency. The extracted text still travels
with it, because that — not the rendering — is the string quotes are matched against.

**Why not enforce mark limits in the Zod schema?** Because a model that over-awards should
produce a *repairable result with a warning*, not a hard parse failure that loses all its
correct judgements. The schema is permissive about numbers on purpose; `validate.ts` is
where the limits live.

**Why a JSON file store?** It adds no native dependency (which matters on Windows), is
inspectable by hand, and is trivially resettable. Writes are serialised through a promise
chain and land via write-then-rename, so an interrupted write cannot corrupt the index.
The extraction for each document lives in its own file rather than in the index, because
it is large and only needed when grading or re-anchoring.

**Why generate the student answer from code?** The assignment asks for a paper with
planted mistakes *and* an error key. Generating both from the same source means they
cannot drift, the paper is reproducible for anyone reviewing the submission, and the test
suite can assert the exact expected breakdown — so a grading regression fails a test
rather than producing a plausible wrong number.

---

## What I would do next

1. **Rubric parsing** from the model-answer PDF, with the teacher confirming the extracted
   table before it is used — keeping the validated-arithmetic guarantee.
2. **Region annotations for diagrams.** Diagram faults are currently anchored to the
   sentence that describes them; asking the model for a bounding box on the rendered page
   would let a box go around the wrongly-wired voltmeter itself.
3. **Calibration.** Grade a set of papers twice and track mark variance per rubric point,
   to find where the rubric is ambiguous rather than where the model is weak.
4. **SQLite** behind the same store interface once there is more than one marker.
