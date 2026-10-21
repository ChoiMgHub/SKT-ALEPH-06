const $ = id => document.getElementById(id);
const planForm = $('plan-form'), taskForm = $('task-form'), logForm = $('log-form'), reflectionForm = $('reflection-form');
let state = { plans: [], plan_revisions: [], tasks: [], execution_logs: [], reflections: [], summary: {} };
let selectedPlanId = null;
let newPlanMode = false;
let evidenceKind = null;
let pendingLogRequestId = null;

function node(tag, className = '', content = '') {
  const result = document.createElement(tag);
  if (className) result.className = className;
  result.textContent = content;
  return result;
}
function add(parent, ...children) { parent.append(...children); return parent; }
function formValue(form, key) { return form.elements.namedItem(key).value; }
function setFormValue(form, key, value) { form.elements.namedItem(key).value = value ?? ''; }
function minutesText(n) { const value = Number(n || 0); return value >= 60 ? `${Math.floor(value / 60)}시간 ${value % 60}분` : `${value}분`; }
function dateText(value) { return value ? new Date(value).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '마감 없음'; }
function dateOnlyText(value) { return value || '날짜 없음'; }
function localInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function show(message, error = false) {
  const box = $('message'); box.textContent = message; box.classList.toggle('error', error); box.hidden = false;
}
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `요청 실패 (${response.status})`);
  return data;
}
async function refresh() {
  state = await api('/api/state');
  if (!state.plans.some(p => p.id === selectedPlanId)) selectedPlanId = state.plans[0]?.id || null;
  renderAll();
}
async function run(action, success) {
  try { await action(); await refresh(); show(success); }
  catch (error) { show(error.message || '요청을 처리하지 못했습니다.', true); }
}
function empty(container, text) { container.replaceChildren(node('p', 'muted', text)); }
function badge(text, className = '') { return node('span', `badge ${className}`, text); }
function planName(id) { return state.plans.find(p => p.id === id)?.title || '삭제된 계획'; }
function taskName(id) { return state.tasks.find(t => t.id === id)?.title || '삭제된 할 일'; }
function activeTasks() { return state.tasks.filter(t => !t.deleted_at); }
function isOverdue(task) { return task.status !== 'done' && task.due_at && Date.parse(task.due_at) < Date.now(); }
function statusText(status) { return { todo: '할 일', doing: '진행 중', done: '완료', blocked: '막힘' }[status] || status; }
function button(text, className, handler) { const b = node('button', className, text); b.type = 'button'; b.addEventListener('click', handler); return b; }

function fillPlan(plan) {
  setFormValue(planForm, 'id', plan?.id);
  setFormValue(planForm, 'title', plan?.title);
  setFormValue(planForm, 'start_date', plan?.start_date || new Date().toISOString().slice(0, 10));
  setFormValue(planForm, 'end_date', plan?.end_date || new Date().toISOString().slice(0, 10));
  setFormValue(planForm, 'priority', plan?.priority || '보통');
  setFormValue(planForm, 'success_criteria', plan?.success_criteria);
  setFormValue(planForm, 'expected_minutes', plan?.expected_minutes ?? 120);
}
function renderPlans() {
  const list = $('plan-list'); list.replaceChildren();
  if (!state.plans.length) empty(list, '아직 계획이 없습니다. 첫 계획을 저장해 주세요.');
  for (const plan of state.plans) {
    const card = node('article', 'item');
    const top = node('div', 'item-top');
    add(top, node('strong', '', plan.title), badge(plan.priority));
    add(card, top, node('p', '', `${dateOnlyText(plan.start_date)} ~ ${dateOnlyText(plan.end_date)} · 예상 ${minutesText(plan.expected_minutes)}`),
      node('p', '', `성공 기준: ${plan.success_criteria}`));
    const actions = node('div', 'actions');
    add(actions, button(plan.id === selectedPlanId ? '선택됨' : '선택·수정', 'tiny', () => { selectedPlanId = plan.id; newPlanMode = false; renderAll(); $('plans').scrollIntoView(); }));
    card.append(actions); list.append(card);
  }
  const revisions = $('revision-list'); revisions.replaceChildren();
  const rows = state.plan_revisions.filter(r => r.plan_id === selectedPlanId);
  if (!rows.length) empty(revisions, '선택한 계획의 수정 전 내용은 아직 없습니다.');
  for (const revision of rows) {
    let old; try { old = JSON.parse(revision.snapshot_json); } catch { continue; }
    const card = node('article', 'item');
    add(card, node('strong', '', old.title), node('p', '', `${old.start_date} ~ ${old.end_date} · ${old.priority} · 예상 ${minutesText(old.expected_minutes)}`),
      node('p', '', `성공 기준: ${old.success_criteria}`), node('p', 'muted', `수정 전 저장: ${dateText(revision.recorded_at)}`));
    revisions.append(card);
  }
  if (!newPlanMode) fillPlan(state.plans.find(p => p.id === selectedPlanId));
}

function option(value, label) { const o = document.createElement('option'); o.value = value; o.textContent = label; return o; }
function renderSelects() {
  const planSelect = $('task-plan'), reflectionSelect = $('reflection-plan'), logSelect = $('log-task');
  const oldTaskPlan = planSelect.value, oldReflection = reflectionSelect.value, oldLog = logSelect.value;
  planSelect.replaceChildren(...state.plans.map(p => option(p.id, p.title)));
  reflectionSelect.replaceChildren(...state.plans.map(p => option(p.id, p.title)));
  planSelect.value = state.plans.some(p => p.id === oldTaskPlan) ? oldTaskPlan : selectedPlanId || '';
  reflectionSelect.value = state.plans.some(p => p.id === oldReflection) ? oldReflection : selectedPlanId || '';
  logSelect.replaceChildren(...activeTasks().map(t => option(t.id, `${t.title} · ${planName(t.plan_id)}`)));
  if (activeTasks().some(t => t.id === oldLog)) logSelect.value = oldLog;
}
function resetTaskForm() {
  taskForm.reset(); setFormValue(taskForm, 'id', '');
  setFormValue(taskForm, 'expected_minutes', 30);
  setFormValue(taskForm, 'category', '과제');
  setFormValue(taskForm, 'plan_id', selectedPlanId);
  $('task-form-title').textContent = '할 일 추가';
}
function editTask(task) {
  setFormValue(taskForm, 'id', task.id); setFormValue(taskForm, 'plan_id', task.plan_id);
  setFormValue(taskForm, 'title', task.title); setFormValue(taskForm, 'due_at', localInput(task.due_at));
  setFormValue(taskForm, 'priority', task.priority); setFormValue(taskForm, 'category', task.category);
  setFormValue(taskForm, 'expected_minutes', task.expected_minutes); setFormValue(taskForm, 'status', task.status);
  setFormValue(taskForm, 'blocked_reason', task.blocked_reason);
  $('task-form-title').textContent = '할 일 수정';
  $('task-form').scrollIntoView();
}
function filteredTasks() {
  const search = $('task-search').value.trim().toLocaleLowerCase();
  const filter = $('task-filter').value;
  const sort = $('task-sort').value;
  const priorities = { 높음: 0, 보통: 1, 낮음: 2 };
  const rows = activeTasks().filter(t =>
    (!search || `${t.title} ${t.category}`.toLocaleLowerCase().includes(search)) &&
    (filter === 'all' || (filter === 'overdue' ? isOverdue(t) : t.status === filter))
  );
  rows.sort((a, b) => {
    if (sort === 'priority') return priorities[a.priority] - priorities[b.priority] || (a.due_at || '9999').localeCompare(b.due_at || '9999');
    if (sort === 'created') return b.created_at.localeCompare(a.created_at);
    if (sort === 'title') return a.title.localeCompare(b.title, 'ko');
    return (a.due_at || '9999').localeCompare(b.due_at || '9999');
  });
  return rows;
}
function renderTasks() {
  const list = $('task-list'); list.replaceChildren();
  const rows = filteredTasks();
  $('task-result-label').textContent = `정렬: ${$('task-sort').selectedOptions[0].textContent} · 결과 ${rows.length}개`;
  if (!rows.length) empty(list, '조건에 맞는 할 일이 없습니다.');
  for (const task of rows) {
    const card = node('article', 'item'); card.id = `task-${task.id}`;
    const top = node('div', 'item-top'); add(top, node('strong', '', task.title), badge(statusText(task.status), task.status));
    const badges = node('div', 'meta');
    add(badges, badge(task.category), badge(task.priority), badge(`예상 ${minutesText(task.expected_minutes)}`));
    if (isOverdue(task)) badges.append(badge('지연', 'overdue'));
    add(card, top, badges, node('p', '', `${planName(task.plan_id)} · ${dateText(task.due_at)}`));
    if (task.blocked_reason) card.append(node('p', '', `막힌 이유: ${task.blocked_reason}`));
    const actions = node('div', 'actions');
    add(actions, button('수정', 'tiny', () => editTask(task)));
    if (task.status !== 'done') actions.append(button('완료', 'tiny', event => changeStatus(task, 'done', event.currentTarget)));
    if (task.status === 'done') actions.append(button('진행 중으로', 'tiny', event => changeStatus(task, 'doing', event.currentTarget)));
    actions.append(button('기록 연결', 'tiny', () => { $('log-task').value = task.id; $('execution').scrollIntoView(); }));
    actions.append(button('삭제', 'tiny danger', async () => {
      if (!confirm(`“${task.title}” 할 일을 삭제할까요? 기록은 내보내기에 남습니다.`)) return;
      await run(() => api(`/api/tasks/${task.id}`, { method: 'DELETE' }), '할 일을 삭제했습니다.');
    }));
    card.append(actions); list.append(card);
  }
}
async function changeStatus(task, status, btn) {
  btn.disabled = true;
  await run(() => api(`/api/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    status === 'done' ? '완료로 바꿨습니다.' : '진행 중으로 되돌렸습니다.');
}
function renderLogs() {
  const list = $('log-list'); list.replaceChildren();
  if (!state.execution_logs.length) empty(list, '아직 실행 기록이 없습니다.');
  for (const log of state.execution_logs) {
    const card = node('article', 'item'); card.id = `log-${log.id}`;
    add(card, node('strong', '', taskName(log.task_id)), node('p', '', `${dateText(log.started_at)} → ${dateText(log.ended_at)}`));
    const meta = node('div', 'meta'); meta.append(badge(`실제 ${minutesText(log.actual_minutes)}`)); card.append(meta);
    if (log.difference_reason) card.append(node('p', '', `달랐던 이유: ${log.difference_reason}`));
    list.append(card);
  }
}
function evidenceRows(kind) {
  const active = activeTasks();
  if (kind === 'plans') return state.plans.map(p => `${p.title} · ${p.start_date} ~ ${p.end_date}`);
  if (kind === 'open_tasks') return active.map(t => `${t.title} · ${statusText(t.status)}`);
  if (kind === 'completed') return active.filter(t => t.status === 'done').map(t => t.title);
  if (kind === 'overdue') return active.filter(isOverdue).map(t => `${t.title} · 마감 ${dateText(t.due_at)}`);
  if (kind === 'blocked') return active.filter(t => t.status === 'blocked').map(t => `${t.title} · ${t.blocked_reason}`);
  if (kind === 'expected_minutes') return active.map(t => `${t.title} · 예상 ${minutesText(t.expected_minutes)}`);
  if (kind === 'actual_minutes') return state.execution_logs.filter(l => active.some(t => t.id === l.task_id)).map(l => `${taskName(l.task_id)} · 실제 ${minutesText(l.actual_minutes)}`);
  return [];
}
function renderEvidence() {
  const root = $('evidence'); root.replaceChildren();
  root.append(node('h3', '', evidenceKind ? `숫자의 근거 · ${evidenceKind.label}` : '숫자의 근거'));
  if (!evidenceKind) { root.append(node('p', 'muted', '위 숫자를 눌러 근거 기록을 확인하세요.')); return; }
  const rows = evidenceRows(evidenceKind.key);
  if (!rows.length) { root.append(node('p', 'muted', '해당하는 기록이 없습니다.')); return; }
  const list = node('div', 'list');
  rows.forEach(row => list.append(node('div', 'item', row)));
  root.append(list);
}
function renderSummary() {
  const root = $('summary'); root.replaceChildren();
  const summary = state.summary;
  const items = [
    ['plans', '계획 수', `${summary.plans || 0}개`],
    ['open_tasks', '삭제하지 않은 할 일', `${summary.open_tasks || 0}개`],
    ['completed', '완료', `${summary.completed || 0}개`],
    ['overdue', '지연', `${summary.overdue || 0}개`],
    ['blocked', '막힘', `${summary.blocked || 0}개`],
    ['expected_minutes', '할 일 예상 시간', minutesText(summary.expected_minutes)],
    ['actual_minutes', '실행한 시간', minutesText(summary.actual_minutes)]
  ];
  for (const [key, label, value] of items) {
    const b = node('button', 'stat'); b.type = 'button';
    add(b, node('span', '', label), node('strong', '', value));
    b.addEventListener('click', () => { evidenceKind = { key, label }; renderEvidence(); $('evidence').scrollIntoView(); $('evidence').focus(); });
    root.append(b);
  }
  renderEvidence();
}
function renderReflections() {
  const list = $('reflection-list'); list.replaceChildren();
  if (!state.reflections.length) { empty(list, '아직 다음 계획을 위한 한 줄이 없습니다.'); return; }
  for (const r of state.reflections) {
    const card = node('article', 'item');
    add(card, node('strong', '', planName(r.plan_id)), node('p', '', r.next_step || '아직 정하지 않았습니다.'));
    list.append(card);
  }
}
function renderAll() { renderSelects(); renderPlans(); renderTasks(); renderLogs(); renderSummary(); renderReflections(); }

$('new-plan').addEventListener('click', () => { newPlanMode = true; fillPlan(null); planForm.elements.namedItem('title').focus(); });
$('cancel-task').addEventListener('click', resetTaskForm);
for (const id of ['task-search', 'task-filter', 'task-sort']) $(id).addEventListener(id === 'task-search' ? 'input' : 'change', renderTasks);

planForm.addEventListener('submit', async event => {
  event.preventDefault();
  const id = formValue(planForm, 'id');
  const data = Object.fromEntries(new FormData(planForm)); delete data.id;
  data.expected_minutes = Number(data.expected_minutes);
  await run(async () => {
    const result = await api(id ? `/api/plans/${id}` : '/api/plans', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(data) });
    selectedPlanId = result.id; newPlanMode = false;
  }, id ? '계획을 저장했습니다. 이전 값은 이력에서 확인할 수 있습니다.' : '계획을 만들었습니다.');
});
taskForm.addEventListener('submit', async event => {
  event.preventDefault();
  const id = formValue(taskForm, 'id');
  const data = Object.fromEntries(new FormData(taskForm)); delete data.id;
  data.expected_minutes = Number(data.expected_minutes);
  data.due_at = data.due_at ? new Date(data.due_at).toISOString() : null;
  await run(() => api(id ? `/api/tasks/${id}` : '/api/tasks', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(data) }),
    id ? '할 일을 수정했습니다.' : '할 일을 만들었습니다.');
  if (!$('message').classList.contains('error')) resetTaskForm();
});
logForm.addEventListener('input', () => { pendingLogRequestId = null; });
logForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(logForm));
  if (new Date(data.ended_at) < new Date(data.started_at)) { show('종료 시각은 시작 시각보다 빠를 수 없습니다.', true); return; }
  if (!pendingLogRequestId) pendingLogRequestId = crypto.randomUUID();
  data.request_id = pendingLogRequestId;
  data.started_at = new Date(data.started_at).toISOString();
  data.ended_at = new Date(data.ended_at).toISOString();
  const submit = logForm.querySelector('button[type="submit"]'); submit.disabled = true;
  try {
    await api('/api/logs', { method: 'POST', body: JSON.stringify(data) });
    pendingLogRequestId = null; logForm.reset(); await refresh(); show('실행 기록을 남겼습니다.');
  } catch (error) { show(error.message || '기록 저장에 실패했습니다.', true); }
  finally { submit.disabled = false; }
});
reflectionForm.addEventListener('submit', async event => {
  event.preventDefault();
  const planId = formValue(reflectionForm, 'plan_id');
  await run(() => api(`/api/reflections/${planId}`, { method: 'PUT', body: JSON.stringify({ next_step: formValue(reflectionForm, 'next_step') }) }),
    '다음 계획을 위한 한 줄을 저장했습니다.');
});

refresh().catch(error => show(`서버 데이터를 읽지 못했습니다: ${error.message}`, true));
