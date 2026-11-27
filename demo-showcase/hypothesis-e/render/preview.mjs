import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const __dir=path.dirname(fileURLToPath(import.meta.url)), ROOT=path.resolve(__dir,'..');
const ENGINE='/Users/Igor.Gerasimov/IdeaProjects/negaverse/local-docs/demo-showcase';
const mime={'.html':'text/html','.jsx':'text/javascript','.js':'text/javascript','.mp4':'video/mp4'};
const port=Number(process.argv[2]||4173);
http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split('?')[0]);const file=u.startsWith('/engine/')?path.join(ENGINE,u.slice(8)):path.join(ROOT,u==='/'?'render/host.html':u);
fs.readFile(file,(err,buf)=>{if(err){res.writeHead(404);res.end('not found');return}res.writeHead(200,{'content-type':mime[path.extname(file)]||'application/octet-stream'});res.end(buf)})}).listen(port,'127.0.0.1',()=>console.log(`Sinain HP-E preview: http://localhost:${port}/render/host.html?cut=60\n20s cut: http://localhost:${port}/render/host.html?cut=20`));
