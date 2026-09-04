import http from 'node:http'; import fs from 'node:fs';
const out='/private/tmp/claude-501/-Users-shaansisodia/affb423a-733a-4cf7-9357-ea8a57ad3ed2/scratchpad/captured.jsonl';
http.createServer((req,res)=>{const c=[];req.on('data',d=>c.push(d));req.on('end',()=>{const body=Buffer.concat(c);
 if(req.method==='POST') fs.appendFileSync(out, JSON.stringify({url:req.url, body: body.toString('utf8')})+'\n');
 const up=http.request({host:'127.0.0.1',port:8098,method:req.method,path:req.url,headers:{...req.headers,host:'127.0.0.1:8098','content-length':String(body.length)}},ur=>{res.writeHead(ur.statusCode,ur.headers);ur.pipe(res);});
 up.on('error',e=>{res.writeHead(502);res.end(String(e));}); up.end(body);});}).listen(8099,'127.0.0.1',()=>console.log('cap 8099'));
