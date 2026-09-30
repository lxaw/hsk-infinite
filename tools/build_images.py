"""Generate pictures for picture-based writing items locally with Z-Image-Turbo (mflux, Apple Silicon).

Renders every free-writing unit that has a `scene` (HSK 4 看图造句, HSK 5 看图写短文) whose picture
is missing (or all with --force) into site/images/<level>/<id>.jpg, loading the model once.
Look at every new picture: if it does not clearly show the scene, or shows any writing, change
the unit's `scene` (or add "seed") and rerun with --only <id>.

    .venv/bin/python tools/build_images.py --level hsk4 [--force] [--only ID ...]
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / "models/z-image-turbo-q8"  # made once with: mflux-save --model z-image-turbo --quantize 8 --path models/z-image-turbo-q8
# Keep the words "Chinese", "exam", "language" out of this prompt: they make the model draw
# (fake) Chinese characters into the picture.
STYLE = ("A clear, simple, realistic photograph. {scene}. "
         "Single obvious action, uncluttered plain background, natural daylight. "
         "The image contains no text, no writing, no letters, no characters, no signs, no labels, no watermark.")
args = sys.argv[1:]
LEVEL = args[args.index("--level") + 1] if "--level" in args else "hsk4"


def main():
    force = "--force" in args
    only = set(args[args.index("--only") + 1:]) if "--only" in args else None
    cfg = json.loads((ROOT / "levels" / f"{LEVEL}.json").read_text())
    out = ROOT / "site/images" / LEVEL
    out.mkdir(parents=True, exist_ok=True)
    units = []
    for s in cfg["sections"]:
        for p in s["parts"]:
            f = ROOT / "bank" / LEVEL / f"{p['id']}.json"
            if p["type"] == "free" and f.exists():
                units += [u for u in json.loads(f.read_text()) if u.get("scene")]
    todo = [u for u in units if (not only or u["id"] in only) and (force or only or not (out / f"{u['id']}.jpg").exists())]
    print(f"{LEVEL}: {len(units)} pictures, {len(todo)} to generate")
    if not todo:
        return
    from mflux.models.common.resolution.config_resolution import ConfigResolution
    from mflux.models.z_image.variants.z_image import ZImage
    path = str(MODEL) if MODEL.exists() else None  # on-the-fly quantizing swaps on a 32 GB Mac
    model = ZImage(model_config=ConfigResolution.resolve_restricted("z-image-turbo", "z-image-turbo", model_path=path),
                   quantize=None if path else 8, model_path=path)
    for k, u in enumerate(todo, 1):
        img = model.generate_image(seed=u.get("seed", 7), prompt=STYLE.format(scene=u["scene"]),
                                   num_inference_steps=9, width=768, height=576)
        (img.image if hasattr(img, "image") else img).convert("RGB").save(out / f"{u['id']}.jpg", quality=85)
        print(f"  {k}/{len(todo)} {u['id']}", flush=True)


if __name__ == "__main__":
    main()
