#!/usr/bin/env python3
"""Convert a model2vec/potion static embedding into codeindex's model.json.

Maintainer one-shot tool. NOT an npm dependency — the published package ships
zero model assets; this only produces the asset attached to the GitHub release
`embed-model-v1`. It is fully reproducible: the HuggingFace revision is pinned
and the quantization is deterministic, so running it twice yields byte-identical
output (same sha256).

The engine's encoder (src/embed/encode.ts) is the compatibility contract:

  * it lowercases + strips accents (foldText NFKD) and splits on non-[a-z0-9],
    so every vocab entry it can ever gather is `[a-z0-9]+` or a `##[a-z0-9]+`
    WordPiece continuation, plus the `[UNK]` OOV row;
  * it mean-pools the gathered rows then L2-normalizes, so a single *global*
    scale on the weight matrix is invisible to ranking — int8 quantization at
    one shared scale is exact up to per-value rounding, and no scale needs to
    be stored in the file.

potion-base-8M's tokenizer IS BERT WordPiece (`##` continuation, uncased,
strip-accents), so its vocab drops straight into that contract. Fidelity to the
original HF tokenizer is deliberately NOT required (docs/SEMANTIC.md): query and
corpus are both encoded by the same JS encoder, so self-consistency is all that
matters.

Usage:
    python convert.py --out /path/to/model.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

import numpy as np
from huggingface_hub import snapshot_download
from model2vec import StaticModel

# Pinned for reproducibility. Bump both together when re-cutting the asset.
REPO_ID = "minishlab/potion-base-8M"
REVISION = "bf8b056651a2c21b8d2565580b8569da283cab23"

UNK = "[UNK]"
# The engine's wordpiece alphabet: a first piece `[a-z0-9]+` or a `##`-prefixed
# continuation of the same. Anything else (punctuation, CJK, [PAD]/[CLS]/…) is a
# row the encoder can never look up, so it is dropped as dead weight.
MATCHABLE = re.compile(r"^(?:##)?[a-z0-9]+$")


def convert(out_path: Path) -> None:
    # Pin the exact revision: snapshot_download resolves the commit hash from the
    # local HF cache (or fetches it once), then StaticModel reads that dir.
    local_dir = snapshot_download(REPO_ID, revision=REVISION)
    model = StaticModel.from_pretrained(local_dir, force_download=False)

    embedding = np.asarray(model.embedding, dtype=np.float32)
    vocab = model.tokenizer.get_vocab()  # token -> id
    dim = int(embedding.shape[1])
    if embedding.shape[0] != len(vocab):
        raise SystemExit(
            f"embedding rows {embedding.shape[0]} != vocab size {len(vocab)}"
        )

    # Deterministic int8 quantization at one global scale. np.rint is
    # round-half-to-even (the same tie-break the engine's quantize() uses).
    global_max = float(np.abs(embedding).max())
    scale = 127.0 / global_max
    quantized = np.clip(np.rint(embedding * scale), -127, 127).astype(np.int8)

    # Keep only engine-matchable rows + the UNK row, ordered by original token id
    # (stable, reproducible from the pinned revision — no timestamps, no sort by
    # a floating quantity).
    id_to_tok = {tid: tok for tok, tid in vocab.items()}
    kept_vocab: list[str] = []
    kept_weights: list[list[int]] = []
    for tid in sorted(id_to_tok):
        tok = id_to_tok[tid]
        if tok == UNK or MATCHABLE.match(tok):
            kept_vocab.append(tok)
            kept_weights.append(quantized[tid].tolist())

    if UNK not in kept_vocab:
        raise SystemExit(f"{UNK} row missing from source vocab — cannot build OOV fallback")

    payload = {
        "modelId": f"{REPO_ID}@{REVISION}",
        "dim": dim,
        "unk": UNK,
        "vocab": kept_vocab,
        "weights": kept_weights,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Compact, ASCII, fixed key order → byte-deterministic across runs.
    text = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    out_path.write_text(text, encoding="utf-8")

    sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    zeroed = int((quantized == 0).all(axis=1).sum())
    print(f"source     : {REPO_ID}@{REVISION} (MIT)", file=sys.stderr)
    print(f"dim        : {dim}", file=sys.stderr)
    print(f"vocab (src): {len(vocab)}  ->  kept {len(kept_vocab)} matchable rows", file=sys.stderr)
    print(f"quant      : global int8, scale=127/{global_max:.6f}, all-zero rows={zeroed}", file=sys.stderr)
    print(f"bytes      : {len(text)}", file=sys.stderr)
    print(f"sha256     : {sha}", file=sys.stderr)
    print(f"written    : {out_path}", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(description="Build codeindex model.json from potion-base-8M.")
    ap.add_argument("--out", required=True, type=Path, help="destination model.json path")
    args = ap.parse_args()
    convert(args.out)


if __name__ == "__main__":
    main()
