# Bundled ONNX models

## selfie_segmentation_256x256.onnx

- **What:** MediaPipe Selfie Segmentation, single-person foreground/background
  segmentation. Input `input_1:0` float32 `[1, 256, 256, 3]` RGB in [0, 1];
  output `activation_10` float32 `[1, 256, 256, 1]` foreground probability.
- **Source:** Google MediaPipe, converted to ONNX by PINTO0309's model zoo
  (`109_Selfie_Segmentation`, `model_float32.onnx`), downloaded 2026-11-17
  from https://s3.ap-northeast-2.wasabisys.com/pinto-model-zoo/109_Selfie_Segmentation/resources.tar.gz
  (tarball 7,399,012 bytes; this file 447,658 bytes, md5
  `0244992cbc250eb80b14b070d46b4b7c`).
- **License:** Apache License 2.0 (see the PINTO folder LICENSE and the
  MediaPipe model card). Commercial use is allowed; keep this attribution
  when distributing the file. No model from CapCut/Jianying/FCP was used.
- **Measured on this machine (2026-11-17, Linux, CPU, onnxruntime 1.32.0):**
  inference median ~3.7 ms/frame at the fixed 256x256 input (mean ~8 ms
  including first-run warmup), outputs bit-identical across repeated runs.
  Real-photo quality: foreground share 55–67%, uncertain band (0.1–0.9)
  only ~1.25% of pixels (sharp, confident edges). A flat-colour synthetic
  "person" scores ~0 — the model only fires on real human images.
- **Runtime:** the TypeScript engine calls `scripts/portrait_segment.py`
  (Python + onnxruntime, same pattern as `scripts/transcribe.py` for
  faster-whisper). On Windows the same interface will be served natively
  by Microsoft.ML.OnnxRuntime (NuGet); the Python script is the Linux
  reference implementation.

## Models deliberately NOT bundled (2026-11-17)

- **MODNet** (`078_MODNet`): weights are CC BY-NC-SA 4.0 — NonCommercial,
  so they cannot ship in a paid product. Bundle was also 2.28 GB.
  Rejected on license, not downloaded.
- **Robust Video Matting** (`242_RobustVideoMatting`): weights are GPL-3.0,
  bundle 1.08 GB. Rejected on license + size, not downloaded.
