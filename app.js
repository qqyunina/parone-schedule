/* ============================================================
   Parone 排班系統 — 前端邏輯（月曆版）
   ============================================================ */

// ---------- 連線 ----------
const cfg = window.PARONE_CONFIG || {};
let sb = null;
const configReady =
  cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY &&
  !cfg.SUPABASE_URL.includes("貼上") && !cfg.SUPABASE_ANON_KEY.includes("貼上");
if (configReady) sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

// ---------- 常數 ----------
const CAT_ORDER = ["正職", "PT", "教練"];
const DOW = ["日", "一", "二", "三", "四", "五", "六"];
// 上班為固定內建；其餘假別由 leave_types（後台可自訂）動態產生。公休為系統自動。
const WORK_STATUS = { key: "work", label: "上班", color: "#6fb06a", needs_note: false, is_annual: false, is_monthly: false, is_comp: false };
const SPECIAL_REASONS = ["長期出國", "留職停薪", "出差", "進修", "事假", "病假", "婚假", "產假"];

function leaveKeys() { return (state.leaveTypes || []).map((t) => t.name); }
function monthlyKeys() { return (state.leaveTypes || []).filter((t) => t.is_monthly).map((t) => t.name); }
function compKeys() { return (state.leaveTypes || []).filter((t) => t.is_comp).map((t) => t.name); }
function statusMeta(key) {
  if (key === "work") return WORK_STATUS;
  const t = (state.leaveTypes || []).find((x) => x.name === key);
  return t ? { key: t.name, label: t.name, color: t.color, needs_note: t.needs_note, is_annual: t.is_annual, is_monthly: !!t.is_monthly, is_comp: !!t.is_comp }
           : { key, label: key, color: "#8a7a64", needs_note: false, is_annual: false, is_monthly: false, is_comp: false };
}
function hexA(hex, a) {
  const h = hex.replace("#", ""); const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(f, 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function textOn(hex) {
  const h = hex.replace("#", ""); const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(f, 16); const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? "#16110d" : "#fff";
}
function isLocked(period) { return !!state.locks[period]; }
const periodOf = (dateStr) => dateStr.slice(0, 7);

// 某員工在目前使用者身分下「可選的狀態」
function allowedStatusKeys(empId, dateStr) {
  const all = ["work", ...leaveKeys()];
  if (state.user.is_admin) return all;                    // 管理者：全部
  const emp = state.employees.find((e) => e.id === empId);
  let keys = all;
  if (emp && emp.category === "PT") keys = leaveKeys().filter((k) => !statusMeta(k).is_annual); // PT：只能非特休的假
  if (dateStr && isLocked(periodOf(dateStr))) keys = keys.filter((k) => k !== "work");           // 班表已確認→員工只能請假
  return keys;
}

// ---------- 狀態 ----------
const state = {
  user: null,
  ym: null,
  viewEmp: "__all__",
  selectedDate: null,
  clipboard: null,   // 複製的班別 { status, start_time, end_time, note }
  employees: [],
  presets: [],
  hours: [],
  shifts: [],
  requests: [],
  dayNotes: {},   // { "2026-08-15": "包場活動 18:00" }
  payrolls: [],   // 當月薪資單
  leaveTypes: [], // 假別（後台自訂）
  locks: {},      // { "2026-09": true } 班表確認鎖
  quickMode: false, quickEmp: null, quickStart: null, quickEnd: null, _qInit: false, // ⚡ 快速排班
};

// ---------- 小工具 ----------
const $ = (s, r = document) => r.querySelector(s);
const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const minToStr = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const todayStr = () => { const d = new Date(); return iso(d.getFullYear(), d.getMonth(), d.getDate()); };
const periodStr = () => `${state.ym.y}-${pad(state.ym.m + 1)}`;
const monthTotalHours = (empId) => state.shifts.filter((s) => s.employee_id === empId).reduce((t, s) => t + hoursOf(s), 0);

// 特休額度：計算某員工在「本年度週期」內某假別已用天數
async function annualLeaveUsage(emp, statusKey) {
  const now = new Date();
  let start = emp.leave_start ? new Date(emp.leave_start + "T00:00:00") : new Date(now.getFullYear(), 0, 1);
  while (new Date(start.getFullYear() + 1, start.getMonth(), start.getDate()) <= now) {
    start = new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
  }
  const end = new Date(start.getFullYear() + 1, start.getMonth(), start.getDate());
  const sIso = iso(start.getFullYear(), start.getMonth(), start.getDate());
  const eIso = iso(end.getFullYear(), end.getMonth(), end.getDate());
  const { data } = await sb.from("shifts").select("work_date")
    .eq("employee_id", emp.id).eq("status", statusKey).gte("work_date", sIso).lt("work_date", eIso);
  return { used: (data || []).length, quota: Number(emp.annual_leave_days) || 0, from: sIso, to: eIso };
}

// 某員工某月已排的「指休」（計月休上限的假別）日期
async function monthlyOffDates(emp, period) {
  const keys = monthlyKeys();
  if (!keys.length) return [];
  const [y, mm] = period.split("-").map(Number);
  const first = `${period}-01`, last = iso(y, mm - 1, daysInMonth(y, mm - 1));
  const { data } = await sb.from("shifts").select("work_date")
    .eq("employee_id", emp.id).in("status", keys).gte("work_date", first).lte("work_date", last);
  return (data || []).map((r) => r.work_date);
}

// 加班補休餘額：earned（帳本加總）− used（已排補休天數）
async function compBalance(emp) {
  const keys = compKeys();
  const [led, used] = await Promise.all([
    sb.from("comp_ledger").select("delta").eq("employee_id", emp.id),
    keys.length ? sb.from("shifts").select("work_date").eq("employee_id", emp.id).in("status", keys) : Promise.resolve({ data: [] }),
  ]);
  const earned = (led.data || []).reduce((t, r) => t + Number(r.delta), 0);
  const usedDates = (used.data || []).map((r) => r.work_date);
  return { earned, usedDates, used: usedDates.length, balance: earned - usedDates.length };
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtClock = (ts) => { if (!ts) return "—"; const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtDateTime = (ts) => { if (!ts) return "—"; const d = new Date(ts); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function timeOptions() {
  const out = [];
  for (let h = 6; h <= 24; h++) for (const mm of [0, 15, 30, 45]) {
    if (h === 24 && mm > 0) break;
    out.push(`${pad(h % 24)}:${pad(mm)}`);
  }
  return out;
}
function hoursOf(s) {
  if (!s || s.status !== "work" || !s.start_time || !s.end_time) return 0;
  let d = toMin(s.end_time) - toMin(s.start_time);
  if (d < 0) d += 1440;
  return d / 60;
}
function shiftText(s) {
  if (!s) return "";
  if (s.status === "work") return `${s.start_time}-${s.end_time}`;
  if (statusMeta(s.status).needs_note && s.note) return `${s.status}：${s.note}`;
  return s.status;
}
// 精簡時間顯示：10:00→10、14:15→14:15
function compactTime(t) { const [h, m] = t.split(":"); return m === "00" ? String(Number(h)) : `${Number(h)}:${m}`; }

// 當天上班者（依開始時間早→晚排序）
function workersOf(dateStr) {
  return state.shifts
    .filter((s) => s.work_date === dateStr && s.status === "work" && s.start_time && s.end_time)
    .map((s) => ({ emp: state.employees.find((e) => e.id === s.employee_id), s }))
    .filter((w) => w.emp)
    .sort((a, b) => toMin(a.s.start_time) - toMin(b.s.start_time));
}

// 營業時間是否「沒排滿」（回傳未覆蓋的分鐘數；0 = 有排滿）
function uncoveredMinutes(dateStr) {
  const bh = bhFor(dateStr);
  if (!bh || !bh.is_open) return 0;
  const open = toMin(bh.open_time), close = toMin(bh.close_time);
  const ivs = state.shifts
    .filter((s) => s.work_date === dateStr && s.status === "work" && s.start_time && s.end_time)
    .map((s) => [Math.max(toMin(s.start_time), open), Math.min(toMin(s.end_time), close)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let cursor = open, uncovered = 0;
  for (const [a, b] of ivs) {
    if (a > cursor) uncovered += a - cursor;      // 中間有空檔
    cursor = Math.max(cursor, b);
  }
  if (cursor < close) uncovered += close - cursor; // 尾端沒排到打烊
  return uncovered;
}

// 當天營業時間內「還沒人排」的空檔（回傳 [[起,迄]...] 分鐘）——單人顧店：正職排完後剩給 PT 選
function openGaps(dateStr) {
  const bh = bhFor(dateStr);
  if (!bh || !bh.is_open) return [];
  const open = toMin(bh.open_time), close = toMin(bh.close_time);
  const ivs = state.shifts
    .filter((s) => s.work_date === dateStr && s.status === "work" && s.start_time && s.end_time)
    .map((s) => [Math.max(toMin(s.start_time), open), Math.min(toMin(s.end_time), close)])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const gaps = []; let cursor = open;
  for (const [a, b] of ivs) { if (a > cursor) gaps.push([cursor, a]); cursor = Math.max(cursor, b); }
  if (cursor < close) gaps.push([cursor, close]);
  return gaps;
}

// 單人顧店：某時段是否和「別人」的上班時段重疊（回傳衝突者，否則 null）
function conflictWorker(empId, dateStr, start, end) {
  const s0 = toMin(start), e0 = toMin(end);
  for (const s of state.shifts) {
    if (s.work_date !== dateStr || s.status !== "work" || s.employee_id === empId) continue;
    if (!s.start_time || !s.end_time) continue;
    const a = toMin(s.start_time), b = toMin(s.end_time);
    if (s0 < b && a < e0) return { emp: state.employees.find((e) => e.id === s.employee_id), s };
  }
  return null;
}
// 某班別時段是否已被「排定」（approved 班表）；回傳排班者或 null
function covererOf(dateStr, start, end) {
  const s0 = toMin(start), e0 = toMin(end);
  for (const s of state.shifts) {
    if (s.work_date !== dateStr || s.status !== "work" || !s.start_time || !s.end_time) continue;
    const a = toMin(s.start_time), b = toMin(s.end_time);
    if (s0 < b && a < e0) return state.employees.find((e) => e.id === s.employee_id) || { name: "?" };
  }
  return null;
}
// 某班別時段是否已有「待核准的上班申請」（給其他 PT 看到已被搶）；回傳申請者或 null
function requesterOf(dateStr, start, end) {
  const s0 = toMin(start), e0 = toMin(end);
  for (const r of state.requests) {
    if (r.work_date !== dateStr || r.req_type !== "work" || r.state !== "pending" || !r.start_time || !r.end_time) continue;
    const a = toMin(r.start_time), b = toMin(r.end_time);
    if (s0 < b && a < e0) return { emp: state.employees.find((e) => e.id === r.employee_id), r };
  }
  return null;
}

function bhFor(dateStr) {
  const dow = new Date(dateStr + "T00:00:00").getDay();
  return state.hours.find((h) => h.weekday === dow);
}
function isClosedDate(dateStr) { const bh = bhFor(dateStr); return bh ? !bh.is_open : false; }

// 營業時間防呆：回傳錯誤訊息或 null
function validateWorkTime(dateStr, start, end) {
  const bh = bhFor(dateStr);
  if (!bh || !bh.is_open) return "這天是公休日，不可排班";
  if (toMin(end) <= toMin(start)) return "結束時間需晚於開始時間";
  const earliest = toMin(bh.open_time) - 60;
  const latest = toMin(bh.close_time) + 60;
  if (toMin(start) < earliest) return `這天 ${bh.open_time} 開店，最早只能排 ${minToStr(earliest)}（開店前 1 小時）`;
  if (toMin(end) > latest) return `這天 ${bh.close_time} 打烊，最晚只能排到 ${minToStr(latest)}（打烊後 1 小時）`;
  return null;
}

// ---------- 彈窗 ----------
function openModal(title, bodyEl, footEl, wide) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const modal = document.createElement("div");
  modal.className = "modal" + (wide ? " wide" : "");
  const head = document.createElement("div");
  head.className = "modal-head";
  head.innerHTML = `<h3></h3><button class="close">×</button>`;
  head.querySelector("h3").textContent = title;
  const body = document.createElement("div"); body.className = "modal-body"; body.appendChild(bodyEl);
  modal.append(head, body);
  if (footEl) { const f = document.createElement("div"); f.className = "modal-foot"; f.appendChild(footEl); modal.appendChild(f); }
  overlay.appendChild(modal);
  const close = () => overlay.remove();
  head.querySelector(".close").onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };
  $("#modal-root").appendChild(overlay);
  return { overlay, close };
}
function frag(html) { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; }
// 帶標籤的欄位（卡片式表單用）
function fieldWrap(label, inputEl, cls) {
  const l = document.createElement("label"); l.className = "fld" + (cls ? " " + cls : "");
  const s = document.createElement("span"); s.textContent = label;
  l.append(s, inputEl); return l;
}

// ============================================================
//  登入
// ============================================================
async function initLogin() {
  const sel = $("#login-name");
  const { data, error } = await sb.from("employees").select("name").eq("active", true).order("sort_order");
  if (error) { $("#login-error").textContent = "無法連線資料庫，請檢查 config.js"; return; }
  sel.innerHTML = data.map((e) => `<option>${e.name}</option>`).join("");
  $("#login-btn").onclick = doLogin;
  $("#login-pin").onkeydown = (e) => { if (e.key === "Enter") doLogin(); };
}
async function doLogin() {
  const name = $("#login-name").value;
  const pin = $("#login-pin").value.trim();
  const errEl = $("#login-error"); errEl.textContent = "";
  if (!/^\d{4}$/.test(pin)) { errEl.textContent = "請輸入 4 位數 PIN 碼"; return; }
  const { data, error } = await sb.rpc("verify_login", { p_name: name, p_pin: pin });
  if (error) { errEl.textContent = "登入失敗：" + error.message; return; }
  if (!data || data.length === 0) { errEl.textContent = "姓名或 PIN 碼錯誤"; return; }
  state.user = data[0];
  localStorage.setItem("parone_user", JSON.stringify(state.user));
  enterApp();
}
function logout() { localStorage.removeItem("parone_user"); location.reload(); }

// ============================================================
//  主畫面
// ============================================================
async function enterApp() {
  $("#login-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  $("#who").textContent = `${state.user.name}${state.user.is_admin ? "（管理者）" : ""}`;
  if (state.user.is_admin) {
    $("#admin-btn").classList.remove("hidden");
    $("#quick-btn").classList.remove("hidden");
  } else {
    $("#view-pick").classList.add("hidden");        // 員工不用選人，只看自己
  }
  const now = new Date();
  state.ym = { y: now.getFullYear(), m: now.getMonth() };
  state.viewEmp = state.user.is_admin ? "__all__" : state.user.id;

  $("#prev-month").onclick = () => shiftMonth(-1);
  $("#next-month").onclick = () => shiftMonth(1);
  $("#today-btn").onclick = () => { const d = new Date(); state.ym = { y: d.getFullYear(), m: d.getMonth() }; loadAndRender(); };
  $("#logout-btn").onclick = logout;
  $("#payroll-btn").onclick = openPayroll;
  $("#requests-btn").onclick = openRequests;
  $("#admin-btn").onclick = openAdmin;
  $("#quick-btn").onclick = toggleQuick;
  $("#view-emp").onchange = (e) => { state.viewEmp = e.target.value; renderCalendar(); };

  await loadStatic();
  await loadAndRender();
}
function shiftMonth(delta) {
  let { y, m } = state.ym; m += delta;
  if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
  state.ym = { y, m }; loadAndRender();
}
async function loadStatic() {
  const [emp, pre, bh, lt] = await Promise.all([
    sb.from("employees").select("*").eq("active", true),
    sb.from("preset_shifts").select("*").order("sort_order"),
    sb.from("business_hours").select("*").order("weekday"),
    sb.from("leave_types").select("*").order("sort_order"),
  ]);
  state.employees = sortEmployees(emp.data || []);
  state.presets = pre.data || [];
  state.hours = bh.data || [];
  // 假別：若尚未建表則用預設三種
  state.leaveTypes = (lt.data && lt.data.length) ? lt.data : [
    { name: "特休", color: "#5b95d1", needs_note: false, is_annual: true, is_monthly: false, is_comp: false, sort_order: 1 },
    { name: "指休", color: "#d9584f", needs_note: false, is_annual: false, is_monthly: true, is_comp: false, sort_order: 2 },
    { name: "特殊", color: "#a678d6", needs_note: true, is_annual: false, is_monthly: false, is_comp: false, sort_order: 3 },
    { name: "補休", color: "#e0a458", needs_note: false, is_annual: false, is_monthly: false, is_comp: true, sort_order: 4 },
  ];
  updateLegend();
  // 檢視下拉
  const sel = $("#view-emp");
  sel.innerHTML = `<option value="__all__">全部（整店）</option>` +
    state.employees.map((e) => `<option value="${e.id}">${e.name}</option>`).join("");
  sel.value = state.viewEmp;
}
function sortEmployees(list) {
  return list.slice().sort((a, b) => {
    const ca = CAT_ORDER.indexOf(a.category), cb = CAT_ORDER.indexOf(b.category);
    const x = ca === -1 ? 99 : ca, y = cb === -1 ? 99 : cb;
    if (x !== y) return x - y;
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order;
    return a.name.localeCompare(b.name);
  });
}
function renderLockBtn() {
  const btn = $("#lock-btn");
  if (!btn || !state.user.is_admin) return;
  btn.classList.remove("hidden");
  const locked = isLocked(periodOf(iso(state.ym.y, state.ym.m, 1)));
  btn.textContent = locked ? "🔒 班表已確認（點解除）" : "🔓 確認本月班表";
  btn.classList.toggle("btn-primary", locked);
  btn.onclick = async () => {
    const period = `${state.ym.y}-${pad(state.ym.m + 1)}`;
    const next = !locked;
    if (!confirm(next ? `確認 ${period} 班表？確認後員工在這個月只能「請假」，不能自行加班別。` : `解除 ${period} 班表確認？`)) return;
    const { error } = await sb.from("schedule_locks").upsert({ period, locked: next, locked_at: new Date().toISOString() }, { onConflict: "period" });
    if (error) { alert("失敗（可能尚未跑 sql_進階.sql）：" + error.message); return; }
    await loadAndRender();
  };
}
function updateLegend() {
  const el = document.querySelector(".legend");
  if (!el) return;
  const items = [{ label: "公休", color: "#b08968" }, { label: "上班", color: WORK_STATUS.color },
    ...(state.leaveTypes || []).map((t) => ({ label: t.name, color: t.color }))];
  el.innerHTML = items.map((i) =>
    `<span class="chip" style="background:${i.color};color:${textOn(i.color)}">${esc(i.label)}</span>`).join("");
}
async function loadAndRender() {
  const { y, m } = state.ym;
  const period = `${y}-${pad(m + 1)}`;
  $("#month-label").textContent = `${y} 年 ${m + 1} 月`;
  const first = iso(y, m, 1), last = iso(y, m, daysInMonth(y, m));
  const [sh, rq, dn, pr, lk] = await Promise.all([
    sb.from("shifts").select("*").gte("work_date", first).lte("work_date", last),
    sb.from("requests").select("*").eq("state", "pending"),
    sb.from("day_notes").select("*").gte("work_date", first).lte("work_date", last),
    sb.from("payrolls").select("*").eq("period", period),
    sb.from("schedule_locks").select("*").eq("period", period).maybeSingle(),
  ]);
  state.shifts = sh.data || [];
  state.requests = rq.data || [];
  state.dayNotes = {};
  (dn.data || []).forEach((r) => { state.dayNotes[r.work_date] = r.note; });
  state.payrolls = pr.data || [];
  state.locks[period] = !!(lk.data && lk.data.locked);
  renderLockBtn();
  renderBadge();
  renderCalendar();
  if (state.selectedDate && state.selectedDate.startsWith(iso(y, m, 1).slice(0, 7))) renderDayPanel(state.selectedDate);
  else { state.selectedDate = null; $("#day-panel").classList.add("hidden"); }
}
function renderBadge() {
  const badge = $("#req-badge");
  const count = state.user.is_admin
    ? state.requests.length
    : state.requests.filter((r) => r.employee_id === state.user.id).length;
  if (count > 0) { badge.textContent = count; badge.classList.remove("hidden"); }
  else badge.classList.add("hidden");

  // 薪資徽章
  const payBadge = $("#pay-badge");
  let payCount;
  if (state.user.is_admin) payCount = state.payrolls.filter((p) => !p.signed_at).length;       // 已發放未簽收
  else payCount = state.payrolls.filter((p) => p.employee_id === state.user.id && !p.signed_at).length;
  if (payCount > 0) { payBadge.textContent = payCount; payBadge.classList.remove("hidden"); }
  else payBadge.classList.add("hidden");
}
function shiftOf(empId, dateStr) {
  return state.shifts.find((s) => s.employee_id === empId && s.work_date === dateStr);
}

// ============================================================
//  月曆
// ============================================================
function renderCalendar() {
  const { y, m } = state.ym;
  const grid = $("#cal-grid");
  const nDays = daysInMonth(y, m);
  const firstDow = new Date(y, m, 1).getDay();
  const todayStr = (() => { const d = new Date(); return iso(d.getFullYear(), d.getMonth(), d.getDate()); })();
  const reqDates = new Set(
    state.requests
      .filter((r) => state.viewEmp === "__all__" || r.employee_id === state.viewEmp)
      .map((r) => r.work_date)
  );

  let html = "";
  for (let i = 0; i < firstDow; i++) html += `<div class="cal-cell blank"></div>`;
  for (let d = 1; d <= nDays; d++) {
    const date = iso(y, m, d);
    const closed = isClosedDate(date);
    const cls = ["cal-cell"];
    if (closed) cls.push("closed");
    if (date === todayStr) cls.push("today");
    let sub = "", numStyle = "";
    if (closed) {
      sub = `<div class="closed-tag">公休</div>`;
    } else if (state.viewEmp === "__all__") {
      const workers = workersOf(date);
      if (workers.length) {
        sub = `<div class="wlist">` + workers.map((w) =>
          `<div class="wline"><span class="wn">${w.emp.name}</span> ${compactTime(w.s.start_time)}-${compactTime(w.s.end_time)}</div>`).join("") + `</div>`;
      }
      const gap = uncoveredMinutes(date);
      if (gap > 0) { cls.push("gap"); sub += `<div class="gap-tag">⚠ 未排滿</div>`; }
    } else {
      const s = shiftOf(state.viewEmp, date);
      if (s) { const meta = statusMeta(s.status); numStyle = `background:${meta.color};color:${textOn(meta.color)}`; sub = `<div class="sub">${shiftText(s)}</div>`; }
    }
    if (date === state.selectedDate) cls.push("selected");
    const dot = reqDates.has(date) ? `<span class="req-dot"></span>` : "";
    const note = state.dayNotes[date];
    if (note) cls.push("has-note");
    const noteTag = note ? `<div class="note-tag" title="${esc(note)}">📌 ${esc(note)}</div>` : "";
    html += `<div class="${cls.join(" ")}" data-date="${date}">${dot}<div class="num" style="${numStyle}">${d}</div>${noteTag}${sub}</div>`;
  }
  grid.innerHTML = html;
  grid.querySelectorAll(".cal-cell[data-date]").forEach((c) => {
    c.onclick = () => (state.quickMode ? quickPaint(c.dataset.date) : selectDay(c.dataset.date));
  });
}

// ============================================================
//  ⚡ 快速排班：選好人＋時間，直接點日期就排入（再點一次取消）
// ============================================================
function toast(msg) {
  const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => t.remove(), 1500);
}
function toggleQuick() {
  state.quickMode = !state.quickMode;
  document.body.classList.toggle("quick-on", state.quickMode);
  const btn = $("#quick-btn");
  if (btn) { btn.classList.toggle("btn-primary", state.quickMode); btn.textContent = state.quickMode ? "✓ 完成快排" : "⚡ 快速排班"; }
  if (state.quickMode && state.selectedDate) { state.selectedDate = null; $("#day-panel").classList.add("hidden"); }
  renderQuickBar();
  renderCalendar();
  // 若員工清單是空的，背景補載一次（不擋 UI），載到再刷新工具列
  if (state.quickMode && !(state.employees && state.employees.length)) {
    loadStatic().then(() => { if (state.quickMode) renderQuickBar(); }).catch(() => {});
  }
}
function renderQuickBar() {
  let bar = $("#quick-bar");
  if (!state.quickMode) { if (bar) bar.remove(); return; }
  const cal = document.querySelector(".calendar");
  if (!bar) { bar = document.createElement("div"); bar.id = "quick-bar"; cal.insertBefore(bar, cal.firstChild); }
  if (!state.quickEmp) {
    const def = state.employees.find((e) => e.id === state.user.id) || state.employees.find((e) => e.category === "正職") || state.employees[0];
    state.quickEmp = def ? def.id : null;
  }
  if (!state._qInit) { const bh = state.hours.find((h) => h.is_open); state.quickStart = bh ? bh.open_time : "14:00"; state.quickEnd = bh ? bh.close_time : "23:00"; state._qInit = true; }
  const opts = timeOptions();
  bar.innerHTML =
    `<div class="qbar-row">
       <span class="qbar-label">⚡ 點日期就排</span>
       <select id="q-emp" class="inp"></select>
       <select id="q-start" class="inp"></select><span>—</span><select id="q-end" class="inp"></select>
       <button id="q-done" class="btn btn-primary btn-sm">完成</button>
     </div>
     <div class="qbar-hint">選好人和時間，直接點月曆日期就排入；同一天再點一次＝取消。公休、超出營業或和別人重疊會自動略過。</div>`;
  const empSel = bar.querySelector("#q-emp");
  if (!state.employees.length) {
    empSel.innerHTML = `<option value="">（沒有員工，請重新整理或到「管理」新增）</option>`;
  } else {
    empSel.innerHTML = state.employees.map((e) => `<option value="${e.id}">${esc(e.name)}（${e.category}）</option>`).join("");
    empSel.value = state.quickEmp || "";
  }
  empSel.onchange = () => { state.quickEmp = empSel.value; };
  const ss = bar.querySelector("#q-start"), es = bar.querySelector("#q-end");
  ss.innerHTML = es.innerHTML = opts.map((t) => `<option>${t}</option>`).join("");
  ss.value = state.quickStart; es.value = state.quickEnd;
  ss.onchange = () => { state.quickStart = ss.value; };
  es.onchange = () => { state.quickEnd = es.value; };
  bar.querySelector("#q-done").onclick = toggleQuick;
}
async function quickPaint(dateStr) {
  const emp = state.employees.find((e) => e.id === state.quickEmp);
  if (!emp) { toast("請先選人員"); return; }
  if (isClosedDate(dateStr)) { toast("公休日，略過"); return; }
  const start = state.quickStart, end = state.quickEnd;
  const existing = shiftOf(emp.id, dateStr);
  // 同一天同一設定再點一次 → 取消
  if (existing && existing.status === "work" && existing.start_time === start && existing.end_time === end) {
    await sb.from("shifts").delete().eq("id", existing.id);
    state.shifts = state.shifts.filter((s) => s.id !== existing.id);
    renderCalendar(); return;
  }
  const err = validateWorkTime(dateStr, start, end);
  if (err) { toast("超出營業時間，略過"); return; }
  const cf = conflictWorker(emp.id, dateStr, start, end);
  if (cf) { toast(`已有 ${cf.emp ? cf.emp.name : "他人"}（${cf.s.start_time}-${cf.s.end_time}）`); return; }
  const { data, error } = await sb.from("shifts")
    .upsert({ employee_id: emp.id, work_date: dateStr, status: "work", start_time: start, end_time: end, note: null }, { onConflict: "employee_id,work_date" })
    .select().maybeSingle();
  if (error) { toast("排班失敗：" + error.message); return; }
  state.shifts = state.shifts.filter((s) => !(s.employee_id === emp.id && s.work_date === dateStr));
  if (data) state.shifts.push(data);
  renderCalendar();
}

function selectDay(dateStr) {
  state.selectedDate = dateStr;
  $("#cal-grid").querySelectorAll(".cal-cell").forEach((c) => c.classList.toggle("selected", c.dataset.date === dateStr));
  renderDayPanel(dateStr);
  $("#day-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// ============================================================
//  當天詳情（顯示在日曆下方）
// ============================================================
function renderDayPanel(dateStr) {
  const panel = $("#day-panel");
  const dow = new Date(dateStr + "T00:00:00").getDay();
  const [yy, mm, dd] = dateStr.split("-").map(Number);
  const closed = isClosedDate(dateStr);
  const isAdmin = state.user.is_admin;

  panel.innerHTML = "";
  const head = document.createElement("div"); head.className = "dp-head";
  head.innerHTML = `<span class="dp-title">${mm}月${dd}日（${DOW[dow]}）</span>` +
    (closed ? `<span class="dp-closed">公休</span>` : "");
  panel.appendChild(head);

  // 當日特殊事項（全員可見；管理者可編輯）
  const note = state.dayNotes[dateStr];
  const noteBox = document.createElement("div"); noteBox.className = "dp-note";
  if (note) noteBox.innerHTML = `<span class="dp-note-txt">📌 ${esc(note)}</span>`;
  else noteBox.innerHTML = `<span class="dp-note-empty">本日無特殊事項</span>`;
  if (isAdmin) {
    const editNote = document.createElement("button"); editNote.className = "r-act";
    editNote.textContent = note ? "編輯" : "＋ 加註";
    editNote.onclick = () => editDayNote(dateStr);
    noteBox.appendChild(editNote);
  }
  if (note || isAdmin) panel.appendChild(noteBox);

  // 還沒人排的時段（單人顧店：正職排完，剩下給 PT 選）——只在有設定營業時間的日子顯示
  const _bh = bhFor(dateStr);
  if (_bh && _bh.is_open) {
    const gaps = openGaps(dateStr);
    const gapBox = document.createElement("div"); gapBox.className = "dp-gaps";
    if (gaps.length) gapBox.innerHTML = `🟢 還沒人排的時段：` + gaps.map(([a, b]) => `<b>${minToStr(a)}-${minToStr(b)}</b>`).join("、");
    else gapBox.innerHTML = `<span class="dp-gaps-full">✓ 營業時間已排滿</span>`;
    panel.appendChild(gapBox);
  }

  // PT 選班別：正職排完後，PT 直接點還空著的班別送出申請
  if (!isAdmin && !closed && _bh && _bh.is_open && state.presets.length) {
    const myShift = shiftOf(state.user.id, dateStr);
    const box = document.createElement("div"); box.className = "dp-shifts";
    box.appendChild(frag(`<div class="dp-shifts-h">可選班別</div>`));
    state.presets.forEach((p) => {
      const info = `${esc(p.label)}　${p.start_time}-${p.end_time}`;
      const coverer = covererOf(dateStr, p.start_time, p.end_time);
      const requester = coverer ? null : requesterOf(dateStr, p.start_time, p.end_time);
      const row = document.createElement("div"); row.className = "shift-pick";
      if (coverer) {
        row.innerHTML = `<span class="sp-info">${info}</span><span class="sp-taken">已排：${esc(coverer.name)}</span>`;
      } else if (requester) {
        const who = requester.emp ? requester.emp.name : "他人";
        const mine = requester.r.employee_id === state.user.id;
        row.innerHTML = `<span class="sp-info">${info}</span><span class="sp-pending">${mine ? "你已申請，待核准" : "已被申請：" + esc(who)}</span>`;
      } else if (myShift) {
        row.innerHTML = `<span class="sp-info">${info}</span><span class="sp-open">空缺</span>`;
      } else {
        row.innerHTML = `<span class="sp-info">${info}</span>`;
        const btn = frag(`<button class="btn btn-primary btn-sm">選這班</button>`);
        btn.onclick = () => pickShift(p, dateStr);
        row.appendChild(btn);
      }
      box.appendChild(row);
    });
    if (myShift) box.appendChild(frag(`<div class="dp-shifts-note">你當天已排：${shiftText(myShift)}（要換班請按下方自己那列的「改申請」）</div>`));
    panel.appendChild(box);
  }

  // 剪貼簿提示
  if (state.clipboard) {
    const c = state.clipboard;
    const info = c.status === "work" ? `${c.start_time}-${c.end_time}` : statusMeta(c.status).label;
    const clip = frag(`<div class="dp-clip">📋 已複製：<b>${info}</b>　<span class="clip-clear">清除</span></div>`);
    clip.querySelector(".clip-clear").onclick = () => { state.clipboard = null; renderDayPanel(dateStr); };
    panel.appendChild(clip);
  }

  // 要列出的名單：管理者＝全員；員工＝自己＋當天有排班/打卡的所有人（都看得到誰上班、時段）
  const empById = (id) => state.employees.find((e) => e.id === id);
  let rosterEmps;
  if (isAdmin) {
    rosterEmps = state.employees.slice();
  } else {
    const ids = new Set([state.user.id]);
    state.shifts.filter((s) => s.work_date === dateStr).forEach((s) => ids.add(s.employee_id));
    rosterEmps = [...ids].map((id) => empById(id) || { id, name: id === state.user.id ? state.user.name : "員工", category: "" });
    rosterEmps.sort((a, b) => {
      const ia = state.employees.findIndex((e) => e.id === a.id);
      const ib = state.employees.findIndex((e) => e.id === b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
  }

  const ul = document.createElement("ul"); ul.className = "roster";
  for (const emp of rosterEmps) {
    const s = shiftOf(emp.id, dateStr);
    const canEdit = !closed && (isAdmin || emp.id === state.user.id);
    const li = document.createElement("li");
    const meta = s ? statusMeta(s.status) : null;
    const tagStyle = meta ? `background:${hexA(meta.color, 0.22)};color:${meta.color}` : "";
    li.innerHTML = `<span class="r-name">${emp.name}</span>` +
      (s ? `<span class="r-tag" style="${tagStyle}">${shiftText(s)}</span>` : `<span class="r-empty">未排</span>`);
    const actions = document.createElement("span"); actions.className = "r-actions";
    if (s && isAdmin) {   // 複製只給管理者
      const copy = document.createElement("button"); copy.className = "r-act"; copy.textContent = "複製";
      copy.onclick = () => { state.clipboard = { status: s.status, start_time: s.start_time, end_time: s.end_time, note: s.note }; renderDayPanel(dateStr); };
      actions.appendChild(copy);
    }
    if (canEdit) {
      const locked = isLocked(periodOf(dateStr));
      if (s) {
        const edit = document.createElement("button"); edit.className = "r-act";
        edit.textContent = isAdmin ? "編輯" : (locked ? "請假" : "改申請");
        edit.onclick = () => openShiftEditor(emp.id, dateStr);
        actions.appendChild(edit);
        if (isAdmin) {
          const del = document.createElement("button"); del.className = "r-act r-del"; del.textContent = "刪除";
          del.onclick = async () => {
            if (!confirm(`清除 ${emp.name} 在 ${mm}月${dd}日 的班？`)) return;
            await sb.from("shifts").delete().eq("id", s.id);
            await loadAndRender();
          };
          actions.appendChild(del);
        }
      } else {
        if (isAdmin && state.clipboard) {
          const paste = document.createElement("button"); paste.className = "r-act r-paste"; paste.textContent = "貼上";
          paste.onclick = () => pasteShift(emp.id, dateStr);
          actions.appendChild(paste);
        }
        const add = document.createElement("button"); add.className = "r-act";
        add.textContent = isAdmin ? "＋ 排班" : (locked ? "請假" : "＋ 申請");
        add.onclick = () => openShiftEditor(emp.id, dateStr);
        actions.appendChild(add);
      }
    }
    li.appendChild(actions);
    ul.appendChild(li);
  }
  if (!ul.children.length) ul.appendChild(frag(`<li class="r-empty">${closed ? "本日公休" : "尚無班表"}</li>`));
  panel.appendChild(ul);
  panel.classList.remove("hidden");
}

// 把剪貼簿的班別貼到某人（管理者直接寫入；員工送申請）
async function pasteShift(empId, dateStr) {
  const c = state.clipboard;
  if (!c) return;
  const isAdmin = state.user.is_admin;
  if (!isAdmin && !allowedStatusKeys(empId, dateStr).includes(c.status)) {
    alert(`這個身分不能登記「${statusMeta(c.status).label}」`); return;
  }
  if (c.status === "work") {
    const err = validateWorkTime(dateStr, c.start_time, c.end_time);
    if (err) { alert("⚠️ " + err); return; }
  }
  const emp = state.employees.find((e) => e.id === empId);
  if (emp && statusMeta(c.status).is_annual) {
    const q = await annualLeaveUsage(emp, c.status);
    if (q.quota > 0 && q.used + 1 > q.quota && !confirm(`${emp.name} 的「${c.status}」本年度已用 ${q.used}/${q.quota} 天，這次會超過額度。仍要排？`)) return;
  }
  if (emp && statusMeta(c.status).is_monthly && emp.category === "正職" && Number(emp.monthly_off_days) > 0) {
    const existing = (await monthlyOffDates(emp, periodOf(dateStr))).filter((d) => d !== dateStr).length;
    if (existing + 1 > Number(emp.monthly_off_days) && !confirm(`${emp.name} ${periodOf(dateStr)} 指休已排 ${existing}/${emp.monthly_off_days} 天，這次會超過。仍要排？`)) return;
  }
  if (emp && statusMeta(c.status).is_comp) {
    const cbal = await compBalance(emp);
    const usedOther = cbal.usedDates.filter((d) => d !== dateStr).length;
    if (1 > cbal.earned - usedOther && !confirm(`${emp.name} 的補休餘額 ${cbal.earned - usedOther} 天，這次會超過。仍要排？`)) return;
  }
  if (isAdmin) {
    await sb.from("shifts").upsert(
      { employee_id: empId, work_date: dateStr, status: c.status, start_time: c.start_time, end_time: c.end_time, note: c.note },
      { onConflict: "employee_id,work_date" });
  } else {
    await sb.from("requests").insert({
      employee_id: empId, work_date: dateStr, req_type: c.status,
      start_time: c.status === "work" ? c.start_time : null,
      end_time: c.status === "work" ? c.end_time : null, note: c.note,
    });
  }
  await loadAndRender();
}

// PT 點選空班別 → 送出上班申請（待管理者核准）
async function pickShift(p, dateStr) {
  const err = validateWorkTime(dateStr, p.start_time, p.end_time);
  if (err) { alert("⚠️ " + err); return; }
  // 送出前再確認一次沒被排走 / 沒被別人搶先申請
  const cf = covererOf(dateStr, p.start_time, p.end_time);
  if (cf) { alert(`這個班別已經被 ${cf.name} 排走了。`); await loadAndRender(); return; }
  const rq = requesterOf(dateStr, p.start_time, p.end_time);
  if (rq && rq.r.employee_id !== state.user.id) { alert(`這個班別已經有${rq.emp ? rq.emp.name : "人"}申請了，你可以選別班。`); await loadAndRender(); return; }
  const [, mm, dd] = dateStr.split("-").map(Number);
  if (!confirm(`送出「${p.label} ${p.start_time}-${p.end_time}」的上班申請（${mm}月${dd}日）？`)) return;
  const { error } = await sb.from("requests").insert({
    employee_id: state.user.id, work_date: dateStr, req_type: "work",
    start_time: p.start_time, end_time: p.end_time,
  });
  if (error) { alert("送出失敗：" + error.message); return; }
  await loadAndRender();
  alert("已送出申請，待管理者核准 🎀");
}

// 編輯當日特殊事項（管理者）
function editDayNote(dateStr) {
  const [, mm, dd] = dateStr.split("-").map(Number);
  const cur = state.dayNotes[dateStr] || "";
  const body = document.createElement("div");
  body.appendChild(frag(`<p class="hint">例如：包場活動、私人聚會、設備維修、公司活動…（總覽與員工頁都看得到）</p>`));
  const ta = document.createElement("textarea");
  ta.className = "inp"; ta.style.cssText = "width:100%;min-height:84px;resize:vertical";
  ta.value = cur; ta.placeholder = "輸入當日特殊事項";
  body.appendChild(ta);

  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;gap:10px;width:100%;justify-content:flex-end";
  if (cur) {
    const del = document.createElement("button"); del.className = "btn btn-danger"; del.textContent = "刪除"; del.style.marginRight = "auto";
    del.onclick = async () => { await sb.from("day_notes").delete().eq("work_date", dateStr); m.close(); await loadAndRender(); };
    foot.appendChild(del);
  }
  const save = document.createElement("button"); save.className = "btn btn-primary"; save.textContent = "儲存";
  foot.appendChild(save);
  const m = openModal(`${mm}月${dd}日 · 特殊事項`, body, foot);
  save.onclick = async () => {
    const v = ta.value.trim();
    if (!v) await sb.from("day_notes").delete().eq("work_date", dateStr);
    else await sb.from("day_notes").upsert({ work_date: dateStr, note: v, updated_at: new Date().toISOString() }, { onConflict: "work_date" });
    m.close(); await loadAndRender();
  };
}

// ============================================================
//  排班／申請編輯器
// ============================================================
function openShiftEditor(empId, dateStr) {
  const emp = state.employees.find((e) => e.id === empId);
  const existing = shiftOf(empId, dateStr);
  const isAdmin = state.user.is_admin;
  const opts = timeOptions();
  const bh = bhFor(dateStr);

  const body = document.createElement("div");

  // 常駐時段
  body.appendChild(frag(`<p class="subhead">常駐時段（點選套用）</p>`));
  const plist = document.createElement("div"); plist.className = "preset-list";
  body.appendChild(plist);

  // 狀態（依身分/類別/班表鎖限制可選項）
  const allowed = allowedStatusKeys(empId, dateStr);
  body.appendChild(frag(`<p class="subhead">狀態</p>`));
  const choiceRow = document.createElement("div"); choiceRow.className = "choice-row";
  let curStatus = existing && allowed.includes(existing.status) ? existing.status : allowed[0];
  const btns = {};
  allowed.forEach((k) => {
    const meta = statusMeta(k);
    const b = document.createElement("button");
    b.className = "choice";
    b.innerHTML = `<span class="dot" style="background:${meta.color}"></span>${meta.label}`;
    b.onclick = () => setStatus(k);
    choiceRow.appendChild(b); btns[k] = b;
  });
  body.appendChild(choiceRow);
  if (!isAdmin && emp.category === "PT") body.appendChild(frag(`<p class="hint">PT 只能登記休假（不含特休）</p>`));
  if (!isAdmin && isLocked(periodOf(dateStr))) body.appendChild(frag(`<p class="hint">本月班表已確認，只能申請請假</p>`));
  if (emp.category === "正職") {
    const info = frag(`<p class="hint" style="color:var(--amber)">載入額度中…</p>`);
    body.appendChild(info);
    (async () => {
      const parts = [];
      if (Number(emp.monthly_off_days) > 0 && monthlyKeys().length) {
        const used = (await monthlyOffDates(emp, periodOf(dateStr))).length;
        parts.push(`本月指休 ${used}/${emp.monthly_off_days} 天`);
      }
      if (compKeys().length) { const cb = await compBalance(emp); parts.push(`補休餘額 ${cb.balance} 天`); }
      info.textContent = parts.length ? "📊 " + parts.join("　·　") : "";
    })();
  }

  // 時段
  const timeRow = document.createElement("div"); timeRow.className = "time-row";
  const startSel = document.createElement("select"); startSel.className = "inp";
  const endSel = document.createElement("select"); endSel.className = "inp";
  startSel.innerHTML = endSel.innerHTML = opts.map((t) => `<option>${t}</option>`).join("");
  timeRow.append(startSel, frag(`<span>—</span>`), endSel);
  body.appendChild(timeRow);
  startSel.value = existing?.start_time || (bh ? bh.open_time : "14:00");
  endSel.value = existing?.end_time || (bh ? bh.close_time : "23:00");
  if (bh && bh.is_open) body.appendChild(frag(`<p class="hint">這天營業 ${bh.open_time}–${bh.close_time}，可排 ${minToStr(toMin(bh.open_time) - 60)}–${minToStr(toMin(bh.close_time) + 60)}</p>`));

  // 還沒人排的時段（一鍵帶入）——單人顧店：直接選剩餘空檔
  const gaps = openGaps(dateStr).filter(([a, b]) => b - a >= 15);
  if (gaps.length) {
    const gapWrap = document.createElement("div");
    gapWrap.appendChild(frag(`<p class="subhead">還沒人排的時段（點一下帶入）</p>`));
    const gapRow = document.createElement("div"); gapRow.className = "choice-row";
    gaps.forEach(([a, b]) => {
      const gb = document.createElement("button"); gb.className = "choice";
      gb.innerHTML = `<span class="dot" style="background:var(--st-work)"></span>${minToStr(a)}-${minToStr(b)}`;
      gb.onclick = () => { setStatus("work"); startSel.value = minToStr(a); endSel.value = minToStr(b); };
      gapRow.appendChild(gb);
    });
    gapWrap.appendChild(gapRow); body.appendChild(gapWrap);
  }

  // 特殊備註
  const noteWrap = document.createElement("div");
  noteWrap.innerHTML = `<p class="subhead">備註（特殊狀態）</p>`;
  const noteInp = document.createElement("input"); noteInp.className = "inp"; noteInp.style.width = "100%";
  noteInp.placeholder = "例如：長期出國、支援他店…"; noteInp.value = existing?.note || "";
  noteWrap.appendChild(noteInp);
  const reasonRow = document.createElement("div"); reasonRow.className = "choice-row"; reasonRow.style.marginTop = "8px";
  SPECIAL_REASONS.forEach((r) => {
    const b = document.createElement("button"); b.className = "choice"; b.style.fontSize = "12px"; b.style.padding = "6px 9px";
    b.textContent = r; b.onclick = () => { noteInp.value = r; };
    reasonRow.appendChild(b);
  });
  noteWrap.appendChild(reasonRow);
  body.appendChild(noteWrap);

  // 設為常駐（管理者）
  let presetChk = null, presetName = null;
  if (isAdmin) {
    const wrap = document.createElement("div");
    const cr = document.createElement("label"); cr.className = "check-row";
    cr.innerHTML = `<input type="checkbox"/> 把這個時段設為常駐選項`;
    presetChk = cr.querySelector("input");
    presetName = document.createElement("input"); presetName.className = "inp"; presetName.placeholder = "常駐名稱（例：早班）"; presetName.style.width = "100%"; presetName.style.marginTop = "6px"; presetName.style.display = "none";
    presetChk.onchange = () => { presetName.style.display = presetChk.checked ? "block" : "none"; };
    wrap.append(cr, presetName); body.appendChild(wrap);
  }

  function setStatus(k) {
    curStatus = k;
    Object.entries(btns).forEach(([kk, bb]) => bb.classList.toggle("selected", kk === k));
    timeRow.style.display = k === "work" ? "flex" : "none";
    noteWrap.style.display = statusMeta(k).needs_note ? "block" : "none";
    if (presetChk) presetChk.parentElement.parentElement.style.display = k === "work" ? "block" : "none";
  }

  function renderPresets() {
    plist.innerHTML = "";
    if (!state.presets.length) { plist.appendChild(frag(`<p class="hint">尚無常駐時段</p>`)); return; }
    state.presets.forEach((p) => {
      const item = document.createElement("div"); item.className = "preset-item";
      const b = document.createElement("button"); b.className = "choice"; b.style.flex = "1"; b.style.justifyContent = "flex-start";
      b.innerHTML = `<span class="dot" style="background:var(--st-work)"></span>${p.label}　<span style="color:var(--text-mute);font-weight:400">${p.start_time}-${p.end_time}</span>`;
      b.onclick = () => { setStatus("work"); startSel.value = p.start_time; endSel.value = p.end_time; markPreset(p.id); };
      item.appendChild(b);
      if (isAdmin) {
        const del = document.createElement("button"); del.className = "p-del"; del.textContent = "🗑"; del.title = "刪除";
        del.onclick = async () => { if (!confirm(`刪除常駐時段「${p.label}」？`)) return; await sb.from("preset_shifts").delete().eq("id", p.id); await loadStatic(); renderPresets(); };
        item.appendChild(del);
      }
      plist.appendChild(item);
    });
  }
  function markPreset(id) {
    plist.querySelectorAll(".choice").forEach((c) => c.classList.remove("selected"));
    const items = [...plist.querySelectorAll(".preset-item")];
    const idx = state.presets.findIndex((p) => p.id === id);
    if (idx >= 0 && items[idx]) items[idx].querySelector(".choice").classList.add("selected");
  }
  renderPresets();
  setStatus(curStatus);

  // ---- 套用到多天（直接在排班當下設定，免另開批次） ----
  body.appendChild(frag(`<div class="divider"></div>`));
  const multiChkLabel = frag(`<label class="check-row"><input type="checkbox"/> 套用到多天（同一設定一次排）</label>`);
  const multiChk = multiChkLabel.querySelector("input");
  body.appendChild(multiChkLabel);
  const multiOpts = document.createElement("div"); multiOpts.style.display = "none";
  const endWrap = frag(`<label class="field"><span>從這天排到（結束日期）</span></label>`);
  const endInp = frag(`<input type="date" class="inp" style="width:100%">`);
  const [_ey, _em] = dateStr.split("-").map(Number);
  endInp.value = iso(_ey, _em - 1, daysInMonth(_ey, _em - 1)); // 預設：當月最後一天
  endInp.min = dateStr;
  endWrap.appendChild(endInp); multiOpts.appendChild(endWrap);
  multiOpts.appendChild(frag(`<p class="hint">只排這些星期：連續多天就全選；每週固定某天就只勾那天（公休日自動略過）</p>`));
  const wpick = document.createElement("div"); wpick.className = "week-picker";
  const wchecks = [];
  for (let i = 0; i < 7; i++) {
    const l = document.createElement("label");
    l.innerHTML = `<input type="checkbox" checked/> ${DOW[i]}`;
    wpick.appendChild(l); wchecks.push(l.querySelector("input"));
  }
  multiOpts.appendChild(wpick);
  body.appendChild(multiOpts);
  multiChk.onchange = () => { multiOpts.style.display = multiChk.checked ? "block" : "none"; };

  if (!isAdmin) body.appendChild(frag(`<p class="hint">你送出的是「申請」，需管理者核准後才會排入班表。</p>`));

  // footer
  const foot = document.createElement("div");
  foot.style.cssText = "display:flex;gap:10px;width:100%;justify-content:flex-end";
  if (existing && isAdmin) {
    const del = document.createElement("button"); del.className = "btn btn-danger"; del.textContent = "清除這格"; del.style.marginRight = "auto";
    del.onclick = async () => { await sb.from("shifts").delete().eq("id", existing.id); m.close(); loadAndRender(); };
    foot.appendChild(del);
  }
  const save = document.createElement("button"); save.className = "btn btn-primary"; save.textContent = isAdmin ? "儲存" : "送出申請";
  foot.appendChild(save);

  const m = openModal(`${emp.name} · ${dateStr}`, body, foot);

  save.onclick = async () => {
    const needsNote = statusMeta(curStatus).needs_note;
    const payload = {
      status: curStatus,
      start_time: curStatus === "work" ? startSel.value : null,
      end_time: curStatus === "work" ? endSel.value : null,
      note: needsNote ? noteInp.value.trim() : null,
    };
    if (needsNote && !payload.note) { alert(`「${statusMeta(curStatus).label}」請填寫備註`); return; }

    // 目標日期：單天 or 多天
    let dates = [dateStr];
    if (multiChk.checked) {
      const start = new Date(dateStr + "T00:00:00"), end = new Date(endInp.value + "T00:00:00");
      if (isNaN(end) || end < start) { alert("結束日期需在開始日期之後"); return; }
      const wd = wchecks.map((c, i) => (c.checked ? i : -1)).filter((i) => i >= 0);
      if (!wd.length) { alert("請至少勾一個星期"); return; }
      dates = [];
      let cur = new Date(start);
      while (cur <= end) {
        const ds = iso(cur.getFullYear(), cur.getMonth(), cur.getDate());
        if (wd.includes(cur.getDay()) && !isClosedDate(ds)) dates.push(ds);
        cur.setDate(cur.getDate() + 1);
      }
    }

    // 逐日驗證營業時間 + 單人顧店防重疊（上班才需要）
    let skipped = 0; const valid = [];
    for (const ds of dates) {
      if (curStatus === "work") {
        const err = validateWorkTime(ds, payload.start_time, payload.end_time);
        if (err) { if (dates.length === 1) { alert("⚠️ " + err); return; } skipped++; continue; }
        const cf = conflictWorker(empId, ds, payload.start_time, payload.end_time);
        if (cf) {
          const who = cf.emp ? cf.emp.name : "他人";
          const msg = `${ds} 這個時段已經有 ${who}（${cf.s.start_time}-${cf.s.end_time}），同一時間只能一個人。`;
          if (dates.length > 1) { skipped++; continue; }        // 多天：略過衝突日
          if (!isAdmin) { alert("⚠️ " + msg + "\n請改選還沒人排的時段。"); return; } // PT：擋
          if (!confirm("⚠️ " + msg + "\n（管理者）仍要排入嗎？")) return;              // 管理者：可強制
        }
      }
      valid.push(ds);
    }
    if (!valid.length) { alert("沒有可套用的日期（可能都超出營業時間或公休）"); return; }

    // 特休額度檢查
    if (statusMeta(curStatus).is_annual) {
      const q = await annualLeaveUsage(emp, curStatus);
      if (q.quota > 0 && q.used + valid.length > q.quota) {
        const msg = `${emp.name} 的「${curStatus}」本年度額度 ${q.quota} 天，已用 ${q.used} 天，這次 ${valid.length} 天會超過。`;
        if (!isAdmin) { alert("⚠️ " + msg + "\n請洽管理者。"); return; }
        if (!confirm("⚠️ " + msg + "\n（管理者）仍要排入嗎？")) return;
      }
    }

    // 每月指休上限（僅正職、且有設上限）
    if (statusMeta(curStatus).is_monthly && emp.category === "正職" && Number(emp.monthly_off_days) > 0) {
      const validSet = new Set(valid);
      const byMonth = {};
      valid.forEach((ds) => { const p = periodOf(ds); (byMonth[p] = byMonth[p] || 0), byMonth[p]++; });
      for (const p of Object.keys(byMonth)) {
        const existing = (await monthlyOffDates(emp, p)).filter((d) => !validSet.has(d)).length;
        if (existing + byMonth[p] > Number(emp.monthly_off_days)) {
          const msg = `${emp.name} ${p} 的指休上限 ${emp.monthly_off_days} 天，已排 ${existing} 天，這次再排 ${byMonth[p]} 天會超過。`;
          if (!isAdmin) { alert("⚠️ " + msg + "\n請洽管理者。"); return; }
          if (!confirm("⚠️ " + msg + "\n（管理者）仍要排入嗎？")) return;
        }
      }
    }

    // 加班補休餘額檢查
    if (statusMeta(curStatus).is_comp) {
      const validSet = new Set(valid);
      const cb = await compBalance(emp);
      const usedOther = cb.usedDates.filter((d) => !validSet.has(d)).length;
      const remain = cb.earned - usedOther;
      if (valid.length > remain) {
        const msg = `${emp.name} 的補休餘額 ${remain} 天（加班取得 ${cb.earned}、已用 ${usedOther}），這次休 ${valid.length} 天會超過。`;
        if (!isAdmin) { alert("⚠️ " + msg + "\n請洽管理者確認加班補休。"); return; }
        if (!confirm("⚠️ " + msg + "\n（管理者）仍要排入嗎？")) return;
      }
    }

    if (dates.length > 1 && !confirm(`將${isAdmin ? "排入" : "送出申請"} ${valid.length} 天${skipped ? `（${skipped} 天超出營業時間略過）` : ""}，確定？`)) return;

    if (isAdmin) {
      const rows = valid.map((ds) => ({ employee_id: empId, work_date: ds, ...payload }));
      await sb.from("shifts").upsert(rows, { onConflict: "employee_id,work_date" });
      if (presetChk && presetChk.checked && curStatus === "work") {
        const nm = (presetName.value.trim()) || `${payload.start_time}-${payload.end_time}`;
        await addPreset(nm, payload.start_time, payload.end_time);
      }
    } else {
      const reqRows = valid.map((ds) => ({ employee_id: empId, work_date: ds, req_type: curStatus, start_time: payload.start_time, end_time: payload.end_time, note: payload.note }));
      await sb.from("requests").insert(reqRows);
    }
    m.close(); await loadStatic(); loadAndRender();
  };
}

async function addPreset(label, start, end) {
  if (state.presets.some((p) => p.start_time === start && p.end_time === end && p.label === label)) return;
  const sort = state.presets.reduce((mx, p) => Math.max(mx, p.sort_order), 0) + 1;
  await sb.from("preset_shifts").insert({ label, start_time: start, end_time: end, sort_order: sort });
}

// ============================================================
//  申請流程（含一鍵核准）
// ============================================================
async function openRequests() {
  let list;
  if (state.user.is_admin) list = state.requests.slice();
  else {
    const { data } = await sb.from("requests").select("*").eq("employee_id", state.user.id).order("created_at", { ascending: false }).limit(30);
    list = data || [];
  }
  const empName = (id) => (state.employees.find((e) => e.id === id) || {}).name || "?";
  const descOf = (r) => r.req_type === "work" ? `想上班 ${r.start_time}-${r.end_time}`
    : (statusMeta(r.req_type).needs_note && r.note) ? `${r.req_type}：${r.note}` : (statusMeta(r.req_type).label || r.req_type);

  const body = document.createElement("div");

  async function approve(r, silent) {
    // 單人顧店：核准前確認時段沒和別人重疊
    if (r.req_type === "work") {
      const cf = conflictWorker(r.employee_id, r.work_date, r.start_time, r.end_time);
      if (cf) {
        const who = cf.emp ? cf.emp.name : "他人";
        if (silent) return false;
        if (!confirm(`${r.work_date} ${r.start_time}-${r.end_time} 與 ${who}（${cf.s.start_time}-${cf.s.end_time}）重疊，同一時間只能一人。仍要核准嗎？`)) return false;
      }
    }
    await sb.from("shifts").upsert({
      employee_id: r.employee_id, work_date: r.work_date, status: r.req_type,
      start_time: r.req_type === "work" ? r.start_time : null,
      end_time: r.req_type === "work" ? r.end_time : null,
      note: statusMeta(r.req_type).needs_note ? r.note : null,
    }, { onConflict: "employee_id,work_date" });
    await sb.from("requests").update({ state: "approved", reviewed_at: new Date().toISOString() }).eq("id", r.id);
    return true;
  }

  const pending = list.filter((r) => r.state === "pending");
  if (state.user.is_admin && pending.length > 1) {
    const bar = document.createElement("div"); bar.style.marginBottom = "12px";
    const all = document.createElement("button"); all.className = "btn btn-primary btn-sm"; all.textContent = `✓ 一鍵核准全部（${pending.length}）`;
    all.onclick = async () => {
      if (!confirm(`一次核准並排入全部 ${pending.length} 筆申請？`)) return;
      let done = 0, skip = 0;
      for (const r of pending) { (await approve(r, true)) ? done++ : skip++; }
      m.close(); await loadAndRender();
      if (skip) alert(`已核准 ${done} 筆；${skip} 筆因時段和別人重疊未核准，請個別處理。`);
      openRequests();
    };
    bar.appendChild(all); body.appendChild(bar);
  }

  if (list.length === 0) body.appendChild(frag(`<p class="empty">目前沒有申請</p>`));
  list.forEach((r) => {
    const stLabel = { pending: "待審核", approved: "已核准", rejected: "已駁回" }[r.state] || r.state;
    const item = document.createElement("div"); item.className = "req-item";
    item.innerHTML = `<div class="req-meta"><b>${empName(r.employee_id)}</b> · ${r.work_date} · ${descOf(r)} · <span style="color:var(--amber)">${stLabel}</span></div>`;
    if (state.user.is_admin && r.state === "pending") {
      const actions = document.createElement("div"); actions.className = "req-actions";
      const ok = document.createElement("button"); ok.className = "btn btn-primary btn-sm"; ok.textContent = "核准並排入";
      const no = document.createElement("button"); no.className = "btn btn-danger btn-sm"; no.textContent = "駁回";
      ok.onclick = async () => { await approve(r); m.close(); await loadAndRender(); openRequests(); };
      no.onclick = async () => { await sb.from("requests").update({ state: "rejected", reviewed_at: new Date().toISOString() }).eq("id", r.id); m.close(); await loadAndRender(); openRequests(); };
      actions.append(ok, no); item.appendChild(actions);
    }
    body.appendChild(item);
  });

  const m = openModal(state.user.is_admin ? "待審核申請" : "我的申請", body, null, true);
}

// ============================================================
//  薪資結算與簽收
// ============================================================
function openPayroll() {
  if (state.user.is_admin) openPayrollAdmin();
  else openPayrollEmployee();
}

function openPayrollAdmin() {
  const period = periodStr();
  const hourlyEmps = state.employees.filter((e) => e.category !== "正職"); // 正職為月薪制，不列入
  const body = document.createElement("div");
  body.appendChild(frag(`<p class="subhead">${period} 薪資結算（時薪制：PT／教練；正職為月薪不列入）</p>`));

  const tbl = document.createElement("table"); tbl.className = "simple";
  tbl.innerHTML = `<thead><tr><th>姓名</th><th>時數</th><th>時薪</th><th>金額</th><th>操作</th></tr></thead>`;
  const tb = document.createElement("tbody"); tbl.appendChild(tb);

  async function releaseOne(emp) {
    const existing = state.payrolls.find((p) => p.employee_id === emp.id);
    if (existing && existing.signed_at) { alert("已簽收，不可重發"); return; }
    const hrs = monthTotalHours(emp.id);
    if (!confirm(`發放 ${emp.name} 的 ${period} 薪資（${Math.round(hrs * emp.hourly_rate)} 元）？`)) return;
    const { error } = await sb.from("payrolls").upsert(
      { period, employee_id: emp.id, total_hours: Number(hrs.toFixed(2)), hourly_rate: emp.hourly_rate, amount: Math.round(hrs * emp.hourly_rate), released_at: new Date().toISOString() },
      { onConflict: "period,employee_id" });
    if (error) { alert("失敗（可能尚未跑 sql_薪資.sql）：" + error.message); return; }
    m.close(); await loadAndRender(); openPayrollAdmin();
  }

  let total = 0;
  if (!hourlyEmps.length) tb.appendChild(frag(`<tr><td colspan="5" class="empty">沒有時薪制員工（PT／教練）</td></tr>`));
  for (const emp of hourlyEmps) {
    const pr = state.payrolls.find((p) => p.employee_id === emp.id);
    const hrs = pr ? Number(pr.total_hours) : monthTotalHours(emp.id);
    const rate = pr ? pr.hourly_rate : emp.hourly_rate;
    const amt = pr ? pr.amount : Math.round(hrs * rate);
    total += amt;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${emp.name}</td><td>${hrs.toFixed(1)}</td><td>${rate}</td><td><b>${amt}</b></td><td class="pay-op"></td>`;
    const op = tr.querySelector(".pay-op");
    if (!pr) {
      const b = document.createElement("button"); b.className = "r-act"; b.textContent = "發放"; b.onclick = () => releaseOne(emp); op.appendChild(b);
    } else if (pr.signed_at) {
      const b = document.createElement("button"); b.className = "r-act"; b.style.color = "var(--st-work)"; b.textContent = "✓ 已簽收"; b.onclick = () => viewSignature(emp, pr); op.appendChild(b);
    } else {
      op.innerHTML = `<span style="color:var(--st-fixed)">待簽收</span>`;
      const b = document.createElement("button"); b.className = "r-act"; b.textContent = "重發"; b.onclick = () => releaseOne(emp); op.appendChild(b);
    }
    tb.appendChild(tr);
  }
  body.appendChild(tbl);
  body.appendChild(frag(`<p class="hint">本月合計應發：<b style="color:var(--amber)">${total}</b> 元</p>`));

  const foot = document.createElement("div"); foot.style.cssText = "display:flex;gap:10px;width:100%;justify-content:flex-end;flex-wrap:wrap";
  const exportBtn = document.createElement("button"); exportBtn.className = "btn btn-ghost"; exportBtn.textContent = "⬇ 匯出 CSV（算薪明細）"; exportBtn.style.marginRight = "auto";
  exportBtn.onclick = exportCsv;
  const releaseAll = document.createElement("button"); releaseAll.className = "btn btn-outline"; releaseAll.textContent = "全部一次發放";
  foot.append(exportBtn, releaseAll);
  const m = openModal("薪資結算", body, foot, true);
  releaseAll.onclick = async () => {
    if (!confirm(`一次發放 ${period} 全體薪資？（已簽收者不覆蓋）`)) return;
    const rows = hourlyEmps.map((emp) => {
      const existing = state.payrolls.find((p) => p.employee_id === emp.id);
      if (existing && existing.signed_at) return null;
      const hrs = monthTotalHours(emp.id);
      return { period, employee_id: emp.id, total_hours: Number(hrs.toFixed(2)), hourly_rate: emp.hourly_rate, amount: Math.round(hrs * emp.hourly_rate), released_at: new Date().toISOString() };
    }).filter(Boolean);
    if (rows.length) {
      const { error } = await sb.from("payrolls").upsert(rows, { onConflict: "period,employee_id" });
      if (error) { alert("失敗：" + error.message); return; }
    }
    m.close(); await loadAndRender(); openPayrollAdmin();
  };
}

function viewSignature(emp, pr) {
  const body = document.createElement("div");
  body.appendChild(frag(`<div class="pay-detail">
    <div class="pay-row"><span>員工</span><b>${emp.name}</b></div>
    <div class="pay-row"><span>金額</span><b>${pr.amount} 元</b></div>
    <div class="pay-row"><span>簽收時間</span><b>${fmtDateTime(pr.signed_at)}</b></div>
  </div>`));
  body.appendChild(frag(`<p class="subhead">簽名</p>`));
  const img = document.createElement("img"); img.src = pr.signature; img.className = "sign-img";
  body.appendChild(img);
  openModal("簽收明細", body, null);
}

function openPayrollEmployee() {
  const period = periodStr();
  const pr = state.payrolls.find((p) => p.employee_id === state.user.id);
  const body = document.createElement("div");
  body.appendChild(frag(`<p class="subhead">${period} 薪資單</p>`));
  if (!pr) { body.appendChild(frag(`<p class="empty">本月薪資尚未發放</p>`)); openModal("我的薪資", body, null); return; }

  body.appendChild(frag(`<div class="pay-detail">
    <div class="pay-row"><span>總時數</span><b>${Number(pr.total_hours).toFixed(1)} 小時</b></div>
    <div class="pay-row"><span>時薪</span><b>${pr.hourly_rate} 元</b></div>
    <div class="pay-row pay-amt"><span>應發金額</span><b>${pr.amount} 元</b></div>
  </div>`));
  if (pr.note) body.appendChild(frag(`<p class="hint">備註：${esc(pr.note)}</p>`));

  if (pr.signed_at) {
    body.appendChild(frag(`<p class="hint" style="color:var(--st-work);font-weight:700">✓ 已於 ${fmtDateTime(pr.signed_at)} 簽收</p>`));
    const img = document.createElement("img"); img.src = pr.signature; img.className = "sign-img";
    body.appendChild(img);
    openModal("我的薪資", body, null);
    return;
  }

  body.appendChild(frag(`<p class="subhead">簽收（請在下方簽名，確認已收到本月薪資）</p>`));
  const padWrap = document.createElement("div");
  body.appendChild(padWrap);
  const pad = signaturePad(padWrap);
  const clear = frag(`<button class="btn btn-ghost btn-sm" style="margin-top:6px">清除重簽</button>`);
  clear.onclick = () => pad.clear();
  body.appendChild(clear);

  const foot = document.createElement("button"); foot.className = "btn btn-primary"; foot.textContent = "✍️ 確認簽收";
  const m = openModal("我的薪資", body, foot);
  foot.onclick = async () => {
    if (pad.isEmpty()) { alert("請先簽名"); return; }
    if (!confirm("確認已收到本月薪資並送出簽名？")) return;
    const { error } = await sb.from("payrolls").update({ signed_at: new Date().toISOString(), signature: pad.dataUrl() }).eq("id", pr.id);
    if (error) { alert("失敗：" + error.message); return; }
    m.close(); await loadAndRender(); alert("已簽收，謝謝！");
  };
}

function signaturePad(container) {
  const canvas = document.createElement("canvas");
  canvas.className = "sign-pad"; canvas.width = 600; canvas.height = 200;
  container.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  ctx.strokeStyle = "#f2e8dc"; ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.lineJoin = "round";
  let drawing = false, empty = true;
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: (t.clientX - r.left) * canvas.width / r.width, y: (t.clientY - r.top) * canvas.height / r.height };
  };
  const start = (e) => { drawing = true; const p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); };
  const move = (e) => { if (!drawing) return; const p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); empty = false; e.preventDefault(); };
  const end = () => { drawing = false; };
  canvas.addEventListener("mousedown", start); canvas.addEventListener("mousemove", move); window.addEventListener("mouseup", end);
  canvas.addEventListener("touchstart", start, { passive: false }); canvas.addEventListener("touchmove", move, { passive: false }); canvas.addEventListener("touchend", end);
  return { clear: () => { ctx.clearRect(0, 0, canvas.width, canvas.height); empty = true; }, isEmpty: () => empty, dataUrl: () => canvas.toDataURL("image/png") };
}

// ============================================================
//  管理：員工 + 營業時間
// ============================================================
async function openAdmin() {
  const { data: allEmp } = await sb.from("employees").select("*").order("category").order("sort_order");
  const ltRes = await sb.from("leave_types").select("*").order("sort_order");
  const compLed = await sb.from("comp_ledger").select("*").order("created_at", { ascending: false });
  const compUsed = compKeys().length ? await sb.from("shifts").select("employee_id,work_date,status").in("status", compKeys()) : { data: [] };
  const body = document.createElement("div");

  body.appendChild(frag(`<p class="subhead">員工管理（時薪僅 PT／教練；特休天＝正職年度額度，起算日＝特休年度起點，月指休＝正職每月指休上限，0＝不限）</p>`));
  const empList = document.createElement("div"); empList.className = "adm-list";

  function empCard(e) {
    const card = document.createElement("div"); card.className = "adm-card";
    const fields = document.createElement("div"); fields.className = "adm-fields";
    const name = frag(`<input class="inp" placeholder="姓名">`); name.value = e?.name || "";
    const cat = frag(`<select class="inp"><option>正職</option><option>PT</option><option>教練</option></select>`); cat.value = e?.category || "正職";
    const pin = frag(`<input class="inp" maxlength="4" inputmode="numeric" placeholder="4 位數">`); pin.value = e?.pin || "";
    const rate = frag(`<input class="inp" type="number" placeholder="時薪">`); rate.value = e?.hourly_rate ?? 200;
    const annual = frag(`<input class="inp" type="number" min="0">`); annual.value = e?.annual_leave_days ?? 0;
    const lstart = frag(`<input class="inp" type="date">`); if (e?.leave_start) lstart.value = e.leave_start;
    const monthlyOff = frag(`<input class="inp" type="number" min="0">`); monthlyOff.value = e?.monthly_off_days ?? 0;
    const adm = frag(`<input type="checkbox">`); adm.checked = !!e?.is_admin;

    const fName = fieldWrap("姓名", name, "fld-name");
    const fCat = fieldWrap("類別", cat, "fld-cat");
    const fPin = fieldWrap("PIN", pin, "fld-pin");
    const fRate = fieldWrap("時薪", rate, "fld-num");
    const fAnnual = fieldWrap("特休天", annual, "fld-num");
    const fStart = fieldWrap("特休起算日", lstart, "fld-date");
    const fMonthly = fieldWrap("每月指休上限", monthlyOff, "fld-num");
    const fAdm = document.createElement("label"); fAdm.className = "fld fld-check";
    fAdm.append(adm, frag(`<span>管理者</span>`));
    fields.append(fName, fCat, fPin, fRate, fAnnual, fStart, fMonthly, fAdm);
    card.appendChild(fields);

    // 正職＝月薪＋有特休/月指休（隱藏時薪、顯示特休欄）；非正職相反
    const syncFT = () => {
      const isFT = cat.value === "正職";
      fRate.style.display = isFT ? "none" : "";
      fAnnual.style.display = isFT ? "" : "none";
      fStart.style.display = isFT ? "" : "none";
      fMonthly.style.display = isFT ? "" : "none";
    };
    cat.onchange = syncFT; syncFT();

    const foot = document.createElement("div"); foot.className = "adm-foot";
    const act = frag(`<button class="btn btn-sm btn-outline">${e ? "更新" : "＋ 新增員工"}</button>`);
    act.onclick = async () => {
      if (!name.value.trim() || !/^\d{4}$/.test(pin.value)) { alert("姓名必填、PIN 需 4 位數"); return; }
      const isFT = cat.value === "正職";
      const payload = { name: name.value.trim(), category: cat.value, pin: pin.value, hourly_rate: Number(rate.value) || 0, is_admin: adm.checked, annual_leave_days: isFT ? (Number(annual.value) || 0) : 0, leave_start: isFT ? (lstart.value || null) : null, monthly_off_days: isFT ? (Number(monthlyOff.value) || 0) : 0 };
      const res = e ? await sb.from("employees").update(payload).eq("id", e.id) : await sb.from("employees").insert({ ...payload, active: true });
      if (res.error) { alert("儲存失敗（特休/月指休欄位需先跑 sql_正職補休.sql）：" + res.error.message); return; }
      m.close(); await loadStatic(); loadAndRender(); openAdmin();
    };
    foot.appendChild(act);
    if (e) {
      const del = frag(`<button class="p-del" title="刪除">🗑</button>`);
      del.onclick = async () => {
        if (!confirm(`刪除員工「${e.name}」？其班表也會一併刪除。`)) return;
        await sb.from("employees").delete().eq("id", e.id);
        m.close(); await loadStatic(); loadAndRender(); openAdmin();
      };
      foot.appendChild(del);
    }
    card.appendChild(foot);
    return card;
  }
  (allEmp || []).forEach((e) => empList.appendChild(empCard(e)));
  empList.appendChild(empCard(null));
  body.appendChild(empList);

  // ---- 加班補休額度（正職）----
  body.appendChild(frag(`<div class="divider"></div>`));
  body.appendChild(frag(`<p class="subhead">加班補休額度（正職）：加班時在這裡記一筆（＋天數），員工休「補休」會自動扣抵</p>`));
  if (compLed.error) {
    body.appendChild(frag(`<p class="hint warn">尚未建立補休帳本，請先在 Supabase 跑 sql_正職補休.sql</p>`));
  } else {
    const ftEmps = (allEmp || []).filter((e) => e.category === "正職");
    if (!ftEmps.length) body.appendChild(frag(`<p class="hint">目前沒有正職員工</p>`));
    else {
      const compList = document.createElement("div"); compList.className = "adm-list";
      ftEmps.forEach((e) => {
        const earned = (compLed.data || []).filter((r) => r.employee_id === e.id).reduce((t, r) => t + Number(r.delta), 0);
        const used = (compUsed.data || []).filter((r) => r.employee_id === e.id).length;
        const bal = earned - used;
        const card = document.createElement("div"); card.className = "adm-card";
        card.appendChild(frag(`<div class="adm-name-lg">${esc(e.name)}</div>`));
        card.appendChild(frag(`<div class="adm-stat">取得 <b>${earned}</b> 天　·　已用 <b>${used}</b> 天　·　剩餘 <b>${bal}</b> 天</div>`));
        const fields = document.createElement("div"); fields.className = "adm-fields";
        const days = frag(`<input class="inp" type="number" step="0.5" placeholder="+1">`);
        const note = frag(`<input class="inp" placeholder="例：6/1 加班 2 小時">`);
        fields.append(fieldWrap("加班天數", days, "fld-num"), fieldWrap("事由", note, "fld-grow"));
        card.appendChild(fields);
        const foot = document.createElement("div"); foot.className = "adm-foot";
        const add = frag(`<button class="btn btn-sm btn-outline">記一筆</button>`);
        add.onclick = async () => {
          const d = Number(days.value);
          if (!d) { alert("請填加班天數（可負數做調整）"); return; }
          const { error } = await sb.from("comp_ledger").insert({ employee_id: e.id, delta: d, note: note.value.trim() });
          if (error) { alert("失敗：" + error.message); return; }
          m.close(); openAdmin();
        };
        foot.appendChild(add); card.appendChild(foot);
        compList.appendChild(card);
      });
      body.appendChild(compList);
    }
  }

  // ---- 假別設定 ----
  body.appendChild(frag(`<div class="divider"></div>`));
  body.appendChild(frag(`<p class="subhead">假別設定（名稱是班表存的值；「計特休」＝計入特休額度；「需備註」＝像特殊需填原因）</p>`));
  if (ltRes.error) {
    body.appendChild(frag(`<p class="hint warn">尚未建立假別表，請先在 Supabase 跑 sql_進階.sql</p>`));
  } else {
    const ltList = document.createElement("div"); ltList.className = "adm-list";
    const mkChk = (label, checked) => {
      const l = document.createElement("label"); l.className = "fld fld-check";
      const c = frag(`<input type="checkbox">`); c.checked = !!checked;
      l.append(c, frag(`<span>${label}</span>`)); return { l, c };
    };
    function ltCard(t) {
      const card = document.createElement("div"); card.className = "adm-card";
      const fields = document.createElement("div"); fields.className = "adm-fields";
      const name = frag(`<input class="inp" placeholder="假別名稱">`); name.value = t?.name || "";
      const color = frag(`<input type="color" class="inp" style="padding:2px;height:36px;width:52px">`); color.value = t?.color || "#8a7a64";
      const nn = mkChk("需備註", t?.needs_note);
      const ann = mkChk("計特休", t?.is_annual);
      const mon = mkChk("計月休", t?.is_monthly);
      const comp = mkChk("計補休", t?.is_comp);
      fields.append(fieldWrap("名稱", name, "fld-grow"), fieldWrap("顏色", color, "fld-cat"), nn.l, ann.l, mon.l, comp.l);
      card.appendChild(fields);
      const foot = document.createElement("div"); foot.className = "adm-foot";
      const act = frag(`<button class="btn btn-sm btn-outline">${t ? "更新" : "＋ 新增假別"}</button>`);
      act.onclick = async () => {
        if (!name.value.trim()) { alert("請填假別名稱"); return; }
        const payload = { name: name.value.trim(), color: color.value, needs_note: nn.c.checked, is_annual: ann.c.checked, is_monthly: mon.c.checked, is_comp: comp.c.checked, sort_order: t?.sort_order ?? 99 };
        const res = t ? await sb.from("leave_types").update(payload).eq("id", t.id) : await sb.from("leave_types").insert(payload);
        if (res.error) { alert("失敗（可能尚未跑 sql_正職補休.sql）：" + res.error.message); return; }
        m.close(); await loadStatic(); loadAndRender(); openAdmin();
      };
      foot.appendChild(act);
      if (t) {
        const del = frag(`<button class="p-del" title="刪除">🗑</button>`);
        del.onclick = async () => {
          if (!confirm(`刪除假別「${t.name}」？（已排的資料仍會顯示此名稱）`)) return;
          await sb.from("leave_types").delete().eq("id", t.id);
          m.close(); await loadStatic(); loadAndRender(); openAdmin();
        };
        foot.appendChild(del);
      }
      card.appendChild(foot);
      return card;
    }
    (ltRes.data || []).forEach((t) => ltList.appendChild(ltCard(t)));
    ltList.appendChild(ltCard(null));
    body.appendChild(ltList);
  }

  // ---- 班別設定（早班/晚班…，PT 依此選班）----
  body.appendChild(frag(`<div class="divider"></div>`));
  body.appendChild(frag(`<p class="subhead">班別設定（例：早班 9:30–14:00、晚班 13:00–22:00）。正職排完後，PT 會依這裡的班別點選空缺。</p>`));
  const psList = document.createElement("div"); psList.className = "adm-list";
  const psOpts = timeOptions();
  function psCard(p) {
    const card = document.createElement("div"); card.className = "adm-card";
    const fields = document.createElement("div"); fields.className = "adm-fields";
    const label = frag(`<input class="inp" placeholder="班別名稱，例：早班">`); label.value = p?.label || "";
    const ss = document.createElement("select"); ss.className = "inp"; ss.innerHTML = psOpts.map((t) => `<option>${t}</option>`).join(""); ss.value = p?.start_time || "09:30";
    const es = document.createElement("select"); es.className = "inp"; es.innerHTML = psOpts.map((t) => `<option>${t}</option>`).join(""); es.value = p?.end_time || "14:00";
    fields.append(fieldWrap("名稱", label, "fld-grow"), fieldWrap("開始", ss, "fld-cat"), fieldWrap("結束", es, "fld-cat"));
    card.appendChild(fields);
    const foot = document.createElement("div"); foot.className = "adm-foot";
    const act = frag(`<button class="btn btn-sm btn-outline">${p ? "更新" : "＋ 新增班別"}</button>`);
    act.onclick = async () => {
      if (!label.value.trim()) { alert("請填班別名稱"); return; }
      if (toMin(es.value) <= toMin(ss.value)) { alert("結束時間需晚於開始時間"); return; }
      const payload = { label: label.value.trim(), start_time: ss.value, end_time: es.value };
      let res;
      if (p) res = await sb.from("preset_shifts").update(payload).eq("id", p.id);
      else res = await sb.from("preset_shifts").insert({ ...payload, sort_order: (state.presets.reduce((m, x) => Math.max(m, x.sort_order || 0), 0)) + 1 });
      if (res.error) { alert("儲存失敗：" + res.error.message); return; }
      m.close(); await loadStatic(); loadAndRender(); openAdmin();
    };
    foot.appendChild(act);
    if (p) {
      const del = frag(`<button class="p-del" title="刪除">🗑</button>`);
      del.onclick = async () => { if (!confirm(`刪除班別「${p.label}」？`)) return; await sb.from("preset_shifts").delete().eq("id", p.id); m.close(); await loadStatic(); loadAndRender(); openAdmin(); };
      foot.appendChild(del);
    }
    card.appendChild(foot);
    return card;
  }
  (state.presets || []).forEach((p) => psList.appendChild(psCard(p)));
  psList.appendChild(psCard(null));
  body.appendChild(psList);

  body.appendChild(frag(`<div class="divider"></div>`));
  body.appendChild(frag(`<p class="subhead">營業時間（公休日不可排班、月曆自動標公休）</p>`));
  const opts = timeOptions();
  const bhList = document.createElement("div"); bhList.className = "adm-list";
  const ctrls = [];
  for (let i = 0; i < 7; i++) {
    const bh = state.hours.find((h) => h.weekday === i) || { is_open: true, open_time: "10:00", close_time: "23:00" };
    const card = document.createElement("div"); card.className = "adm-card";
    const fields = document.createElement("div"); fields.className = "adm-fields";
    const open = frag(`<input type="checkbox">`); open.checked = bh.is_open;
    const openL = document.createElement("label"); openL.className = "fld fld-check"; openL.append(open, frag(`<span>營業</span>`));
    const o = document.createElement("select"); o.className = "inp"; o.innerHTML = opts.map((t) => `<option>${t}</option>`).join(""); o.value = bh.open_time;
    const c = document.createElement("select"); c.className = "inp"; c.innerHTML = opts.map((t) => `<option>${t}</option>`).join(""); c.value = bh.close_time;
    fields.append(frag(`<div class="fld fld-cat"><span>星期</span><div class="adm-name-lg" style="padding-top:2px">週${DOW[i]}</div></div>`), openL, fieldWrap("開始", o, "fld-cat"), fieldWrap("結束", c, "fld-cat"));
    card.appendChild(fields); bhList.appendChild(card);
    ctrls.push({ weekday: i, open, o, c });
  }
  body.appendChild(bhList);

  const foot = document.createElement("button"); foot.className = "btn btn-primary"; foot.textContent = "儲存營業時間";
  foot.onclick = async () => {
    const rows = ctrls.map((x) => ({ weekday: x.weekday, is_open: x.open.checked, open_time: x.o.value, close_time: x.c.value }));
    await sb.from("business_hours").upsert(rows, { onConflict: "weekday" });
    await loadStatic(); loadAndRender(); alert("營業時間已儲存");
  };
  const m = openModal("管理設定", body, foot, true);
}

// ============================================================
//  CSV 匯出
// ============================================================
function exportCsv() {
  const { y, m } = state.ym;
  const nDays = daysInMonth(y, m);
  const map = {};
  state.shifts.forEach((s) => { map[`${s.employee_id}|${s.work_date}`] = s; });

  const header = ["類別", "姓名"];
  for (let d = 1; d <= nDays; d++) header.push(`${d}(${DOW[new Date(y, m, d).getDay()]})`);
  header.push("總時數", "時薪", "薪資");

  const lines = [header];
  for (const emp of state.employees) {
    const row = [emp.category, emp.name]; let total = 0;
    for (let d = 1; d <= nDays; d++) {
      const date = iso(y, m, d);
      const s = map[`${emp.id}|${date}`];
      row.push(s ? shiftText(s) : (isClosedDate(date) ? "公休" : ""));
      total += hoursOf(s);
    }
    row.push(total, emp.hourly_rate, Math.round(total * emp.hourly_rate));
    lines.push(row);
  }
  const csv = lines.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = `parone_班表_${y}-${pad(m + 1)}.csv`; a.click();
  URL.revokeObjectURL(url);
}
function csvCell(v) { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

// ============================================================
//  啟動
// ============================================================
(function boot() {
  if (!configReady) {
    if ($("#login-error")) $("#login-error").textContent = "尚未設定 Supabase 金鑰，請先填寫 config.js";
    const sel = $("#login-name"); if (sel) sel.innerHTML = `<option>（未設定）</option>`;
    return;
  }
  const saved = localStorage.getItem("parone_user");
  if (saved) { try { state.user = JSON.parse(saved); } catch (_) {} }
  if (state.user) enterApp(); else initLogin();
})();
