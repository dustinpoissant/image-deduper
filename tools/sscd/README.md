# SSCD copy-detection model — conversion

The SSCD tier uses `sscd_disc_mixup`, a copy-detection descriptor from
["A Self-Supervised Descriptor for Image Copy Detection"](https://arxiv.org/abs/2202.10261)
(Pizzi et al., CVPR 2022).

## Why this tier exists

DINOv2 is a general-purpose *semantic* model. Rating "same person, same pose, different
outfit and location" as highly similar is what it was trained to do — which is exactly the
false positive that shows up on a real photo library. SSCD is trained on the opposite
objective: match transformed **copies of one image**, and explicitly **not** different
photos of the same subject.

Measured over `example/` (11,200 pairs, 240 true duplicates), scoring the raw cosine:

| | DINOv2 | SSCD |
| --- | --- | --- |
| worst non-duplicate | 0.9379 | **0.3369** |
| hardest true duplicate | 0.7093 | 0.4379 |
| separable? | **no — they overlap** | **yes, 0.10 gap** |
| best split | 98.3% recall @ 0.90% FPR | **100% recall @ 0.00% FPR** |
| `zoomed` variant recall | 93% | **100%** |
| speed | slower | 34 ms/image |

The pair that forced `remapEmbed`'s boundary up to 0.938 (`nissan-370z` vs
`toyota-celica`, two different cars) scores **0.938 under DINOv2 and 0.143 under SSCD**.

## Converting

Upstream ships TorchScript only — there is no official ONNX, and the HF mirror
(`m3/sscd-copy-detection`) carries `.pt` files with a stub `model.safetensors`. So the
`.onnx` is produced here, once, offline. The app never needs PyTorch at runtime.

```bash
python -m venv venv
./venv/Scripts/python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
./venv/Scripts/python -m pip install onnx onnxruntime onnxscript

curl -L -o sscd_disc_mixup.torchscript.pt \
  https://huggingface.co/m3/sscd-copy-detection/resolve/main/sscd_disc_mixup.torchscript.pt

./venv/Scripts/python convert.py
```

`convert.py` verifies parity against the TorchScript source and fails loudly on mismatch —
a silent divergence here would poison every embedding downstream. Observed: `3.07e-07`.

`onnxscript` is required because torch >= 2.9 defaults to the dynamo exporter; the script
passes `dynamo=False` since this model is a `ScriptModule` and needs the legacy path.

## Do NOT ship the int8 build

`quantize.py` produces a 24.8 MB int8 version (25% of fp32) that is **8.8x slower**
(299 ms/image vs 34 ms) because dynamic quantization overhead dominates without efficient
int8 kernels for these ops. Accuracy holds on the example set, but per-descriptor fidelity
drops to 0.796 cosine worst-case. The script is kept only to document that this was
measured and rejected — size should be solved by distribution, not quantization.

## Distribution

`models/sscd_disc_mixup.onnx` is **committed to this repo and bundled into the packaged
app**. Unlike DINOv2 — which transformers.js downloads from the HF hub on first run —
there is no public ONNX build of SSCD to download, so shipping it is the only way the tier
works out of the box.

This is safe with `kempo-app`'s packaging because it builds with `asar: false`
(`node_modules/kempo-app/bin/kempo-app.js`), so `models/` is copied into
`resources/app/models/` as a real directory. `onnxruntime-node` is native code and cannot
read out of an asar archive, so an asar build would have needed `asarUnpack`.

At 93.6 MiB it sits under GitHub's 100 MiB per-file hard limit with ~6 MiB to spare, but it
is past the 50 MiB warning threshold and lives in git history permanently. **If the model is
ever replaced with a larger one, move to `git lfs track "*.onnx"` rather than trying to
squeeze under the cap.**

Uploading this export to the HF hub would also make it the first public ONNX build of SSCD
— upstream's README explicitly invites format requests.

## Input contract

320x320 RGB, ImageNet normalization (mean `[0.485,0.456,0.406]`, std `[0.229,0.224,0.225]`),
NCHW float32. GeM pooling is inside the graph; output is a 512-d L2-normalized descriptor,
so it feeds the same `cosine()` comparison the DINOv2 embeddings use. Implemented in
[`src/sscd.js`](../../src/sscd.js).

Upstream suggests cosine > 0.75 for copies at 90% precision, but that is measured on DISC
with ~1M distractors. On `example/`, the worst non-duplicate scores 0.3369 and the hardest
true duplicate scores 0.4379 — `remapSscd` in `lib/engine.js` anchors its 50% boundary at
0.39, the middle of that gap, not either endpoint. A personal library sits between the
upstream number and what `example/` shows — calibrate against real data (`tools/calibrate.js`)
rather than adopting either number as-is.
