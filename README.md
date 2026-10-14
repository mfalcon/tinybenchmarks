# tinybenchmarks

Tiny LLM benchmarks: one task, several models, one table.
Each bite is a YAML file with a prompt, cases with the expected answer, and deterministic metrics (no LLM judge).

Requires Node ≥ 22.18 (runs TypeScript directly, no build step) and an OpenAI API key in `OPENAI_API_KEY`.
**Every run spends tokens on that account.** `npm test` doesn't: it uses a fake model.

```sh
npm install
node tb.ts negotiation                         # uses the models listed in the YAML
node tb.ts shelf --models gpt-4.1 --repeats 3
node tb.ts shelf --models gpt-6-astra@low,gpt-6-astra@high   # @ sets reasoning_effort
npm test && npm run typecheck
```

Output: per-call progress and one table row per model. Plus, in `runs/`:

- `<bite>-<date>.md`: for reading. Each call with the **full prompt** that was sent, the model's **full response**, the expected answer and the metrics.
- `<bite>-<date>.jsonl`: the same, one line per call, plus `usage` (tokens) and `finish_reason`, for processing.

Both are written as responses arrive, so nothing is lost if a run is interrupted.
Calls run concurrently, up to 8 at a time (`--concurrency n` to change it). Network errors, timeouts, malformed responses, 429 and 5xx are retried up to 3 times.
Responses are cached in `.cache/` (key: model + message + repeat number), so re-running is free.
To force fresh calls, delete `.cache/` or raise `--repeats` (each new repeat is a new call).

## Bite format

```yaml
models: [gpt-4.1, gpt-6.1-sol@high] # can be overridden with --models; @level sets reasoning_effort
prompt: |                           # {{field}} is replaced with each case's values
  ...{{text}}...
  Answer only JSON: {"label": "..."}
image: "../photos/{{photo}}"        # optional; relative to the YAML (jpg, png, webp, gif)
labels:                             # optional, for classification
  dog: "description"                #   {{labels}} in the prompt is replaced with this list
  cat: "description"                #   and expected values of `exact` fields are validated against it
metrics:                            # response JSON field → metric(s)
  label: exact
  facings: [abs_error, exact]
cases:
  - text: "..."
    expected: {label: dog}          # each case only scores the fields in its expected
```

The model's response is always parsed as JSON (tolerating ```` ```json ```` fences and surrounding text).

| Metric | What it measures |
|---|---|
| `exact` | 1 if it matches, ignoring case, accents and whitespace |
| `abs_error` | absolute difference between numbers (↓ is better) |
| `match_rate` | share of an object's keys that match with `exact` |

If the JSON is invalid or the field is missing, `exact` and `match_rate` count as 0 and `abs_error` has no value.
Those are left out of the `abs_error` mean and counted next to it, e.g. `1.20 (2 unscored)`, so a model that dodges the hard cases doesn't look better.
Expected values are type-checked when the bite loads (`abs_error` needs a number, `match_rate` an object), so a typo fails before spending tokens.
The `±` in the table is the standard deviation **across repeats**, so it only shows up with `--repeats` > 1.

Other columns: `invalid_json` (% of responses that couldn't be parsed), `off_label` (% that answered a class outside `labels`), `errors` (calls that failed after 3 attempts).

## Creating a bite with a coding agent

Open the repo in your agent (Claude Code, Codex, Cursor…) and ask for it, e.g.:

> Create a bite in `bites/<name>.yaml` that measures <task>. Follow the bite format in README.md and the rules in CLAUDE.md, and put any files it needs in `data/<name>/`. Propose the questions and the answer format, but ask me for every expected value instead of filling them in from your own reading. When it's done, run `npm test` to check that it loads.

Then read the YAML, check every expected value yourself, and run `node tb.ts <name>`.
The expected values are what make a bite trustworthy: if a model wrote them, the bite measures agreement with that model, not correctness.

## Provider

Any OpenAI Chat Completions–compatible endpoint. Defaults to OpenAI with `OPENAI_API_KEY`.
For OpenRouter: `TB_BASE_URL=https://openrouter.ai/api/v1 TB_API_KEY=$OPENROUTER_API_KEY node tb.ts ...` with models like `anthropic/...`.
Each attempt times out after 180 s (`TB_TIMEOUT=<seconds>` to change it) and is retried like a network error.

## Included bites

- `shelf`: count facings and gaps in `data/shelf/` (cases verified by hand).
- `negotiation`: diagnose 5 competencies of a seller in "The Used Car" (Lewicki), against an expert evaluator's blind labels.

## License

MIT. See [LICENSE](LICENSE).
