import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(directory,'..');
const workspace=path.resolve(root,'..');
const engine=process.env.SINAIN_ANIMATION_ENGINE || '/Users/Igor.Gerasimov/IdeaProjects/negaverse/local-docs/demo-showcase';
const port=Number(process.argv[2]||4174);
const mime={'.html':'text/html','.jsx':'text/javascript','.js':'text/javascript','.png':'image/png','.mp4':'video/mp4'};

http.createServer((request,response)=>{
  const url=decodeURIComponent(request.url.split('?')[0]);
  let file;
  if(url.startsWith('/engine/')) file=path.join(engine,url.slice('/engine/'.length));
  else if(url.startsWith('/hypothesis-e/')) file=path.join(workspace,url.slice(1));
  else file=path.join(root,url==='/'?'render/host.html':url);
  fs.readFile(file,(error,buffer)=>{
    if(error){response.writeHead(404);response.end('not found');return}
    response.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});
    response.end(buffer);
  });
}).listen(port,'127.0.0.1',()=>console.log(`Sinain context merge preview: http://localhost:${port}/render/host.html`));
