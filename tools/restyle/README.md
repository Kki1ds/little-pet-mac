# Restyle tools (private)

Recolors the ojousama clips: orange hair to orange-red, orange eyes to amber gold.
Needs `ffmpeg` with libvpx, `numpy`, `Pillow` and `opencv-python-headless<5`
(OpenCV 5 dropped `CascadeClassifier`).

```sh
python tools/restyle/process.py in.webm out.webm [crf]   # recolor one clip
python tools/restyle/qa.py in.webm sheet.png 10          # every 10th frame, iris mask in green
```

Tuning lives at the top of `recolor.py` (`HAIR_SHIFT`, `HAIR_SAT`, `HAIR_VAL`, `EYE_HUE`...).
Run it on the original clips (git history), not on already recolored ones.
`lbpcascade_animeface.xml` is from https://github.com/nagadomi/lbpcascade_animeface (MIT).
