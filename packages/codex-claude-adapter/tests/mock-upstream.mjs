// Fault-injecting tee between the normalizer and Bifrost. Mode file: $S/mock-mode  (pass | 429once | 529twice | dropmid | 500once)
import http from 'node:http'; import fs from 'node:fs';
const S='/private/tmp/claude-501/-Users-shaansisodia/affb423a-733a-4cf7-9357-ea8a57ad3ed2/scratchpad';
let count=0;
http.createServer((req,res)=>{const c=[];req.on('data',d=>c.push(d));req.on('end',()=>{const body=Buffer.concat(c); count+=1;
 const mode=(fs.existsSync(S+'/mock-mode')?fs.readFileSync(S+'/mock-mode','utf8'):'pass').trim();
 fs.appendFileSync(S+'/mock-requests.jsonl', JSON.stringify({n:count,mode,body:body.toString('utf8')})+'\n');
 if(mode==='429once'&&count===1){res.writeHead(429,{'content-type':'application/json','retry-after':'1'});return res.end('{"type":"error","error":{"type":"rate_limit_error","message":"mock 429"}}');}
 if(mode==='529twice'&&count<=2){res.writeHead(529,{'content-type':'application/json'});return res.end('{"type":"error","error":{"type":"overloaded_error","message":"mock overloaded"}}');}
 if(mode==='500once'&&count===1){res.writeHead(500,{'content-type':'application/json'});return res.end('{"type":"error","error":{"type":"api_error","message":"mock 500"}}');}
 const up=http.request({host:'127.0.0.1',port:8080,method:req.method,path:req.url,headers:{...req.headers,host:'127.0.0.1:8080','content-length':String(body.length)}},ur=>{
   res.writeHead(ur.statusCode,ur.headers);
   if(mode==='dropmid'&&count===1){let sent=0;ur.on('data',d=>{sent+=d.length; if(sent<1500){res.write(d);} else {ur.destroy(); res.destroy();}});ur.on('end',()=>res.end());}
   else ur.pipe(res);});
 up.on('error',e=>{res.writeHead(502);res.end(String(e));}); up.end(body);});}).listen(8090,'127.0.0.1',()=>console.log('mock 8090'));
