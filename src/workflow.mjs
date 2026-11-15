import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

// 版本在编辑期间反复变化时只允许有限次重读重试，绝不无限循环。
const MAX_SAVE_ATTEMPTS = 3;

const FIELD_LABELS = {
  written: '已写入',
  unchanged: '无需改动',
  kept: '保留未动',
  normalized: '规范化差异',
  conflict: '真正冲突',
  blocked: '未写入',
};

const same = (left, right) => String(left) === String(right);

// 字段级三方核对：base 是导入前基值，desired 是本次想写的值，current 是门户最新回读。
// 规则：
//  - 回读已等于想写值（双方改成相同结果，或此前已成功写入）→ unchanged，不再重复写；
//  - 想写值等于基值（我方其实没改）→ kept，保留现场值；
//  - 缺少基值无法核对 → conflict，留人工；
//  - 回读仍等于基值（只有我方改）→ pending，可以写；
//  - 回读与基值、想写值都不同（双方各改同字段）→ conflict，不覆盖任何一方。
export function mergePlan(base, desired, current) {
  const fields = {};
  const pending = [];
  const conflicts = [];
  for (const [key, target] of Object.entries(desired)) {
    const before = current[key];
    const hasBase = Object.prototype.hasOwnProperty.call(base, key);
    let status;
    let reason;
    if (before !== undefined && same(before, target)) status = 'unchanged';
    else if (hasBase && same(target, base[key])) status = 'kept';
    else if (!hasBase) { status = 'conflict'; reason = '缺少导入基值，无法核对现场是否改过我方未改'; }
    else if (before !== undefined && same(before, base[key])) status = 'pending';
    else { status = 'conflict'; reason = '同一字段双方改成不同值'; }
    if (status === 'pending') pending.push(key);
    if (status === 'conflict') conflicts.push(key);
    fields[key] = { status, base: base[key], desired: target, before, ...(reason ? { reason } : {}) };
  }
  return { fields, pending, conflicts };
}

// 读取页面可见控件呈现的业务对象与版本，不绕过页面直接取内部接口。
async function readVisible(page) {
  return page.evaluate(() => {
    const record = {};
    for (const control of document.querySelectorAll('#app input[id], #app select[id]')) record[control.id] = control.value;
    return { version: Number(document.querySelector('#version').textContent), record };
  });
}

// 通过可见的“刷新”控件拿到门户最新回读，并等页面把该版本渲染出来再读。
async function refreshVisible(page) {
  const [response] = await Promise.all([
    page.waitForResponse(reply => reply.url().includes('/portal/state') && reply.request().method() === 'GET', { timeout: 8000 }),
    page.click('#refresh'),
  ]);
  const latest = await response.json();
  await page.waitForFunction(version => document.querySelector('#version')?.textContent === String(version), latest.version, { timeout: 5000 });
  return readVisible(page);
}

async function fillControl(page, key, value) {
  const tag = await page.$eval('#' + key, control => control.tagName);
  if (tag === 'SELECT') await page.selectOption('#' + key, String(value));
  else await page.fill('#' + key, String(value));
}

// 只通过可见的“保存本行”按钮提交，并记录这次点击真实得到的响应。
async function clickSave(page) {
  const [response] = await Promise.all([
    page.waitForResponse(reply => reply.url().includes('/portal/action') && reply.request().method() === 'POST', { timeout: 8000 }),
    page.click('#save'),
  ]);
  return { status: response.status(), body: await response.json() };
}

function reviewBucket(fields) {
  const review = { 已写入: [], 无需改动: [], 保留未动: [], 规范化差异: [], 真正冲突: [], 未写入: [] };
  for (const [key, field] of Object.entries(fields)) review[FIELD_LABELS[field.status]].push(key);
  return review;
}

// 业务入口：基于浏览器的增量录入。每次执行都以门户实际台账为准重新核对，
// 不读取本地任何“已点击保存”的记录来决定跳过，因此中断后重跑自然收敛：
// 已写入的字段回读即等于想写值，被判为 unchanged，不会反复追加。
export async function run({ source, stateDir, input }) {
  if (!source) throw new Error('缺少来源地址');
  const base = input?.base ?? {};
  const desired = input?.desired ?? {};
  await mkdir(stateDir, { recursive: true });
  const auditFile = path.join(stateDir, 'audit.jsonl');
  // 审计日志只追加、只用于事后复核，不作为恢复依据；恢复依据始终是门户实际台账。
  const audit = async entry => appendFile(auditFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  await audit({ type: 'start', source, input: { base, desired } });

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(8000);
    await page.goto(source + '/portal');
    await page.waitForSelector('#save');

    let current = await refreshVisible(page);
    await audit({ type: 'read', phase: 'initial', ...current });
    const initialVersion = current.version;
    let evaluation = mergePlan(base, desired, current.record);

    const saves = [];
    let attempts = 0;
    let saved = null;
    let preSave = null;
    let rejected = null;
    // 同一行存在真正冲突时整行不写，避免在人工决定前覆盖任何一方。
    while (evaluation.pending.length > 0 && evaluation.conflicts.length === 0 && attempts < MAX_SAVE_ATTEMPTS) {
      attempts += 1;
      preSave = current;
      for (const key of evaluation.pending) await fillControl(page, key, desired[key]);
      const outcome = await clickSave(page);
      saves.push({ attempt: attempts, status: outcome.status, version: outcome.body?.version ?? outcome.body?.state?.version ?? null });
      await audit({ type: 'save', attempt: attempts, status: outcome.status, response: outcome.body });
      if (outcome.status === 200) { saved = outcome.body; break; }
      if (outcome.status !== 409) { rejected = outcome.body?.error ?? '保存被拒绝'; break; }
      // 版本在编辑中再次变化：以最新回读重新核对，已等于想写值的字段退出待写集合。
      current = await refreshVisible(page);
      await audit({ type: 'read', phase: 'retry-' + attempts, ...current });
      evaluation = mergePlan(base, desired, current.record);
    }

    const fields = {};
    const warnings = [];
    let state;
    let record;
    let versionAfter = current.version;

    if (saved) {
      // 保存触发门户对关联字段的规范化，必须回读整个业务对象核对，而不是只看本次输入。
      const after = await refreshVisible(page);
      await audit({ type: 'read', phase: 'after-save', ...after });
      record = after.record;
      versionAfter = after.version;
      if (after.version !== preSave.version + 1) warnings.push(`保存后版本从 ${preSave.version} 变为 ${after.version}，期间可能有其他写入，请复核`);
      const cleanDelta = after.version === preSave.version + 1;
      const failed = [];
      for (const [key, target] of Object.entries(desired)) {
        const got = after.record[key];
        if (same(got, target)) {
          const status = evaluation.fields[key].status === 'unchanged' ? 'unchanged' : 'written';
          fields[key] = { status, base: base[key], desired: target, before: preSave.record[key], after: got };
        } else {
          fields[key] = { status: 'conflict', base: base[key], desired: target, before: preSave.record[key], after: got, reason: '回读与想写值不一致，可能被规范化或其他写入改变' };
          failed.push(key);
        }
      }
      for (const [key, got] of Object.entries(after.record)) {
        if (Object.prototype.hasOwnProperty.call(desired, key)) continue;
        const before = preSave.record[key];
        if (!same(before, got)) {
          // 版本只前进一格时，差异只能来自本次保存触发的门户规范化。
          const status = cleanDelta ? 'normalized' : 'conflict';
          fields[key] = { status, base: base[key], before, after: got, ...(cleanDelta ? { reason: '保存触发的门户规范化' } : { reason: '保存后该字段被再次改变' }) };
        } else fields[key] = { status: 'kept', base: base[key], after: got };
      }
      state = failed.length ? 'conflict' : 'saved';
    } else {
      record = current.record;
      for (const [key, field] of Object.entries(evaluation.fields)) {
        if (field.status === 'pending') {
          const reason = rejected ?? (evaluation.conflicts.length ? '同行存在真正冲突，整行未写入' : `版本在编辑中反复变化，超过 ${MAX_SAVE_ATTEMPTS} 次重试上限`);
          fields[key] = { ...field, status: 'blocked', after: current.record[key], reason };
        } else fields[key] = { ...field, after: current.record[key] };
      }
      for (const [key, got] of Object.entries(current.record)) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) fields[key] = { status: 'kept', base: base[key], after: got };
      }
      if (evaluation.conflicts.length || rejected || evaluation.pending.length) state = 'conflict';
      else state = 'unchanged';
      if (!rejected && !evaluation.conflicts.length && evaluation.pending.length) warnings.push(`版本在编辑中反复变化，${MAX_SAVE_ATTEMPTS} 次尝试后仍未写入`);
    }

    const result = {
      state,
      record,
      fields,
      review: reviewBucket(fields),
      version: { before: initialVersion, after: versionAfter },
      attempts,
      ...(warnings.length ? { warnings } : {}),
      evidence: { portal: source + '/portal', saves },
    };
    await writeFile(path.join(stateDir, 'result.json'), JSON.stringify(result, null, 2));
    await audit({ type: 'result', state, record, review: result.review });
    return result;
  } finally {
    await browser.close();
  }
}
