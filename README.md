# RedPen

A marking tool that reads a student's answer paper, marks it against a rubric, explains
every mark with a quote from the student's own words, and draws the problems on the page
where they occur — as annotations a teacher can move, edit or delete, and export as an
annotated PDF.

The original answer paper is never modified. Marks can never exceed the rubric. When the
tool is unsure, it says so instead of pretending.

---

## Quick start

> **Supplied materials are not in this repo.** RedPen was built as a 36-hour take-home for
> an AI/ML product engineering internship. The question paper, model answer and rubric were
> supplied by the company and aren't mine to publish, so `fixtures/provided/` is empty here.
> The app and the test suite need `fixtures/provided/rubric.json`; everything else —
> the student answer papers, the error key, the cases and the code — is my own.

```bash
npm install
npm run seed      # generates the student answer papers into fixtures/
npm run dev       # API on :5174, web app on :5173
```

Open <http://localhost:5173>, upload `fixtures/student-answer.pdf` as the student answer,
and press **Grade this paper**.

**No API key is required.** Without one the app runs on its deterministic offline grader
and labels every result as degraded.

To grade for real, `cp .env.example .env` and set **one** of:

| Key | Cost | Sees diagrams? | Notes |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | paid | yes | Best quality. `claude-opus-5` by default. |
| `GEMINI_API_KEY` | **free** | **yes** | <https://aistudio.google.com/apikey>. `gemini-flash-latest`. |
| `GROQ_API_KEY` | **free** | no | <https://console.groq.com/keys>. Much faster, generous limits. |

`GRADER_PROVIDER=auto` (the default) prefers Claude, then Gemini, then Groq, then the
offline grader. Force one with `anthropic`, `gemini`, `groq` or `mock`.

**Which free option to pick.** Gemini accepts the answer PDF, so it can mark the circuit
diagram and the supply/demand graph - two of the three questions. Groq is text-only and
considerably faster, which makes it a good demo option and a fallback if Gemini's free
tier throttles; on Groq the two diagram questions are explicitly flagged for human review
rather than guessed at. That degradation is deliberate and tested: the Groq adapter drops
the PDF, which switches the prompt to the branch that tells the model it cannot see the
diagrams and must lower its confidence.

Groq speaks the OpenAI chat-completions format, so `GROQ_BASE_URL` also points that same
adapter at OpenRouter, Together, vLLM or LM Studio with no code change.

`.env` is gitignored and no key is ever committed.

### Other commands

| Command | What it does |
|---|---|
| `npm test` | Runs the 102-test suite (no network, no API key) |
| `npm run seed` | Regenerates the answer papers in `fixtures/` |
| `npm run example` | Writes `fixtures/example-annotated.pdf` — a worked annotated paper |
| `npm run build` | Type-checks and builds both packages |

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | *(unset)* | Enables the Claude grader. |
| `GEMINI_API_KEY` | *(unset)* | Enables the Gemini grader (free tier). |
| `GROQ_API_KEY` | *(unset)* | Enables the Groq grader (free tier, text-only). |
| `GRADER_PROVIDER` | `auto` | `auto` \| `anthropic` \| `gemini` \| `groq` \| `mock`. |
| `GRADER_MODEL` | `claude-opus-5` | Claude model id. |
| `GEMINI_MODEL` | `gemini-flash-latest` | Gemini model id. |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Groq model id. |
| `GROQ_BASE_URL` | Groq | Any OpenAI-compatible endpoint. |
| `PORT` | `5174` | API port. |
| `BLANK_THRESHOLD` | `40` | Characters below which a paper is treated as blank. |

---

## What is in the box

```
fixtures/
  provided/            the supplied question paper, model answer, rubric.json (not published)
  student-answer.pdf   the authored student script (the assignment deliverable)
  error-key.md         every planted mistake, its correction and the mark it costs
  cases/               correct / incorrect / blank / OCR-damaged answer papers
  example-annotated.pdf  a worked annotated output
server/                Express + TypeScript API, grading pipeline, tests
web/                   React + TypeScript UI with the PDF annotation editor
scripts/               generators for the answer papers and the example export
docs/                  captured test output
ARCHITECTURE.md        how it works and why
```

---

## The student answer paper

`fixtures/student-answer.pdf` is a two-page script written for this exercise, containing a
deliberate mix of correct points, missing points, wrong reasoning, spelling errors and
layout problems. It is **generated from code** (`scripts/make-student-answer.ts`) so that
the paper and its error key can never drift apart.

Its intended mark is **6 / 15**, and `fixtures/error-key.md` lists all 23 planted mistakes
with corrections and the rubric point each one hits. The test suite asserts that exact
breakdown, so a regression in the grader shows up as a failing test rather than as a
plausible-looking wrong number.

---

## How marking works

1. **Extract.** The PDF is read into text *with a bounding box for every run of
   characters*, plus offsets into the flat text. Those offsets are the join key that later
   turns a quote into a rectangle on the page.
2. **Grade.** The rubric, the model answer, the extracted text and the answer PDF itself
   go to the model, which returns marks, evidence quotes and annotations against a strict
   JSON schema. The PDF is sent as a document so the model can see the circuit diagram and
   the demand/supply graph — two of the three questions are marked partly on a drawing.
3. **Reconcile.** The model's judgements are kept; its arithmetic is not. Totals are
   recomputed from the rubric points, marks are clamped, skipped rubric points are filled
   in, and unknown rubric ids are discarded. Every adjustment is recorded as a warning.
4. **Anchor.** Each evidence quote is located in the answer paper — exactly, then by
   fuzzy word-window search, then by a distinctive-word fallback — and turned into
   per-line rectangles. A quote that cannot be located lowers the confidence and raises a
   review flag instead of being silently dropped.
5. **Annotate.** Boxes are drawn over a *copy* of the paper with the correction in the
   margin and a leader line, plus a summary sheet listing every rubric point, its
   evidence, the review flags and any notes that could not be placed.

### The guarantees

- A mark never exceeds the rubric point's maximum, and is never negative.
- A question's total always equals the sum of its rubric points; the paper's total always
  equals the sum of its questions. These are asserted on the way out of the pipeline
  (`assertInvariants`) and a breach throws rather than returning a wrong number.
- Feedback is tied to evidence; marks awarded without a quote raise a flag.
- The uploaded original is stored byte-for-byte and only ever read.
- Every result carries a confidence value, a `needsHumanReview` flag, and the specific
  reasons behind them.

### When things go wrong

| Situation | What happens |
|---|---|
| Blank or near-blank paper | Short-circuits before any model call. Zero marks, flagged `blank_answer`, and the flag says it may be a scan needing OCR rather than a genuine zero. |
| Model unreachable, rate-limited, timed out | Falls back to the offline grader, flags `model_unavailable` with the underlying reason, and marks the result degraded. |
| Malformed model output | Tolerant parse (bare JSON, fenced JSON, JSON buried in prose), then one repair round-trip, then the offline grader. Flagged either way. |
| Marks above the maximum | Clamped, flagged `marks_clamped`, and the warning records what the model originally said. |
| Rubric points not marked | Filled in as 0 with "a teacher must mark this manually", flagged `criteria_missing`. |
| Quote not found in the paper | The annotation is kept as a margin note, confidence drops, flagged `unanchored_evidence`. |
| Corrupt or non-PDF upload | Rejected at upload time with a 415/422 and a readable message. |

---

## Editing annotations

Annotations are stored **separately from the grade**, which is what makes them editable
without re-marking. In the UI you can:

- drag a box to move it, or its corner handle to resize it;
- edit the note, the suggested correction, or the annotation type;
- retype the quoted text — the box re-locates itself by searching the paper again (a text
  search, not a re-grade);
- draw a brand-new annotation anywhere on the page;
- delete any annotation.

Every one of these is a `PATCH`/`POST`/`DELETE` against the annotation alone. No route in
`/api/gradings/:id/annotations` can change a mark or call a model, and the test suite
asserts that the marks and the grading timestamp are untouched after an edit.

---

## API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/health` | Which grader is active, and whether it is degraded |
| `GET` | `/api/rubric` | The rubric the marks are computed against |
| `POST` | `/api/documents` | Upload a PDF (`file`, `kind`); extracts text on the way in |
| `GET` | `/api/documents/:id/file` | The stored PDF, unmodified |
| `POST` | `/api/gradings` | Grade an uploaded answer |
| `GET` | `/api/gradings` | Grading history |
| `GET` | `/api/gradings/:id` | One grading with its annotations |
| `POST` | `/api/gradings/:id/annotations` | Add an annotation |
| `PATCH` | `/api/gradings/:id/annotations/:aid` | Edit or move one |
| `DELETE` | `/api/gradings/:id/annotations/:aid` | Remove one |
| `GET` | `/api/gradings/:id/export` | Download the annotated PDF |

---

## Tests

`npm test` — 102 tests, eight files, no network access and no API key. Captured output is in
[`docs/test-output.txt`](docs/test-output.txt).

The scenarios the brief asks for are in `server/tests/grading.test.ts`:

| Scenario | Assertion |
|---|---|
| Fully correct answer | 15/15, every rubric point awarded |
| Partially correct answer | exactly 6/15 with the [2, 3, 1] breakdown from the error key |
| Incorrect answer | near zero, every error carries a quote and a comment |
| Blank answer | 0/15, flagged, and the model is *never called* (asserted with a spy) |
| OCR-style spelling errors | same total as the clean paper, misspellings surface as annotations |
| Malformed model output | repaired on retry; if still bad, degrades to the offline grader |
| Model/API failure | degrades, flags `model_unavailable`, still returns a valid grade |
| Score above the maximum | clamped to 15/15 from a model that awarded 75 |

Plus: extraction and anchoring (`extraction.test.ts`), the validation and repair layer
(`validation.test.ts`), annotated-PDF geometry and content (`export.test.ts`), the Gemini
and Groq adapters' HTTP-to-contract mapping against a stubbed fetch (`gemini.test.ts`,
`groq.test.ts` - including that Groq never sends a PDF and tells the model to flag the
diagram questions), and the full HTTP flow including annotation editing and export
(`api.test.ts`).

---

## Known limitations

These are deliberate, given the time budget.

- **Scanned or handwritten papers are not OCR'd.** They extract to no text, so they are
  correctly identified as unreadable and routed to human review rather than being scored.
  Adding OCR means producing the same positioned-token structure from an OCR engine; the
  rest of the pipeline would not change.
- **The rubric is a JSON file, not parsed from the model-answer PDF.** The
  "total equals the sum of its parts" guarantee needs a machine-readable rubric whose
  arithmetic is validated on load. `fixtures/provided/rubric.json` is the transcription of
  the supplied model-answer paper; an uploaded model-answer PDF is stored and passed to
  the grader as extra reference context, but marks always come from the rubric.
- **The offline grader is a pattern matcher.** It is honest about that — it reports 0.55
  confidence and every offline grade is flagged for review. It is there so the product
  runs without an API key and degrades to something defensible, not to replace the model.
  It is weakest on Q2, where the whole point is judging reasoning quality.
- **Annotation placement assumes unrotated pages.** Page rotation is not compensated for.
- **Persistence is a JSON file.** Fine for a local marking tool, inspectable by hand; a
  real deployment would use SQLite or Postgres behind the same store interface.
- **No authentication.** Explicitly out of scope per the brief.
