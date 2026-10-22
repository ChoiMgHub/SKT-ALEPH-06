import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import worker from '../src/worker.js';
import { makeEnv, call } from '../test-support/helpers.mjs';

async function until(predicate) {
  for (let n=0;n<100;n++) { if (predicate()) return; await new Promise(resolve=>setImmediate(resolve)); }
  assert.fail('화면 갱신을 기다렸지만 조건이 충족되지 않음');
}
async function screen(t) {
  const env = makeEnv();
  const planId = (await call(env,'/api/plans','POST',{title:'자동 검증용 계획',start_date:'2026-10-21',end_date:'2026-10-28',priority:'보통',success_criteria:'자동 검증 자료',expected_minutes:180})).data.id;
  const titles = ['가 항목','나 항목','다 항목','라 항목','마 항목'];
  const taskIds = [];
  for (const [i,title] of titles.entries()) {
    const task = await call(env,'/api/tasks','POST',{plan_id:planId,title,due_at:`2020-01-0${i+1}T00:00:00Z`,priority:'보통',category:'자동검증',expected_minutes:30,status:'todo'});
    taskIds.push(task.data.id);
  }
  for (const [i,id] of taskIds.slice(0,3).entries()) await call(env,'/api/logs','POST',{task_id:id,request_id:`ui-${i}`,started_at:'2026-10-21T01:00:00Z',ended_at:'2026-10-21T01:25:00Z',difference_reason:'자동 검증용'});
  const dom = new JSDOM(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),{url:'https://example.test/',runScripts:'outside-only'});
  t.after(()=>dom.window.close());
  const w=dom.window, d=w.document;
  w.Element.prototype.scrollIntoView = function() { this.setAttribute('data-scrolled','true'); };
  w.confirm = () => true;
  Object.defineProperty(w.crypto,'randomUUID',{value:randomUUID});
  w.fetch = (path,options={})=>worker.fetch(new Request(new URL(path,w.location.href),options),env);
  w.eval(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'));
  await until(()=>d.querySelectorAll('#task-list article').length===5);
  return {env,planId,taskIds,w,d};
}
function change(w,el,value) { el.value=value; el.dispatchEvent(new w.Event('change',{bubbles:true})); }
function submit(w,form) { form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})); }

test('C18-C20 C32 C63: UI filters, deterministic sorting, signed difference and original-record navigation', async t=>{
  const {w,d,taskIds}=await screen(t);
  assert.match(d.querySelector('#summary').textContent,/차이\(실제 − 예상\)−1시간 15분/);
  const search=d.querySelector('#task-search'); search.value='나 항목'; search.dispatchEvent(new w.Event('input',{bubbles:true}));
  assert.equal(d.querySelectorAll('#task-list article').length,1);
  change(w,d.querySelector('#task-filter'),'done'); assert.equal(d.querySelectorAll('#task-list article').length,0);
  search.value='';search.dispatchEvent(new w.Event('input',{bubbles:true}));change(w,d.querySelector('#task-filter'),'all');
  change(w,d.querySelector('#task-sort'),'title');
  assert.equal(d.querySelector('#task-list article strong').textContent,'가 항목');
  assert.match(d.querySelector('#task-sort-rule').textContent,/ID순/);
  [...d.querySelectorAll('#summary button')].find(b=>b.textContent.includes('실행한 시간')).click();
  assert.equal(d.querySelectorAll('#evidence a').length,3);
  d.querySelector('#evidence a').click();
  assert.match(d.activeElement.id,/^log-/);
  [...d.querySelectorAll('#summary button')].find(b=>b.textContent.includes('계획 수(할 일)')).click();
  const evidenceTarget = d.querySelector('#evidence a').getAttribute('href').slice(1);
  search.value='없는 검색어';search.dispatchEvent(new w.Event('input',{bubbles:true}));
  d.querySelector('#evidence a').click();
  assert.equal(d.activeElement.id,evidenceTarget);
  assert.equal(d.querySelectorAll('#task-list article').length,5);
});

test('C09-C13 C21 C22 C57: UI create, edit, double completion, undo, delete and script-like text', async t=>{
  const {w,d,env}=await screen(t);
  const form=d.querySelector('#task-form');
  const scriptText='<script>window.__audit_xss=1</script><img src=x onerror="window.__audit_xss=2">';
  form.elements.namedItem('title').value=scriptText;
  submit(w,form);
  await until(()=>d.querySelectorAll('#task-list article').length===6);
  let card=[...d.querySelectorAll('#task-list article')].find(x=>x.textContent.includes(scriptText));
  assert.ok(card); assert.equal(card.querySelectorAll('script,img').length,0); assert.equal(w.__audit_xss,undefined);
  [...card.querySelectorAll('button')].find(b=>b.textContent==='수정').click();
  form.elements.namedItem('expected_minutes').value='45'; submit(w,form);
  await until(()=>[...d.querySelectorAll('#task-list article')].some(x=>x.textContent.includes(scriptText)&&x.textContent.includes('45분')));
  card=[...d.querySelectorAll('#task-list article')].find(x=>x.textContent.includes(scriptText));
  const done=[...card.querySelectorAll('button')].find(b=>b.textContent==='완료'); done.click(); done.click();
  await until(()=>d.querySelectorAll('#completion-list article').length===1);
  let s=(await call(env,'/api/state')).data; assert.equal(s.task_completions.length,1); assert.equal(s.summary.completed,1);
  card=[...d.querySelectorAll('#task-list article')].find(x=>x.textContent.includes(scriptText));
  [...card.querySelectorAll('button')].find(b=>b.textContent==='진행 중으로').click();
  await until(()=>!d.querySelector('#summary').textContent.includes('완료1개'));
  card=[...d.querySelectorAll('#task-list article')].find(x=>x.textContent.includes(scriptText));
  [...card.querySelectorAll('button')].find(b=>b.textContent==='삭제').click();
  await until(()=>d.querySelectorAll('#task-list article').length===5);
  s=(await call(env,'/api/export')).data; assert.equal(s.tasks.length,6); assert.equal(s.task_completions.length,1);
});

test('C33: reflection button fills next-plan form, saves relationship and exposes both directions', async t=>{
  const {w,d,planId,env}=await screen(t);
  const reflection=d.querySelector('#reflection-form');
  reflection.elements.namedItem('next_step').value='기록을 읽고 예상 시간을 다시 정한다';
  submit(w,reflection);
  await until(()=>d.querySelector('#reflection-list button'));
  d.querySelector('#reflection-list button').click();
  const form=d.querySelector('#plan-form');
  assert.equal(form.elements.namedItem('success_criteria').value,'기록을 읽고 예상 시간을 다시 정한다');
  assert.equal(form.elements.namedItem('source_reflection_plan_id').value,planId);
  form.elements.namedItem('title').value='검증용 다음 계획';submit(w,form);
  await until(()=>d.querySelectorAll('#plan-list article').length===2);
  assert.match(d.querySelector('#reflection-list').textContent,/이어진 다음 계획: 검증용 다음 계획/);
  assert.match(d.querySelector('#plan-list').textContent,/이전 돌아보기에서 가져온 한 줄/);
  assert.match(d.querySelector('#summary').textContent,/계획 수\(할 일\)0개/);
  assert.equal((await call(env,'/api/state')).data.reflection_links.length,1);
});
