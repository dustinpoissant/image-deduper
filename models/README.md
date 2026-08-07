# Bundled models

## `sscd_disc_mixup.onnx` (93.6 MiB)

The copy-detection descriptor behind the **Copy detection** tier. Committed on purpose and
bundled into the packaged app — see [tools/sscd/README.md](../tools/sscd/README.md) for why
and for how to rebuild it.

Not trained here. It's an ONNX conversion of Meta's published `sscd_disc_mixup` TorchScript
weights, produced by [tools/sscd/convert.py](../tools/sscd/convert.py), which verifies the
export against the TorchScript source and fails on mismatch (observed: `3.07e-07`, i.e.
float32 round-off). Original weights and paper:
[facebookresearch/sscd-copy-detection](https://github.com/facebookresearch/sscd-copy-detection),
[arXiv 2202.10261](https://arxiv.org/abs/2202.10261).

Resolved at runtime by [api/initSscd.js](../api/initSscd.js), which checks
`SSCD_MODEL_PATH` first (used by the calibration harness) and falls back to this folder. A
missing file disables the tier with a clear message instead of failing the scan.

DINOv2, by contrast, is **not** here — transformers.js downloads it from the HF hub on first
run. SSCD is bundled only because no public ONNX build of it exists to download.
