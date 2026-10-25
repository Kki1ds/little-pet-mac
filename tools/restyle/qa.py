"""Debug sheet: every k-th frame of a clip with the iris mask in green."""
import sys, json, subprocess
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import numpy as np, recolor
from PIL import Image
src, outp, step = sys.argv[1], sys.argv[2], int(sys.argv[3])
info = json.loads(subprocess.check_output(['ffprobe','-v','error','-select_streams','v:0','-show_entries','stream=width,height','-of','json',src]))['streams'][0]
w,h = info['width'], info['height']
dec = subprocess.Popen(['ffmpeg','-v','error','-c:v','libvpx-vp9','-i',src,'-f','rawvideo','-pix_fmt','rgba','-'],stdout=subprocess.PIPE)
t = recolor.FaceTracker(); tiles=[]; i=0
while True:
    b = dec.stdout.read(w*h*4)
    if len(b) < w*h*4: break
    f = np.frombuffer(b,np.uint8).reshape(h,w,4)
    out, em, box = recolor.recolor(f, t, debug=True)
    if i % step == 0:
        d = out.copy(); d[em>0.3] = [0,255,0,255]
        tiles.append(Image.fromarray(d))
    i += 1
bb = None
for im in tiles:
    b = im.getbbox()
    if b: bb = b if bb is None else (min(bb[0],b[0]),min(bb[1],b[1]),max(bb[2],b[2]),max(bb[3],b[3]))
tiles = [im.crop(bb) for im in tiles]
tw, th = tiles[0].size; cols = 6; rows = (len(tiles)+cols-1)//cols
sh = Image.new('RGBA',(tw*cols, th*rows),(205,205,205,255))
for k,im in enumerate(tiles): sh.alpha_composite(im,((k%cols)*tw,(k//cols)*th))
sh.thumbnail((1500,1500)); sh.save(outp)
