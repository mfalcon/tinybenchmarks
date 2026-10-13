# Potential ideas

## A bite about a challenging PDF

Fixed PDF + question → JSON with a closed answer (number, date, name, `yes`/`no`/`not_found`), compared against `expected`.

- **Harness:** generalize `image` into `file` and, depending on the extension, send `image_url` or `{"type": "file"}` (base64 PDF). Still to verify: whether gpt-4.1 / gpt-5.6-* accept PDFs through Chat Completions.
- **Send the PDF directly** (not text we extract ourselves), so reading and understanding are measured together and a bad extractor of ours doesn't pollute the result.
- **Where to aim the questions:** tables (merged cells, tables split across pages), numbers that only appear in charts, footnotes that change the answer, two-column or scanned layouts, data that has to be combined across pages.
- **Trap cases** where the data isn't in the document (`expected: not_found`), to catch models that make things up.

Blocked: no PDF yet.
