import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const __dir=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(__dir,'..');
const ENGINE='/Users/Igor.Gerasimov/IdeaProjects/negaverse/local-docs/demo-showcase';
const requireFromNegaverse=createRequire(path.join(ENGINE,'render/package.json'));
const puppeteer=requireFromNegaverse('puppeteer-core');
const CHROME='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cut=process.argv[2]==='20'?'20':'60';
const duration=Number(cut), fps=Number(process.argv[3]||24), width=Number(process.argv[4]||1280), height=Math.round(width*9/16);
const renderWidth=1920, renderHeight=1080;
const total=Math.round(duration*fps), frames=path.join(__dir,`frames-${cut}`), outputDir=path.join(ROOT,'output');
fs.rmSync(frames,{recursive:true,force:true}); fs.mkdirSync(frames,{recursive:true}); fs.mkdirSync(outputDir,{recursive:true});
const mime={'.html':'text/html','.jsx':'text/javascript','.js':'text/javascript','.png':'image/png','.mp4':'video/mp4'};
const serve=()=>new Promise(resolve=>{const srv=http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split('?')[0]);
  const file=u.startsWith('/engine/')?path.join(ENGINE,u.slice('/engine/'.length)):path.join(ROOT,u==='/'?'render/host.html':u);
  fs.readFile(file,(err,buf)=>{if(err){res.writeHead(404);res.end();return}res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});res.end(buf)})});srv.listen(0,'127.0.0.1',()=>resolve(srv))});

const srv=await serve(); const port=srv.address().port;
const browser=await puppeteer.launch({executablePath:CHROME,headless:'new',args:['--no-sandbox','--force-color-profile=srgb','--hide-scrollbars']});
const page=await browser.newPage(); await page.setViewport({width:renderWidth,height:renderHeight+44,deviceScaleFactor:1});
page.on('console',m=>{if(m.type()==='error')console.log('[page]',m.text())});
await page.goto(`http://localhost:${port}/render/host.html?cut=${cut}`,{waitUntil:'networkidle0',timeout:60000});
await page.waitForFunction('window.__ready===true||window.__err',{timeout:60000});
const err=await page.evaluate('window.__err'); if(err)throw new Error(err);
const svg=await page.$('[data-om-exportable-video-with-duration-secs]'); const box=await svg.boundingBox();
console.log(`Rendering ${cut}s cut: ${total} frames at ${fps} fps (${Math.round(box.width)}x${Math.round(box.height)})`);
for(let f=0;f<total;f++){
  await page.evaluate(tt=>window.__seek(tt),Math.min(f/fps,duration-.001));
  await new Promise(resolve=>setTimeout(resolve,10));
  const out=path.join(frames,`f_${String(f).padStart(6,'0')}.png`);
  await page.screenshot({clip:{x:Math.round(box.x),y:Math.round(box.y),width:Math.round(box.width),height:Math.round(box.height)}});
  await page.screenshot({path:out,clip:{x:Math.round(box.x),y:Math.round(box.y),width:Math.round(box.width),height:Math.round(box.height)}});
  if(f%Math.max(1,fps*5)===0)console.log(`  ${f}/${total}`);
}
await browser.close(); srv.close();
const output=path.join(outputDir,`sinain-hp-e-${cut}s-placeholder.mp4`);
const ff=spawnSync('/opt/homebrew/bin/ffmpeg',['-y','-framerate',String(fps),'-i',path.join(frames,'f_%06d.png'),'-vf',`scale=${width}:${height}:flags=lanczos`,'-c:v','libx264','-pix_fmt','yuv420p','-crf','18','-movflags','+faststart',output],{stdio:'inherit'});
if(ff.status!==0)process.exit(ff.status||1);
console.log(`Wrote ${output}`);
