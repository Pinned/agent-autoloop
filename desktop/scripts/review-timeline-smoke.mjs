// Prevent receipt reviews becoming fake nodes, markup execution or guessed acceptance.
// Only the real renderer and an isolated fake bridge run; no hub or notifications.
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import electron from "electron";
const root = resolve(import.meta.dirname, "../..");
const home = mkdtempSync(join(tmpdir(), "review-timeline-"));
const screenshot = join(tmpdir(), "task48-review-timeline.png");
try {
  await build({ stdin: { resolveDir: root, contents: `
import {mountBusinessTasksView} from '${root}/desktop/src/renderer/business-tasks-view.ts';
import {createRendererBusinessTasks} from '${root}/desktop/src/renderer/business-tasks-controller.ts';
const task={key:'task:48',kind:'task',id:48,rule:'本机开发',source:'local',origin:{eventId:1,title:'任务复查安排',detail:'本轮已结束，任务仍有后续复查。',availability:'recorded',truncated:false},state:'active',latestRunId:127,latestProgress:'本轮结束',finalResult:null,decisions:{items:[],hasMore:false},createdAt:null,updatedAt:null,legacyNotice:null};
const review={id:7,key:'ci',at:'2026-11-19T13:35:00Z',about:'<img src=x onerror=alert(1)>核实远程检查',action:'scheduled',state:'triggered',truncated:false};
const item={seq:50,kind:'finish',at:'2026-11-19T13:15:59Z',runId:127,eventId:null,cardId:null,feedbackId:null,text:'',truncated:false,display:{events:[],runs:[{id:127,state:'done',summary:'已推送，尚待核实远程检查',error:'',truncated:false}],cards:[],completion:null,feedback:[],reviews:{items:[review,{...review,id:8,at:'2099-01-01T00:00:00Z',state:'pending',about:'长文'.repeat(200)},{...review,id:9,state:'cancelled',action:'cancelled'}],truncated:true}}};
let view;const c=createRendererBusinessTasks({businessTasksRead:async r=>({ok:true,data:r.operation==='list'?{scope:'business',rules:['本机开发'],items:[task],hasMore:false,nextBefore:null}:{task,timeline:{items:[item],hasMore:false,nextBefore:null},actions:{cancelTask:false,completeTask:false,completionBlocker:'timers'}}})},()=>view?.update());
view=mountBusinessTasksView(c,{});document.querySelector('main').append(view.root);view.init();c.open('task:48');
window.verify=async()=>{await new Promise(r=>setTimeout(r,150));const list=document.querySelector('.business-timeline');const text=list.textContent;const check=(v,m)=>{if(!v)throw Error(m)};check(list.children.length===1,'one fact one node');check(text.includes('复查安排')&&text.includes('执行者说明'),'independent sections');check(text.includes('已触发，核实结果见后续真实记录'),'no guessed acceptance');check(text.includes('已取消')&&text.includes('待复查'),'all states');check(text.includes('仅显示前20项'),'explicit truncation');check(!list.querySelector('img'),'pure text');check(list.querySelector('details'),'long text expandable');check(!document.querySelector('.business-task-operations')?.textContent.includes('复查安排'),'not operations');c.dispose();return {nodes:list.children.length,markup:!!list.querySelector('img'),width:document.documentElement.scrollWidth,viewport:innerWidth};};` }, bundle: true, platform: "browser", format: "iife", outfile: join(home, "fixture.js") });
  writeFileSync(join(home, "index.html"), `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${root}/desktop/src/renderer/style.css"><main></main><script src="fixture.js"></script>`);
  writeFileSync(join(home, "driver.cjs"), `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');app.setPath('userData',${JSON.stringify(join(home,"data"))});app.whenReady().then(async()=>{try{const w=new BrowserWindow({show:false,width:1100,height:950,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.webContents.on('console-message',(_,level,message)=>console.log(message));await w.loadFile(${JSON.stringify(join(home,"index.html"))});console.log(JSON.stringify(await w.webContents.executeJavaScript('verify().catch(e=>{console.error(e.stack);throw e})')));fs.writeFileSync(${JSON.stringify(screenshot)},(await w.webContents.capturePage()).toPNG());app.exit(0)}catch(e){console.error(e);app.exit(1)}});`);
  const result = spawnSync(electron, [join(home, "driver.cjs")], { env: { ...process.env, HOME: home, AGENT_AUTOLOOP_HOME: home, ELECTRON_RUN_AS_NODE: undefined }, encoding: "utf8", timeout: 30000 });
  process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || "");
  if(result.status !== 0) process.exitCode=1;
  else console.log(`Review timeline visual checks passed; screenshot: ${screenshot}`);
} finally { rmSync(home,{recursive:true,force:true}); }
