import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(directory,'..');
const workspace=path.resolve(root,'..');
const engine=process.env.SINAIN_ANIMATION_ENGINE || '/Users/Igor.Gerasimov/IdeaProjects/negaverse/local-docs/demo-showcase';
const requireFromEngine=createRequire(path.join(engine,'render/package.json'));
const puppeteer=requireFromEngine('puppeteer-core');
const chrome=process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const duration=24;
const fps=Number(process.argv[2]||24);
const width=Number(process.argv[3]||1280);
const height=Math.round(width*9/16);
const total=Math.round(duration*fps);
const frames=path.join(directory,'frames');
const outputDirectory=path.join(root,'output');
const mime={'.html':'text/html','.jsx':'text/javascript','.js':'text/javascript','.png':'image/png'};

fs.rmSync(frames,{recursive:true,force:true});
fs.mkdirSync(frames,{recursive:true});
fs.mkdirSync(outputDirectory,{recursive:true});

const server=await new Promise(resolve=>{
  const instance=http.createServer((request,response)=>{
    const url=decodeURIComponent(request.url.split('?')[0]);
    let file;
    if(url.startsWith('/engine/')) file=path.join(engine,url.slice('/engine/'.length));
    else if(url.startsWith('/hypothesis-e/')) file=path.join(workspace,url.slice(1));
    else file=path.join(root,url==='/'?'render/host.html':url);
    fs.readFile(file,(error,buffer)=>{
      if(error){response.writeHead(404);response.end();return}
      response.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});
      response.end(buffer);
    });
  });
  instance.listen(0,'127.0.0.1',()=>resolve(instance));
});

const browser=await puppeteer.launch({executablePath:chrome,headless:'new',args:['--no-sandbox','--force-color-profile=srgb','--hide-scrollbars']});
const page=await browser.newPage();
await page.setViewport({width:1920,height:1124,deviceScaleFactor:1});
page.on('console',message=>{if(message.type()==='error')console.log('[page]',message.text())});
await page.goto(`http://localhost:${server.address().port}/render/host.html`,{waitUntil:'networkidle0',timeout:60000});
await page.waitForFunction('window.__ready===true||window.__err',{timeout:60000});
const error=await page.evaluate('window.__err');
if(error) throw new Error(error);
const stage=await page.$('[data-om-exportable-video-with-duration-secs]');
const box=await stage.boundingBox();
console.log(`Rendering ${total} frames at ${fps} fps`);
for(let frame=0;frame<total;frame++){
  await page.evaluate(time=>window.__seek(time),Math.min(frame/fps,duration-.001));
  await new Promise(resolve=>setTimeout(resolve,8));
  await page.screenshot({path:path.join(frames,`f_${String(frame).padStart(6,'0')}.png`),clip:{x:Math.round(box.x),y:Math.round(box.y),width:Math.round(box.width),height:Math.round(box.height)}});
  if(frame%Math.max(1,fps*4)===0) console.log(`  ${frame}/${total}`);
}
await browser.close();
server.close();

const output=path.join(outputDirectory,'sinain-context-merge-24s.mp4');
const ffmpeg=spawnSync('/opt/homebrew/bin/ffmpeg',['-y','-framerate',String(fps),'-i',path.join(frames,'f_%06d.png'),'-vf',`scale=${width}:${height}:flags=lanczos`,'-c:v','libx264','-pix_fmt','yuv420p','-crf','18','-movflags','+faststart',output],{stdio:'inherit'});
if(ffmpeg.status!==0) process.exit(ffmpeg.status||1);
console.log(`Wrote ${output}`);
