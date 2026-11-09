// Prevent configuration ABA GET, late read display, timer leaks and invalid IPC capability expansion.
// Production modules only, memory config/fetch/stream/manual scheduler; no business fs/network/timers/processes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTaskQuerySource } from '../src/task-query-source.ts';
import { createTaskDetailIpc } from '../src/task-detail-ipc.ts';
import { createRuntimePresentation } from '../src/runtime-presentation.ts';
import { encodeRunCursor } from '../../host/desktop-task-query-contract.ts';
const detail = () => ({run:{id:7,rule:'r',agent:'a',state:'done',attempts:1,createdAt:null,claimedAt:null,finishedAt:null,notBefore:null,summary:'s',error:'',stopping:false,usage:null,truncated:false},association:{kind:'available'},events:{items:[],hasMore:false,nextCursor:null},cards:{items:[],hasMore:false,nextCursor:null},relatedRuns:{items:[],hasMore:false,nextCursor:null}});
function fixture() {
 let state={status:'running' as 'running'|'stopped',role:'hub-worker' as 'hub-worker'|'worker',pendingSync:0,error:null};
 const gates={phase:'idle' as 'idle'|'quitting',busy:false,blocked:false,quitting:false};
 const p=createRuntimePresentation({page:'file:///trusted',read:()=>state,gates:()=>gates,send:()=>{},refresh:()=>{},report:()=>{}});
 p.finishDocument(p.beginDocument(),'file:///trusted');
 let calls=0,now=0,config=()=>({hub:{listen:'127.0.0.1:8080'},owner:'memory'});
 let resolve!: (value:Response)=>void;
 let fetcher=(_url:string,_init?:RequestInit)=>new Promise<Response>(yes=>{resolve=yes;});
 const scheduled=new Map<object,()=>void>();
 const source=createTaskQuerySource({home:'unused',getState:()=>state,readConfig:()=>config(),fetchImpl:(url,init)=>{calls++;return fetcher(String(url),init);},schedule:{now:()=>now,set:(callback)=>{const h:object={};scheduled.set(h,callback);return h;},clear:(handle)=>{scheduled.delete(handle as object);}}});
 const event={};const ipc=createTaskDetailIpc({assertSender:(v)=>{assert.equal(v,event);},presentation:p,source});
 const reply=(data:unknown,status=200)=>resolve(new Response(JSON.stringify(data),{status}));
 return {p,gates,source,ipc,event,scheduled,calls:()=>calls,reply,setConfig:(f:typeof config)=>{config=f;},setFetch:(f:typeof fetcher)=>{fetcher=f;},advance:(ms:number)=>{now+=ms;},setState:(s:typeof state)=>{state=s;}};
}
const ops=['detail','events','cards','related'] as const;
const req=(operation:typeof ops[number])=>operation==='detail'?{operation,runId:7}:{operation,runId:7,input:{}};
const payload=(op:typeof ops[number])=>op==='detail'?detail():{items:[],hasMore:false,nextCursor:null};
test('sender first, strict arity/capability and valid selected-run response through real handler/source',async()=>{
 const f=fixture();let touched=0;const poison=new Proxy({}, {ownKeys(){touched++;throw Error('poison');}});
 await assert.rejects(f.ipc.read({},[poison]));assert.equal(touched,0);
 for(const args of [[],[req('detail'),undefined],[{operation:'list',input:{}}],[{operation:'cancel',runId:7}],[{operation:'detail',runId:0}]])assert.equal((await f.ipc.read(f.event,args)).ok,false);
 assert.equal(f.calls(),0);
 for(const op of ops){const pending=f.ipc.read(f.event,[req(op)]);f.reply(payload(op));const result=await pending;assert.equal(result.ok,true);assert.equal(f.scheduled.size,0);}
});
test('each query forbids GET when config read revokes lease and returns to same runtime/document',async()=>{
 for(const op of ops){const f=fixture();f.setConfig(()=>{f.p.invalidateDocument();f.p.finishDocument(f.p.beginDocument(),'file:///trusted');return {hub:{listen:'127.0.0.1:8080'},owner:'memory'};});const result=await f.ipc.read(f.event,[req(op)]);assert.equal(result.ok,false);assert.equal(f.calls(),0);assert.equal(f.scheduled.size,0);}
});
test('every section refuses late response after setup/quit/role/document ABA',async()=>{
 for(const op of ops)for(const boundary of ['setup','quit','role','document']){
  const f=fixture();const pending=f.ipc.read(f.event,[req(op)]);
  if(boundary==='document'){f.p.invalidateDocument();f.p.finishDocument(f.p.beginDocument(),'file:///trusted');}
  else if(boundary==='setup'){f.gates.busy=true;f.p.changed();f.gates.busy=false;f.p.changed();}
  else if(boundary==='quit'){f.gates.phase='quitting';f.p.changed();f.gates.phase='idle';f.p.changed();}
  else{f.setState({status:'running',role:'worker',pendingSync:0,error:null});f.p.changed();f.setState({status:'running',role:'hub-worker',pendingSync:0,error:null});f.p.changed();}
  f.reply(payload(op));const result=await pending;assert.equal(result.ok,false);if(!result.ok)assert.equal(result.error.code,'aborted');assert.equal(f.scheduled.size,0);
 }
});
test('original deadline covers stalled fetch and body; manual scheduler settles independently',async()=>{
 const f=fixture();const pending=f.source.detail(7);assert.equal(f.scheduled.size,1);f.advance(1500);[...f.scheduled.values()][0]();assert.deepEqual(await pending,{ok:false,error:'timeout'});assert.equal(f.scheduled.size,0);
 const g=fixture();g.setFetch(async()=>new Response(new ReadableStream({start(){}})));const body=g.source.detail(7);for(let i=0;i<8;i++)await Promise.resolve();g.advance(1500);[...g.scheduled.values()][0]();assert.deepEqual(await body,{ok:false,error:'timeout'});
});
test('lease queries do not share result with another lease; replacement and late cleanup retain new slot',async()=>{
 const f=fixture();const a=f.source.detail(7,()=>true);const oldReply=f.reply;const b=f.source.detail(7,()=>true);assert.equal(f.calls(),2);assert.deepEqual(await a,{ok:false,error:'aborted'});f.reply(detail());assert.equal((await b).ok,true);assert.equal(f.scheduled.size,0);void oldReply;
});
test('wrong run, corrupt response and section cursor are refused; cleanup throw preserves strict result',async()=>{
 const f=fixture();const bad=f.ipc.read(f.event,[req('detail')]);f.reply({...detail(),run:{...detail().run,id:8}});assert.equal((await bad).ok,false);
 const cursor=encodeRunCursor({version:1,run:8,section:'cards',lastId:9});assert.equal((await f.ipc.read(f.event,[{operation:'cards',runId:7,input:{cursor}}])).ok,false);
 const g=fixture();const handler=createTaskDetailIpc({assertSender:()=>{},presentation:{acquireTaskLease:()=>g.p.acquireTaskLease(),checkTaskLease:(l)=>g.p.checkTaskLease(l),releaseTaskLease(){throw Error('cleanup');}},source:g.source});const pending=handler.read({},[req('detail')]);g.reply(detail());assert.equal((await pending).ok,true);
});
