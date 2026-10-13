# tinybenchmarks

Tiny LLM benchmarks: each bite in `bites/` is a YAML file (prompt, cases, expected answers, deterministic metrics). See README.md for the bite format.

- `lib.ts`: pure logic (loading and validating bites, templates, JSON parsing, metrics, reports). No network.
- `tb.ts`: CLI, the OpenAI-compatible client (cache in `.cache/`, retries, timeout) and the concurrent runner.
- `data/<bite>/`: files a bite references (e.g. photos); paths in the YAML are relative to `bites/`.
- `test/lib.test.ts`: uses a fake model. Tests must never call a real API.

## Commands

- `npm test && npm run typecheck`: run both before committing.
- `npm test` also loads every bite in `bites/` and checks its files exist: use it to validate a new bite without spending tokens.
- `node tb.ts <bite>`: a real run. It spends tokens, so don't run it unless asked.

## Rules

- Everything in the repo is in English: code, comments, output, docs, commit messages and bite content.
- Expected values come from a human who checked them. Never fill them in from a model's own reading of a photo or document, yours included: the benchmark would then measure agreement with that model.
- Each question must have exactly one correct answer. Spell out the edge rules in the question (e.g. how to count a product cut off at the edge, or a bag placed backwards).
- Keep it minimal: no new dependencies or abstractions without a concrete need.
