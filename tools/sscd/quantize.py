"""
Dynamic int8 quantization of the SSCD ONNX export.

98 MB of fp32 sits awkwardly in git (GitHub warns >50 MB, hard-caps at 100 MB). int8
typically lands around a quarter of that. Whether the accuracy cost is acceptable is an
empirical question, so this only produces the file — the head-to-head against fp32 on the
real example set is run separately.
"""
import os
from onnxruntime.quantization import quantize_dynamic, QuantType

SRC = "sscd_disc_mixup.onnx"
DST = "sscd_disc_mixup.int8.onnx"

mb = lambda p: os.path.getsize(p) / 1e6

quantize_dynamic(
    model_input=SRC,
    model_output=DST,
    weight_type=QuantType.QInt8,
)
print(f"fp32 {mb(SRC):7.1f} MB  ->  int8 {mb(DST):7.1f} MB  ({mb(DST)/mb(SRC):.1%} of original)")
