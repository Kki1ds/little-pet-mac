"""Draw the macOS menu bar icon (client/assets/trayTemplate.png + @2x).

A template image: black + alpha only, macOS tints it for light and dark menu bars.
小克 bust silhouette: long hair, face cut out under the bangs, sunflower hair ornament.
Shapes are drawn on a 36x36 grid (18pt @2x), rendered at 8x and box-downsampled.

    pip install cairosvg pillow numpy
    python tools/macos/tray-icon/make_tray_icon.py [preview-dir]
"""
import math, io, sys, pathlib, cairosvg, numpy as np
from PIL import Image
ASSETS=pathlib.Path(__file__).resolve().parents[3]/'client/assets'
PREVIEW=pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else None
def petals(cx,cy,r_in,r_out,n,w):
    out=[]
    for i in range(n):
        a=2*math.pi*i/n - math.pi/2
        tip=(cx+r_out*math.cos(a), cy+r_out*math.sin(a))
        l=(cx+r_in*math.cos(a-w), cy+r_in*math.sin(a-w)); r=(cx+r_in*math.cos(a+w), cy+r_in*math.sin(a+w))
        out.append(f'M{l[0]:.2f},{l[1]:.2f} L{tip[0]:.2f},{tip[1]:.2f} L{r[0]:.2f},{r[1]:.2f} Z')
    return ' '.join(out)
FX,FY=27.6,7.6
# Solid shapes: hair (crown + long locks) and dress.
POS='''
<path d="M16.8,3.0 C9.6,3.0 6.0,8.4 6.2,14.6 C6.4,19.6 5.0,23.0 3.8,26.6 C2.8,29.6 3.4,32.6 2.4,35.6 L9.8,35.6 C9.2,31.6 10.2,28.4 10.6,25.8
 L22.8,25.8 C23.6,28.6 24.4,31.8 23.8,35.6 L31.2,35.6 C30.2,32.4 30.8,29.4 29.6,26.4 C28.4,23.2 27.2,19.6 27.4,14.6 C27.6,8.4 24.0,3.0 16.8,3.0 Z"/>
<path d="M12.6,27.4 L21.0,27.4 L23.0,35.6 L10.6,35.6 Z"/>'''
# Cut-outs: face below jagged bangs, neck/collar, gaps between dress and hair, ring around the sunflower.
NEG=f'''
<path d="M9.4,14.6 C9.2,21.4 12.6,24.4 16.8,24.4 C21.0,24.4 24.4,21.4 24.2,14.6
 L22.8,18.2 L21.2,14.2 L19.2,18.6 L17.4,13.8 L15.4,18.6 L13.6,14.0 L11.8,18.4 L10.6,14.4 Z"/>
<path d="M15.0,23.6 L18.6,23.6 L18.9,26.0 L21.0,27.4 L12.6,27.4 L14.7,26.0 Z"/>
<path d="M12.6,27.4 L11.2,27.4 L9.4,35.6 L10.6,35.6 Z M21.0,27.4 L22.4,27.4 L24.6,35.6 L23.0,35.6 Z"/>
<circle cx="{FX}" cy="{FY}" r="5.4"/>'''
TOP=f'<path d="{petals(FX,FY,1.2,4.4,9,0.36)}"/><circle cx="{FX}" cy="{FY}" r="1.9"/>'
def render(body,px):
    doc=f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">{body}</svg>'
    im=Image.open(io.BytesIO(cairosvg.svg2png(bytestring=doc.encode(),output_width=px,output_height=px))).convert('RGBA')
    return np.asarray(im.split()[3],dtype=np.float32)/255
def build(px):
    S=px*8
    a=np.maximum(render(POS,S)*(1-render(NEG,S)),render(TOP,S))
    al=Image.fromarray((a*255).round().astype('uint8'),'L').resize((px,px),Image.BOX)
    out=Image.new('RGBA',(px,px),(0,0,0,0));out.putalpha(al);return out
for name,px in (('trayTemplate.png',18),('trayTemplate@2x.png',36)):
    build(px).save(ASSETS/name,optimize=True)
if PREVIEW is None:sys.exit()
PREVIEW.mkdir(parents=True,exist_ok=True)
icon=Image.open(ASSETS/'trayTemplate@2x.png').split()[3]
prev=Image.new('RGB',(36*8*2+40,36*8+20),(128,128,128))
for i,(bg,fg) in enumerate((((236,236,236),(0,0,0)),((40,40,40),(255,255,255)))):
    a=icon
    tile=Image.new('RGB',(36,36),bg);tile.paste(fg,(0,0),a)
    prev.paste(tile.resize((288,288),Image.NEAREST),(10+i*308,10))
prev.save(PREVIEW/'preview.png')
strip=Image.new('RGB',(260,60),(236,236,236))
for i,n in enumerate(('trayTemplate.png','trayTemplate@2x.png')):
    a=Image.open(ASSETS/n).split()[3]; strip.paste((0,0,0),(20+i*60,10),a)
dark=Image.new('RGB',(60,60),(40,40,40));dark.paste((255,255,255),(10,10),icon);strip.paste(dark,(180,0))
strip.save(PREVIEW/'actual.png')
