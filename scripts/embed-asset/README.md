# Static-embedding asset toolchain

Maintainer-only, one-shot tool that produces the `model.json` published as the
GitHub release [`embed-model-v1`](https://github.com/maxgfr/codeindex/releases/tag/embed-model-v1).
It is **not** an npm dependency: the published package ships zero model assets
(`tests/pack-smoke.test.ts` asserts it), and the engine fetches the asset lazily
via `codeindex embed pull`.

## Source model

| | |
|---|---|
| model | [`minishlab/potion-base-8M`](https://huggingface.co/minishlab/potion-base-8M) |
| revision | `bf8b056651a2c21b8d2565580b8569da283cab23` (pinned in `convert.py`) |
| license | **MIT** (model card frontmatter) |
| kind | model2vec / potion static embedding — a `token → row` lookup table, no neural forward pass |
| dim | 256 (PCA'd), 29 528-token WordPiece vocab |

potion-base-8M is a distillation of `baai/bge-base-en-v1.5`; its tokenizer is
BERT **WordPiece** (`##` continuation, uncased, accent-stripping) — the exact
alphabet the engine's pure-JS encoder (`src/embed/encode.ts`) already tokenizes
into.

## Why the conversion is faithful (the compatibility contract)

The engine encoder is the contract, and it is documented as self-consistent by
design (`docs/SEMANTIC.md`): the corpus **and** the query are encoded by the same
JS encoder, so fidelity to the original HF tokenizer is *not* required — only
that every vocab entry the encoder can gather is present.

Two facts make potion-base-8M drop straight in:

1. **Tokenizer alphabet matches.** The encoder folds text (NFKD + strip combining
   marks), lowercases, splits on non-`[a-z0-9]`, then does greedy-longest
   WordPiece with `##` continuations. potion's vocab is already lowercase,
   accent-stripped WordPiece with `##`. `convert.py` keeps exactly the rows the
   encoder can ever look up — tokens matching `^(?:##)?[a-z0-9]+$` — plus the
   `[UNK]` OOV row, and drops the ~2 000 punctuation / CJK / `[PAD]`/`[CLS]`/…
   rows that the encoder could never gather (27 559 of 29 528 rows kept). No
   entry is rewritten, so nothing collides.

2. **A single global int8 scale is invisible to ranking.** The encoder mean-pools
   the gathered rows then L2-normalizes, so multiplying the whole matrix by one
   constant cancels out. `convert.py` quantizes at `scale = 127 / max(|E|)`
   (round-half-to-even via `np.rint`, clamp to `[-127, 127]`) and stores the
   int8 integers directly — no scale field is needed in `model.json`, and the
   direction of every encoded vector is preserved up to per-value rounding. Only
   2 of 29 528 rows (the lowest-norm, zipf-downweighted tokens) round to all-zero.

## `model.json` shape (validated by `loadEmbedModel`)

```json
{ "modelId": "minishlab/potion-base-8M@<rev>", "dim": 256, "unk": "[UNK]",
  "vocab": ["[UNK]", "the", "##ing", "..."], "weights": [[-3, 12, ...], ...] }
```

`vocab[i]` is the token whose int8 row is `weights[i]` (length `dim`).

## Reproduce

```sh
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python convert.py --out model.json
```

The build is **deterministic**: the HF revision is pinned and the quantization
uses fixed rounding, so two runs produce byte-identical output. Verify with
`shasum -a 256 model.json` — it must match the sha256 recorded in the engine
(`EMBED_ASSET_SHA256` in `src/embed/model.ts`) and in the release notes.

## Publish

```sh
gh release create embed-model-v1 \
  --title "Static embedding model v1" \
  --notes "…source + revision + MIT + sha256 + reproduction…" \
  model.json
```

The tag is deliberately **not** `v<semver>`: semantic-release owns the `v*`
namespace, and every CI workflow triggers only on `push` to `main`, so a
`gh`-created release fires nothing.
