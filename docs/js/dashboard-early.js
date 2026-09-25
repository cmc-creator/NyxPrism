// NyxPrism dashboard: code that must run before the main module (moved out of dashboard.html).
(function(){
  var canvas=document.getElementById('nyx-live-wallpaper');
  if(!canvas)return;
  var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var wallOff=false,running=false;
  try{wallOff=localStorage.getItem('nyx_wallpaper')==='solid';}catch(e){}
  if(wallOff)canvas.style.display='none';
  window.__nyxSetWallpaper=function(mode){
    wallOff=(mode==='solid');
    canvas.style.display=wallOff?'none':'block';
    try{localStorage.setItem('nyx_wallpaper',mode);}catch(e){}
    if(!wallOff&&!running){if(reduce)draw(0);else{running=true;requestAnimationFrame(draw);}}
  };
  var ctx=canvas.getContext('2d');
  var w=0,h=0,dpr=1;
  var particles=[];
  var pointerX=0,pointerY=0,targetX=0,targetY=0;
  var palette=[194,218,252,286,318,34,148];

  function rand(min,max){return Math.random()*(max-min)+min;}

  function resize(){
    dpr=Math.min(window.devicePixelRatio||1,2);
    w=window.innerWidth;
    h=window.innerHeight;
    canvas.width=Math.floor(w*dpr);
    canvas.height=Math.floor(h*dpr);
    canvas.style.width=w+'px';
    canvas.style.height=h+'px';
    ctx.setTransform(dpr,0,0,dpr,0,0);
    build();
  }

  function build(){
    particles=[];
    if(w<680){
      particles.push(
        {x:w*.9,y:h*.17,depth:.72,radius:42,hue:218,phase:.8,driftX:.018,driftY:.012,spin:.00004,rotation:-.2,alpha:.22,sides:6,thickness:.3},
        {x:w*.05,y:h*.68,depth:.56,radius:34,hue:286,phase:2.7,driftX:-.012,driftY:.016,spin:-.000035,rotation:.35,alpha:.19,sides:5,thickness:.28},
        {x:w*.94,y:h*.86,depth:.38,radius:28,hue:32,phase:4.5,driftX:.014,driftY:-.01,spin:.00005,rotation:-.55,alpha:.16,sides:6,thickness:.24}
      );
      return;
    }
    particles.push({x:w*.81,y:h*.4,depth:1,radius:Math.min(160,w*.11),hue:218,phase:.8,driftX:.012,driftY:.008,spin:.000025,rotation:-.12,alpha:.3,sides:6,thickness:.34});
    var count=Math.max(10,Math.min(16,Math.round(w*h/80000)));
    for(var i=0;i<count;i++){
      var depth=rand(.14,.78);
      var radius=rand(24,62)*(.7+depth*.55);
      var sideBias=Math.random()<.45?rand(-.04,.12):rand(.82,1.04);
      particles.push({
        x:sideBias*w,y:rand(-.08,1.08)*h,depth:depth,radius:radius,
        hue: palette[i % palette.length] + rand(-12,18),
        phase: rand(0, Math.PI*2),
        driftX: rand(-.022,.022)*(1+depth),
        driftY: rand(-.018,.018)*(1+depth),
        spin: rand(-.00008,.00008),
        rotation: rand(0,Math.PI*2),
        alpha: .09+depth*.16,
        sides: 5+Math.floor(Math.random()*2),
        thickness: rand(.2,.36)
      });
    }
  }

  function transformPoint(px,py,rotation,scaleX,scaleY,cx,cy){
    var scaledX=px*scaleX,scaledY=py*scaleY,cos=Math.cos(rotation),sin=Math.sin(rotation);
    return [cx+scaledX*cos-scaledY*sin,cy+scaledX*sin+scaledY*cos];
  }

  function polygonPath(points){
    ctx.beginPath();
    points.forEach(function(point,index){if(index===0)ctx.moveTo(point[0],point[1]);else ctx.lineTo(point[0],point[1]);});
    ctx.closePath();
  }

  function drawGlassShard(p,t){
    var parallax=.25+p.depth*1.25;
    var x=p.x+Math.sin(t*.00016+p.phase)*(12+p.depth*32)+pointerX*parallax;
    var y=p.y+Math.cos(t*.00014+p.phase*1.3)*(10+p.depth*26)+pointerY*parallax;
    var r=p.radius;
    var rotation=p.rotation+t*p.spin;
    var orientation=p.phase+t*.00013;
    var thicknessX=Math.cos(orientation)*r*p.thickness;
    var thicknessY=Math.sin(orientation*.72)*r*p.thickness*.52;
    var frontCenter=[x-thicknessX*.22,y-thicknessY*.22];
    var backCenter=[x+thicknessX,y+thicknessY];
    var front=[],back=[];
    for(var index=0;index<p.sides;index++){
      var angle=-Math.PI/2+index*Math.PI*2/p.sides;
      var contour=index%2?.9:1;
      var px=Math.cos(angle)*contour,py=Math.sin(angle);
      front.push(transformPoint(px,py,rotation,r,r*.88,frontCenter[0],frontCenter[1]));
      back.push(transformPoint(px,py,rotation,r*.78,r*.69,backCenter[0],backCenter[1]));
    }

    ctx.save();

    ctx.shadowColor='rgba(0,0,0,'+(.18+p.depth*.24)+')';ctx.shadowBlur=18+p.depth*26;ctx.shadowOffsetY=9+p.depth*14;
    polygonPath(back);
    var backGlass=ctx.createLinearGradient(backCenter[0]-r,backCenter[1]-r,backCenter[0]+r,backCenter[1]+r);
    backGlass.addColorStop(0,'hsla('+(p.hue+42)+',92%,72%,'+(p.alpha*.42)+')');
    backGlass.addColorStop(1,'hsla('+(p.hue-18)+',90%,30%,'+(p.alpha*.8)+')');
    ctx.fillStyle=backGlass;
    ctx.fill();
    ctx.shadowColor='transparent';ctx.shadowBlur=0;ctx.shadowOffsetY=0;

    for(var side=0;side<p.sides;side++){
      var next=(side+1)%p.sides;
      polygonPath([back[side],back[next],front[next],front[side]]);
      var wallLight=(Math.cos(rotation+side*Math.PI*2/p.sides-.7)+1)/2;
      var wallGradient=ctx.createLinearGradient(back[side][0],back[side][1],front[next][0],front[next][1]);
      wallGradient.addColorStop(0,'hsla('+(p.hue+side*12)+',95%,'+(34+wallLight*28)+'%,'+(p.alpha*.58)+')');
      wallGradient.addColorStop(.55,'hsla('+(p.hue+52)+',100%,'+(48+wallLight*26)+'%,'+(p.alpha+.07)+')');
      wallGradient.addColorStop(1,'rgba(255,255,255,'+(.06+wallLight*.18)+')');
      ctx.fillStyle=wallGradient;ctx.fill();ctx.strokeStyle='rgba(255,255,255,'+(.12+wallLight*.23)+')';ctx.lineWidth=.7;ctx.stroke();
    }

    for(var facet=0;facet<p.sides;facet++){
      var facetNext=(facet+1)%p.sides;
      var tip=[frontCenter[0]+Math.cos(orientation*.6)*r*.08,frontCenter[1]+Math.sin(orientation*.8)*r*.06];
      polygonPath([tip,front[facet],front[facetNext]]);
      var light=(Math.cos(rotation+facet*Math.PI*2/p.sides+.35)+1)/2;
      var facetGradient=ctx.createLinearGradient(tip[0],tip[1],front[facet][0],front[facet][1]);
      facetGradient.addColorStop(0,'rgba(255,255,255,'+(.08+light*.2)+')');
      facetGradient.addColorStop(.45,'hsla('+(p.hue+facet*15)+',100%,'+(52+light*24)+'%,'+(p.alpha+light*.08)+')');
      facetGradient.addColorStop(1,'hsla('+(p.hue+68)+',95%,'+(34+light*30)+'%,'+(p.alpha*.42)+')');
      ctx.fillStyle=facetGradient;ctx.fill();ctx.strokeStyle='rgba(255,255,255,'+(.1+light*.22)+')';ctx.lineWidth=.65;ctx.stroke();
    }

    polygonPath(front);
    ctx.strokeStyle='rgba(255,255,255,'+(.34+p.depth*.28)+')';ctx.lineWidth=1.05;
    ctx.stroke();

    ctx.globalCompositeOperation='screen';
    var shineX=frontCenter[0]-r*.35+Math.sin(orientation)*r*.18;
    var shine=ctx.createLinearGradient(shineX-r*.18,y-r,shineX+r*.18,y+r);
    shine.addColorStop(0,'rgba(255,255,255,0)');shine.addColorStop(.43,'rgba(255,255,255,0)');shine.addColorStop(.5,'rgba(255,255,255,'+(.36+p.depth*.24)+')');shine.addColorStop(.57,'hsla('+(p.hue+90)+',100%,76%,'+(.2+p.depth*.18)+')');shine.addColorStop(1,'rgba(255,255,255,0)');
    polygonPath(front);ctx.fillStyle=shine;ctx.fill();
    ctx.beginPath();ctx.moveTo(back[0][0],back[0][1]);ctx.lineTo(front[0][0],front[0][1]);ctx.lineTo(frontCenter[0],frontCenter[1]);ctx.strokeStyle='rgba(255,255,255,'+(.28+p.depth*.28)+')';ctx.lineWidth=1.1;ctx.stroke();
    ctx.restore();
  }

  function draw(t){
    if(wallOff){running=false;return;}
    pointerX+=(targetX-pointerX)*.035;
    pointerY+=(targetY-pointerY)*.035;
    ctx.clearRect(0,0,w,h);
    var base=ctx.createLinearGradient(0,0,w,h);
    base.addColorStop(0,'#02040a');
    base.addColorStop(.52,'#080914');
    base.addColorStop(1,'#020811');
    ctx.fillStyle=base;
    ctx.fillRect(0,0,w,h);

    particles.sort(function(a,b){return a.depth-b.depth;});
    for(var i=0;i<particles.length;i++){
      var p=particles[i];
      p.x+=p.driftX;
      p.y+=p.driftY;
      if(p.x > w + 180) p.x = -180;
      if(p.x < -180) p.x = w + 180;
      if(p.y > h + 180) p.y = -180;
      if(p.y < -180) p.y = h + 180;
      drawGlassShard(p,t);
    }

    if(!reduce) requestAnimationFrame(draw);
  }

  window.addEventListener('pointermove',function(event){
    targetX=(event.clientX/w-.5)*18;
    targetY=(event.clientY/h-.5)*14;
  },{passive:true});
  window.addEventListener('resize', resize, { passive: true });
  resize();
  if(wallOff)return;
  if(reduce)draw(0);
  else{running=true;requestAnimationFrame(draw);}
})();

// ── ACCENT COLOR ──
(function(){
  var ACCENTS={
    violet:{a:'#7c3aed',a2:'#6d28d9',a3:'#5b21b6',bright:'#a78bfa',glow:'rgba(124,58,237,.18)'},
    blue:{a:'#2563eb',a2:'#1d4ed8',a3:'#1e40af',bright:'#60a5fa',glow:'rgba(37,99,235,.18)'},
    emerald:{a:'#059669',a2:'#047857',a3:'#065f46',bright:'#34d399',glow:'rgba(5,150,105,.18)'},
    rose:{a:'#e11d48',a2:'#be123c',a3:'#9f1239',bright:'#fb7185',glow:'rgba(225,29,72,.18)'}
  };
  window.__nyxApplyAccent=function(name){
    var c=ACCENTS[name]||ACCENTS.violet;
    var root=document.documentElement.style;
    root.setProperty('--accent',c.a);root.setProperty('--accent2',c.a2);root.setProperty('--accent3',c.a3);
    root.setProperty('--accent-bright',c.bright);root.setProperty('--accent-glow',c.glow);
    try{localStorage.setItem('nyx_accent',name);}catch(e){}
  };
  var saved=null;try{saved=localStorage.getItem('nyx_accent');}catch(e){}
  if(saved&&saved!=='violet')window.__nyxApplyAccent(saved);
})();
