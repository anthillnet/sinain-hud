/* Sinain HP-E social animatic.
   Graphic-first: one idea per frame, oversized objects, minimal UI. */

const { Stage, Sprite, useTime, useSprite, Easing, clamp } = window;
const P={bg:'#0b0e13',ink:'#f2f4f8',dim:'#7d8798',blue:'#58c4dd',blueD:'#1c758a',green:'#77c169',greenD:'#1f8039',yellow:'#f4d35e',red:'#fc6255',panel:'#171b22'};
const FONT="Inter, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif";
const MONO="'IBM Plex Mono', Menlo, monospace";
const W=1920,H=1080, ease=Easing.easeOutCubic;
const lerp=(a,b,t)=>a+(b-a)*t;
const fade=(t,d,a=.28,b=.28)=>Math.min(clamp(t/a,0,1),clamp((d-t)/b,0,1));
const glow=(c,n=20)=>`drop-shadow(0 0 ${n}px ${c})`;
function useLocal(n){const {localTime,duration}=useSprite();return{t:localTime*n/duration,d:n}}

function Logo(){return <div style={{position:'absolute',left:54,top:44,zIndex:30,display:'flex',alignItems:'center',gap:10,fontFamily:FONT,fontWeight:800,fontSize:21,color:P.ink}}><Eye size={28}/><span>sinain</span></div>}
function Eye({size=54,color=P.green}){return <div style={{width:size,height:size*.62,borderRadius:'55% / 80%',background:color,display:'grid',placeItems:'center',filter:glow(color,12)}}><div style={{width:size*.25,height:size*.25,borderRadius:'50%',background:P.bg}}/></div>}
function Progress({cut}){const t=useTime(),d=cut==='20'?20:60;return <div style={{position:'absolute',zIndex:40,left:54,right:54,bottom:32,height:4,borderRadius:4,background:'rgba(255,255,255,.08)'}}><div style={{height:'100%',width:`${clamp(t/d,0,1)*100}%`,borderRadius:4,background:P.green,filter:glow(P.green,7)}}/></div>}
function Wrap({t,d,children,bg=P.bg}){return <div style={{position:'absolute',inset:0,background:bg,opacity:fade(t,d),overflow:'hidden'}}>{children}</div>}
function Kicker({children,color=P.dim,style={}}){return <div style={{fontFamily:MONO,fontSize:18,fontWeight:700,letterSpacing:'.16em',color,textTransform:'uppercase',...style}}>{children}</div>}
function Big({children,size=112,color=P.ink,style={}}){return <div style={{fontFamily:FONT,fontSize:size,fontWeight:900,letterSpacing:'-.055em',lineHeight:.9,color,...style}}>{children}</div>}
function Orb({x,y,size=150,color=P.blue,label,scale=1,dim=false}){return <div style={{position:'absolute',left:x-size/2,top:y-size/2,width:size,height:size,borderRadius:'50%',background:color,transform:`scale(${scale})`,opacity:dim?.28:1,filter:glow(color,18),display:'grid',placeItems:'center',fontFamily:MONO,fontSize:15,fontWeight:700,letterSpacing:'.09em',color:P.bg}}>{label}</div>}
function Arrow({x1,y1,x2,y2,color=P.blue,width=8,progress=1}){const x=lerp(x1,x2,progress),y=lerp(y1,y2,progress);return <svg width={W} height={H} style={{position:'absolute',inset:0}}><line x1={x1} y1={y1} x2={x} y2={y} stroke={color} strokeWidth={width} strokeLinecap="round"/><circle cx={x} cy={y} r={width*1.25} fill={color}/></svg>}

function SceneParallel(){const {t,d}=useLocal(5),p=ease(clamp((t-.2)/1.6,0,1));return <Wrap t={t} d={d}>
  <Kicker style={{position:'absolute',left:100,top:130}}>Parallel work</Kicker>
  <Big size={126} style={{position:'absolute',left:95,top:190,width:720}}>THREE<br/><span style={{color:P.blue}}>AGENTS.</span></Big>
  <Orb x={1150} y={270} size={190} label="01" scale={p}/><Orb x={1480} y={520} size={190} label="02" scale={p}/><Orb x={1120} y={790} size={190} label="03" scale={p}/>
  <Arrow x1={770} y1={530} x2={1100} y2={285} progress={p}/><Arrow x1={770} y1={530} x2={1430} y2={520} progress={p}/><Arrow x1={770} y1={530} x2={1070} y2={775} progress={p}/>
  <div style={{position:'absolute',left:650,top:445,width:230,height:230,borderRadius:'50%',background:P.yellow,filter:glow(P.yellow,24),display:'grid',placeItems:'center',fontFamily:FONT,fontSize:34,fontWeight:900,color:P.bg}}>YOU</div>
  <Big size={86} style={{position:'absolute',left:95,bottom:105}}>ONE <span style={{color:P.yellow}}>FOCUS.</span></Big>
  </Wrap>}

function SceneOneFocus(){const {t,d}=useLocal(6),p=ease(clamp((t-.25)/1,0,1));return <Wrap t={t} d={d} bg="#0d1118">
  <div style={{position:'absolute',left:'50%',top:'47%',transform:'translate(-50%,-50%)',width:520,height:520,borderRadius:'50%',border:`16px solid ${P.yellow}`,filter:glow(P.yellow,28),display:'grid',placeItems:'center'}}>
    <Big size={210} color={P.yellow} style={{transform:`scale(${p})`}}>1</Big>
  </div>
  <Kicker color={P.yellow} style={{position:'absolute',left:0,right:0,top:140,textAlign:'center'}}>Human constraint</Kicker>
  <Big size={104} style={{position:'absolute',left:0,right:0,bottom:120,textAlign:'center'}}>ACTIVE FOCUS</Big>
  </Wrap>}

function SceneSwitch(){const {t,d}=useLocal(6),i=Math.floor(t*1.7)%3;const pos=[[410,510],[960,260],[1510,600]];return <Wrap t={t} d={d}>
  <Kicker style={{position:'absolute',left:95,top:120}}>Every switch reloads</Kicker>
  {pos.map(([x,y],n)=><Orb key={n} x={x} y={y} size={190} label={`AGENT ${n+1}`} dim={n!==i}/>) }
  <Orb x={pos[i][0]+(i===1?210:0)} y={pos[i][1]+(i===0?-210:180)} size={100} color={P.yellow} label="YOU"/>
  {['GOAL?','DECISION?','NEXT?'].map((w,n)=><Big key={w} size={88} color={n===i?P.red:P.dim} style={{position:'absolute',left:220+n*535,top:790,opacity:n===i?1:.22}}>{w}</Big>)}
  </Wrap>}

function SceneWhere(){const {t,d}=useLocal(5),p=ease(clamp((t-.2)/.8,0,1));return <Wrap t={t} d={d} bg="#10141c">
  <Orb x={960} y={535} size={250} color={P.yellow} label="YOU" scale={p}/>
  <Big size={170} style={{position:'absolute',left:0,right:0,top:130,textAlign:'center'}}>WHERE</Big>
  <Big size={170} color={P.red} style={{position:'absolute',left:0,right:0,bottom:120,textAlign:'center'}}>WAS I?</Big>
  </Wrap>}

function Code({left=0,top=0,width=1000,height=650}){return <div style={{position:'absolute',left,top,width,height,borderRadius:28,background:'#11151b',border:'2px solid rgba(119,193,105,.45)',overflow:'hidden'}}>
  <div style={{height:64,background:'#20252d',display:'flex',alignItems:'center',gap:12,padding:'0 24px'}}><i style={{width:12,height:12,borderRadius:'50%',background:P.red}}/><i style={{width:12,height:12,borderRadius:'50%',background:P.yellow}}/><i style={{width:12,height:12,borderRadius:'50%',background:P.green}}/><Kicker style={{marginLeft:14,fontSize:13}}>checkout / agent 01</Kicker></div>
  <div style={{padding:34}}>{[.42,.7,.83,.55,.76,.66].map((w,i)=><div key={i} style={{width:`${w*100}%`,height:15,borderRadius:10,background:i===4?P.red:'rgba(255,255,255,.15)',marginBottom:24}}/>)}</div>
  <Kicker color={P.red} style={{position:'absolute',left:34,bottom:32,fontSize:15}}>FAIL · duplicate webhook event</Kicker>
  </div>}
function OfferCard({brief=false,sent=false}){return <div style={{position:'absolute',right:110,top:245,width:720,padding:36,borderRadius:28,background:'#1d222b',border:`2px solid ${P.green}`,boxShadow:'0 30px 90px rgba(0,0,0,.65)'}}>
  <div style={{display:'flex',alignItems:'center',gap:20}}><Eye size={48}/><Big size={43} style={{letterSpacing:'-.035em'}}>BACK TO CHECKOUT?</Big></div>
  {!brief&&<><Kicker style={{marginTop:24,lineHeight:1.8,fontSize:15}}>LEFT 18 MIN AGO<br/>AGENT WAITING ON ONE DECISION</Kicker><div style={{display:'flex',gap:14,marginTop:28}}><div style={{padding:'17px 24px',borderRadius:12,background:P.greenD,color:'#fff',fontFamily:FONT,fontWeight:850,fontSize:19}}>RESUME WITH AGENT</div><div style={{padding:'17px 24px',borderRadius:12,border:'1px solid rgba(255,255,255,.18)',color:P.dim,fontFamily:FONT,fontWeight:700,fontSize:19}}>DISMISS</div></div></>}
  {brief&&<div style={{display:'grid',gridTemplateColumns:'170px 1fr',gap:'18px 20px',marginTop:30}}>{[['GOAL','Idempotent retries'],['DECISION','Cap backoff at 5'],['BLOCKER','Duplicate response'],['NEXT','Run integration test']].map(([k,v],i)=><React.Fragment key={k}><Kicker color={i===3?P.green:P.dim} style={{fontSize:14}}>{k}</Kicker><div style={{fontFamily:FONT,fontSize:25,fontWeight:800,color:P.ink}}>{v}</div></React.Fragment>)}{sent&&<><div/><div style={{background:P.greenD,color:'#fff',fontFamily:FONT,fontWeight:850,padding:'14px 18px',borderRadius:10,width:'fit-content'}}>BRIEF SENT · AGENT RESUMED</div></>}</div>}
  </div>}
function PlaceholderLabel({id,path}){return <Kicker color={P.green} style={{position:'absolute',left:86,top:92,zIndex:10,fontSize:14,border:`1px dashed ${P.green}`,padding:'10px 14px',borderRadius:8}}>LIVE {id}<span style={{color:P.dim,marginLeft:18}}>{path}</span></Kicker>}

function SceneOffer(){const {t,d}=useLocal(6),p=ease(clamp((t-.3)/.7,0,1));return <Wrap t={t} d={d}>
  <PlaceholderLabel id="L1" path="live/live-01-return-offer.mp4"/><Code left={70} top={150} width={1120} height={720}/><div style={{opacity:p,transform:`translateX(${(1-p)*60}px)`}}><OfferCard/></div>
  </Wrap>}

function SceneConsent(){const {t,d}=useLocal(6);return <Wrap t={t} d={d}>
  <div style={{position:'absolute',left:0,top:0,bottom:0,width:'50%',background:'#141820',display:'grid',placeItems:'center'}}><div><Big size={126} color={P.dim}>IGNORE</Big><Kicker style={{textAlign:'center',marginTop:24}}>IT FADES</Kicker></div></div>
  <div style={{position:'absolute',right:0,top:0,bottom:0,width:'50%',background:P.greenD,display:'grid',placeItems:'center'}}><div><Big size={156}>TAP</Big><Kicker color="rgba(255,255,255,.65)" style={{textAlign:'center',marginTop:24}}>YOU CHOOSE</Kicker></div></div>
  <div style={{position:'absolute',left:'50%',top:0,bottom:0,width:5,background:P.ink,transform:'translateX(-50%)'}}/>
  </Wrap>}

function SceneBrief(){const {t,d}=useLocal(7),p=ease(clamp((t-.2)/.7,0,1));const rows=[['GOAL','IDEMPOTENT RETRIES'],['DECISION','CAP AT 5'],['BLOCKER','DUPLICATE RESPONSE'],['NEXT','RUN THE TEST']];return <Wrap t={t} d={d} bg="#0d1117">
  <PlaceholderLabel id="L2" path="live/live-02-resume-brief.mp4"/>
  <div style={{position:'absolute',left:110,right:110,top:170,bottom:110,display:'grid',gridTemplateRows:'repeat(4,1fr)',gap:14}}>{rows.map(([k,v],i)=><div key={k} style={{display:'grid',gridTemplateColumns:'300px 1fr',alignItems:'center',padding:'0 42px',borderRadius:24,background:i===3?P.greenD:P.panel,transform:`translateX(${(1-p)*(i%2?-120:120)}px)`,opacity:p}}><Kicker color={i===3?'rgba(255,255,255,.6)':P.dim}>{k}</Kicker><Big size={i===3?70:64}>{v}</Big></div>)}</div>
  </Wrap>}

function SceneCompress(){const {t,d}=useLocal(6),p=ease(clamp((t-.3)/2.4,0,1));const words=[['GOAL?',250,220],['409?',1350,190],['TEST?',260,760],['WHY?',1450,790],['BLOCKED?',830,180],['NEXT?',820,830]];return <Wrap t={t} d={d}>
  {words.map(([w,x,y],i)=><Big key={w+i} size={70} color={i%2?P.red:P.dim} style={{position:'absolute',left:lerp(x,760,p),top:lerp(y,430,p),opacity:1-p}}>{w}</Big>)}
  <div style={{position:'absolute',left:'50%',top:'45%',transform:`translate(-50%,-50%) scale(${p})`,width:760,height:280,borderRadius:140,background:P.green,filter:glow(P.green,30),display:'grid',placeItems:'center'}}><Big size={150} color={P.bg}>NEXT</Big></div>
  <Big size={88} style={{position:'absolute',left:0,right:0,bottom:135,textAlign:'center'}}>ONE MOVE.</Big>
  </Wrap>}

function SceneJoin(){const {t,d}=useLocal(5),p=ease(clamp((t-.25)/1.8,0,1));return <Wrap t={t} d={d} bg="#0d1118">
  <PlaceholderLabel id="L3" path="live/live-03-agent-rejoins.mp4"/>
  <Orb x={430} y={520} size={290} color={P.yellow} label="YOU"/><Orb x={1490} y={520} size={290} color={P.blue} label="AGENT 01"/>
  <Arrow x1={590} y1={520} x2={1330} y2={520} color={P.green} width={18} progress={p}/>
  <div style={{position:'absolute',left:680,top:395,width:560,height:250,borderRadius:32,background:P.panel,border:`2px solid ${P.green}`,display:'grid',placeItems:'center',opacity:p,filter:glow(P.green,15)}}><div style={{textAlign:'center'}}><Kicker color={P.green}>Shared context</Kicker><Big size={62} style={{marginTop:18}}>SAME BRIEF.</Big></div></div>
  </Wrap>}

function ScenePause(){const {t,d}=useLocal(4),p=ease(clamp((t-.2)/.8,0,1));return <Wrap t={t} d={d} bg={P.yellow}>
  <div style={{position:'absolute',left:'50%',top:'46%',transform:`translate(-50%,-50%) scale(${p})`,width:600,height:600,borderRadius:'50%',background:P.bg,display:'grid',placeItems:'center'}}><div style={{textAlign:'center'}}><Kicker color={P.yellow}>Three heavy switches</Kicker><Big size={135} style={{marginTop:20}}>PAUSE?</Big></div></div>
  <Kicker color="rgba(11,14,19,.55)" style={{position:'absolute',left:0,right:0,bottom:95,textAlign:'center'}}>ASKS · NEVER ORDERS</Kicker>
  </Wrap>}

function SceneEnd(){const {t,d}=useLocal(4),p=ease(clamp((t-.15)/.65,0,1));return <Wrap t={t} d={d}>
  <div style={{position:'absolute',left:100,top:135,transform:`scale(${p})`,transformOrigin:'left top'}}><Eye size={110}/></div>
  <Big size={158} style={{position:'absolute',left:95,top:300}}>AGENTS<br/>DO THE <span style={{color:P.blue}}>WORK.</span></Big>
  <Big size={142} style={{position:'absolute',right:100,bottom:120,textAlign:'right'}}>YOU KEEP<br/><span style={{color:P.yellow}}>FOCUS.</span></Big>
  </Wrap>}

function Cut60(){return <><Sprite start={0} end={5}><SceneParallel/></Sprite><Sprite start={5} end={11}><SceneOneFocus/></Sprite><Sprite start={11} end={17}><SceneSwitch/></Sprite><Sprite start={17} end={22}><SceneWhere/></Sprite><Sprite start={22} end={28}><SceneOffer/></Sprite><Sprite start={28} end={34}><SceneConsent/></Sprite><Sprite start={34} end={41}><SceneBrief/></Sprite><Sprite start={41} end={47}><SceneCompress/></Sprite><Sprite start={47} end={52}><SceneJoin/></Sprite><Sprite start={52} end={56}><ScenePause/></Sprite><Sprite start={56} end={60.01}><SceneEnd/></Sprite></>}
function Cut20(){return <><Sprite start={0} end={3}><SceneParallel/></Sprite><Sprite start={3} end={6.5}><SceneSwitch/></Sprite><Sprite start={6.5} end={10.5}><SceneOffer/></Sprite><Sprite start={10.5} end={13.5}><SceneBrief/></Sprite><Sprite start={13.5} end={16.5}><SceneJoin/></Sprite><Sprite start={16.5} end={20.01}><SceneEnd/></Sprite></>}
window.SinainHPEVideo=function({cut='60'}){const d=cut==='20'?20:60;return <Stage width={W} height={H} duration={d} fps={30} background={P.bg} autoplay={true} loop={true} persistKey={`sinain-hp-e-social-${cut}`}>{cut==='20'?<Cut20/>:<Cut60/>}<Logo/><Progress cut={cut}/></Stage>}

