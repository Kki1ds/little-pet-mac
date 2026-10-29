/* Reference-canvas display calibration. Does not resize the pet's physics stage. */
(function (root) {
  'use strict';
  const reference = Object.freeze({ width:1280, height:960, subjectLeft:405, subjectRight:880, subjectTop:268, subjectBottom:851, subjectHeight:583 });
  const previousReference = Object.freeze({ width:1280, height:1000, subjectLeft:405, subjectRight:875, subjectTop:298, subjectBottom:879, subjectHeight:582 });
  // Engine floor (FEET_Y/CANVAS_H = 330/360 of the stage) in 1280-wide stage units.
  const floor = 660;
  // Standing feet line per character and canvas, in source pixels (median over the clips).
  // Characters listed here are moved onto `floor`; the rest keep the original layout.
  const feetLines = Object.freeze({
    Claude: Object.freeze({ '640x360':329, '1280x720':630, '1280x960':878 }),
    Grok: Object.freeze({ '1280x720':634, '1280x960':851 }),
    GPT: Object.freeze({ '1280x720':630, '1280x960':850 }),
  });
  function layout(width, height, petSize, assetRoot) {
    if (![width,height,petSize].every(n=>Number.isFinite(n)&&n>0)) return null;
    const feet = feetLines[assetRoot]?.[`${width}x${height}`];
    // 16:9 clips fill the stage; only a calibrated character needs a vertical shift.
    if (Math.abs(width*9-height*16)<1) {
      if (!feet) return null;
      const scale = petSize/width;
      return {
        profile:'脚底对齐16:9',
        width:petSize,
        height:height*scale,
        left:0,
        top:petSize*floor/1280-feet*scale,
        scale,
        footOrigin:`50% ${feet/height*100}%`,
      };
    }
    // Exact 1280x960 and integer multiples only: legacy 960x720 must keep its layout.
    const isNew = width>=1280 && width%1280===0 && height===width*3/4;
    const ref = isNew ? reference : previousReference;
    if (!isNew && Math.abs(width/height-previousReference.width/previousReference.height)>0.002) return null;
    // White dragon calibration measured from its actual idle first frame (1280x720).
    const idle = isNew && assetRoot==='GPT' ? {height:532,feet:632} : {height:535,feet:634};
    const subjectHeight = petSize*idle.height/1280;
    const scale = subjectHeight/ref.subjectHeight;
    const bottom = feet || ref.subjectBottom;
    return {
      profile:isNew?'参考画幅1280x960':'参考画幅1280x1000',
      width:ref.width*scale,
      height:ref.height*scale,
      left:petSize/2-(ref.subjectLeft+ref.subjectRight)/2*scale,
      top:petSize*(feet?floor:idle.feet)/1280-bottom*scale,
      scale,
      footOrigin:`${(ref.subjectLeft+ref.subjectRight)/2/ref.width*100}% ${bottom/ref.height*100}%`,
    };
  }
  function apply(video, petSize, assetRoot) {
    const box=layout(video.videoWidth,video.videoHeight,petSize,assetRoot);
    for(const key of ['left','top','width','height']) video.style[key]=box?box[key]+'px':'';
    if(video.dataset){if(box)video.dataset.canvasFootOrigin=box.footOrigin;else delete video.dataset.canvasFootOrigin;}
    return box;
  }
  const api={reference,feetLines,layout,apply};root.PetCanvasLayout=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
