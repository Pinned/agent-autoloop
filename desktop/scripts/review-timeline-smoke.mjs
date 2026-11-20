// Prevent fake review nodes, repeated handoff previews, lost expansion and narrow-screen overflow.
// Only the real renderer and an isolated fake bridge run; no hub, agents or notifications.
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import electron from "electron";

const root = resolve(import.meta.dirname, "../..");
const home = mkdtempSync(join(tmpdir(), "review-timeline-"));
const screenshots = mkdtempSync(join(tmpdir(), "review-timeline-screenshots-"));
let child;
try {
  await build({
    stdin: {
      resolveDir: root,
      contents: `
import {mountBusinessTasksView} from '${root}/desktop/src/renderer/business-tasks-view.ts';
import {createRendererBusinessTasks} from '${root}/desktop/src/renderer/business-tasks-controller.ts';
const task={key:'task:48',kind:'task',id:48,rule:'本机开发',source:'local',origin:{eventId:1,title:'任务复查安排',detail:'本轮已结束，任务仍有后续复查。',availability:'recorded',truncated:false},state:'active',latestRunId:127,latestProgress:'本轮结束',finalResult:null,decisions:{items:[],hasMore:false},createdAt:null,updatedAt:null,legacyNotice:null};
const about='<img src=x onerror="window.markupExecuted=true">交接原文开始\\n'+'核实远程检查，保留已完成的工作。'.repeat(15)+'\\nhttps://example.invalid/'+ 'x'.repeat(200)+'\\n交接原文结束';
const review={id:7,key:'ci',at:'2026-11-19T13:35:00Z',about,action:'scheduled',state:'triggered',truncated:false};
const base={at:'2026-11-19T13:15:59Z',runId:127,eventId:null,cardId:null,feedbackId:null,text:'',truncated:false};
const display={events:[],runs:[],cards:[],completion:null,feedback:[]};
const items=[
 {...base,seq:50,kind:'finish',display:{...display,runs:[{id:127,state:'done',summary:'已推送，尚待核实远程检查',error:'',truncated:false}],reviews:{items:[review,{...review,id:8,key:'pending',at:'2099-01-01T00:00:00Z',state:'pending'},{...review,id:9,key:'cancelled',state:'cancelled',action:'cancelled',truncated:true}],truncated:true}}},
 {...base,seq:51,kind:'tick',text:about,display:{...display,reviews:{items:[{...review,action:'triggered'}],truncated:false}}},
 {...base,seq:52,kind:'finish',display:{...display,reviews:{items:[{...review,id:9,key:'cancelled',action:'cancelled',state:'cancelled'}],truncated:false}}}
];
let view,detailReads=0;
const controller=createRendererBusinessTasks({businessTasksRead:async request=>{
 if(request.operation==='list')return {ok:true,data:{scope:'business',rules:['本机开发'],items:[task],hasMore:false,nextBefore:null}};
 detailReads++;return {ok:true,data:structuredClone({task,timeline:{items:[...items].reverse(),hasMore:false,nextBefore:null},actions:{cancelTask:false,completeTask:false,completionBlocker:'timers'}})};
}},()=>view?.update());
view=mountBusinessTasksView(controller,{});document.querySelector('main').append(view.root);view.init();controller.open('task:48');
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,150));await new Promise(requestAnimationFrame)};
window.verify=async()=>{
 await settle();
 const failures=[];const check=(value,message)=>{if(!value)failures.push(message)};
 const list=document.querySelector('.business-timeline');
 check(!!list,'时间线存在');if(!list)return {failures};
 check(list.children.length===3,'安排、触发、取消仍为三条原事实，不拆假节点');
 const text=list.textContent;
 check(!!list.querySelector('.business-reviews')&&text.includes('执行者说明'),'原事实内独立展示复查与执行者说明');
 const headings=[...list.querySelectorAll('.business-review-heading strong')].map(node=>node.textContent);
 check(headings.filter(title=>title==='已安排复查').length===2&&headings.filter(title=>title==='本次复查已触发').length===1&&headings.filter(title=>title==='已取消复查').length===2,'原事实安排、触发、取消使用真实动作标题');
 check([...list.querySelectorAll('.business-review-item')].filter(row=>row.querySelector('.business-review-state')?.textContent==='已触发').length===2&&!list.querySelector('.business-reviews')?.textContent.match(/验收通过|核实完成|复查通过/),'触发只显示可信触发状态，不冒充核实完成');
 check(text.includes('已取消')&&text.includes('待复查'),'多个复查的当前状态独立');
 check(text.includes('仅显示前20项')&&text.includes('此复查内容仅显示部分'),'数量及单项截断明确');
 check(!list.querySelector('img,script')&&!window.markupExecuted,'about 只作为纯文字，不执行标记');
 check(!document.querySelector('.business-task-operations')?.textContent.includes('复查安排'),'复查不混入任务操作');
 const rows=[...list.querySelectorAll('.business-review-item')];
 check(rows.length===5,'五个复查各有 business-review-item');
 check(rows.every(row=>row.querySelector('.business-review-heading')),'每项有独立 business-review-heading');
 const details=[...list.querySelectorAll('details.business-review-details')];
 check(details.length===5,'五段长交接均使用 business-review-details');
 check(details.map(node=>node.dataset.reviewId).sort().join(',')==='7,7,8,9,9','details.dataset.reviewId 使用原 timer id');
 for(const node of details){
  check(!node.open,'长交接默认收起 timer '+node.dataset.reviewId);
  check(node.querySelector('summary')?.textContent==='查看交接详情','收起 summary 仅为查看交接详情');
  check(node.textContent.includes(about),'长交接原文完整保留');
 }
 check(!list.innerText.includes('交接原文开始')&&!list.innerText.includes('交接原文结束'),'安排与触发默认不重复长交接原文');
 window.smokeFailures=failures;
 return {failures,nodes:list.children.length,details:details.length};
};
window.expandAndRefresh=async()=>{
 const failures=window.smokeFailures;
 const check=(value,message)=>{if(!value)failures.push(message)};
 const find=()=>document.querySelector('details.business-review-details[data-review-id="8"]');
 const node=find();
 if(!node){check(false,'无法验证展开与刷新：缺少 timer 8 交接详情');return {failures};}
 node.querySelector('summary').click();await settle();
 check(node.open,'点击 summary 展开交接');
 check(node.querySelector('summary').textContent==='收起交接详情','展开 summary 为收起交接详情');
 const body=[...node.children].find(child=>child.tagName!=='SUMMARY'&&child.textContent===about);
 check(!!body,'展开显示完整原文，不截断或重复');
 if(body){const style=getComputedStyle(body);check(['pre-wrap','pre-line','break-spaces'].includes(style.whiteSpace),'交接全文保留换行且自动折行');check(body.scrollWidth<=body.clientWidth+1,'交接全文无内部横向溢出');}
 const reads=detailReads;await controller.refreshDetail();await settle();
 items.push({...base,seq:53,kind:'tick',display:{...display,reviews:{items:[{...review,id:10,key:'missing',about:'短交接',state:'unknown',action:'triggered'}],truncated:false}}});
 await controller.refreshDetail();await settle();
 check(document.querySelectorAll('.business-timeline > li').length===4,'新增事实后保留完整时间线');
 const missing=document.querySelector('details.business-review-details[data-review-id="10"]');
 check(!missing?.open&&missing?.querySelector('summary').textContent==='查看交接详情','短交接也默认收起');
 check(missing?.closest('.business-review-item').textContent.includes('缺少可核对的复查历史'),'未知状态明确缺历史');
 check(detailReads>reads,'refreshDetail 确实权威重读 fake bridge');
 check(find()?.open,'详情刷新保留 timer 8 展开');
 check(find()?.querySelector('summary').textContent==='收起交接详情','刷新保留展开 summary 文案');
 check([...document.querySelectorAll('details.business-review-details')].filter(detail=>detail.open).length===1,'多个复查独立展开，刷新不串 timer');
 return {failures};
};
window.checkOverflow=()=>{
 const failures=window.smokeFailures;
 if(document.documentElement.scrollWidth>innerWidth+1)failures.push(innerWidth+'px 页面横向溢出：'+document.documentElement.scrollWidth);
 return {failures,width:document.documentElement.scrollWidth,viewport:innerWidth};
};
window.disposeSmoke=()=>controller.dispose();`,
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: join(home, "fixture.js"),
  });
  writeFileSync(
    join(home, "index.html"),
    `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${root}/desktop/src/renderer/style.css"><main></main><script src="fixture.js"></script>`,
  );
  writeFileSync(
    join(home, "driver.cjs"),
    `const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(join(home, "data"))});
app.whenReady().then(async()=>{
 let window;
 try{
  window=new BrowserWindow({show:false,width:1100,height:950,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadFile(${JSON.stringify(join(home, "index.html"))});
  console.log(JSON.stringify(await window.webContents.executeJavaScript('verify()')));
  for(const width of [1100,420]){
   window.setContentSize(width,950);
   await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   console.log(JSON.stringify(await window.webContents.executeJavaScript('checkOverflow()')));
   fs.writeFileSync(${JSON.stringify(screenshots)}+'/'+width+'-collapsed.png',(await window.webContents.capturePage()).toPNG());
  }
  window.setContentSize(1100,950);
  console.log(JSON.stringify(await window.webContents.executeJavaScript('expandAndRefresh()')));
  await window.webContents.executeJavaScript(${JSON.stringify('document.querySelector(\'details.business-review-details[data-review-id="8"]\')?.scrollIntoView({block:"center"})')});
  for(const width of [1100,420]){
   window.setContentSize(width,950);
   await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
   console.log(JSON.stringify(await window.webContents.executeJavaScript('checkOverflow()')));
   fs.writeFileSync(${JSON.stringify(screenshots)}+'/'+width+'-expanded.png',(await window.webContents.capturePage()).toPNG());
  }
  const failures=await window.webContents.executeJavaScript('smokeFailures');
  await window.webContents.executeJavaScript('disposeSmoke()');
  console.log(JSON.stringify({failures,screenshots:${JSON.stringify(screenshots)}}));
  window.destroy();app.exit(failures.length?1:0);
 }catch(error){console.error(error);window?.destroy();app.exit(1)}
});`,
  );
  child = spawn(electron, [join(home, "driver.cjs")], {
    detached: true,
    env: { ...process.env, HOME: home, AGENT_AUTOLOOP_HOME: home, ELECTRON_RUN_AS_NODE: undefined },
    stdio: "inherit",
  });
  const timeout = setTimeout(() => {
    process.kill(-child.pid, "SIGKILL");
  }, 30000);
  try {
    const status = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    if (status !== 0) process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
} finally {
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  rmSync(home, { recursive: true, force: true });
  console.log(`截图保留在 ${screenshots}`);
}
