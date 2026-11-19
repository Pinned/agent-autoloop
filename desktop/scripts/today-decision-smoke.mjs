// Prevent wrong-task decision navigation, lost drafts and duplicate/uncertain answers.
// Chromium runs the real views against a fake bridge, never the user's hub or agents.
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import electron from "electron";
const root = resolve(import.meta.dirname, "../..");
const home = mkdtempSync(join(tmpdir(), "today-decision-"));
const fixture = `
import { mountTodayView } from '${root}/desktop/src/renderer/today-view.ts';
import { mountBusinessTasksView } from '${root}/desktop/src/renderer/business-tasks-view.ts';
import { createRendererBusinessTasks } from '${root}/desktop/src/renderer/business-tasks-controller.ts';
const check=(value,message)=>{if(!value)throw Error(message)};
const wait=()=>new Promise(r=>setTimeout(r,50));
const card={id:66,kind:'ask',state:'open',title:'真实问题',text:'完整问题',options:['甲','乙'],recommend:null,choice:null,answer:null,result:null,createdAt:null,decidedAt:null,closedAt:null,truncated:false};
const task={key:'task:42',kind:'task',id:42,rule:'r',source:'s',origin:{eventId:1,title:'任务42',detail:'原始详情',availability:'recorded',truncated:false},state:'waiting-decision',latestRunId:118,latestProgress:'',finalResult:null,decisions:{items:[card],hasMore:false},createdAt:null,updatedAt:null,legacyNotice:null};
let view,reads=0,writes=0,finish,historicalMode=false;
const historicalCard={id:68,runId:118,kind:'ask',state:'open',title:'第四个问题',text:'历史问题',options:['甲'],choice:null,answer:null,by:null,result:null,truncated:false};
const historyItem={seq:2,kind:'finish',at:null,text:'',runId:118,eventId:null,cardId:null,feedbackId:null,truncated:false,display:{events:[],runs:[],cards:[historicalCard,{...historicalCard,id:69}],completion:null,feedback:[]}};
const requests=[];
const control=createRendererBusinessTasks({businessTasksRead:async request=>{reads++;requests.push(request);return {ok:true,data:request.operation==='timeline'?{items:[historyItem],hasMore:false,nextBefore:null}:request.operation==='list'?{scope:'business',rules:['r'],items:[task],hasMore:false,nextBefore:null}:{task,timeline:{items:historicalMode && request.operation==='detail'?[{...historyItem,seq:3,display:{events:[],runs:[],cards:[],completion:null,feedback:[]}}]:[],hasMore:historicalMode && request.operation==='detail',nextBefore:historicalMode && request.operation==='detail'?3:null},actions:{cancelTask:false,completeTask:false,completionBlocker:'cards'}}}},taskAction:request=>{writes++;return new Promise(r=>finish=r)}},()=>view?.update());
const todayHost=document.querySelector('#today'),detailHost=document.querySelector('#detail');
view=mountBusinessTasksView(control,{backLabel:()=> '返回今天',backFromDetail:()=>{detailHost.hidden=true;todayHost.hidden=false;}});detailHost.append(view.root);view.init();
const snapshot={version:3,now:'',timezone:'UTC',totals:{running:0,queued:0,doneToday:0},askTotal:2,cards:[{id:66,kind:'ask',title:'误导标题任务45',text:'问题',by:null,taskId:42},{id:67,kind:'ask',title:'旧问题',text:'旧资料',by:null}],spendingToday:{rounds:0,cost:0,missingCost:0},activeRuns:[],activeTruncated:false};
const today=mountTodayView(todayHost,{state:{kind:'ready',snapshot}},()=>{},()=>{},(id,cardId)=>{if(control.actionBusy||control.mustReread)return;control.open('task:'+id);todayHost.hidden=true;detailHost.hidden=false;view.locateQuestion('task:'+id,cardId)});
window.verify=async()=>{
 await wait();check(!todayHost.querySelector('textarea'),'no fake form');check(todayHost.querySelectorAll('.today-decision button').length===1,'missing identity no operation');
 todayHost.querySelector('.today-decision button').click();await wait();check(control.selectedKey==='task:42','66 must map to 42');check(requests.some(r=>r.input?.key==='task:42'),'real detail read');check(document.activeElement.dataset.cardId==='66','question located');
 const form=detailHost.querySelector('.business-decisions .business-decision');const text=form.querySelector('textarea'),radio=[...form.querySelectorAll('input')].find(e=>e.value==='1'),send=form.querySelector('button');
 radio.click();check(writes===0,'selection draft only');text.value='补充';text.dispatchEvent(new Event('input'));control.refreshDetail();await wait();check(form.querySelector('textarea').value==='补充','refresh preserves draft');
 detailHost.querySelector('.tasks-detail-page .tasks-detail-head .task-back-button').click();check(!todayHost.hidden,'return today');today.update();todayHost.querySelector('.today-decision button').click();await wait();check(detailHost.querySelector('.business-decisions .business-decision textarea').value==='补充','return preserves draft');
 detailHost.querySelector('.business-decisions .business-decision button').click();detailHost.querySelector('.business-decisions .business-decision button').click();check(writes===1,'single flight');finish(undefined);await wait();check(control.mustReread,'unknown result protected');control.refreshDetail();await wait();check(!control.mustReread,'explicit reread');
 const latest=detailHost.querySelector('.business-decisions .business-decision button');latest.click();check(writes===2,'explicit retry permitted');card.state='decided';task.decisions.items=[];finish({version:1,ok:true,action:'answer',cardId:66,result:{changed:true,state:'decided'}});await wait();check(writes===2,'no automatic retry');
 historicalMode=true;control.refreshDetail();await wait();view.locateQuestion('task:42',68);await wait();await wait();check(requests.some(r=>r.operation==='timeline'),'historical question pages');const historical=detailHost.querySelector('.business-record-question[data-question-id="68"]');check(historical,'multi-card exact identity');check(!historical.closest('.business-timeline').hidden,'historical timeline visible before locate');control.submitAction({version:1,action:'answer',cardId:68,input:{choice:0}});check(writes===2,'historical open never grants permission');
 console.log('Today decision Chromium checks passed: identity 66→42, located form, drafts, return, duplicate and unknown write protection, paged multi-card read-only location');control.dispose();return true;
};`;
try {
  await build({
    stdin: { contents: fixture, resolveDir: root },
    bundle: true,
    format: "iife",
    platform: "browser",
    outfile: join(home, "fixture.js"),
  });
  writeFileSync(
    join(home, "index.html"),
    `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${root}/desktop/src/renderer/style.css"><main><div id="today"></div><div id="detail" hidden></div></main><script src="fixture.js"></script>`,
  );
  writeFileSync(
    join(home, "driver.cjs"),
    `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(home, "user-data"))});app.whenReady().then(async()=>{try{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.webContents.on('console-message',(_,level,message)=>console.log(message));await w.loadFile(${JSON.stringify(join(home, "index.html"))});await w.webContents.executeJavaScript('verify()');app.exit(0)}catch(e){console.error(e);app.exit(1)}});`,
  );
  const result = spawnSync(electron, [join(home, "driver.cjs")], {
    env: { ...process.env, HOME: home, AGENT_AUTOLOOP_HOME: home, ELECTRON_RUN_AS_NODE: undefined },
    encoding: "utf8",
    timeout: 30000,
  });
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  if (result.status !== 0) process.exitCode = 1;
} finally {
  rmSync(home, { recursive: true, force: true });
}
