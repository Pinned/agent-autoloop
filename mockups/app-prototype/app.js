'use strict';
// Standalone simulation: intentionally no fetch, sockets, native APIs or service calls.
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const money = value => '$' + Number(value).toFixed(2);
const statusNames = {waiting:'待决策',running:'运行中',queued:'排队中',done:'已完成',stopped:'已停止'};
const statusSymbols = {waiting:'◇',running:'●',queued:'◷',done:'✓',stopped:'■'};
const KEY = 'autoloop-interaction-prototype-v1';
const THEME_KEY = 'autoloop-prototype-theme';
const main = $('#main');
const modal = $('#modal');
let toastTimer, returnFocus, selectedTask = null, page = 'today', settingTab = 'Agent';
let search = '', statusFilter = 'all', typeFilter = 'all', workerFilter = '', welcomeStep = 1, welcomeRole = 'owner', onboarding = false;
let environmentChecked = false, connectionChecked = false, ruleEditing = null;
let windowMode = 'open';
const initialTask = (id, title, type, status, worker, agent, cost, details) => ({id,title,type,status,worker,agent,cost,details,round:1,feedback:[],events:[
  {time:'09:00',title:'第 1 轮 · 接收任务',text:'任务已进入模拟队列，保留原始输入。'},
  ...(status === 'queued' ? [] : [{time:'09:01',title:'第 1 轮 · 分配执行机',text:worker + ' / ' + agent}]),
  ...(status === 'done' ? [{time:'09:08',title:'第 1 轮 · 交付完成',text:'输出已整理，等待你查阅。'}] : status === 'waiting' ? [{time:'09:06',title:'第 1 轮 · 等待你的决策',text:'需要确认早报长度。Agent 已暂停，等待回答。'}] : status === 'running' ? [{time:'09:04',title:'第 1 轮 · 执行中',text:'已完成分析，正在整理交付结果。'}] : [])
]});
function seed() {
  return {
    version:1,setup:false,role:'owner',demo:'normal',nextId:46,
    connection:{address:'http://127.0.0.1:8787',name:'小罗的 MacBook',token:'demo-token'},
    tasks:[
      initialTask(41,'每日早报','内容任务','waiting','本机 · MacBook','Claude',.42,'整理今日产品与技术动态，生成一份可直接阅读的早报。'),
      initialTask(42,'梳理登录失败的原因','开发任务','running','本机 · MacBook','Codex',.86,'分析登录日志，给出定位结论与修复方案，不直接修改生产环境。'),
      initialTask(43,'整理本周产品反馈','内容任务','queued','工作站 · Studio','Claude',0,'按主题归类本周反馈，提取需要决策的事项。'),
      initialTask(44,'交付文案审读','审查任务','done','本机 · MacBook','Claude',.28,'检查交付文案的准确性与可读性，整理审读结论。'),
      initialTask(45,'检查回归用例覆盖','审查任务','done','工作站 · Studio','Codex',.64,'核对主要流程的回归用例覆盖情况。')
    ],
    rules:[
      {id:1,title:'工作日早报',trigger:'schedule',time:'09:00',frequency:'工作日',event:'新任务创建',source:'手动输入',agent:'Claude',directory:'/Users/demo/workspace',mode:'prompt',instruction:'汇总今天值得关注的信息，先给出摘要。'},
      {id:2,title:'新反馈归类',trigger:'event',event:'收到新反馈',source:'飞书',time:'10:00',frequency:'每天',agent:'Claude',directory:'/Users/demo/workspace',mode:'skill',instruction:'feedback-triage'}
    ],
    agents:[{name:'Claude',command:'claude',directory:'/Users/demo/workspace'},{name:'Codex',command:'codex',directory:'/Users/demo/workspace'}],
    sources:[{name:'手动输入',value:'在指挥台创建任务'},{name:'飞书',value:'演示来源 · 未连接真实飞书'}],
    channels:[{name:'桌面通知',value:'仅在原型内显示消息'},{name:'飞书机器人',value:'https://example.invalid/demo-webhook'}],
    general:{launch:'关窗驻留（模拟）',language:'简体中文'},
    notifications:[{id:1,title:'交付文案审读已完成',text:'审读结论已归档，无需你做决策。',taskId:44,closed:false}],environmentMissing:false
  };
}
let state;
try {
  const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
  state = saved && saved.version === 1 && Array.isArray(saved.tasks) && Array.isArray(saved.rules) ? saved : seed();
} catch (_) { state = seed(); }
let theme = 'dark';
try { theme = localStorage.getItem(THEME_KEY) || 'dark'; } catch (_) { /* file storage can be unavailable */ }
if (!['dark','light','system'].includes(theme)) theme = 'dark';
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() { document.documentElement.dataset.theme = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme; }
applyTheme();
systemTheme.addEventListener('change', () => { if (theme === 'system') applyTheme(); });
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (_) { toast('浏览器不允许本地保存；本次会话仍可正常演示。'); }
}
function toast(text) { clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').classList.add('show'); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3200); }
function button(text, action, id, kind = '') { return `<button class="${kind}" data-action="${action}"${id === undefined ? '' : ` data-id="${escapeHTML(id)}"`}>${text}</button>`; }
function badge(status) { return `<span class="badge ${status}">${statusSymbols[status] || '○'} ${statusNames[status] || (status === 'offline' ? '离线' : status)}</span>`; }
function isOwner() { return state.role === 'owner'; }
function localTask(task) { return task.worker.startsWith('本机'); }
function visibleTasks() { return state.demo === 'empty' ? [] : state.tasks.filter(task => isOwner() || localTask(task)); }
function taskById(id) { return visibleTasks().find(task => task.id === Number(id)); }
function isDisconnected() { return state.demo === 'offline'; }
function isMissing() { return state.demo === 'missing' || state.environmentMissing; }
function canMutate() { if (isDisconnected()) { toast('演示已断线：不能提交操作，请先模拟重连。'); return false; } return true; }
function requireOwner() { if (!isOwner()) { toast('纯 worker 没有中台管理权限。'); return false; } return true; }
function timestamp() { return new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',hour12:false}); }
function recordEvent(task, title, text) { task.events.push({time:timestamp(),title:`第 ${task.round} 轮 · ${title}`,text}); }
function navigate(target) {
  if (!isOwner() && !['tasks','workers','settings'].includes(target)) target = 'tasks';
  page = target; selectedTask = null; search = ''; statusFilter = 'all'; typeFilter = 'all'; workerFilter = ''; render(); main.scrollTop = 0; main.focus();
}
function pageHead(title, subtitle, action = '') { return `<div class="page-head"><div><div class="eyebrow">${isOwner() ? 'Workspace / command center' : 'Local worker / restricted view'}</div><h1>${title}</h1><p>${subtitle}</p></div><div class="actions">${action}</div></div>`; }
function emptyState(title, description, action = '') { return `<div class="empty"><div class="empty-symbol">[ — ]</div><h2>${title}</h2><p>${description}</p>${action}</div>`; }
function render() {
  if (onboarding || !state.setup) { renderWelcome(); return; }
  $('#demo-state').value = state.demo;
  $('#demo-state').disabled = false;
  const taskCount = visibleTasks().filter(task => ['running','waiting','queued'].includes(task.status)).length;
  const navItems = isOwner() ? [['today','▦','今天'],['tasks','☷','任务'],['automation','↻','自动化'],['workers','▣','执行机'],['settings','⚙','设置']] : [['tasks','☷','本机任务'],['workers','▣','本机环境'],['settings','⚙','连接与设置']];
  $('#sidebar').innerHTML = `<div class="brand"><span class="logo"></span><span class="brand-name">agent-autoloop<small>COMMAND CENTER</small></span></div><div class="nav-label">${isOwner() ? '工作空间' : '纯 WORKER'}</div><nav class="nav" aria-label="主导航">${navItems.map(([id,icon,label]) => `<button data-action="nav" data-id="${id}" class="${page === id ? 'active' : ''}" ${page === id ? 'aria-current="page"' : ''}><span class="nav-icon" aria-hidden="true">${icon}</span><span class="nav-text">${label}</span>${id === 'tasks' ? `<span class="nav-count">${taskCount}</span>` : ''}</button>`).join('')}</nav>${isOwner() ? button('＋ 新建任务','new-task',undefined,'primary new-button') : ''}<div class="sidebar-footer"><div><span class="dot ${isDisconnected() ? 'offline' : ''}"></span>${isDisconnected() ? '中台连接已断开' : '模拟连接正常'}<p class="mono">${isOwner() ? (isDisconnected() ? '0 在线 / 3 执行机' : '2 在线 / 3 执行机') : '仅本机 · 不可调度全局'}</p><div class="role-pill">${isOwner() ? '中台 + 本机 worker · owner' : '纯 worker · 受限角色'}</div>${button('查看连接','connection',undefined,'ghost small')}</div></div>`;
  $('#status-text').textContent = `${isOwner() ? 'Owner' : 'Worker'} · ${isDisconnected() ? '离线快照' : '本地假数据'} · 不触发真实操作`;
  $('#tray-dot').textContent = isDisconnected() ? '○' : '●';
  let html = isDisconnected() ? `<div class="notice warning"><strong>中台连接已断开</strong><p>正在展示演示快照，提交操作暂不可用；本机环境检查仍可模拟。</p><div class="actions">${button('模拟重连','reconnect',undefined,'small')}${button('编辑连接','connection',undefined,'small ghost')}</div></div>` : '';
  if (isMissing()) html += `<div class="notice warning"><strong>本机 Agent 环境缺失</strong><p>模拟 Claude 未安装。新任务仍可入队，但本机不能启动执行。</p><div class="actions">${button('查看环境','nav','workers','small')}${button('模拟修复','repair',undefined,'small ghost')}</div></div>`;
  if (selectedTask !== null) html += renderDetail();
  else if (page === 'today' && isOwner()) html += renderToday();
  else if (page === 'tasks') html += renderTasks();
  else if (page === 'automation' && isOwner()) html += renderAutomation();
  else if (page === 'workers') html += renderWorkers();
  else html += renderSettings();
  main.innerHTML = html;
}
function taskRows(tasks) {
  return tasks.map(task => `<button class="task-row" data-action="task" data-id="${task.id}" aria-label="查看任务 ${task.id} ${escapeHTML(task.title)}"><div><strong><span class="mono muted">#${task.id}</span> ${escapeHTML(task.title)}</strong><div class="meta">${escapeHTML(task.agent)} · ${escapeHTML(task.worker)} · 第 ${task.round} 轮</div></div><div>${badge(task.status)}</div><span class="cost-cell mono muted">${money(task.cost)}</span><span class="arrow">›</span></button>`).join('');
}
function renderToday() {
  const tasks = visibleTasks(), decisions = tasks.filter(task => task.status === 'waiting');
  const active = tasks.filter(task => ['running','queued'].includes(task.status)), done = tasks.filter(task => task.status === 'done');
  const notifications = state.demo === 'empty' ? [] : state.notifications.filter(item => !item.closed);
  return pageHead('今天','让 Agent 继续推进，只把需要你的事情带回来。',button('＋ 新建任务','new-task',undefined,'primary')) +
    `<div class="stats">${[['待你决策',decisions.length,'需要你的输入'],['正在推进',active.filter(t=>t.status==='running').length,'运行中的任务'],['今日完成',done.length,'已归档交付'],['模拟成本',money(tasks.reduce((n,t)=>n+t.cost,0)),'USD · 非实际账单']].map(([label,value,hint])=>`<div class="stat"><div class="label">${label}</div><div class="value">${value}</div><div class="hint">${hint}</div></div>`).join('')}</div>` +
    `<div class="section-head"><h2>待你决策 <small>${decisions.length} 项</small></h2><span class="hint">回答后继续推进</span></div>` +
    (decisions.length ? decisions.map(task => `<article class="panel decision"><div class="decision-top"><h2><span class="mono muted">#${task.id}</span> ${escapeHTML(task.title)}</h2>${badge(task.status)}</div><p>早报希望采用哪种篇幅？选择一种，或告诉 Agent 你的要求。</p><div class="actions">${button('精简摘要','answer-option',`${task.id}:精简摘要`,'small')}${button('深度分析','answer-option',`${task.id}:深度分析`,'small')}${button('自定义回答','answer-custom',task.id,'small ghost')}</div><div class="foot"><span class="muted">${escapeHTML(task.agent)} · 第 ${task.round} 轮等待中</span>${button('查看完整上下文 →','task',task.id,'small ghost')}</div></article>`).join('') : emptyState('没有待决策事项','需要你介入时，决策会集中出现在这里。')) +
    `<div class="section-head"><h2>正在推进 <small>运行与排队</small></h2>${button('全部任务 →','nav','tasks','ghost small')}</div>` + (active.length ? taskRows(active) : emptyState('队列暂时安静','新建一个任务，开始演示路由与推进。',button('新建任务','new-task',undefined,'primary'))) +
    `<div class="section-head"><h2>已完成与通知 <small>通知无需回答</small></h2></div>` + (notifications.map(item=>`<article class="panel"><div class="decision-top"><h3>✓ ${escapeHTML(item.title)}</h3><span class="badge done">通知</span></div><p class="muted">${escapeHTML(item.text)}</p><div class="actions" style="margin-top:12px">${button('查看交付','task',item.taskId,'small')}${button('通知结案','close-notification',item.id,'small ghost')}</div></article>`).join('') || '<p class="hint">没有未结案通知。</p>') + (done.length ? taskRows(done) : '');
}
function renderTasks() {
  return pageHead(isOwner() ? '任务' : '本机任务',isOwner() ? '所有任务、输入与交付，保留完整推进轨迹。' : '只显示分配到本机的任务；不可创建或管理全局任务。',isOwner() ? button('＋ 新建任务','new-task',undefined,'primary') : button('检查本机环境','check-environment',undefined,'')) +
    `<div class="filters"><input id="task-search" type="search" placeholder="搜索标题、编号、详情或 Agent…" aria-label="搜索任务" value="${escapeHTML(search)}"><select id="task-status" aria-label="状态筛选"><option value="all">全部状态</option>${Object.entries(statusNames).map(([key,name])=>`<option value="${key}" ${statusFilter===key?'selected':''}>${name}</option>`).join('')}</select><select id="task-type" aria-label="类型筛选"><option value="all">全部类型</option>${['开发任务','内容任务','审查任务'].map(type=>`<option ${typeFilter===type?'selected':''}>${type}</option>`).join('')}</select></div><div id="task-results">${filteredTasksHTML()}</div>`;
}
function filteredTasksHTML() {
  const tasks = visibleTasks().filter(task => (!workerFilter || (workerFilter === 'local' ? localTask(task) : task.worker === workerFilter)) && (statusFilter==='all'||task.status===statusFilter) && (typeFilter==='all'||task.type===typeFilter) && `${task.id} ${task.title} ${task.details} ${task.agent}`.toLowerCase().includes(search.toLowerCase()));
  return `${workerFilter ? `<div class="notice">范围：${workerFilter==='local'?'本机任务':escapeHTML(workerFilter)} ${button('查看全部 / 清空筛选','clear-filter',undefined,'ghost small')}</div>` : ''}<p class="hint" style="margin-bottom:10px" role="status">${tasks.length} 个任务 · ${isOwner() ? '演示工作空间' : '本机范围'}</p>` + (tasks.length ? taskRows(tasks) : emptyState(search||statusFilter!=='all'||typeFilter!=='all'?'没有匹配的任务':'还没有任务',search||statusFilter!=='all'||typeFilter!=='all'?'试试更短的关键词，或清空筛选。':'这个状态用于演示首次进入与空列表。',search||statusFilter!=='all'||typeFilter!=='all'?button('清空筛选','clear-filter'):isOwner()?button('新建任务','new-task',undefined,'primary'):button('查看连接','connection')));
}
function renderDetail() {
  const task = taskById(selectedTask);
  if (!task) { selectedTask = null; return emptyState('此任务不在当前视图','空状态或角色切换后，原任务不可见。',button('返回任务','nav','tasks')); }
  const mutable = ['running','waiting','queued'].includes(task.status);
  return button('‹ 返回任务列表','back',undefined,'back') +
    pageHead(`<span class="mono muted">#${task.id}</span> ${escapeHTML(task.title)}`,`${escapeHTML(task.type)} · 第 ${task.round} 轮`,badge(task.status)) +
    `<div class="detail-meta"><span>${escapeHTML(task.agent)}</span><span>${escapeHTML(task.worker)}</span><span>来源：手动输入 / 演示</span><span>所有时间与成本均为假数据</span></div><div class="actions" style="margin-bottom:20px">${isOwner() ? button('提交更正','correction',task.id) + (mutable ? button('停止任务','stop-task',task.id,'danger') : '') : '<span class="hint">受限视图：输入更正与停止由中台 owner 决策。</span>'}${task.status === 'running' ? button('模拟完成','complete-task',task.id,'small') : task.status === 'queued' ? button('模拟开始执行','start-task',task.id,'small') : ''}</div>` +
    `<div class="two-columns"><div><section class="panel"><h2>任务输入</h2><p class="muted" style="margin-top:12px;white-space:pre-wrap;overflow-wrap:anywhere">${escapeHTML(task.details)}</p></section>${task.status==='waiting' && isOwner() ? `<section class="panel decision"><h2>需要确认早报篇幅</h2><p class="hint">回答将恢复本轮；更正任务则会开启新一轮。</p><div class="actions" style="margin-top:12px">${button('精简摘要','answer-option',`${task.id}:精简摘要`,'small')}${button('深度分析','answer-option',`${task.id}:深度分析`,'small')}${button('自定义回答','answer-custom',task.id,'small')}</div></section>` : ''}<section class="panel"><h2>执行时间线</h2><p class="hint">每轮编号独立。历史不会被覆盖，也不会伪装成同一轮重跑。</p><ol class="timeline">${task.events.map((event,index)=>`<li class="${index===task.events.length-1?'current':''}"><time>${escapeHTML(event.time)}</time><strong>${escapeHTML(event.title)}</strong><p>${escapeHTML(event.text)}</p></li>`).join('')}</ol></section>${task.status==='done' ? `<section class="panel"><h2>交付摘要</h2><p class="hint">${escapeHTML(task.title)}已完成。演示交付包括：结论摘要、待关注事项和下一步建议。</p><div class="preview">这是原型中的示例结果，不来自真实 Agent，也没有实际文件产物。</div><div class="actions" style="margin-top:12px">${button('复制示例结果','copy-result',task.id,'small')}${isOwner()?button('提交交付反馈','feedback',task.id,'small'):''}</div></section>`:''}${task.feedback.length ? `<section class="panel"><h2>已提交反馈</h2>${task.feedback.map(item=>`<div class="feedback-box"><strong>${escapeHTML(item.kind)}</strong><p>${escapeHTML(item.text)}</p><small class="muted">${escapeHTML(item.time)} · 已记录在原型中</small></div>`).join('')}</section>`:''}</div><aside><section class="panel"><h2>成本 · 模拟</h2><div class="cost-total">${money(task.cost)}</div><p class="hint">累计 ${task.round} 轮 · USD</p><div class="cost-row"><span class="muted">输入</span><span class="mono">${money(task.cost*.35)}</span></div><div class="cost-row"><span class="muted">输出</span><span class="mono">${money(task.cost*.65)}</span></div><p class="hint">仅用于展示计费信息，不代表真实价格或账单。</p></section><section class="panel"><h2>执行信息</h2><dl class="key-values"><dt>当前轮次</dt><dd>第 ${task.round} 轮</dd><dt>执行 Agent</dt><dd>${escapeHTML(task.agent)}</dd><dt>执行机</dt><dd>${escapeHTML(task.worker)}</dd><dt>目录</dt><dd class="mono">/Users/demo/workspace</dd><dt>权限</dt><dd>${isOwner()?'中台管理':'本机只读 + 模拟执行'}</dd></dl></section></aside></div>`;
}
function renderAutomation() {
  const rules = state.demo === 'empty' ? [] : state.rules;
  return pageHead('自动化','把重复的工作写成规则，让触发、执行与路由更清楚。',button('＋ 新增规则','new-rule',undefined,'primary')) +
    `<div class="notice">规则编辑仅为交互设计。此原型不创建真实调度器，也不承诺现有后端支持规则启停，因此不提供启停开关。</div>` +
    (rules.length ? rules.map(rule=>`<article class="panel"><div class="rule-top"><h2>${escapeHTML(rule.title)}</h2><div class="actions"><span class="badge">${rule.trigger==='schedule'?'◷ 定时触发':'↳ 事件触发'}</span>${button('编辑','edit-rule',rule.id,'small')}</div></div><p class="rule-description">${rule.trigger==='schedule'?`${escapeHTML(rule.frequency)} ${escapeHTML(rule.time)} · 本机时区（演示）`:`${escapeHTML(rule.source)} / ${escapeHTML(rule.event)}`}</p><p>${escapeHTML(rule.mode==='skill'?'Skill: '+rule.instruction:rule.instruction)}</p><div class="chips"><span class="chip">Agent · ${escapeHTML(rule.agent)}</span><span class="chip mono">${escapeHTML(rule.directory)}</span><span class="chip">仅本地原型规则</span></div></article>`).join('') : emptyState('还没有自动化规则','先添加一个定时或事件规则，预览其执行配置。',button('新增规则','new-rule',undefined,'primary')));
}
function renderWorkers() {
  const workers = [{name:'本机 · MacBook',platform:'macOS · arm64',online:!isDisconnected(),local:true},{name:'工作站 · Studio',platform:'macOS · arm64',online:!isDisconnected(),local:false},{name:'Linux · Build',platform:'Linux · x64',online:false,local:false}].filter(worker=>isOwner()||worker.local);
  return pageHead(isOwner()?'执行机':'本机环境',isOwner()?'看清任务在哪里执行，以及 Agent 是否准备就绪。':'本机任务、Agent 检查与中台连接；不展示其他执行机。',button('模拟环境检查','check-environment')) +
    `<div class="worker-grid">${workers.map(worker=>`<section class="panel"><div class="worker-top"><h2>${worker.local?'▣':'▤'} ${worker.name}</h2><span class="badge ${worker.online?'done':'offline'}">${worker.online?'● 在线':'○ 离线'}</span></div><p class="hint">${worker.platform} · ${worker.local?'当前设备':'模拟远程设备'}</p><dl class="key-values"><dt>分配任务</dt><dd>${visibleTasks().filter(task=>task.worker===worker.name&&['running','waiting','queued'].includes(task.status)).length} 项</dd><dt>环境</dt><dd>${worker.local&&isMissing()?'Claude 缺失':worker.online?'就绪（模拟）':'无法获取'}</dd><dt>最近心跳</dt><dd>${worker.online?'3 秒前（假数据）':'42 分钟前（假数据）'}</dd></dl><div class="actions" style="margin-top:12px">${button(worker.local?'本机任务':'查看分配任务','worker-tasks',worker.local?'local':worker.name,'small')}${worker.local?button('检查环境','check-environment',undefined,'small ghost'):button('连接说明','worker-info',worker.name,'small ghost')}</div></section>`).join('')}</div>` +
    `<div class="section-head"><h2>本机 Agent 环境</h2><span class="hint">不执行真实命令</span></div><section class="panel">${state.agents.map(agent=>`<div class="environment-row"><div><h3>${escapeHTML(agent.name)}</h3><p class="hint mono">启动程序：${escapeHTML(agent.command)}</p></div><span class="badge ${isMissing()&&agent.name==='Claude'?'waiting':'done'}">${isMissing()&&agent.name==='Claude'?'! 未安装':'✓ 可用（模拟）'}</span></div>`).join('')}<p class="hint">环境检查只显示预设结果，不读取文件系统、密钥或真实 CLI 配置。</p></section><div class="section-head"><h2>本机任务</h2>${button('任务列表 →','nav','tasks','ghost small')}</div>${visibleTasks().filter(localTask).length?taskRows(visibleTasks().filter(localTask)):emptyState('本机暂无分配任务','中台分配到本机后，任务会出现在这里。')}`;
}
function renderSettings() {
  const tabs = isOwner()?['Agent','来源','通知通道','角色连接','通用']:['Agent','角色连接','通用'];
  if (!tabs.includes(settingTab)) settingTab='角色连接';
  let body='';
  if (settingTab==='Agent') body=`<section class="panel"><h2>本机 Agent 配置</h2><p class="hint">启动命令仅作为演示文本保存，不调用本机程序。</p>${state.agents.map((agent,index)=>`<div class="setting-row"><div><h3>${escapeHTML(agent.name)}</h3><p class="mono">${escapeHTML(agent.command)} · ${escapeHTML(agent.directory)}</p></div>${button('编辑','edit-agent',index,'small')}</div>`).join('')}<div class="actions" style="margin-top:15px">${button('模拟环境检查','check-environment',undefined,'small')}</div></section>`;
  if (settingTab==='来源') body=`<section class="panel"><h2>任务来源</h2>${state.sources.map((source,index)=>`<div class="setting-row"><div><h3>${escapeHTML(source.name)}</h3><p>${escapeHTML(source.value)}</p></div>${button('编辑','edit-source',index,'small')}</div>`).join('')}<p class="hint">仅为来源配置视觉稿，不授权账号、不拉取真实消息。</p></section>`;
  if (settingTab==='通知通道') body=`<section class="panel"><h2>通知通道</h2>${state.channels.map((channel,index)=>`<div class="setting-row"><div><h3>${escapeHTML(channel.name)}</h3><p>${escapeHTML(channel.value)}</p></div><div class="actions">${button('测试','test-channel',index,'small ghost')}${button('编辑','edit-channel',index,'small')}</div></div>`).join('')}<p class="hint">测试通知只在本页面显示，不向桌面或飞书发送。</p></section>`;
  if (settingTab==='角色连接') body=`<section class="panel"><h2>角色与连接</h2><div class="setting-row"><div><h3>运行角色</h3><p>${isOwner()?'中台 + 本机 worker · owner 可管理全局':'纯 worker · 只能查看本机任务、环境和连接'}</p></div>${button('切换角色','switch-role',undefined,'small')}</div><div class="setting-row"><div><h3>中台地址</h3><p class="mono">${escapeHTML(state.connection.address)}</p></div>${button('编辑连接','connection',undefined,'small')}</div><div class="setting-row"><div><h3>连接状态</h3><p>${isDisconnected()?'断线 · 仅演示快照':'已连接（模拟）'} · 设备：${escapeHTML(state.connection.name)}</p></div>${button('模拟连接检查','test-connection',undefined,'small')}</div><p class="hint">角色切换仅用于演示，不是真实权限提升。请勿填写真实令牌。</p></section>`;
  if (settingTab==='通用') body=`<section class="panel"><h2>外观与桌面行为</h2><div class="setting-row"><div><h3>主题</h3><p>深色 / 浅色独立对比度；跟随系统实时更新。</p></div><select id="theme-select" aria-label="主题">${[['dark','深色'],['light','浅色'],['system','跟随系统']].map(([value,label])=>`<option value="${value}" ${theme===value?'selected':''}>${label}</option>`).join('')}</select></div><div class="setting-row"><div><h3>关窗行为</h3><p>${escapeHTML(state.general.launch)} · 浏览器页面实际仍在运行</p></div>${button('编辑','edit-general',undefined,'small')}</div><div class="setting-row"><div><h3>桌面菜单栏</h3><p>查看任务、恢复窗口和真退出的模拟入口。</p></div>${button('打开模拟菜单','tray',undefined,'small')}</div><div class="setting-row"><div><h3>本地原型数据</h3><p>localStorage 仅保存主题与原型状态；不保存真实凭据。</p></div>${button('重置演示','reset',undefined,'small danger')}</div></section>`;
  return pageHead('设置',isOwner()?'Agent、来源、通知与连接，集中管理演示配置。':'仅本机 Agent、连接和个人外观设置。')+`<nav class="setting-tabs" aria-label="设置分组">${tabs.map(tab=>button(escapeHTML(tab),'setting-tab',tab,settingTab===tab?'active':'')).join('')}</nav>`+body;
}
function openModal(title, body, footer = '', onSubmit) {
  returnFocus = document.activeElement;
  if (modal.open) modal.close();
  $('#modal-content').innerHTML=`<form id="modal-form" novalidate><header class="modal-header"><h2 id="modal-title">${title}</h2><button type="button" class="ghost" data-action="close-modal" aria-label="关闭弹窗">×</button></header><div class="modal-body">${body}<p class="error" id="form-error" role="alert" aria-live="assertive"></p></div><footer class="modal-footer">${footer||'<button type="button" data-action="close-modal">取消</button><button type="submit" class="primary">保存（模拟）</button>'}</footer></form>`;
  // Action buttons in forms must never accidentally submit.
  $$('button[data-action]',modal).forEach(element=>element.type='button');
  $('#modal-form').addEventListener('submit',event=>{event.preventDefault();if(onSubmit)onSubmit(new FormData(event.currentTarget));});
  modal.showModal();
  requestAnimationFrame(()=>{if(!modal.open)return;const focus=$('input,select,textarea',modal)||$('button',modal);focus?.focus();});
}
function closeModal() { modal.close(); }
modal.addEventListener('close',()=>{if(returnFocus?.isConnected)returnFocus.focus();else main.focus();});
modal.addEventListener('click',event=>{if(event.target===modal){const rect=modal.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeModal();}});
modal.addEventListener('keydown',event=>{
  if(event.key!=='Tab')return;
  const focusable=$$('button,input,select,textarea,[tabindex]',modal).filter(element=>!element.disabled&&!element.closest('[hidden]'));
  const first=focusable[0],last=focusable.at(-1);
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
});
function formError(text, name) { $('#form-error').textContent=text; if(name){const input=$(`[name="${name}"]`,modal);input?.setAttribute('aria-invalid','true');input?.focus();} }
function field(label,name,value='',options={}) {
  const {type='text',hint='',placeholder='',required=false} = options;
  return `<label class="field"><span>${label}${required?' <small class="muted">必填</small>':''}</span>${type==='textarea'?`<textarea name="${name}" ${required?'required':''} placeholder="${escapeHTML(placeholder)}">${escapeHTML(value)}</textarea>`:`<input name="${name}" type="${type}" value="${escapeHTML(value)}" ${required?'required':''} placeholder="${escapeHTML(placeholder)}">`}${hint?`<small class="hint">${hint}</small>`:''}</label>`;
}
function selectField(label,name,options,value) { return `<label class="field"><span>${label}</span><select name="${name}">${options.map(option=>{const [val,text]=Array.isArray(option)?option:[option,option];return `<option value="${escapeHTML(val)}" ${value===val?'selected':''}>${escapeHTML(text)}</option>`;}).join('')}</select></label>`; }
function validDirectory(value) { return /^(\/|[A-Za-z]:[\\/])/.test(value) && !/[\r\n\0]/.test(value); }
function newTask() {
  if(!requireOwner())return;
  openModal('新建任务',selectField('任务类型','type',['开发任务','内容任务','审查任务'],'开发任务')+field('标题','title','',{required:true,placeholder:'例如：分析登录失败的原因'})+field('任务详情','details','',{type:'textarea',required:true,placeholder:'描述目标、背景和希望交付的结果'})+`<div class="preview" id="route-preview"></div>`, '<button type="button" data-action="close-modal">取消</button><button type="submit" class="primary">创建并入队（模拟）</button>',data=>{
    if(!canMutate())return formError('连接已断开，请重连后创建。');
    const title=data.get('title').trim(),details=data.get('details').trim(),type=data.get('type');
    if(!title)return formError('请输入任务标题。','title');
    if(title.length>100)return formError('标题最多 100 个字符。','title');
    if(!details)return formError('请补充任务详情，Agent 需要明确目标。','details');
    const agent=type==='开发任务'?'Codex':'Claude';
    const task=initialTask(state.nextId++,title,type,'queued','本机 · MacBook',agent,0,details);
    task.events=[{time:timestamp(),title:'第 1 轮 · 创建并入队',text:`手动输入 → ${agent} → 本机 · MacBook。${isMissing()&&agent==='Claude'?'本机环境缺失，等待准备就绪。':'等待执行槽位。'}`}];
    state.tasks.unshift(task);state.demo=state.demo==='empty'?'normal':state.demo;persist();closeModal();page='tasks';selectedTask=task.id;render();main.scrollTop=0;toast('任务已在原型中创建并入队。');
  });
  const update=()=>{const type=$('[name=type]',modal).value;$('#route-preview').innerHTML=`<strong>路由预览 · 模拟</strong><p>手动输入 → ${type==='开发任务'?'Codex':'Claude'} → 本机 · MacBook</p><p class="hint">目录：${escapeHTML(state.agents.find(agent=>agent.name===(type==='开发任务'?'Codex':'Claude'))?.directory||'/Users/demo/workspace')}<br>${isMissing()&&type!=='开发任务'?'环境缺失：创建后排队，暂不能启动。':'创建后进入队列，手动点击“模拟开始执行”推进。'}</p>`;};
  $('[name=type]',modal).addEventListener('change',update);update();
}
function answer(taskId, text) {
  if(!requireOwner()||!canMutate())return;
  const task=taskById(taskId);if(!task||task.status!=='waiting')return toast('此任务已不在待决策状态。');
  recordEvent(task,'收到决策',text);task.status='running';recordEvent(task,'恢复推进','保持当前轮次，使用已确认的要求继续执行。');persist();closeModal();render();toast('回答已记录，Agent 在本轮继续推进（模拟）。');
}
function answerCustom(id) {
  const task=taskById(id);if(!task||!requireOwner())return;
  openModal('回答 Agent 的问题',`<p class="muted">#${task.id} ${escapeHTML(task.title)} · 本轮继续，不新增轮次。</p>`+field('你的回答','answer','',{type:'textarea',required:true,placeholder:'例如：控制在 800 字以内，重点关注产品动态'}),'<button type="button" data-action="close-modal">取消</button><button type="submit" class="primary">提交回答（模拟）</button>',data=>{const text=data.get('answer').trim();if(!text)return formError('请输入你的回答。','answer');answer(id,text);});
}
function correctTask(id) {
  const task=taskById(id);if(!task||!requireOwner())return;
  openModal('更正任务输入',`<div class="notice">提交后保留第 ${task.round} 轮历史，并开启第 ${task.round+1} 轮。不是“同一轮重跑”。${['running','waiting'].includes(task.status)?'当前轮将结束。':''}</div>`+field('更正说明','correction','',{type:'textarea',required:true,placeholder:'明确需要改变的目标、约束或交付要求'}),'<button type="button" data-action="close-modal">取消</button><button type="submit" class="primary">提交并开启新一轮（模拟）</button>',data=>{
    if(!canMutate())return formError('断线状态不能提交更正。');
    const text=data.get('correction').trim();if(!text)return formError('请填写更正说明。','correction');
    recordEvent(task,'收到更正，本轮结束',text);task.round++;task.status='queued';recordEvent(task,'根据更正创建新一轮',text+'\n保留全部历史，等待重新分配执行。');persist();closeModal();render();toast(`更正已记录，第 ${task.round} 轮已入队。`);
  });
}
function stopTask(id) {
  const task=taskById(id);if(!task||!requireOwner())return;
  openModal('确认停止任务？',`<p>#${task.id} ${escapeHTML(task.title)}</p><p class="hint">第 ${task.round} 轮将停止，已产生的历史与模拟成本保留。之后如需继续，请提交更正开启新一轮。</p>`,'<button type="button" data-action="close-modal">继续任务</button><button type="submit" class="danger">确认停止（模拟）</button>',()=>{
    if(!canMutate())return formError('断线状态不能停止任务。');
    task.status='stopped';recordEvent(task,'用户停止','停止当前轮次，保留已执行结果。');persist();closeModal();render();toast('已模拟停止，不会终止真实进程。');
  });
}
function completeTask(id) {
  const task=taskById(id);if(!task||!canMutate())return;
  if(task.status!=='running')return toast('只有运行中的任务可以模拟完成。');
  task.status='done';task.cost=Number((task.cost+.18).toFixed(2));recordEvent(task,'交付完成','已生成示例摘要，成本新增 $0.18（假数据）。');state.notifications.push({id:Date.now(),title:task.title+'已完成',text:'示例交付已准备好，无需回答。',taskId:task.id,closed:false});persist();render();toast('任务已模拟完成，已生成一条交付通知。');
}
function startTask(id) {
  const task=taskById(id);if(!task||!canMutate())return;
  if(task.status!=='queued')return toast('此任务不在队列中。');
  if(localTask(task)&&isMissing()&&task.agent==='Claude')return toast('Claude 环境缺失，请先在执行机页模拟修复。');
  task.status='running';recordEvent(task,'开始执行',`${task.worker} / ${task.agent} 已模拟接收本轮任务。`);persist();render();toast('已模拟开始执行。');
}
function feedbackTask(id) {
  const task=taskById(id);if(!task||!requireOwner())return;
  openModal('交付反馈',selectField('反馈类型','kind',['交付满意','需要改善','内容错误'],'交付满意')+field('反馈内容','text','',{type:'textarea',required:true,placeholder:'告诉我们结果哪里做得好，或哪里需要改善'})+`<p class="hint">反馈只记录评价，不自动重新执行。如需修改任务，请用“提交更正”开启新一轮。</p>`,'<button type="button" data-action="close-modal">取消</button><button type="submit" class="primary">提交反馈（模拟）</button>',data=>{
    if(!canMutate())return formError('断线状态不能提交反馈。');const text=data.get('text').trim();if(!text)return formError('请填写反馈内容。','text');
    task.feedback.push({kind:data.get('kind'),text,time:timestamp()});recordEvent(task,'交付反馈已记录',data.get('kind')+'：'+text);persist();closeModal();render();toast('反馈已保存到原型，没有触发新一轮。');
  });
}
function editRule(id) {
  if(!requireOwner())return;
  ruleEditing=id?state.rules.find(rule=>rule.id===Number(id)):null;
  const rule=ruleEditing||{title:'',trigger:'schedule',time:'09:00',frequency:'每天',event:'新任务创建',source:'手动输入',agent:'Claude',directory:'/Users/demo/workspace',mode:'prompt',instruction:''};
  openModal(ruleEditing?'编辑自动化规则':'新增自动化规则',field('规则名称','title',rule.title,{required:true})+selectField('触发方式','trigger',[['schedule','定时触发'],['event','事件触发']],rule.trigger)+`<div id="schedule-fields" class="form-grid">${selectField('执行频率','frequency',['每天','工作日','每周一'],rule.frequency)}${field('执行时间','time',rule.time,{type:'time',required:true})}</div><div id="event-fields" class="form-grid">${selectField('事件','event',['新任务创建','收到新反馈','任务交付完成'],rule.event)}${selectField('来源','source',state.sources.map(source=>source.name),rule.source)}</div>`+`<div class="form-grid">${selectField('Agent','agent',state.agents.map(agent=>agent.name),rule.agent)}${selectField('输入方式','mode',[['prompt','Prompt'],['skill','Skill']],rule.mode)}</div>`+field('工作目录','directory',rule.directory,{required:true,hint:'仅验证绝对路径格式，不访问目录。'})+field('Prompt / Skill','instruction',rule.instruction,{type:'textarea',required:true,hint:'Prompt 必须填写；Skill 使用字母、数字、下划线、短横线组成的名称。'})+`<div class="preview" id="rule-preview"></div><p class="hint">仅保存本地规则，未注册真实事件监听或定时任务。</p>`,undefined,data=>{
    if(!canMutate())return formError('断线状态不能提交规则。');
    const title=data.get('title').trim(),directory=data.get('directory').trim(),instruction=data.get('instruction').trim();
    if(!title)return formError('请填写规则名称。','title');
    if(!state.agents.some(agent=>agent.name===data.get('agent')))return formError('请选择可用 Agent。','agent');
    if(!validDirectory(directory))return formError('工作目录必须是绝对路径，例如 /Users/demo/workspace。','directory');
    if(!instruction)return formError(data.get('mode')==='skill'?'请填写 Skill 名称。':'请填写 Prompt 内容。','instruction');
    if(data.get('mode')==='skill'&&!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(instruction))return formError('Skill 名称只能包含字母、数字、下划线与短横线，不能包含空格。','instruction');
    if(data.get('trigger')==='schedule'&&!/^([01]\d|2[0-3]):[0-5]\d$/.test(data.get('time')||''))return formError('请填写有效的执行时间。','time');
    const updated={id:ruleEditing?.id||Date.now(),title,trigger:data.get('trigger'),time:data.get('time')||rule.time,frequency:data.get('frequency')||rule.frequency,event:data.get('event')||rule.event,source:data.get('source')||rule.source,agent:data.get('agent'),directory,mode:data.get('mode'),instruction};
    if(ruleEditing)state.rules=state.rules.map(item=>item.id===updated.id?updated:item);else state.rules.unshift(updated);
    if(state.demo==='empty')state.demo='normal';persist();closeModal();render();toast('规则已在原型中保存；没有创建真实自动化。');
  });
  const update=()=>{
    const trigger=$('[name=trigger]',modal).value,mode=$('[name=mode]',modal).value;
    $('#schedule-fields').hidden=trigger!=='schedule';$('#event-fields').hidden=trigger!=='event';
    $$('input,select',$('#schedule-fields')).forEach(el=>el.disabled=trigger!=='schedule');
    $$('input,select',$('#event-fields')).forEach(el=>el.disabled=trigger!=='event');
    $('[name=instruction]',modal).placeholder=mode==='skill'?'例如：feedback-triage':'写清楚触发后希望 Agent 做什么';
    const frequency=$('[name=frequency]',modal).value,time=$('[name=time]',modal).value,event=$('[name=event]',modal).value,source=$('[name=source]',modal).value,agent=$('[name=agent]',modal).value;
    $('#rule-preview').innerHTML=`<strong>执行预览 · 模拟</strong><p>${escapeHTML(trigger==='schedule'?frequency+' '+time:source+' / '+event)} → ${escapeHTML(agent)} → 本机 worker</p><p class="hint">输入：${mode==='skill'?'命名 Skill（不验证本机是否安装）':'自定义 Prompt'} · 不执行命令</p>`;
  };
  $$('select,input',modal).forEach(el=>el.addEventListener('change',update));update();
}
function checkEnvironment() {
  openModal('本机环境检查 · 模拟',`<p class="muted">不会运行命令，也不会读取真实安装状态。</p><div style="margin-top:15px">${[['操作系统','✓ macOS arm64（预设）'],['工作目录','✓ 绝对路径格式有效（预设）'],['Claude 启动程序',isMissing()?'! 缺失（演示状态）':'✓ 可用（预设）'],['Codex 启动程序','✓ 可用（预设）'],['中台连接',isDisconnected()?'! 已断开（演示状态）':'✓ 可达（预设）']].map(([name,result])=>`<div class="check-result"><span>${name}</span><strong>${result}</strong></div>`).join('')}</div><p class="hint">${isMissing()?'可通过“模拟修复”切换到就绪状态，不会安装任何包。':'当前模拟环境已准备就绪。'}</p>`,`${isMissing()?'<button type="button" data-action="repair">模拟修复</button>':''}<button type="button" data-action="close-modal" class="primary">完成检查</button>`);
}
function editAgent(index) {
  const agent=state.agents[Number(index)];if(!agent)return;
  openModal('编辑 '+escapeHTML(agent.name),field('启动程序 / 前缀','command',agent.command,{required:true,hint:'仅演示文本，不执行 shell。'})+field('默认工作目录','directory',agent.directory,{required:true}),undefined,data=>{
    const command=data.get('command').trim(),directory=data.get('directory').trim();if(!command)return formError('请填写启动程序。','command');if(!validDirectory(directory))return formError('请输入绝对目录路径。','directory');
    agent.command=command;agent.directory=directory;persist();closeModal();render();toast('Agent 演示配置已保存。');
  });
}
function editSimple(kind,index) {
  if(!requireOwner())return;
  const list=kind==='source'?state.sources:state.channels,item=list[Number(index)];if(!item)return;
  openModal('编辑'+(kind==='source'?'任务来源':'通知通道'),field('名称','name',item.name,{required:true})+field(kind==='source'?'来源说明':'通道配置（仅演示）','value',item.value,{required:true,hint:'请勿填写真实令牌或私密信息。所有内容只作为原型状态保存。'}),undefined,data=>{
    if(!canMutate())return formError('断线状态不能提交中台配置。');
    const name=data.get('name').trim(),value=data.get('value').trim();if(!name)return formError('请填写名称。','name');if(!value)return formError('请填写配置内容。','value');
    if(kind==='channel'&&Number(index)===1&&!/^https:\/\//.test(value))return formError('机器人演示地址应以 https:// 开头。','value');
    item.name=name;item.value=value;persist();closeModal();render();toast('演示配置已保存，没有连接外部服务。');
  });
}
function connectionModal() {
  openModal('连接设置 · 模拟',field('中台地址','address',state.connection.address,{required:true,hint:'只校验 URL 格式，不发送网络请求。'})+field('本机名称','name',state.connection.name,{required:true})+field('演示连接令牌','token','demo-token',{hint:'此字段仅用于演示且不保存；不要填写真实令牌。'})+`<p class="hint">当前角色：${isOwner()?'中台 + 本机 worker':'纯 worker'}。保存不会改变角色权限。</p>`,undefined,data=>{
    const address=data.get('address').trim(),name=data.get('name').trim();try{const url=new URL(address);if(!['http:','https:'].includes(url.protocol))throw Error();}catch(_){return formError('请输入有效的 http:// 或 https:// 中台地址。','address');}
    if(!name)return formError('请填写本机名称。','name');state.connection={address,name,token:'demo-token'};persist();closeModal();render();toast('模拟连接配置已保存，没有发起真实连接。');
  });
}
function switchRole() {
  openModal('切换演示角色',`<p>角色切换仅演示两种产品形态，不代表真实提权。</p>${selectField('角色','role',[['owner','中台 + 本机 worker（owner）'],['worker','纯 worker（本机受限）']],state.role)}<div class="notice">纯 worker 无今天、全局任务创建、自动化、来源或通知通道管理权限。仍可检查本机环境、查看连接与分配到本机的任务。</div>`,undefined,data=>{state.role=data.get('role');persist();closeModal();settingTab='角色连接';navigate(isOwner()?'today':'tasks');toast('已切换演示角色。');});
}
function editGeneral() {
  openModal('通用设置',selectField('关窗行为','launch',['关窗驻留（模拟）','关窗前询问（模拟）'],state.general.launch)+`<p class="hint">不控制真实浏览器窗口或操作系统后台驻留。</p>`,undefined,data=>{state.general.launch=data.get('launch');persist();closeModal();render();toast('桌面行为演示配置已保存。');});
}
function trayMenu() {
  const tasks=visibleTasks(),running=tasks.filter(task=>task.status==='running').length;
  openModal('桌面菜单栏 · 模拟',`<p class="muted">${isOwner()?'中台 + 本机 worker':'纯 worker'} · ${isDisconnected()?'连接断开':'模拟连接正常'}</p><div class="preview">${running} 个任务运行中 · ${tasks.filter(task=>task.status==='queued').length} 个排队中</div><div class="tray-menu" style="margin-top:15px">${button('打开控制台','restore')}${button('查看本机任务','tray-local-tasks')}${button('模拟检查 Agent 环境','check-environment')}${button('真退出…（模拟）','exit',undefined,'danger')}</div>`,`<button type="button" data-action="close-modal">关闭菜单</button>`);
}
function reside(mode='resident') {
  closeModal();windowMode=mode;$('#window').hidden=true;$('#residence').hidden=false;
  $('#residence').innerHTML=`<section class="panel"><div class="logo" style="margin:0 auto 18px"></div><h2>${mode==='minimized'?'窗口已模拟最小化':'窗口已关闭，应用模拟驻留'}</h2><p>${mode==='minimized'?'演示页面仍在浏览器中运行。':'任务不会因关窗而自动停止。顶部菜单栏可继续查看状态。'}<br>这只是网页示意，没有真正后台进程。</p><div class="actions" style="justify-content:center">${button('恢复窗口','restore',undefined,'primary')}${button('菜单栏','tray')}${button('真退出…','exit',undefined,'danger')}</div></section>`;
}
function restore() { closeModal();windowMode='open';$('#window').hidden=false;$('#residence').hidden=true;render(); }
function confirmExit() {
  openModal('确认真退出？',`<p>这将模拟停止应用与本机 worker，未完成任务会显示为“已停止”。</p><p class="hint">只影响原型状态，不关闭真实浏览器、不终止真实进程。恢复演示不会伪装成同一轮重跑。</p>`,'<button type="button" data-action="close-modal">保持驻留</button><button type="submit" class="danger">确认真退出（模拟）</button>',()=>{
    state.tasks.filter(task=>localTask(task)&&['running','queued','waiting'].includes(task.status)).forEach(task=>{task.status='stopped';recordEvent(task,'模拟应用退出','本机执行已停止；恢复后需更正开启新一轮。');});persist();closeModal();windowMode='exited';$('#window').hidden=true;$('#residence').hidden=false;
    $('#residence').innerHTML=`<section class="panel"><h2>应用已模拟退出</h2><p>本机 worker 与本机未完成任务已模拟停止。<br>没有关闭浏览器或影响任何真实任务。</p>${button('重新打开演示','restore',undefined,'primary')}</section>`;$('#tray-dot').textContent='○';
  });
}
function resetDemo() {
  openModal('重置原型数据？',`<p>清除本原型中的任务、规则、反馈与首启状态，恢复预设假数据。主题偏好保留。</p><p class="hint">只清除本原型的 localStorage 状态，不影响其他页面或真实业务。</p>`,'<button type="button" data-action="close-modal">取消</button><button type="submit" class="danger">确认重置</button>',()=>{state=seed();persist();closeModal();onboarding=false;welcomeStep=1;welcomeRole='owner';environmentChecked=false;connectionChecked=false;selectedTask=null;windowMode='open';$('#window').hidden=false;$('#residence').hidden=true;render();toast('已恢复初始演示数据。');});
}
function beginWelcome() { closeModal();onboarding=true;welcomeStep=1;welcomeRole=state.role;environmentChecked=false;connectionChecked=false;selectedTask=null;renderWelcome(); }
function renderWelcome() {
  $('#demo-state').value=state.demo;$('#demo-state').disabled=false;
  $('#sidebar').innerHTML=`<div class="brand"><span class="logo"></span><span class="brand-name">agent-autoloop<small>GET STARTED</small></span></div><div class="nav-label">首次使用</div><nav class="nav"><button class="active" data-action="welcome"><span class="nav-icon">◇</span><span class="nav-text">欢迎</span></button></nav><div class="sidebar-footer"><div>本地交互原型<p>无需安装，不连接服务。</p></div></div>`;
  $('#status-text').textContent='首启引导 · 所有配置和检查均为模拟';
  let html=`<div class="stepper"><span class="${welcomeStep===1?'active':''}">01 选择角色</span><span class="${welcomeStep===2?'active':''}">02 配置连接</span><span class="${welcomeStep===3?'active':''}">03 环境检查</span></div>`;
  if(welcomeStep===1)html+=`<div class="intro welcome-splash"><div class="eyebrow">YOUR AGENTS. ONE COMMAND CENTER.</div><h1>让工作推进，而不必一直守着。</h1><p>先选择这台设备的用途。之后可以在设置中重新体验。</p></div><div class="choice-grid"><button class="choice ${welcomeRole==='owner'?'selected':''}" data-action="choose-role" data-id="owner" aria-pressed="${welcomeRole==='owner'}"><span class="mono">01 / COMMAND CENTER</span><strong>中台 + 本机 worker</strong><small>管理今天、所有任务、自动化和执行机。<br>同时使用本机执行任务，适合个人主控设备。</small></button><button class="choice ${welcomeRole==='worker'?'selected':''}" data-action="choose-role" data-id="worker" aria-pressed="${welcomeRole==='worker'}"><span class="mono">02 / LOCAL WORKER</span><strong>纯 worker</strong><small>连接到已有中台，只看本机任务与环境。<br>不能新建全局任务或修改自动化，适合执行设备。</small></button></div><div class="notice">所有内容都是假数据，不启动中台或 worker，不需要真实账号与密钥。</div><div class="actions">${button('继续配置 →','welcome-next',undefined,'primary')}${state.setup?button('返回控制台','welcome-cancel'):''}</div>`;
  if(welcomeStep===2)html+=`<div class="intro"><h1>${welcomeRole==='owner'?'准备中台与本机连接':'连接已有中台'}</h1><p>演示配置只保存在浏览器，不发出网络请求。请使用示例值。</p></div><section class="panel"><form id="welcome-form" novalidate>${field('中台地址','address',state.connection.address,{required:true})}${field('本机名称','name',state.connection.name,{required:true})}${field('演示令牌','token','demo-token',{hint:'不保存此字段，不要输入真实凭据。'})}<div class="preview" id="welcome-connection-result">尚未模拟检查连接。</div><p class="error" id="welcome-error" role="alert"></p><div class="actions" style="margin-top:15px"><button type="button" data-action="welcome-back">上一步</button><button type="button" data-action="welcome-test">模拟连接检查</button><button type="submit" class="primary">继续环境检查 →</button></div></form></section>`;
  if(welcomeStep===3)html+=`<div class="intro"><h1>确认这台设备已准备就绪</h1><p>这里只展示预设结果；不执行 CLI，不检查本机文件。</p></div><section class="panel">${environmentChecked?[['系统架构','macOS arm64（假数据）'],['Codex','✓ 就绪（模拟）'],['Claude',isMissing()?'! 环境缺失（模拟）':'✓ 就绪（模拟）'],['中台',isDisconnected()?'! 断线（模拟）':'✓ 连接正常（模拟）']].map(([name,value])=>`<div class="check-result"><span>${name}</span><strong>${value}</strong></div>`).join(''):'<p class="muted">点击下方按钮执行一次模拟检查。</p>'}<div class="actions" style="margin-top:18px">${button('上一步','welcome-back')}${button(environmentChecked?'重新模拟检查':'模拟环境检查','welcome-environment')}${environmentChecked&&isMissing()?button('模拟修复','welcome-repair'):''}${button('进入'+(welcomeRole==='owner'?'指挥台':'本机任务'),'welcome-finish',undefined,'primary')}</div><p class="hint">${environmentChecked?(isMissing()||isDisconnected()?'可带着异常状态进入，页面会保留环境或断线提示。':'模拟检查通过，可以开始演示。'):'完成模拟检查后即可进入。'}</p></section>`;
  main.innerHTML=html;
  if(welcomeStep===2){
    $('#welcome-form').addEventListener('submit',event=>{event.preventDefault();if(!saveWelcomeConnection())return;if(!connectionChecked){$('#welcome-error').textContent='请先点击“模拟连接检查”。';return;}welcomeStep=3;renderWelcome();});
    $$('input',$('#welcome-form')).forEach(input=>input.addEventListener('input',()=>{connectionChecked=false;$('#welcome-connection-result').textContent='配置已变更，请重新模拟检查。';}));
  }
  main.scrollTop=0;
}
function saveWelcomeConnection() {
  const data=new FormData($('#welcome-form')),address=data.get('address').trim(),name=data.get('name').trim();
  try{const url=new URL(address);if(!['http:','https:'].includes(url.protocol))throw Error();}catch(_){$('#welcome-error').textContent='请输入有效的 http:// 或 https:// 地址。';$('[name=address]',main).focus();return false;}
  if(!name){$('#welcome-error').textContent='请填写本机名称。';$('[name=name]',main).focus();return false;}
  state.connection={address,name,token:'demo-token'};$('#welcome-error').textContent='';return true;
}
const actions={
  nav:id=>navigate(id),task:id=>{const task=taskById(id);if(!task)return toast('此任务不在当前角色或演示状态范围。');page='tasks';selectedTask=task.id;render();main.scrollTop=0;main.focus();},
  back:()=>{selectedTask=null;page='tasks';render();main.scrollTop=0;},'new-task':newTask,
  'clear-filter':()=>{search='';statusFilter='all';typeFilter='all';workerFilter='';render();},
  'answer-option':id=>{const [taskId,...text]=id.split(':');answer(taskId,text.join(':'));},'answer-custom':answerCustom,
  correction:correctTask,'stop-task':stopTask,'complete-task':completeTask,'start-task':startTask,feedback:feedbackTask,
  'close-notification':id=>{if(!requireOwner()||!canMutate())return;const item=state.notifications.find(n=>n.id===Number(id));if(item)item.closed=true;persist();render();toast('通知已结案，任务交付仍保留。');},
  'copy-result':async id=>{const task=taskById(id);if(!task)return;const text=`【原型示例交付】#${task.id} ${task.title}\n结论摘要、待关注事项和下一步建议。非真实 Agent 结果。`;try{if(!navigator.clipboard)throw Error();await navigator.clipboard.writeText(text);toast('示例结果已复制。');}catch(_){openModal('复制示例结果',field('示例结果','copy',text,{type:'textarea',hint:'浏览器未允许直接复制，请选中文本手动复制。'}),'<button type="button" data-action="close-modal">完成</button>');$('[name=copy]',modal).select();}},
  'new-rule':()=>editRule(), 'edit-rule':editRule,'check-environment':checkEnvironment,
  'worker-tasks':id=>{page='tasks';selectedTask=null;search='';workerFilter=id;statusFilter='all';typeFilter='all';render();main.scrollTop=0;},
  'worker-info':id=>openModal('执行机连接说明',`<p>${escapeHTML(id)}</p><p class="hint">远程执行机状态为假数据，不提供远程控制或真实连接能力。离线设备不会接收真实任务。</p>`,'<button type="button" data-action="close-modal">知道了</button>'),
  'setting-tab':id=>{settingTab=id;render();},'edit-agent':editAgent,'edit-source':id=>editSimple('source',id),'edit-channel':id=>editSimple('channel',id),'edit-general':editGeneral,
  'test-channel':id=>{if(!requireOwner())return;toast(`已模拟发送到“${state.channels[Number(id)]?.name}”：这是一条测试通知。未实际发送。`);},
  connection:connectionModal,'switch-role':switchRole,'test-connection':()=>toast(isDisconnected()?'模拟连接检查：失败，请点击“模拟重连”。':'模拟连接检查：通过（未发送网络请求）。'),
  reconnect:()=>{state.demo='normal';persist();render();toast('模拟重连成功；没有实际连接服务。');},
  repair:()=>{state.environmentMissing=false;if(state.demo==='missing')state.demo='normal';persist();closeModal();render();toast('模拟环境已修复，没有安装任何程序。');},
  tray:trayMenu,reside:()=>{if(state.general.launch==='关窗前询问（模拟）')openModal('关闭窗口并驻留？','<p>窗口将隐藏，模拟任务继续推进。可从菜单栏恢复。</p>','<button type="button" data-action="close-modal">取消</button><button type="submit" class="primary">关闭并驻留（模拟）</button>',()=>reside());else reside();},
  minimize:()=>reside('minimized'),maximize:()=>{$('#window').classList.toggle('expanded');toast('已切换网页窗口尺寸；非系统全屏。');},restore,
  'tray-local-tasks':()=>{restore();actions['worker-tasks']('local');},exit:confirmExit,reset:resetDemo,'close-modal':closeModal,
  welcome:beginWelcome,'choose-role':id=>{welcomeRole=id;renderWelcome();},'welcome-next':()=>{welcomeStep=2;connectionChecked=false;renderWelcome();},'welcome-back':()=>{welcomeStep=Math.max(1,welcomeStep-1);renderWelcome();},
  'welcome-cancel':()=>{onboarding=false;render();},'welcome-test':()=>{if(!saveWelcomeConnection())return;connectionChecked=true;$('#welcome-connection-result').textContent=isDisconnected()?'! 模拟连接失败：可继续进入断线演示，不请求真实服务。':'✓ 模拟连接检查通过；没有发送网络请求。';},
  'welcome-environment':()=>{environmentChecked=true;renderWelcome();},'welcome-repair':()=>{state.environmentMissing=false;if(state.demo==='missing')state.demo='normal';environmentChecked=true;renderWelcome();toast('模拟修复完成，没有安装程序。');},
  'welcome-finish':()=>{if(!environmentChecked)return toast('请先完成一次模拟环境检查。');state.role=welcomeRole;state.setup=true;persist();onboarding=false;page=isOwner()?'today':'tasks';settingTab=isOwner()?'Agent':'角色连接';render();main.focus();toast('欢迎进入本地交互原型。');}
};
document.addEventListener('click',event=>{const target=event.target.closest('[data-action]');if(target&&!target.disabled)actions[target.dataset.action]?.(target.dataset.id);});
$('#tray-button').addEventListener('click',trayMenu);
document.addEventListener('input',event=>{if(event.target.id==='task-search'){search=event.target.value;$('#task-results').innerHTML=filteredTasksHTML();}if(modal.open&&event.target.matches('input,textarea'))event.target.removeAttribute('aria-invalid');});
document.addEventListener('change',event=>{
  if(event.target.id==='demo-state'){state.demo=event.target.value;selectedTask=null;persist();render();toast(`已切换到“${event.target.selectedOptions[0].textContent}”演示状态。`);}
  if(event.target.id==='task-status'){statusFilter=event.target.value;$('#task-results').innerHTML=filteredTasksHTML();}
  if(event.target.id==='task-type'){typeFilter=event.target.value;$('#task-results').innerHTML=filteredTasksHTML();}
  if(event.target.id==='theme-select'){theme=event.target.value;applyTheme();try{localStorage.setItem(THEME_KEY,theme);}catch(_){toast('主题已应用，但浏览器不允许保存。');}}
});
// Esc is handled by native <dialog>; Tab additionally wraps for consistent keyboard behavior.
if(!isOwner())page='tasks';
render();
