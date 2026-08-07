"""
Convert the SSCD TorchScript copy-detection model to ONNX so it can run under
onnxruntime-node alongside the existing DINOv2 export.

SSCD ships TorchScript only (no official ONNX — upstream tells people to file a feature
request), so this is a one-time, offline dev step. The app ships the resulting .onnx and
never needs PyTorch.

Input contract (from the upstream README):
  - 320x320 RGB, or small-edge-288 preserving aspect. We use fixed 320x320: it's one of the
    two sanctioned options, gives ONNX a static shape, and keeps the aspect distortion
    identical for both images in a pair (which is what matters for copy detection).
  - ImageNet normalization: mean [0.485,0.456,0.406], std [0.229,0.224,0.225]
  - GeM pooling is already inside the TorchScript; output is a 512-d L2-normalized vector.
"""
import sys
import torch

SRC = "sscd_disc_mixup.torchscript.pt"
DST = "sscd_disc_mixup.onnx"
SIZE = 320

def main():
    print(f"torch {torch.__version__}")
    model = torch.jit.load(SRC, map_location="cpu")
    model.eval()

    dummy = torch.randn(1, 3, SIZE, SIZE)
    with torch.no_grad():
        ref = model(dummy)
    print(f"torchscript output: shape={tuple(ref.shape)} dtype={ref.dtype} "
          f"L2norm={float(torch.linalg.norm(ref[0])):.6f}")

    torch.onnx.export(
        model,
        dummy,
        DST,
        input_names=["image"],
        output_names=["embedding"],
        # Batch stays dynamic so the app can embed several images per call; spatial dims are
        # fixed because we always feed exactly 320x320.
        dynamic_axes={"image": {0: "batch"}, "embedding": {0: "batch"}},
        opset_version=17,
        do_constant_folding=True,
        # torch>=2.6 defaults to the dynamo exporter, which can't take dynamic_axes for a
        # ScriptModule. This model IS TorchScript, so the legacy exporter is the right path.
        dynamo=False,
    )
    print(f"wrote {DST}")

    # Parity check against the TorchScript source on random input. A silent mismatch here
    # would poison every embedding downstream, so fail loudly rather than warn.
    try:
        import onnxruntime as ort
    except ImportError:
        print("onnxruntime not installed in this venv — skipping parity check")
        return
    sess = ort.InferenceSession(DST, providers=["CPUExecutionProvider"])
    got = sess.run(["embedding"], {"image": dummy.numpy()})[0]
    diff = float(torch.max(torch.abs(ref - torch.from_numpy(got))))
    print(f"max abs diff torchscript vs onnx: {diff:.3e}")
    if diff > 1e-4:
        print("PARITY FAILURE — export is not faithful")
        sys.exit(1)
    print("parity OK")

if __name__ == "__main__":
    main()
