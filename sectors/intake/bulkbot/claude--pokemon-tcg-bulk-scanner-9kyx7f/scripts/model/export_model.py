"""
Exports the on-device card embedding model ("cardnet") to TensorFlow.js.

Backbone: Keras MobileNetV3 (ImageNet weights, includes its own [0,255] -> [-1,1] rescaling).
Head:     generalized-mean (GeM, p=3) pooling over three regions of the final feature map
          - whole card       (layout, colors, frame/era style)
          - artwork window   (what makes two cards with the same frame different)
          - footer strip     (set symbol, number block, regulation mark, rarity)
          each region is L2-normalized, then concatenated.
Input:    1 x 320 x 224 x 3 float32 RGB in [0, 255] (the card warped upright, 63:88-ish).

The PCA projection that turns this into the compact index vector is computed by
scripts/build-index.ts from the card images and shipped with the index, so the model
never has to be re-exported when new sets are added.

Usage:
  python3 -m venv .venv && . .venv/bin/activate
  pip install -r scripts/model/requirements.txt
  pip install --no-deps tensorflowjs==4.22.0
  python3 scripts/model/export_model.py [--variant large|small] [--out public/models/cardnet-v1]
"""
import argparse
import json
import os

# oneDNN graph rewrites fuse hard-swish into convs (_FusedHardSwish), which TF.js cannot run.
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
import shutil
import sys
import tempfile

import numpy as np
import tensorflow as tf

H, W = 320, 224
# Feature map is (H/32) x (W/32) = 10 x 7. Rows are 10% of card height each.
ART_ROWS = (1, 5)      # rows 1..4  -> card y in [10%, 50%]
FOOT_ROWS = (8, 10)    # rows 8..9  -> bottom 20% of the card
GEM_P = 3.0


def gem(x, p=GEM_P, eps=1e-6):
    x = tf.maximum(x, eps)
    return tf.pow(tf.reduce_mean(tf.pow(x, p), axis=[1, 2]), 1.0 / p)


def l2n(x):
    return x / (tf.norm(x, axis=-1, keepdims=True) + 1e-8)


def build(variant: str):
    ctor = tf.keras.applications.MobileNetV3Large if variant == "large" else tf.keras.applications.MobileNetV3Small
    backbone = ctor(input_shape=(H, W, 3), include_top=False, weights="imagenet", include_preprocessing=True)
    backbone.trainable = False

    @tf.function(input_signature=[tf.TensorSpec([None, H, W, 3], tf.float32, name="image")])
    def embed(image):
        fm = backbone(image, training=False)              # [B, 10, 7, C]
        fm = tf.nn.relu(fm)
        g = l2n(gem(fm))
        a = l2n(gem(fm[:, ART_ROWS[0]:ART_ROWS[1], :, :]))
        f = l2n(gem(fm[:, FOOT_ROWS[0]:FOOT_ROWS[1], :, :]))
        return {"features": tf.concat([g, a, f], axis=-1, name="features")}

    return backbone, embed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default="large", choices=["large", "small"])
    ap.add_argument("--out", default=os.path.join("public", "models", "cardnet-v1"))
    ap.add_argument("--quantize", default="float16", choices=["float16", "uint8", "none"])
    args = ap.parse_args()

    backbone, embed = build(args.variant)
    probe = embed(tf.zeros([1, H, W, 3]))["features"]
    feat_dim = int(probe.shape[-1])
    print(f"backbone={backbone.name} feature_dim={feat_dim}")

    tmp = tempfile.mkdtemp()
    saved = os.path.join(tmp, "saved")
    module = tf.Module()
    module.backbone = backbone
    module.embed = embed
    tf.saved_model.save(module, saved, signatures={"serving_default": embed})

    if os.path.exists(args.out):
        shutil.rmtree(args.out)
    # tensorflowjs imports tensorflow_decision_forests unconditionally; it is optional for this model.
    import types
    sys.modules.setdefault("tensorflow_decision_forests", types.ModuleType("tensorflow_decision_forests"))
    from tensorflowjs.converters import tf_saved_model_conversion_v2 as tfjs_conv
    qmap = None
    if args.quantize == "float16":
        qmap = {"float16": True}
    elif args.quantize == "uint8":
        qmap = {"uint8": True}
    tfjs_conv.convert_tf_saved_model(
        saved, args.out, signature_def="serving_default", saved_model_tags="serve",
        quantization_dtype_map=qmap, weight_shard_size_bytes=4 * 1024 * 1024)

    meta = {
        "id": f"cardnet-v1-mnv3{args.variant[0]}-gem3",
        "inputW": W,
        "inputH": H,
        "featDim": feat_dim,
        "regions": {"art": list(ART_ROWS), "footer": list(FOOT_ROWS)},
        "input": "RGB float32 0..255, card upright, resized to 224x320",
        "quantization": args.quantize,
    }
    with open(os.path.join(args.out, "cardnet.json"), "w") as fh:
        json.dump(meta, fh, indent=2)

    # Reference output for the JS parity test: a deterministic pattern both sides can generate.
    hh, ww, cc = np.meshgrid(np.arange(H), np.arange(W), np.arange(3), indexing="ij")
    x = ((hh * 7 + ww * 13 + cc * 29) % 256).astype("float32")[None]
    ref = embed(tf.constant(x))["features"].numpy()[0]
    with open(os.path.join(args.out, "parity.json"), "w") as fh:
        json.dump({"pattern": "(h*7 + w*13 + c*29) % 256", "first16": ref[:16].round(6).tolist(),
                   "sum": float(ref.sum()), "dim": int(ref.shape[0])}, fh)
    print("exported to", args.out)


if __name__ == "__main__":
    main()
