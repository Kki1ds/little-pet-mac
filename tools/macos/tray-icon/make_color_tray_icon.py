"""Cut 小克's head out of client/assets/app.png for a colour menu bar icon.

Writes client/assets/trayColor.png (26x18) and trayColor@2x.png (52x36). Not a template
image, so macOS shows it as is on light and dark menu bars. The background around the
sticker outline is flood-filled away; the crop stops above the sign she holds.

    python tools/macos/tray-icon/make_color_tray_icon.py
"""
import pathlib
import numpy as np
from PIL import Image, ImageDraw

ASSETS = pathlib.Path(__file__).resolve().parents[3] / 'client/assets'
HEAD = (120, 46, 920, 600)  # on the 1024x1024 app icon; width:height = 26:18

src = Image.open(ASSETS / 'app.png').convert('RGBA').resize((1024, 1024), Image.LANCZOS)
key = src.convert('RGB')
for seed in [(2, 2), (1021, 2), (2, 1021), (1021, 1021), (512, 4), (4, 512), (1019, 512)]:
    ImageDraw.floodfill(key, seed, (255, 0, 255), thresh=40)
k = np.asarray(key)
rgba = np.array(src)
rgba[(k[:, :, 0] == 255) & (k[:, :, 1] == 0) & (k[:, :, 2] == 255), 3] = 0
head = Image.fromarray(rgba).crop(HEAD)
for name, (w, h) in (('trayColor.png', (26, 18)), ('trayColor@2x.png', (52, 36))):
    head.resize((w * 4, h * 4), Image.LANCZOS).resize((w, h), Image.LANCZOS).save(ASSETS / name, optimize=True)
