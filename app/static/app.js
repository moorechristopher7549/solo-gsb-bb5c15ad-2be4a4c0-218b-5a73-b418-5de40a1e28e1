'use strict';

/* 情景注入台前端
 *
 * 同步协议：
 * 1. 打开 WebSocket 时带上 last_event_id（已应用的最大事件 ID）；
 * 2. 服务端先推权威快照（snapshot）——全量替换本地状态，水位 = snapshot.last_event_id；
 * 3. 之后只应用 id > 水位的增量事件，旧事件一律丢弃，状态绝不回退。
 *
 * 三种角色：
 * - 主持人：房间码连接（全量视野，含观察分享管理与回执门槛编排——卡片可依赖
 *   前置卡片，前置集齐目标组回执后才揭示，可设虚拟时钟超时秒数，超时标记为
 *   「超时揭示」；门槛状态仅主持人可见，随 gate_updated 事件与快照下发）；
 *   另可逐卡锁定/重新开放处置答复，并实时看到各应答组的提交状态、正文与版本；
 * - 参与者：组加入码连接（服务端按组过滤快照与事件，不感知门槛编排）；
 *   可在已揭示卡片下提交/修改本组处置答复（每组一份，携带 revision 乐观并发，
 *   版本过期收到 409 与最新答复；锁定后只读），看不到他组答复正文；
 * - 观察者：限时观察链接（#/observe/{token}）进入，只读——只能看到已揭示的
 *   全员卡片与分享所选组卡片，拿不到房间码、组加入码、未揭示卡片与回执明细；
 *   链接到期或被撤销时服务端主动断开，重连也会被拒绝。
 */

const $ = (sel) => document.querySelector(sel);

const state = {
  code: null,      // 主持人 = 房间码；参与者 = 组加入码；观察者 = 观察凭证
  role: null,      // 'host' | 'player' | 'observer'
  roomName: '',
  status: 'idle',
  cards: [],
  groups: [],      // 主持人：全部参与组；参与者：仅本组；观察者：分享所选组
  shares: [],      // 主持人：全部观察分享（有效/失效）
  anchors: [],     // 主持人：全部轮次的复盘锚点（参与者/观察者永远为空）
  polls: [],       // 主持人：全部轮次投票；参与者：本轮本组可见投票；观察者：恒空
  groupId: null,   // 参与者本组 id（主持人/观察者为 null）
  round: 0,        // 当前演练轮次（= 此前 reset 次数；快照权威下发，reset 事件 +1）
  lastEventId: 0,
  clock: { status: 'idle', elapsedMs: 0, syncedAt: performance.now() },
  ws: null,
  reconnectDelay: 1000,
};

const STATUS_TEXT = { idle: '待机', running: '进行中', paused: '已暂停' };

/* ---------------------------------------------------------- 视图切换 */

function showLanding() {
  $('#view-landing').classList.remove('hidden');
  $('#view-room').classList.add('hidden');
}

function showRoom() {
  $('#view-landing').classList.add('hidden');
  $('#view-room').classList.remove('hidden');
  $('#host-console').classList.toggle('hidden', state.role !== 'host');
  // 现场决策投票对观察者完全不可见；主持人见创建表单与全部投票，参与者见本组投票
  $('#polls-section').classList.toggle('hidden', state.role === 'observer');
  $('#poll-host-controls').classList.toggle('hidden', state.role !== 'host');
  $('#cards-title').textContent =
    state.role === 'host' ? '注入卡片（全部）'
    : state.role === 'observer' ? '已揭示的情景注入（观察席 · 只读）'
    : '已揭示的情景注入';
}

/* ---------------------------------------------------------- 渲染 */

function fmt(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

function groupName(id) {
  const g = state.groups.find((g) => g.id === id);
  return g ? g.name : `#${id}`;
}

function renderMeta() {
  $('#room-name').textContent = state.roomName || '未命名演练';
  // 观察者的 code 是观察凭证而非房间码，不显示「加入码」行
  $('.room-code').classList.toggle('hidden', state.role === 'observer');
  $('#room-code').textContent = state.code;
  const st = $('#status');
  st.textContent = STATUS_TEXT[state.status] || state.status;
  st.className = 'status' + (state.status === 'running' ? ' running' : state.status === 'paused' ? ' paused' : '');
  const pg = $('#player-group');
  if (state.role === 'player' && state.groupId != null) {
    pg.textContent = `参与组：${groupName(state.groupId)}`;
    pg.classList.remove('hidden');
  } else if (state.role === 'observer') {
    const names = state.groups.map((g) => g.name).join('、');
    pg.textContent = `观察席（只读）· 可见组：${names || '全员'}`;
    pg.classList.remove('hidden');
  } else {
    pg.classList.add('hidden');
  }
  renderControls();
}

function renderControls() {
  if (state.role !== 'host') return;
  const s = state.status;
  $('#btn-start').disabled = s !== 'idle';
  $('#btn-pause').disabled = s !== 'running';
  $('#btn-resume').disabled = s !== 'paused';
  $('#btn-reset').disabled = s === 'idle';
  const editing = s !== 'running';
  $('#card-form').querySelectorAll('input, textarea, select, button').forEach((el) => { el.disabled = !editing; });
  $('#card-form-hint').textContent = editing ? '' : '时钟运行中，暂停后才能编辑卡片';
}

/* 主持人：参与组列表 + 卡片目标下拉 */
function renderGroups() {
  if (state.role !== 'host') return;
  $('#group-count').textContent = state.groups.length;
  const list = $('#group-list');
  list.innerHTML = '';
  for (const g of state.groups) {
    const li = document.createElement('li');
    li.className = 'group-item';

    const name = document.createElement('span');
    name.className = 'group-name';
    name.textContent = g.name;
    li.appendChild(name);

    const code = document.createElement('button');
    code.className = 'code-chip group-code';
    code.textContent = g.join_code;
    code.title = '点击复制加入码';
    code.onclick = () => {
      navigator.clipboard?.writeText(g.join_code);
      code.textContent = '已复制';
      setTimeout(() => { code.textContent = g.join_code; }, 1200);
    };
    li.appendChild(code);

    const rename = document.createElement('button');
    rename.className = 'group-op';
    rename.textContent = '改名';
    rename.onclick = async () => {
      const name2 = (prompt('新的组名称', g.name) || '').trim();
      if (!name2 || name2 === g.name) return;
      try {
        await api('PATCH', `/api/rooms/${state.code}/groups/${g.id}`, { name: name2 });
      } catch (err) { showError(err); }
    };
    li.appendChild(rename);

    const del = document.createElement('button');
    del.className = 'group-op group-del';
    del.textContent = '删除';
    del.onclick = async () => {
      if (!confirm(`删除参与组「${g.name}」？其加入码将立即失效。`)) return;
      try {
        await api('DELETE', `/api/rooms/${state.code}/groups/${g.id}`);
      } catch (err) { showError(err); }
    };
    li.appendChild(del);

    list.appendChild(li);
  }

  // 卡片目标下拉：全员 + 各参与组；尽量保留当前选择
  const sel = $('#card-target');
  const cur = sel.value;
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = '';
  all.textContent = '全员';
  sel.appendChild(all);
  for (const g of state.groups) {
    const opt = document.createElement('option');
    opt.value = String(g.id);
    opt.textContent = `仅：${g.name}`;
    sel.appendChild(opt);
  }
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';

  // 观察分享表单的组复选框（1～3 个）；尽量保留已勾选项
  const checked = new Set(
    [...document.querySelectorAll('#share-groups input:checked')].map((el) => el.value)
  );
  const sg = $('#share-groups');
  sg.innerHTML = '';
  for (const g of state.groups) {
    const label = document.createElement('label');
    label.className = 'share-group-chip';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = String(g.id);
    cb.checked = checked.has(String(g.id));
    label.appendChild(cb);
    label.appendChild(document.createTextNode(g.name));
    sg.appendChild(label);
  }
}

/* 主持人：回执门槛的前置卡片下拉（已有卡片均可作前置）；尽量保留当前选择 */
function renderGateOptions() {
  if (state.role !== 'host') return;
  const sel = $('#card-gate');
  const cur = sel.value;
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '无门槛：到点即揭示';
  sel.appendChild(none);
  for (const c of sortedCards()) {
    const opt = document.createElement('option');
    opt.value = String(c.id);
    opt.textContent = `前置 #${c.seq} · ${c.title}（T+${fmt(c.trigger_seconds * 1000)}）`;
    sel.appendChild(opt);
  }
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
}

function sortedCards() {
  return [...state.cards].sort((a, b) => a.trigger_seconds - b.trigger_seconds || a.seq - b.seq);
}

function renderCards() {
  const list = $('#card-list');
  // 重渲染会重建列表：先记住正在编辑的答复框，渲染后恢复焦点与未提交文本
  const active = document.activeElement;
  const editingId = active && active.classList && active.classList.contains('answer-input')
    ? active.dataset.cardId : null;
  const editingVal = editingId ? active.value : '';
  list.innerHTML = '';
  const all = sortedCards();
  const visible = state.role === 'host' ? all : all.filter((c) => c.revealed);
  $('#cards-empty').classList.toggle('hidden', visible.length > 0);
  if (state.role === 'host') {
    $('#cards-empty').textContent = '暂无卡片，请在上方添加';
  } else {
    $('#cards-empty').textContent = all.some((c) => c.revealed) ? '' : '等待主持人注入情景…';
  }
  for (const card of visible) {
    const li = document.createElement('li');
    li.className = 'card-item ' + (card.revealed ? 'revealed' : 'pending');

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const left = document.createElement('span');
    const trig = document.createElement('span');
    trig.className = 'card-trigger';
    trig.textContent = `T+${fmt(card.trigger_seconds * 1000)}`;
    left.appendChild(trig);
    left.appendChild(document.createTextNode(` · #${card.seq} `));
    const target = document.createElement('span');
    target.className = 'badge ' + (card.group_id == null ? 'badge-all' : 'badge-target');
    target.textContent = card.group_id == null ? '全员' : `仅 ${groupName(card.group_id)}`;
    left.appendChild(target);
    meta.appendChild(left);

    const right = document.createElement('span');
    if (card.revealed) {
      right.innerHTML = `<span class="badge badge-revealed">已揭示 ${fmt(card.revealed_at_ms || 0)}</span>`;
    } else {
      right.innerHTML = '<span class="badge badge-pending">待触发</span>';
    }
    if (state.role === 'player' && card.revealed) {
      right.appendChild(receiptButton(card));
    }
    if (state.role === 'host') {
      right.appendChild(answerLockButton(card));
    }
    if (state.role === 'host' && state.status !== 'running') {
      const del = document.createElement('button');
      del.className = 'card-del';
      del.textContent = '删除';
      del.onclick = () => api('DELETE', `/api/rooms/${state.code}/cards/${card.id}`).catch(showError);
      right.appendChild(del);
    }
    meta.appendChild(right);

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = card.title;

    li.appendChild(meta);
    li.appendChild(title);
    if (card.content) {
      const content = document.createElement('div');
      content.className = 'card-content';
      content.textContent = card.content;
      li.appendChild(content);
    }
    if (state.role === 'host' && card.gate) {
      li.appendChild(gateStatus(card));
    }
    if (state.role === 'host' && card.revealed) {
      const summary = receiptSummary(card);
      if (summary) li.appendChild(summary);
      const answers = answerSummary(card);
      if (answers) li.appendChild(answers);
    }
    if (state.role === 'player' && card.revealed) {
      li.appendChild(answerEditor(card));
    }
    list.appendChild(li);
  }
  if (editingId) {
    const ta = list.querySelector(`.answer-input[data-card-id="${editingId}"]`);
    if (ta && !ta.disabled) {
      ta.value = editingVal;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }
}

/* 主持人：回执门槛状态行——等待（含未回执组与超时点）/ 已解锁 / 超时揭示 */
function gateStatus(card) {
  const g = card.gate;
  const box = document.createElement('div');
  box.className = `gate-status gate-${g.state}`;
  const parts = [];
  if (g.state === 'waiting') {
    parts.push(`⏳ 回执门槛：等待前置 #${g.depends_on_seq} 集齐回执`);
    if (g.pending_groups.length) {
      parts.push(`（未回执：${g.pending_groups.map(groupName).join('、')}）`);
    }
    if (g.gate_timeout_seconds != null) {
      parts.push(`· 超时点 T+${fmt((card.trigger_seconds + g.gate_timeout_seconds) * 1000)}`);
    }
  } else if (g.state === 'unlocked') {
    parts.push(`🔓 回执门槛已解锁（前置 #${g.depends_on_seq} 已集齐回执）`);
  } else {
    parts.push(`⏰ 超时揭示（前置 #${g.depends_on_seq} 回执未集齐）`);
  }
  box.textContent = parts.join(' ');
  return box;
}

/* 参与者：已揭示卡片上的「已收到」开关（可撤销） */
function receiptButton(card) {
  const btn = document.createElement('button');
  btn.className = 'receipt-btn' + (card.my_receipt ? ' acked' : '');
  btn.textContent = card.my_receipt ? '✓ 已收到（点击撤销）' : '标记已收到';
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      const res = await api(card.my_receipt ? 'DELETE' : 'POST',
        `/api/join/${state.code}/cards/${card.id}/receipt`);
      card.my_receipt = res.acked; // 同组其他连接会通过 receipt_updated 事件同步
      renderCards();
    } catch (err) {
      showError(err);
      btn.disabled = false;
    }
  };
  return btn;
}

/* 主持人：已揭示卡片的每组回执/未回执汇总（全员卡统计所有组，定向卡只统计目标组） */
function receiptSummary(card) {
  const r = card.receipts;
  if (!r || r.expected.length === 0) return null; // 房间内还没有参与组
  const box = document.createElement('div');
  box.className = 'receipt-summary';

  const count = document.createElement('span');
  const done = r.acked.length === r.expected.length;
  count.className = 'receipt-count' + (done ? ' done' : '');
  count.textContent = `回执 ${r.acked.length}/${r.expected.length}`;
  box.appendChild(count);

  for (const gid of r.expected) {
    const got = r.acked.includes(gid);
    const chip = document.createElement('span');
    chip.className = 'receipt-chip ' + (got ? 'receipt-ok' : 'receipt-wait');
    chip.textContent = (got ? '✓ ' : '未回执 · ') + groupName(gid);
    box.appendChild(chip);
  }
  return box;
}

/* ---------------------------------------------------------- 处置答复 */

/* 主持人：逐卡锁定/重新开放答复的开关（锁定后参与者只读，写入被 409 拒绝） */
function answerLockButton(card) {
  const btn = document.createElement('button');
  btn.className = 'answer-lock-btn' + (card.answers_locked ? ' locked' : '');
  btn.textContent = card.answers_locked ? '🔒 答复已锁定' : '🔓 答复开放';
  btn.title = card.answers_locked
    ? '点击重新开放：参与者可继续提交/修改本组答复'
    : '点击锁定：参与者只读，提交/修改将被拒绝';
  btn.onclick = () => api('POST',
    `/api/rooms/${state.code}/cards/${card.id}/answers/${card.answers_locked ? 'unlock' : 'lock'}`)
    .catch(showError);
  return btn;
}

/* 主持人：已揭示卡片的各组答复状态、正文与版本（定向卡只看目标组，全员卡覆盖全部组） */
function answerSummary(card) {
  const a = card.answers;
  if (!a || a.expected.length === 0) return null; // 房间内还没有参与组
  const box = document.createElement('div');
  box.className = 'answer-summary';

  const head = document.createElement('div');
  head.className = 'answer-summary-head';
  const count = document.createElement('span');
  const done = a.submitted.length === a.expected.length;
  count.className = 'receipt-count' + (done ? ' done' : '');
  count.textContent = `答复 ${a.submitted.length}/${a.expected.length}`;
  head.appendChild(count);
  for (const gid of a.expected) {
    const got = a.submitted.find((s) => s.group_id === gid);
    const chip = document.createElement('span');
    chip.className = 'receipt-chip ' + (got ? 'receipt-ok' : 'receipt-wait');
    chip.textContent = (got ? `✓ v${got.revision} ` : '未提交 · ') + groupName(gid);
    head.appendChild(chip);
  }
  box.appendChild(head);

  for (const s of a.submitted) {
    const item = document.createElement('div');
    item.className = 'answer-item';
    const meta = document.createElement('div');
    meta.className = 'answer-item-meta';
    meta.textContent = `${groupName(s.group_id)} · 版本 ${s.revision}`;
    item.appendChild(meta);
    const body = document.createElement('div');
    body.className = 'answer-item-body';
    body.textContent = s.body || '（空）';
    item.appendChild(body);
    box.appendChild(item);
  }
  return box;
}

/* 参与者：已揭示卡片上的本组答复编辑器（每组一份；锁定后只读） */
function answerEditor(card) {
  const wrap = document.createElement('div');
  wrap.className = 'answer-area';
  const locked = card.answers_locked;
  const ans = card.my_answer || null;

  const head = document.createElement('div');
  head.className = 'answer-head';
  const label = document.createElement('span');
  label.className = 'answer-label';
  label.textContent = '处置答复（本组共享一份）';
  head.appendChild(label);
  const rev = document.createElement('span');
  rev.className = 'answer-rev';
  rev.textContent = locked ? '🔒 主持人已锁定，只读'
    : ans ? `已提交 · 版本 ${ans.revision}` : '尚未提交';
  head.appendChild(rev);
  wrap.appendChild(head);

  const ta = document.createElement('textarea');
  ta.className = 'answer-input';
  ta.dataset.cardId = card.id;
  ta.rows = 3;
  ta.maxLength = 4000;
  ta.placeholder = locked ? '答复已被主持人锁定' : '输入本组的处置答复…';
  ta.value = ans ? ans.body : '';
  ta.disabled = locked;
  wrap.appendChild(ta);

  if (card._answerWarn) {
    const warn = document.createElement('div');
    warn.className = 'answer-warn';
    warn.textContent = '同组其他窗口已提交新版本，继续保存将覆盖其内容';
    wrap.appendChild(warn);
  }

  if (!locked) {
    const save = document.createElement('button');
    save.className = 'primary answer-save';
    save.textContent = ans ? '更新答复' : '提交答复';
    save.onclick = () => submitAnswer(card, ta, save);
    wrap.appendChild(save);
  }
  return wrap;
}

/* 提交/修改本组答复：携带当前 revision 乐观并发；
   版本过期（409）时载入服务端返回的最新答复，绝不静默覆盖同组内容 */
async function submitAnswer(card, ta, btn) {
  btn.disabled = true;
  const cur = card.my_answer;
  try {
    const res = await api('PUT', `/api/join/${state.code}/cards/${card.id}/answer`, {
      body: ta.value,
      revision: cur ? cur.revision : 0,
    });
    card.my_answer = { body: res.body, revision: res.revision };
    card._selfSavedRevision = res.revision; // 自己的提交回显不再提示冲突
    card._answerWarn = false;
    renderCards();
  } catch (err) {
    btn.disabled = false;
    const d = err.detail;
    if (err.status === 409 && d && d.error === 'revision_conflict') {
      card.my_answer = d.answer ? { body: d.answer.body, revision: d.answer.revision } : null;
      card._answerWarn = false;
      showError(new Error('答复已被同组其他窗口更新，已为你载入最新版本'));
      renderCards();
    } else if (err.status === 409 && d && d.error === 'answers_locked') {
      card.answers_locked = true;
      showError(new Error('主持人已锁定该卡答复，当前为只读'));
      renderCards();
    } else {
      showError(err);
    }
  }
}

/* ---------------------------------------------------------- 观察席分享 */

const SHARE_STATUS_TEXT = { active: '有效', expired: '已过期', revoked: '已撤销' };

function shareStatus(s) {
  if (s.status === 'revoked') return 'revoked';
  return s.expires_at * 1000 > Date.now() ? 'active' : 'expired';
}

function shareUrl(s) {
  return `${location.origin}/#/observe/${s.token}`;
}

function upsertShare(s) {
  const i = state.shares.findIndex((x) => x.token === s.token);
  if (i >= 0) state.shares[i] = s;
  else state.shares.unshift(s); // 服务端按 id DESC 下发，新分享排最前
}

/* 主持人：分享列表（有效/失效），可复制链接、可撤销 */
function renderShares() {
  if (state.role !== 'host') return;
  const list = $('#share-list');
  list.innerHTML = '';
  $('#shares-empty').classList.toggle('hidden', state.shares.length > 0);
  for (const s of state.shares) {
    const st = shareStatus(s);
    const li = document.createElement('li');
    li.className = 'share-item';

    const main = document.createElement('div');
    main.className = 'share-main';

    const status = document.createElement('span');
    status.className = `badge share-status-${st}`;
    status.textContent = SHARE_STATUS_TEXT[st];
    main.appendChild(status);

    const groups = document.createElement('span');
    groups.className = 'share-groups-label';
    groups.textContent = (s.group_names || []).join('、');
    main.appendChild(groups);

    const mins = document.createElement('span');
    mins.className = 'share-remaining';
    mins.textContent = `${s.minutes} 分钟`;
    main.appendChild(mins);

    if (st === 'active') {
      const remain = document.createElement('span');
      remain.className = 'share-remaining';
      remain.dataset.expiresAt = s.expires_at;
      remain.dataset.token = s.token;
      remain.textContent = remainingText(s.expires_at);
      main.appendChild(remain);
    }
    li.appendChild(main);

    const ops = document.createElement('span');
    ops.className = 'share-ops';

    const copy = document.createElement('button');
    copy.className = 'group-op';
    copy.textContent = '复制链接';
    copy.onclick = () => {
      navigator.clipboard?.writeText(shareUrl(s));
      copy.textContent = '已复制';
      setTimeout(() => { copy.textContent = '复制链接'; }, 1200);
    };
    ops.appendChild(copy);

    if (st === 'active') {
      const revoke = document.createElement('button');
      revoke.className = 'group-op group-del';
      revoke.textContent = '撤销';
      revoke.onclick = async () => {
        if (!confirm('撤销该观察链接？在线观察者将立即断线，链接此后永久失效。')) return;
        try {
          await api('DELETE', `/api/rooms/${state.code}/shares/${s.token}`);
        } catch (err) { showError(err); }
      };
      ops.appendChild(revoke);
    }
    li.appendChild(ops);
    list.appendChild(li);
  }
}

function remainingText(expiresAt) {
  const mins = Math.ceil((expiresAt * 1000 - Date.now()) / 60000);
  return mins > 1 ? `剩余 ${mins} 分钟` : '剩余不足 1 分钟';
}

/* 倒计时文本就地更新（不重建列表，避免打断点击）；到期翻转时整体重渲染 */
function updateShareCountdowns() {
  let flip = false;
  for (const el of document.querySelectorAll('.share-remaining[data-expires-at]')) {
    const s = state.shares.find((x) => x.token === el.dataset.token);
    if (!s || s.status !== 'active') continue;
    const exp = parseFloat(el.dataset.expiresAt);
    if (exp * 1000 <= Date.now()) {
      s.status = 'expired';
      flip = true;
    } else {
      el.textContent = remainingText(exp);
    }
  }
  if (flip) renderShares();
}

/* ---------------------------------------------------------- 复盘锚点 */

/* 主持人：按 (轮次, 虚拟毫秒, id) 列出全部锚点；旧轮次锚点标记「第 N 轮」。
   服务端已保证锚点仅主持人可见（快照字段与 anchor_* 事件都按视野过滤）。 */
function renderAnchors() {
  if (state.role !== 'host') return;
  const list = $('#anchor-list');
  list.innerHTML = '';
  $('#anchors-empty').classList.toggle('hidden', state.anchors.length > 0);
  const ordered = [...state.anchors].sort(
    (a, b) => a.round - b.round || a.vtime_ms - b.vtime_ms || a.id - b.id);
  for (const a of ordered) {
    const li = document.createElement('li');
    li.className = 'anchor-item' + (a.round < currentRound() ? ' is-old' : '');

    const head = document.createElement('div');
    head.className = 'anchor-item-head';
    const title = document.createElement('span');
    title.className = 'anchor-item-title';
    title.textContent = `⚓ ${a.title}`;
    head.appendChild(title);
    if (a.round < currentRound()) {
      const rt = document.createElement('span');
      rt.className = 'anchor-round-tag';
      rt.textContent = `第 ${a.round + 1} 轮（历史）`;
      head.appendChild(rt);
    }
    const tm = document.createElement('span');
    tm.className = 'anchor-item-time';
    tm.textContent = `T+${fmt(a.vtime_ms)}`;
    head.appendChild(tm);
    li.appendChild(head);

    const note = document.createElement('div');
    note.className = 'anchor-item-note' + (a.note ? '' : ' empty-note');
    note.textContent = a.note || '（无备注）';
    li.appendChild(note);

    const meta = document.createElement('div');
    meta.className = 'anchor-item-meta';
    const info = document.createElement('span');
    info.textContent = `第 ${a.round + 1} 轮 · 事件水位 #${a.event_id}` +
      (a.updated_at && a.updated_at !== a.created_at ? ' · 备注已修改' : '');
    meta.appendChild(info);
    const ops = document.createElement('span');
    ops.className = 'anchor-ops';
    const edit = document.createElement('button');
    edit.className = 'anchor-op';
    edit.textContent = '修改备注';
    edit.onclick = async () => {
      const note2 = prompt('修改锚点备注（标题与绑定的轮次/时间/水位不可变）', a.note || '');
      if (note2 === null || note2 === a.note) return;
      try {
        await api('PATCH', `/api/rooms/${state.code}/anchors/${a.id}`, { note: note2 });
      } catch (err) { showError(err); }
    };
    ops.appendChild(edit);
    const del = document.createElement('button');
    del.className = 'anchor-op anchor-del';
    del.textContent = '删除';
    del.onclick = async () => {
      if (!confirm(`删除锚点「${a.title}」？删除后不可恢复。`)) return;
      try {
        await api('DELETE', `/api/rooms/${state.code}/anchors/${a.id}`);
      } catch (err) { showError(err); }
    };
    ops.appendChild(del);
    meta.appendChild(ops);
    li.appendChild(meta);

    list.appendChild(li);
  }
}

/* 当前轮次由快照权威下发（服务端按 reset 事件计数），reset 事件到达时 +1。 */
function currentRound() {
  return state.round;
}

/* ---------------------------------------------------------- 现场决策投票 */

const POLL_STATUS_TEXT = { open: '投票中', settled: '已结算', void: '已作废（重置）' };

/* 主持人：发起投票表单的参与组勾选（仅主持人表单使用） */
function renderPollGroupChecks() {
  if (state.role !== 'host') return;
  const checked = new Set(
    [...document.querySelectorAll('#poll-groups input:checked')].map((el) => el.value)
  );
  const box = $('#poll-groups');
  box.innerHTML = '';
  for (const g of state.groups) {
    const label = document.createElement('label');
    label.className = 'share-group-chip';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = String(g.id);
    cb.checked = checked.has(String(g.id));
    label.appendChild(cb);
    label.appendChild(document.createTextNode(g.name));
    box.appendChild(label);
  }
}

/* 主持人：选项行 2～4 行动态增减；values 为各行当前文本（保留输入时重渲染） */
function renderPollOptionRows(values) {
  const vals = (values || ['', '']).slice(0, 4);
  const box = $('#poll-option-rows');
  box.innerHTML = '';
  vals.forEach((val, idx) => {
    const row = document.createElement('div');
    row.className = 'poll-option-row';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 200;
    input.placeholder = `选项 ${idx + 1}`;
    input.value = val;
    row.appendChild(input);
    if (vals.length > 2) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'group-op group-del poll-option-del';
      del.textContent = '移除';
      del.onclick = () => {
        const cur = [...box.querySelectorAll('input')].map((el) => el.value);
        cur.splice(idx, 1);
        renderPollOptionRows(cur);
      };
      row.appendChild(del);
    }
    box.appendChild(row);
  });
}

function renderPolls() {
  const list = $('#poll-list');
  list.innerHTML = '';
  // 参与者只保留本轮本组投票（reset 后服务端快照只返回新一轮数据，
  // 实时 reset 事件到达时本地需手动剔除旧轮次条目）
  let polls = state.polls;
  if (state.role === 'player') polls = polls.filter((p) => p.round === state.round);
  $('#polls-empty').classList.toggle('hidden', polls.length > 0);
  if (state.role === 'host') {
    $('#polls-empty').textContent = '暂无投票';
  } else {
    $('#polls-empty').textContent = '当前没有本组可参与的投票';
  }
  for (const poll of polls) {
    list.appendChild(state.role === 'host' ? hostPollItem(poll) : playerPollItem(poll));
  }
}

/* 当前虚拟毫秒（与时钟渲染同一外推口径），用于截止倒计时与可否投票判定 */
function elapsedNowMs() {
  const c = state.clock;
  return c.status === 'running'
    ? c.elapsedMs + (performance.now() - c.syncedAt)
    : c.elapsedMs;
}

function pollDeadlineRemainingMs(poll) {
  return poll.deadline_seconds * 1000 - elapsedNowMs();
}

function pollStatusBadge(poll) {
  const badge = document.createElement('span');
  if (poll.status === 'open') {
    const remain = pollDeadlineRemainingMs(poll);
    badge.className = 'badge badge-pending poll-badge-open';
    badge.dataset.pollId = String(poll.id);
    badge.textContent = remain > 0
      ? `投票中 · 截止 T+${fmt(poll.deadline_seconds * 1000)}（剩 ${fmt(Math.max(0, remain))}）`
      : '等待结算…';
  } else if (poll.status === 'settled') {
    badge.className = 'badge badge-revealed';
    badge.textContent = `已结算 · T+${fmt(poll.settled_at_ms || 0)}`;
  } else {
    badge.className = 'badge share-status-revoked';
    badge.textContent = POLL_STATUS_TEXT.void;
  }
  return badge;
}

function pollRoundTag(poll) {
  const tag = document.createElement('span');
  tag.className = 'anchor-round-tag';
  tag.textContent = poll.round < state.round ? `第 ${poll.round + 1} 轮（历史）`
    : `第 ${poll.round + 1} 轮`;
  return tag;
}

/* 主持人：议题、状态、参与组、选项汇总（票数/获胜）、逐组选票 */
function hostPollItem(poll) {
  const li = document.createElement('li');
  li.className = `poll-item poll-${poll.status}` + (poll.round < state.round ? ' is-old' : '');

  const head = document.createElement('div');
  head.className = 'poll-head';
  const title = document.createElement('span');
  title.className = 'poll-title';
  title.textContent = `🗳 ${poll.title}`;
  head.appendChild(title);
  head.appendChild(pollRoundTag(poll));
  head.appendChild(pollStatusBadge(poll));
  li.appendChild(head);

  const meta = document.createElement('div');
  meta.className = 'poll-meta';
  meta.textContent = `参与组：${poll.group_ids.map(groupName).join('、') || '（无）'}`;
  li.appendChild(meta);

  for (const opt of poll.options) {
    const row = document.createElement('div');
    row.className = 'poll-option' + (poll.status === 'settled'
      && opt.id === poll.winner_option_id ? ' poll-winner' : '');
    const text = document.createElement('span');
    text.className = 'poll-option-text';
    text.textContent = `${opt.seq}. ${opt.text}`;
    row.appendChild(text);
    const votes = document.createElement('span');
    votes.className = 'poll-option-votes';
    votes.textContent = poll.status === 'settled'
      ? `${opt.votes} 票` + (opt.id === poll.winner_option_id ? ' 👑 获胜' : '')
      : '';
    row.appendChild(votes);
    li.appendChild(row);
  }

  // 逐组实时选票：open 时看每组当前投给哪个选项（改投只保留最新）
  const ballots = document.createElement('div');
  ballots.className = 'poll-ballots';
  const ballotMap = new Map((poll.ballots || []).map((b) => [b.group_id, b]));
  const count = document.createElement('span');
  count.className = 'receipt-count'
    + ((poll.ballots || []).length === poll.group_ids.length ? ' done' : '');
  count.textContent = `已投 ${(poll.ballots || []).length}/${poll.group_ids.length}`;
  ballots.appendChild(count);
  for (const gid of poll.group_ids) {
    const b = ballotMap.get(gid);
    const chip = document.createElement('span');
    chip.className = 'receipt-chip ' + (b ? 'receipt-ok' : 'receipt-wait');
    if (b) {
      const opt = poll.options.find((o) => o.id === b.option_id);
      chip.textContent = `✓ ${groupName(gid)} → ${opt ? opt.text : '#' + b.option_id}`;
    } else {
      chip.textContent = `未投 · ${groupName(gid)}`;
    }
    ballots.appendChild(chip);
  }
  li.appendChild(ballots);
  return li;
}

/* 参与者：投票中只见选项与本组选择，可改投；结算后才显示票数与获胜选项 */
function playerPollItem(poll) {
  const li = document.createElement('li');
  li.className = `poll-item poll-${poll.status}`;

  const head = document.createElement('div');
  head.className = 'poll-head';
  const title = document.createElement('span');
  title.className = 'poll-title';
  title.textContent = `🗳 ${poll.title}`;
  head.appendChild(title);
  head.appendChild(pollStatusBadge(poll));
  li.appendChild(head);

  const remain = pollDeadlineRemainingMs(poll);
  const canVote = poll.status === 'open' && remain > 0;
  for (const opt of poll.options) {
    const row = document.createElement('label');
    row.className = 'poll-vote-row' + (opt.id === poll.my_option_id ? ' chosen' : '')
      + (poll.status === 'settled' && opt.id === poll.winner_option_id ? ' poll-winner' : '');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `poll-${poll.id}`;
    radio.value = String(opt.id);
    radio.checked = opt.id === poll.my_option_id;
    radio.disabled = !canVote;
    radio.onchange = () => submitPollVote(poll, opt.id);
    row.appendChild(radio);
    const text = document.createElement('span');
    text.className = 'poll-option-text';
    text.textContent = `${opt.seq}. ${opt.text}`;
    row.appendChild(text);
    if (poll.status === 'settled') {
      const v = document.createElement('span');
      v.className = 'poll-option-votes';
      v.textContent = `${opt.votes} 票` + (opt.id === poll.winner_option_id ? ' 👑' : '');
      row.appendChild(v);
    }
    li.appendChild(row);
  }

  const foot = document.createElement('div');
  foot.className = 'poll-foot';
  if (poll.status === 'open') {
    foot.textContent = canVote
      ? (poll.my_option_id != null ? '已投票，可在截止前改投（每组只计一票）'
        : '本组尚未投票（每组只计一票）')
      : '已过截止，等待主持人侧结算…';
  } else if (poll.status === 'settled') {
    foot.textContent = '投票已结算';
  }
  li.appendChild(foot);
  return li;
}

async function submitPollVote(poll, optionId) {
  try {
    const res = await api('PUT', `/api/join/${state.code}/polls/${poll.id}/vote`,
      { option_id: optionId });
    poll.my_option_id = res.my_option_id; // poll_voted 事件同样会到达并校正
    renderPolls();
  } catch (err) {
    const d = err.detail;
    if (err.status === 409 && d && (d.error === 'poll_deadline_passed' || d.error === 'poll_not_open')) {
      showError(new Error('投票已截止或已结算，不能再改投'));
    } else {
      showError(err);
    }
    renderPolls();
  }
}

/* 倒计时就地刷新；跨越截止瞬间把投票单置为只读（结算事件到达后再显示结果）。
   不整体重渲染，避免「等待结算…」状态下 200ms 一次的重排循环。 */
function updatePollCountdowns() {
  if (state.role === 'observer') return;
  for (const el of document.querySelectorAll('.poll-badge-open')) {
    const poll = state.polls.find((p) => String(p.id) === el.dataset.pollId);
    if (!poll || poll.status !== 'open') continue;
    if (state.status !== 'running') {
      el.textContent = `投票中 · 截止 T+${fmt(poll.deadline_seconds * 1000)}（时钟暂停，计时冻结）`;
      continue;
    }
    const remain = pollDeadlineRemainingMs(poll);
    if (remain <= 0) {
      el.textContent = '等待结算…';
      // 到点即冻结输入：结算 poll_settled 事件到达前的最后一个 tick 可能尚未跑
      document.querySelectorAll(`input[name="poll-${poll.id}"]`).forEach((r) => { r.disabled = true; });
    } else {
      el.textContent = `投票中 · 截止 T+${fmt(poll.deadline_seconds * 1000)}（剩 ${fmt(remain)}）`;
    }
  }
}

function renderAll() {
  renderMeta();
  renderGroups();
  renderGateOptions();
  renderPollGroupChecks();
  renderShares();
  renderAnchors();
  renderPolls();
  renderCards();
}

/* 本地时钟渲染：以快照/事件同步点为基准，running 时本地外推，暂停即冻结 */
setInterval(() => {
  if (!state.code) return;
  const c = state.clock;
  const elapsed = c.status === 'running' ? c.elapsedMs + (performance.now() - c.syncedAt) : c.elapsedMs;
  $('#clock').textContent = fmt(elapsed);
  if (state.role === 'host') updateShareCountdowns();
  updatePollCountdowns(); // 投票截止倒计时（暂停期间显示「计时冻结」）
}, 200);

function syncClock(status, elapsedMs) {
  state.status = status;
  state.clock = { status, elapsedMs, syncedAt: performance.now() };
}

/* ---------------------------------------------------------- 状态应用 */

function applySnapshot(msg) {
  state.roomName = msg.room.name;
  state.cards = msg.cards;
  state.groups = msg.groups || [];
  state.shares = msg.shares || []; // 仅主持人快照携带
  state.anchors = msg.anchors || []; // 仅主持人快照携带；参与者/观察者字段缺省
  state.polls = msg.polls || []; // 观察者快照不带 polls；主持人/参与者按各自视野
  state.groupId = msg.scope && msg.scope.role === 'player' ? msg.scope.group_id : null;
  state.round = Number.isInteger(msg.round) ? msg.round : 0;
  state.lastEventId = msg.last_event_id; // 权威水位
  syncClock(msg.room.status, msg.room.elapsed_ms);
  renderAll();
}

function applyEvent(msg) {
  if (msg.id <= state.lastEventId) return; // 不回退：丢弃旧事件
  state.lastEventId = msg.id;
  const p = msg.payload;
  switch (msg.type) {
    case 'card_added':
      if (!state.cards.some((c) => c.id === p.id)) {
        initCardState(p); // 新卡必然零回执、零答复（未揭示不可回执）
        state.cards.push(p);
      }
      break;
    case 'card_removed':
      state.cards = state.cards.filter((c) => c.id !== p.id);
      break;
    case 'card_revealed': {
      const card = state.cards.find((c) => c.id === p.id);
      if (card) Object.assign(card, p);
      else { initCardState(p); state.cards.push(p); }
      break;
    }
    case 'receipt_updated': {
      // 服务端已按视野过滤：主持人收全部，参与者只收本组
      const card = state.cards.find((c) => c.id === p.card_id);
      if (!card) break;
      if (state.role === 'host' && card.receipts) {
        const i = card.receipts.acked.indexOf(p.group_id);
        if (p.acked && i < 0) card.receipts.acked.push(p.group_id);
        if (!p.acked && i >= 0) card.receipts.acked.splice(i, 1);
      } else if (state.role === 'player' && p.group_id === state.groupId) {
        card.my_receipt = p.acked;
      }
      break;
    }
    case 'answer_updated': {
      // 含答复正文：主持人收全部，参与者只收本组（服务端已过滤）
      const card = state.cards.find((c) => c.id === p.card_id);
      if (!card) break;
      if (state.role === 'host' && card.answers) {
        const i = card.answers.submitted.findIndex((s) => s.group_id === p.group_id);
        const entry = { group_id: p.group_id, body: p.body, revision: p.revision,
                        updated_at: p.updated_at };
        if (i >= 0) card.answers.submitted[i] = entry;
        else card.answers.submitted.push(entry);
      } else if (state.role === 'player' && p.group_id === state.groupId) {
        card.my_answer = { body: p.body, revision: p.revision };
        // 正在编辑时收到同组新版本：保留未提交文本并提示，而非直接覆盖
        const active = document.activeElement;
        const editing = active && active.classList && active.classList.contains('answer-input')
          && active.dataset.cardId === String(card.id);
        if (editing && p.revision !== card._selfSavedRevision) card._answerWarn = true;
      }
      break;
    }
    case 'answer_lock_updated': {
      const card = state.cards.find((c) => c.id === p.card_id);
      if (card) card.answers_locked = p.answers_locked;
      break;
    }
    case 'gate_updated': {
      // 仅主持人会收到：门槛状态由服务端权威计算，直接替换
      const card = state.cards.find((c) => c.id === p.card_id);
      if (card) card.gate = p.gate;
      break;
    }
    case 'group_added':
      if (!state.groups.some((g) => g.id === p.id)) state.groups.push(p);
      // 新组自动成为所有全员卡片的待回执方与待答复方
      state.cards.forEach((c) => {
        if (c.group_id == null) {
          if (c.receipts && !c.receipts.expected.includes(p.id)) {
            c.receipts.expected.push(p.id);
          }
          if (c.answers && !c.answers.expected.includes(p.id)) {
            c.answers.expected.push(p.id);
          }
        }
      });
      break;
    case 'group_renamed': {
      const g = state.groups.find((g) => g.id === p.id);
      if (g) g.name = p.name;
      break;
    }
    case 'group_removed':
      state.groups = state.groups.filter((g) => g.id !== p.id);
      state.cards.forEach((c) => {
        if (c.receipts) {
          c.receipts.expected = c.receipts.expected.filter((id) => id !== p.id);
          c.receipts.acked = c.receipts.acked.filter((id) => id !== p.id);
        }
        if (c.answers) {
          c.answers.expected = c.answers.expected.filter((id) => id !== p.id);
          c.answers.submitted = c.answers.submitted.filter((s) => s.group_id !== p.id);
        }
      });
      break;
    case 'share_created':
      upsertShare(p); // 仅主持人会收到（事件含观察凭证，服务端已过滤）
      break;
    case 'share_revoked':
    case 'share_expired': {
      const s = state.shares.find((x) => x.token === p.token);
      if (s) s.status = msg.type === 'share_revoked' ? 'revoked' : 'expired';
      break;
    }
    case 'anchor_created':
      // 仅主持人会收到（服务端 event_visible 对 anchor_* 已过滤参与者/观察者）
      if (!state.anchors.some((a) => a.id === p.id)) state.anchors.push(p);
      break;
    case 'anchor_updated': {
      const a = state.anchors.find((x) => x.id === p.id);
      if (a) Object.assign(a, p); // 仅备注/updated_at 会变；绑定字段不可变
      break;
    }
    case 'anchor_deleted':
      state.anchors = state.anchors.filter((a) => a.id !== p.id);
      break;
    case 'poll_created':
      // 服务端已按视野投影：主持人收全量（含 ballots/options.votes），
      // 参与者收瘦身后的选项文本，非参与组根本收不到该事件
      if (!state.polls.some((x) => x.id === p.id)) state.polls.unshift(p);
      break;
    case 'poll_voted': {
      // 主持人更新逐组选票（本地重算票数）；参与者只收本组事件
      const poll = state.polls.find((x) => x.id === p.poll_id);
      if (!poll) break;
      if (state.role === 'host') {
        const b = p.ballot;
        const i = poll.ballots.findIndex((x) => x.group_id === b.group_id);
        const entry = { group_id: b.group_id, option_id: b.option_id, updated_at: b.updated_at };
        if (i >= 0) poll.ballots[i] = entry;
        else poll.ballots.push(entry);
        for (const o of poll.options) {
          o.votes = poll.ballots.filter((x) => x.option_id === o.id).length;
        }
      } else {
        poll.my_option_id = p.option_id;
      }
      break;
    }
    case 'poll_settled': {
      // 主持人载荷含 ballots；参与者载荷只有 options(含票数)/winner/settled_at
      const idx = state.polls.findIndex((x) => x.id === p.id);
      if (state.role === 'host') {
        if (idx >= 0) state.polls[idx] = p;
        else state.polls.unshift(p);
      } else if (idx >= 0) {
        Object.assign(state.polls[idx], {
          status: 'settled',
          options: p.options,
          winner_option_id: p.winner_option_id,
          settled_at_ms: p.settled_at_ms,
        });
      }
      break;
    }
    case 'polls_reset': {
      // 主持人：未结算投票就地翻为「已作废」（选票留痕仍显示）；
      // 参与者投影载荷不含 id：直接清空本轮全部投票（历史轮次本就不下发）
      if (state.role === 'host') {
        const ids = new Set(p.void_poll_ids || []);
        for (const poll of state.polls) {
          if (ids.has(poll.id)) {
            poll.status = 'void';
            poll.winner_option_id = null;
          }
        }
      } else {
        state.polls = [];
      }
      break;
    }
    case 'clock':
      syncClock(p.status, p.elapsed_ms);
      break;
    case 'reset':
      state.cards.forEach((c) => {
        c.revealed = false;
        c.revealed_at_ms = null;
        if (c.receipts) c.receipts.acked = []; // 回执随揭示一并收回
        if ('my_receipt' in c) c.my_receipt = false;
        c.answers_locked = false;            // 答复锁定一并解除
        if (c.answers) c.answers.submitted = [];
        if ('my_answer' in c) c.my_answer = null;
        c._answerWarn = false;
      });
      state.round += 1; // 重置开启新一轮；锚点不清空，旧锚点仍归属原轮次
      syncClock('idle', 0);
      break;
  }
  renderAll();
}

/* 事件流里新增的卡片不带回执/答复字段（新卡/新揭示必然零回执、零答复），按角色补默认值；
   观察者只读，不附加任何回执与答复状态 */
function initCardState(card) {
  if (state.role === 'host') {
    card.receipts = {
      expected: card.group_id == null ? state.groups.map((g) => g.id) : [card.group_id],
      acked: [],
    };
    card.answers = {
      expected: card.group_id == null ? state.groups.map((g) => g.id) : [card.group_id],
      submitted: [],
    };
  } else if (state.role === 'player') {
    card.my_receipt = false;
    card.my_answer = null;
  }
}

/* ---------------------------------------------------------- WebSocket */

function setConn(up) {
  const el = $('#conn');
  el.textContent = up ? '已连接' : '连接断开，重连中…';
  el.className = 'conn ' + (up ? 'conn-up' : 'conn-down');
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const path = state.role === 'observer' ? `/ws/observe/${state.code}` : `/ws/${state.code}`;
  const ws = new WebSocket(`${proto}://${location.host}${path}?last_event_id=${state.lastEventId}`);
  state.ws = ws;

  ws.onopen = () => { state.reconnectDelay = 1000; setConn(true); };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.kind === 'snapshot') applySnapshot(msg);
    else if (msg.kind === 'event') applyEvent(msg);
    else if (msg.kind === 'error') { alert(msg.message); leaveRoom(); }
  };
  ws.onclose = () => {
    setConn(false);
    if (!state.code) return;
    setTimeout(connect, state.reconnectDelay);
    state.reconnectDelay = Math.min(state.reconnectDelay * 2, 5000);
  };
}

/* ---------------------------------------------------------- API */

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const d = data.detail;
    // 409 冲突等场景 detail 可能是结构化对象（如答复版本冲突携带最新答复）
    const err = new Error(typeof d === 'string' ? d : (d && d.error) || `请求失败 (${res.status})`);
    err.status = res.status;
    if (d && typeof d === 'object') err.detail = d;
    throw err;
  }
  return res.json();
}

function showError(err) {
  for (const sel of ['#landing-error', '#room-error']) {
    const el = $(sel);
    el.textContent = err.message || String(err);
    setTimeout(() => { el.textContent = ''; }, 4000);
  }
}

/* ---------------------------------------------------------- 流程 */

function enterRoom(code, role) {
  state.code = code;
  state.role = role;
  state.lastEventId = 0;
  state.cards = [];
  state.groups = [];
  state.shares = [];
  state.anchors = [];
  state.polls = [];
  state.round = 0;
  state.groupId = null;
  location.hash = `#/${role}/${code}`;
  localStorage.setItem(`inject-role-${code}`, role);
  showRoom();
  renderAll();
  connect();
}

/* 观察者：凭限时观察链接进入（只读视野，凭证失效后服务端拒绝重连） */
function enterObserver(token) {
  state.code = token;
  state.role = 'observer';
  state.lastEventId = 0;
  state.cards = [];
  state.groups = [];
  state.shares = [];
  state.anchors = [];
  state.polls = [];
  state.round = 0;
  state.groupId = null;
  location.hash = `#/observe/${token}`;
  showRoom();
  renderAll();
  connect();
}

function leaveRoom() {
  if (state.ws) { state.ws.onclose = null; state.ws.close(); }
  state.code = null;
  location.hash = '';
  showLanding();
}

$('#btn-create').onclick = async () => {
  try {
    const name = $('#create-name').value.trim();
    const room = await api('POST', '/api/rooms', { name });
    enterRoom(room.code, 'host');
  } catch (err) { showError(err); }
};

$('#btn-join').onclick = async () => {
  const code = $('#join-code').value.trim().toUpperCase();
  if (!code) return;
  try {
    await api('GET', `/api/join/${code}`);
    enterRoom(code, 'player');
  } catch (err) { showError(new Error('加入码无效，请向主持人确认组加入码')); }
};

$('#room-code').onclick = () => {
  navigator.clipboard?.writeText(state.code);
  $('#room-code').textContent = '已复制';
  setTimeout(() => { $('#room-code').textContent = state.code; }, 1200);
};

$('#btn-start').onclick  = () => api('POST', `/api/rooms/${state.code}/start`).catch(showError);
$('#btn-pause').onclick  = () => api('POST', `/api/rooms/${state.code}/pause`).catch(showError);
$('#btn-resume').onclick = () => api('POST', `/api/rooms/${state.code}/resume`).catch(showError);
$('#btn-reset').onclick  = () => api('POST', `/api/rooms/${state.code}/reset`).catch(showError);

/* 导出复盘 ZIP：按点击瞬间的事件水位打包（服务端在锁内定水位，生成期间新事件不混入）。
   直接走浏览器下载，无需解析 JSON；导出进行中禁用按钮并提示。 */
$('#btn-export').onclick = async () => {
  const btn = $('#btn-export');
  const hint = $('#export-hint');
  btn.disabled = true;
  hint.textContent = '正在按当前事件水位打包…';
  try {
    const res = await fetch(`/api/rooms/${state.code}/review.zip`, { cache: 'no-store' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(typeof data.detail === 'string' ? data.detail : `导出失败 (${res.status})`);
    }
    const blob = await res.blob();
    const wantName = /filename\*=UTF-8''([^;]+)/i.exec(
      res.headers.get('content-disposition') || '');
    const name = wantName ? decodeURIComponent(wantName[1])
      : `review-${Date.now()}.zip`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    hint.textContent = '已导出（含离线回放页 replay.html，可直接打开）';
    setTimeout(() => { hint.textContent = ''; }, 4000);
  } catch (err) {
    hint.textContent = '';
    showError(err);
  } finally {
    btn.disabled = false;
  }
};

$('#group-form').onsubmit = async (e) => {
  e.preventDefault();
  const name = $('#group-name').value.trim();
  if (!name) return;
  try {
    await api('POST', `/api/rooms/${state.code}/groups`, { name });
    $('#group-name').value = '';
    $('#group-name').focus();
  } catch (err) { showError(err); }
};

/* 记录复盘锚点：任意状态可提交，服务端在状态锁内绑定当前轮次/虚拟毫秒/事件水位。
   成功后由 anchor_created 事件（本连接也会收到广播）统一刷新，这里只清空表单。 */
$('#anchor-form').onsubmit = async (e) => {
  e.preventDefault();
  const title = $('#anchor-title').value.trim();
  if (!title) return;
  const note = $('#anchor-note').value;
  const btn = $('#anchor-form').querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api('POST', `/api/rooms/${state.code}/anchors`, { title, note });
    $('#anchor-title').value = '';
    $('#anchor-note').value = '';
    $('#anchor-title').focus();
  } catch (err) { showError(err); } finally {
    btn.disabled = false;
  }
};

$('#card-form').onsubmit = async (e) => {
  e.preventDefault();
  const gateId = $('#card-gate').value;
  const gateTimeout = $('#card-gate-timeout').value.trim();
  if (gateTimeout && !gateId) {
    showError(new Error('设置超时秒数需先选择前置卡片'));
    return;
  }
  const body = {
    title: $('#card-title').value.trim(),
    content: $('#card-content').value.trim(),
    trigger_seconds: parseInt($('#card-trigger').value, 10) || 0,
    group_id: $('#card-target').value ? parseInt($('#card-target').value, 10) : null,
    depends_on_card_id: gateId ? parseInt(gateId, 10) : null,
    gate_timeout_seconds: gateTimeout ? parseInt(gateTimeout, 10) : null,
  };
  try {
    await api('POST', `/api/rooms/${state.code}/cards`, body);
    $('#card-title').value = '';
    $('#card-content').value = '';
    $('#card-trigger').value = '';
    $('#card-gate').value = '';
    $('#card-gate-timeout').value = '';
    $('#card-title').focus();
  } catch (err) { showError(err); }
};

$('#share-form').onsubmit = async (e) => {
  e.preventDefault();
  const ids = [...document.querySelectorAll('#share-groups input:checked')]
    .map((el) => parseInt(el.value, 10));
  const minutes = parseInt($('#share-minutes').value, 10);
  if (ids.length < 1 || ids.length > 3) {
    showError(new Error('请选择 1～3 个参与组'));
    return;
  }
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 120) {
    showError(new Error('有效期须为 5～120 分钟'));
    return;
  }
  try {
    const share = await api('POST', `/api/rooms/${state.code}/shares`,
      { group_ids: ids, minutes });
    upsertShare(share); // share_created 事件到达时按 token 去重
    renderShares();
    document.querySelectorAll('#share-groups input:checked').forEach((el) => { el.checked = false; });
    $('#share-minutes').value = 30;
  } catch (err) { showError(err); }
};

/* 现场决策投票：选项行初始化 2 行，最多 4 行；发起时校验 2～4 个非空选项与参与组 */
(function initPollForm() {
  renderPollOptionRows(['', '']);
  $('#poll-add-option').onclick = () => {
    const box = $('#poll-option-rows');
    const vals = [...box.querySelectorAll('input')].map((el) => el.value);
    if (vals.length >= 4) { showError(new Error('最多 4 个选项')); return; }
    renderPollOptionRows([...vals, '']);
  };
})();

$('#poll-form').onsubmit = async (e) => {
  e.preventDefault();
  const title = $('#poll-title').value.trim();
  if (!title) return;
  const options = [...document.querySelectorAll('#poll-option-rows input')]
    .map((el) => el.value.trim())
    .filter((v) => v.length > 0);
  if (options.length < 2 || options.length > 4) {
    showError(new Error('请填写 2～4 个非空选项'));
    return;
  }
  const groupIds = [...document.querySelectorAll('#poll-groups input:checked')]
    .map((el) => parseInt(el.value, 10));
  if (groupIds.length < 1) {
    showError(new Error('请至少勾选一个参与组'));
    return;
  }
  const deadline = parseInt($('#poll-deadline').value, 10);
  if (!Number.isInteger(deadline) || deadline < 0 || deadline > 86400) {
    showError(new Error('截止虚拟秒须为 0～86400 的整数'));
    return;
  }
  const btn = $('#poll-form').querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    await api('POST', `/api/rooms/${state.code}/polls`,
      { title, options, group_ids: groupIds, deadline_seconds: deadline });
    $('#poll-title').value = '';
    $('#poll-deadline').value = '';
    document.querySelectorAll('#poll-groups input:checked').forEach((el) => { el.checked = false; });
    renderPollOptionRows(['', '']);
    $('#poll-title').focus();
  } catch (err) { showError(err); } finally {
    btn.disabled = false;
  }
};

/* 刷新恢复：根据 hash 与本地角色记录重进房间（走完整的快照+增量协议）；
   观察链接同样从 hash 恢复——凭证已失效时服务端会拒绝并提示 */
(function boot() {
  const m = location.hash.match(/^#\/(host|player)\/([A-Z0-9]{6})$/);
  if (m) { enterRoom(m[2], m[1]); return; }
  const mo = location.hash.match(/^#\/observe\/([A-Za-z0-9_-]+)$/);
  if (mo) { enterObserver(mo[1]); return; }
  showLanding();
})();
