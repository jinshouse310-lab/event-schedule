/* global I18N */
(() => {
  'use strict';

  // ---------- state ----------
  const state = {
    lang: localStorage.getItem('lang') || (navigator.language.startsWith('ja') ? 'ja' : 'en'),
    tz: localStorage.getItem('tz') || (navigator.language.startsWith('ja') ? 'Asia/Tokyo' : 'Asia/Kolkata'),
    view: 'list',
    types: [],
    members: [],
    events: [],
    calMonth: null, // {y, m}
    detailId: null,
    editingEvent: null,
    config: { maxUploadMb: 50, authRequired: false },
  };
  const TZ_LABEL = { 'Asia/Tokyo': 'JST', 'Asia/Kolkata': 'IST' };
  const OTHER_TZ = { 'Asia/Tokyo': 'Asia/Kolkata', 'Asia/Kolkata': 'Asia/Tokyo' };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const t = (key, vars) => {
    let s = I18N[state.lang][key] ?? I18N.ja[key] ?? key;
    if (typeof s === 'string' && vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
    return s;
  };
  const SEP = () => (state.lang === 'ja' ? '、 ' : ', ');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- timezone helpers ----------
  function zonedParts(date, tz) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second, wd: p.weekday };
  }
  function tzOffsetMin(tz, date) {
    const p = zonedParts(date, tz);
    return (Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - date.getTime()) / 60000;
  }
  function zonedToUtc(dateStr, timeStr, tz) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    let off = tzOffsetMin(tz, new Date(guess));
    let utc = guess - off * 60000;
    off = tzOffsetMin(tz, new Date(utc));
    return new Date(guess - off * 60000);
  }
  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (p) => `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  const timeStr = (p) => `${pad(p.hh)}:${pad(p.mm)}`;

  function eventDayKey(ev, tz) {
    if (ev.all_day) return ev.start_at.slice(0, 10);
    return dateKey(zonedParts(new Date(ev.start_at), tz));
  }
  function fmtDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    const wd = t('weekdays')[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    return state.lang === 'ja' ? `${y}/${m}/${d} (${wd})` : `${wd}, ${new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
  }
  function fmtRangeDates(ev) {
    const s = ev.start_at.slice(0, 10);
    const e = ev.end_at ? ev.end_at.slice(0, 10) : s;
    return s === e ? fmtDate(s) : `${fmtDate(s)} – ${fmtDate(e)}`;
  }
  // Time text in one tz, e.g. "10:00–11:30" or "9/21 10:00 – 9/22 12:00"
  function fmtTimes(ev, tz) {
    const s = zonedParts(new Date(ev.start_at), tz);
    if (!ev.end_at) return timeStr(s);
    const e = zonedParts(new Date(ev.end_at), tz);
    if (dateKey(s) === dateKey(e)) return `${timeStr(s)}–${timeStr(e)}`;
    return `${s.m}/${s.d} ${timeStr(s)} – ${e.m}/${e.d} ${timeStr(e)}`;
  }
  function fmtWhen(ev, withDate = true) {
    if (ev.all_day) return `${fmtRangeDates(ev)} · ${t('all_day')}`;
    const main = fmtTimes(ev, state.tz);
    const alt = fmtTimes(ev, OTHER_TZ[state.tz]);
    const day = withDate ? fmtDate(eventDayKey(ev, state.tz)) + ' ' : '';
    return `${day}<span class="time-pair"><b>${esc(main)} ${TZ_LABEL[state.tz]}</b><span class="alt">${esc(alt)} ${TZ_LABEL[OTHER_TZ[state.tz]]}</span></span>`;
  }

  // ---------- api ----------
  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}, ...opts });
    if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) { const err = new Error((data && data.error) || res.statusText); err.data = data; err.status = res.status; throw err; }
    return data;
  }
  const json = (obj) => JSON.stringify(obj);

  // ---------- helpers ----------
  const typeLabel = (x) => (state.lang === 'en' ? x.label_en || x.label_ja : x.label_ja);
  const memberName = (m) => (state.lang === 'en' ? m.name_en || m.name : m.name);
  const evTitle = (ev) => (state.lang === 'en' && ev.title_en ? ev.title_en : ev.title);
  const ownerName = (ev) => (ev.owner_id ? (state.lang === 'en' && ev.owner_name_en ? ev.owner_name_en : ev.owner_name) : t('unassigned'));
  const sideBadge = (side) => (side ? `<span class="side-badge ${side}">${side}</span>` : '');
  const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  function toast(msg, isErr) {
    const el = $('#toast');
    el.textContent = msg; el.classList.toggle('err', !!isErr); el.hidden = false;
    clearTimeout(el._t); el._t = setTimeout(() => (el.hidden = true), 2500);
  }
  function errMsg(e) {
    if (e.message === 'file_too_large') return t('file_too_large', { mb: e.data?.maxUploadMb ?? state.config.maxUploadMb });
    if (e.message === 'end_before_start') return t('end_before_start');
    return `${t('error')} (${e.message})`;
  }

  // ---------- i18n apply ----------
  function applyI18n() {
    document.documentElement.lang = state.lang;
    $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    $$('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    $$('#langToggle button').forEach((b) => b.classList.toggle('active', b.dataset.lang === state.lang));
    $$('#tzToggle button').forEach((b) => b.classList.toggle('active', b.dataset.tz === state.tz));
    fillSelects();
  }

  function fillSelects() {
    const typeOpts = state.types.map((x) => `<option value="${x.id}">${esc(typeLabel(x))}</option>`).join('');
    const keep = $('#fType').value;
    $('#fType').innerHTML = `<option value="">${esc(t('all_types'))}</option>${typeOpts}`;
    $('#fType').value = keep;
    $('#formType').innerHTML = typeOpts;
    const keepOwner = $('#fOwner').value;
    const memberOpts = ['JP', 'IN'].map((side) =>
      `<optgroup label="${esc(t(side === 'JP' ? 'side_jp' : 'side_in'))}">` +
      state.members.filter((m) => m.side === side).map((m) => `<option value="${m.id}">${esc(memberName(m))}</option>`).join('') + '</optgroup>'
    ).join('');
    $('#fOwner').innerHTML = `<option value="">${esc(t('all_owners'))}</option>${memberOpts}`;
    $('#fOwner').value = keepOwner;
    $('#formOwner').innerHTML = `<option value="">${esc(t('unassigned'))}</option>${memberOpts}`;
    $('#formMembers').innerHTML = ['JP', 'IN'].map((side) =>
      `<div class="group">${esc(t(side === 'JP' ? 'side_jp' : 'side_in'))}</div>` +
      state.members.filter((m) => m.side === side).map((m) => `<label><input type="checkbox" name="member_ids" value="${m.id}" />${esc(memberName(m))}</label>`).join('')
    ).join('');
  }

  // ---------- load ----------
  async function loadMeta() {
    [state.types, state.members, state.config] = await Promise.all([api('/api/types'), api('/api/members'), api('/api/config')]);
    $('#logoutBox').hidden = !state.config.authRequired;
  }
  async function loadEvents() {
    state.events = await api('/api/events');
  }

  // ---------- list view ----------
  function rangeBounds(kind) {
    const now = new Date();
    const p = zonedParts(now, state.tz);
    const startOfToday = zonedToUtc(dateKey(p), '00:00', state.tz);
    if (kind === 'upcoming') return { from: startOfToday };
    if (kind === 'past') return { to: startOfToday };
    if (kind === 'month') return { from: zonedToUtc(`${p.y}-${pad(p.m)}-01`, '00:00', state.tz), to: zonedToUtc(p.m === 12 ? `${p.y + 1}-01-01` : `${p.y}-${pad(p.m + 1)}-01`, '00:00', state.tz) };
    if (kind === 'next3') { const to = new Date(startOfToday); to.setUTCMonth(to.getUTCMonth() + 3); return { from: startOfToday, to }; }
    return {};
  }
  function evEnd(ev) { return new Date(ev.end_at ? (ev.all_day ? ev.end_at.slice(0, 10) + 'T23:59:59Z' : ev.end_at) : (ev.all_day ? ev.start_at.slice(0, 10) + 'T23:59:59Z' : ev.start_at)); }

  function filteredEvents() {
    const q = $('#fSearch').value.trim().toLowerCase();
    const type = $('#fType').value, side = $('#fSide').value, owner = $('#fOwner').value, status = $('#fStatus').value;
    const { from, to } = rangeBounds($('#fRange').value);
    return state.events.filter((ev) => {
      if (type && String(ev.type_id) !== type) return false;
      if (owner && String(ev.owner_id) !== owner) return false;
      if (side && ev.owner_side !== side && !ev.members.some((m) => m.side === side)) return false;
      if (status && ev.status !== status) return false;
      if (from && evEnd(ev) < from) return false;
      if (to && new Date(ev.start_at) >= to) return false;
      if (q && ![ev.title, ev.title_en, ev.location, ev.description, ev.owner_name, ev.owner_name_en].some((s) => (s || '').toLowerCase().includes(q))) return false;
      return true;
    });
  }

  function renderList() {
    const list = filteredEvents();
    const past = $('#fRange').value === 'past';
    if (past) list.reverse();
    const box = $('#eventList');
    if (!list.length) { box.innerHTML = `<div class="empty">${esc(t('no_events'))}</div>`; return; }
    const groups = new Map();
    for (const ev of list) {
      const k = eventDayKey(ev, state.tz);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(ev);
    }
    box.innerHTML = [...groups.entries()].map(([k, evs]) => `
      <div class="day-group">
        <div class="day-head">${esc(fmtDate(k))}</div>
        ${evs.map(cardHtml).join('')}
      </div>`).join('');
  }

  function cardHtml(ev) {
    const members = ev.members.map((m) => `${sideBadge(m.side)} ${esc(memberName(m))}`);
    return `
      <div class="event-card ${ev.status}" data-id="${ev.id}">
        <div class="bar" style="background:${ev.type_color}"></div>
        <div>
          <div><span class="type-badge" style="background:${ev.type_color}">${esc(typeLabel({ label_ja: ev.type_label_ja, label_en: ev.type_label_en }))}</span>
            <span class="status-badge ${ev.status}">${esc(t('status_' + ev.status))}</span></div>
          <div class="ev-title">${esc(evTitle(ev))}</div>
          <div class="ev-meta">
            <span>🕒 ${fmtWhen(ev, false)}</span>
            ${ev.location ? `<span>📍 ${esc(ev.location)}</span>` : ''}
          </div>
          ${members.length ? `<div class="ev-meta"><span>👥 ${members.slice(0, 6).join(SEP())}${members.length > 6 ? ' ' + esc(t('more', { n: members.length - 6 })) : ''}</span></div>` : ''}
        </div>
        <div class="ev-right">
          <div>${esc(t('owner'))}: ${sideBadge(ev.owner_side)} <b>${esc(ownerName(ev))}</b></div>
          <div>📎 ${esc(t('count_materials')(ev.materials_count ?? (ev.materials || []).length))}</div>
        </div>
      </div>`;
  }

  // ---------- calendar view ----------
  function renderCalendar() {
    if (!state.calMonth) { const p = zonedParts(new Date(), state.tz); state.calMonth = { y: p.y, m: p.m }; }
    const { y, m } = state.calMonth;
    $('#calTitle').textContent = t('month_fmt')(y, m);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const startDow = first.getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const todayKey = dateKey(zonedParts(new Date(), state.tz));
    const byDay = new Map();
    for (const ev of state.events) {
      // expand multi-day events across days
      const s = ev.all_day ? ev.start_at.slice(0, 10) : eventDayKey(ev, state.tz);
      const e = ev.all_day ? (ev.end_at || ev.start_at).slice(0, 10) : (ev.end_at ? dateKey(zonedParts(new Date(ev.end_at), state.tz)) : s);
      let cur = new Date(s + 'T00:00:00Z');
      const end = new Date(e + 'T00:00:00Z');
      let guard = 0;
      while (cur <= end && guard++ < 400) {
        const k = cur.toISOString().slice(0, 10);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(ev);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }
    const cells = [];
    const wd = t('weekdays');
    for (let i = 0; i < 7; i++) cells.push(`<div class="cal-dow ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${wd[i]}</div>`);
    const totalCells = Math.ceil((startDow + daysInMonth) / 7) * 7;
    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - startDow + 1;
      const d = new Date(Date.UTC(y, m - 1, dayNum));
      const k = d.toISOString().slice(0, 10);
      const other = dayNum < 1 || dayNum > daysInMonth;
      const dow = d.getUTCDay();
      const evs = byDay.get(k) || [];
      cells.push(`<div class="cal-cell ${other ? 'other' : ''} ${k === todayKey ? 'today' : ''} ${dow === 0 ? 'sun' : dow === 6 ? 'sat' : ''}">
        <span class="cal-day">${d.getUTCDate()}</span>
        ${evs.map((ev) => `<span class="cal-ev ${ev.status}" data-id="${ev.id}" style="background:${ev.type_color}" title="${esc(evTitle(ev))} / ${esc(ownerName(ev))}">${ev.all_day ? '' : esc(timeStr(zonedParts(new Date(ev.start_at), state.tz))) + ' '}${esc(evTitle(ev))}</span>`).join('')}
      </div>`);
    }
    $('#calGrid').innerHTML = cells.join('');
  }

  // ---------- members view ----------
  async function renderMembers() {
    const all = await api('/api/members?all=1');
    for (const side of ['JP', 'IN']) {
      const rows = all.filter((m) => m.side === side);
      $(`#members${side}`).innerHTML = `<tr><th>${esc(t('name'))}</th><th>${esc(t('role'))}</th><th>${esc(t('email'))}</th><th></th></tr>` +
        rows.map((m) => `<tr class="${m.active ? '' : 'inactive'}" data-id="${m.id}">
          <td>${esc(m.name)}${m.name_en ? `<div class="m-meta" style="font-size:.8rem;color:var(--muted)">${esc(m.name_en)}</div>` : ''}</td>
          <td>${esc(m.role)}</td><td>${esc(m.email)}</td>
          <td><button class="btn small" data-edit-member="${m.id}">${esc(t('edit'))}</button></td></tr>`).join('');
    }
    $('#view-members')._all = all;
  }

  // ---------- settings view ----------
  async function renderSettings() {
    const all = await api('/api/types?all=1');
    $('#typesTable').innerHTML = `<tr><th>${esc(t('label_ja'))}</th><th>${esc(t('label_en'))}</th><th>${esc(t('sort_order'))}</th><th></th></tr>` +
      all.map((x) => `<tr class="${x.active ? '' : 'inactive'}"><td><span class="color-dot" style="background:${x.color}"></span>${esc(x.label_ja)}</td><td>${esc(x.label_en)}</td><td>${x.sort_order}</td>
        <td><button class="btn small" data-edit-type="${x.id}">${esc(t('edit'))}</button></td></tr>`).join('');
    $('#typesTable')._all = all;
    $('#icsUrlJa').textContent = `${location.origin}/calendar.ics`;
    $('#icsUrlEn').textContent = `${location.origin}/calendar.ics?lang=en`;
  }

  // ---------- detail modal ----------
  async function openDetail(id) {
    const ev = await api(`/api/events/${id}`);
    state.detailId = id;
    $('#dType').textContent = typeLabel({ label_ja: ev.type_label_ja, label_en: ev.type_label_en });
    $('#dType').style.background = ev.type_color;
    $('#dTitle').textContent = evTitle(ev) + (state.lang === 'en' && ev.title_en ? ` (${ev.title})` : ev.title_en ? ` (${ev.title_en})` : '');
    $('#dWhen').innerHTML = fmtWhen(ev, true);
    $('#dLocation').textContent = ev.location || '—';
    $('#dOwner').innerHTML = `${sideBadge(ev.owner_side)} ${esc(ownerName(ev))}`;
    $('#dMembers').innerHTML = ev.members.length ? ev.members.map((m) => `${sideBadge(m.side)} ${esc(memberName(m))}`).join(SEP()) : '—';
    $('#dStatus').innerHTML = `<span class="status-badge ${ev.status}">${esc(t('status_' + ev.status))}</span>`;
    $('#dDescription').textContent = ev.description || '';
    $('#dDescription').hidden = !ev.description;
    renderMaterials(ev.materials);
    $('#uploadHint').textContent = `${t('upload_hint')} (≤ ${state.config.maxUploadMb} MB)`;
    $('#detailModal').hidden = false;
  }
  function renderMaterials(list) {
    const ul = $('#dMaterials');
    if (!list.length) { ul.innerHTML = `<li class="m-meta">${esc(t('no_materials'))}</li>`; return; }
    ul.innerHTML = list.map((m) => `<li>
      <span>${m.kind === 'link' ? '🔗' : '📄'}</span>
      <a class="m-name" href="${m.kind === 'link' ? esc(m.url) : `/api/materials/${m.event_id}/${m.id}/download`}" target="_blank" rel="noopener" title="${esc(m.name)}">${esc(m.name)}</a>
      <span class="m-meta">${m.kind === 'file' ? fmtSize(m.size) + ' · ' : ''}${esc(m.created_at.slice(0, 10))}${m.uploaded_by ? ' · ' + esc(m.uploaded_by) : ''}</span>
      <button class="icon-btn" data-del-material="${m.id}" title="${esc(t('delete'))}">&times;</button>
    </li>`).join('');
  }
  async function refreshDetailMaterials() {
    const ev = await api(`/api/events/${state.detailId}`);
    renderMaterials(ev.materials);
    await refreshAll(false);
  }

  async function uploadFiles(files) {
    if (!files || !files.length) return;
    const prog = $('#uploadProgress');
    prog.hidden = false;
    let i = 0;
    for (const f of files) {
      i++;
      prog.textContent = `${t('uploading')} (${i}/${files.length}) ${f.name}`;
      const fd = new FormData();
      fd.append('file', f);
      try {
        await api(`/api/events/${state.detailId}/materials/upload`, { method: 'POST', body: fd });
      } catch (e) { toast(errMsg(e), true); }
    }
    prog.hidden = true;
    toast(t('uploaded'));
    await refreshDetailMaterials();
  }

  // ---------- event form ----------
  function openEventForm(ev) {
    state.editingEvent = ev || null;
    const f = $('#eventForm');
    f.reset();
    $('#eventFormTitle').textContent = t(ev ? 'edit_event_title' : 'new_event_title');
    fillSelects();
    if (ev) {
      f.title.value = ev.title; f.title_en.value = ev.title_en; f.type_id.value = ev.type_id; f.status.value = ev.status;
      f.all_day.checked = ev.all_day; f.timezone.value = ev.timezone; f.location.value = ev.location; f.owner_id.value = ev.owner_id || '';
      f.description.value = ev.description;
      if (ev.all_day) {
        f.start_date.value = ev.start_at.slice(0, 10);
        f.end_date.value = ev.end_at ? ev.end_at.slice(0, 10) : '';
      } else {
        const s = zonedParts(new Date(ev.start_at), ev.timezone);
        f.start_date.value = dateKey(s); f.start_time.value = timeStr(s);
        if (ev.end_at) { const e = zonedParts(new Date(ev.end_at), ev.timezone); f.end_date.value = dateKey(e); f.end_time.value = timeStr(e); }
      }
      const ids = new Set(ev.members.map((m) => m.id));
      $$('input[name=member_ids]', f).forEach((cb) => (cb.checked = ids.has(cb.value)));
    } else {
      f.timezone.value = state.tz;
      const p = zonedParts(new Date(), state.tz);
      f.start_date.value = dateKey(p); f.start_time.value = '10:00'; f.end_time.value = '11:00';
    }
    toggleAllDay();
    $('#eventModal').hidden = false;
    f.title.focus();
  }
  function toggleAllDay() {
    const f = $('#eventForm');
    const allDay = f.all_day.checked;
    f.start_time.disabled = allDay; f.end_time.disabled = allDay; f.timezone.disabled = allDay;
  }
  async function submitEventForm(e) {
    e.preventDefault();
    const f = $('#eventForm');
    const allDay = f.all_day.checked;
    const tz = f.timezone.value;
    const body = {
      title: f.title.value, title_en: f.title_en.value, type_id: f.type_id.value, status: f.status.value,
      all_day: allDay, timezone: tz, location: f.location.value, owner_id: f.owner_id.value || null,
      description: f.description.value,
      member_ids: $$('input[name=member_ids]:checked', f).map((cb) => cb.value),
    };
    if (allDay) {
      body.start_at = `${f.start_date.value}T00:00:00Z`;
      body.end_at = f.end_date.value ? `${f.end_date.value}T00:00:00Z` : null;
    } else {
      body.start_at = zonedToUtc(f.start_date.value, f.start_time.value || '00:00', tz).toISOString();
      const endDate = f.end_date.value || f.start_date.value;
      body.end_at = f.end_time.value || f.end_date.value ? zonedToUtc(endDate, f.end_time.value || '23:59', tz).toISOString() : null;
    }
    try {
      const saved = state.editingEvent
        ? await api(`/api/events/${state.editingEvent.id}`, { method: 'PUT', body: json(body) })
        : await api('/api/events', { method: 'POST', body: json(body) });
      $('#eventModal').hidden = true;
      toast(t('saved'));
      await refreshAll();
      if (state.editingEvent) openDetail(saved.id);
    } catch (err) { toast(errMsg(err), true); }
  }

  // ---------- member / type forms ----------
  let editingMember = null;
  function openMemberForm(m) {
    editingMember = m || null;
    const f = $('#memberForm');
    f.reset();
    $('#memberFormTitle').textContent = t(m ? 'edit_member' : 'add_member');
    $('#btnDeactivateMember').hidden = !m || !m.active;
    if (m) { f.name.value = m.name; f.name_en.value = m.name_en; f.side.value = m.side; f.role.value = m.role; f.email.value = m.email; }
    $('#memberModal').hidden = false;
    f.name.focus();
  }
  async function submitMemberForm(e) {
    e.preventDefault();
    const f = $('#memberForm');
    const body = { name: f.name.value, name_en: f.name_en.value, side: f.side.value, role: f.role.value, email: f.email.value };
    if (editingMember && !editingMember.active) body.active = true;
    try {
      if (editingMember) await api(`/api/members/${editingMember.id}`, { method: 'PUT', body: json(body) });
      else await api('/api/members', { method: 'POST', body: json(body) });
      $('#memberModal').hidden = true; toast(t('saved'));
      await loadMeta(); fillSelects(); renderMembers();
    } catch (err) { toast(errMsg(err), true); }
  }
  let editingType = null;
  function openTypeForm(x) {
    editingType = x || null;
    const f = $('#typeForm');
    f.reset();
    $('#typeFormTitle').textContent = t(x ? 'edit_type' : 'add_type');
    $('#btnDeactivateType').hidden = !x || !x.active;
    if (x) { f.label_ja.value = x.label_ja; f.label_en.value = x.label_en; f.color.value = x.color; f.sort_order.value = x.sort_order; }
    $('#typeModal').hidden = false;
  }
  async function submitTypeForm(e) {
    e.preventDefault();
    const f = $('#typeForm');
    const body = { label_ja: f.label_ja.value, label_en: f.label_en.value, color: f.color.value, sort_order: Number(f.sort_order.value) };
    if (editingType && !editingType.active) body.active = true;
    try {
      if (editingType) await api(`/api/types/${editingType.id}`, { method: 'PUT', body: json(body) });
      else await api('/api/types', { method: 'POST', body: json(body) });
      $('#typeModal').hidden = true; toast(t('saved'));
      await loadMeta(); fillSelects(); renderSettings();
    } catch (err) { toast(errMsg(err), true); }
  }

  // ---------- view switching ----------
  async function showView(view) {
    state.view = view;
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $$('.view').forEach((s) => (s.hidden = s.id !== `view-${view}`));
    if (view === 'list') renderList();
    if (view === 'calendar') renderCalendar();
    if (view === 'members') await renderMembers();
    if (view === 'settings') await renderSettings();
  }
  async function refreshAll(reloadMeta = true) {
    if (reloadMeta) { await loadMeta(); fillSelects(); }
    await loadEvents();
    if (state.view === 'list') renderList();
    if (state.view === 'calendar') renderCalendar();
  }

  // ---------- events wiring ----------
  function wire() {
    $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) showView(b.dataset.view); });
    $('#langToggle').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.lang = b.dataset.lang; localStorage.setItem('lang', state.lang); applyI18n(); showView(state.view);
    });
    $('#tzToggle').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.tz = b.dataset.tz; localStorage.setItem('tz', state.tz); applyI18n(); state.calMonth = null; showView(state.view);
    });
    $('#btnNewEvent').addEventListener('click', () => openEventForm(null));
    ['#fSearch', '#fType', '#fSide', '#fOwner', '#fRange', '#fStatus'].forEach((s) => $(s).addEventListener('input', renderList));
    $('#eventList').addEventListener('click', (e) => { const c = e.target.closest('.event-card'); if (c) openDetail(c.dataset.id); });
    $('#calGrid').addEventListener('click', (e) => { const c = e.target.closest('.cal-ev'); if (c) openDetail(c.dataset.id); });
    $('#calPrev').addEventListener('click', () => { const c = state.calMonth; state.calMonth = c.m === 1 ? { y: c.y - 1, m: 12 } : { y: c.y, m: c.m - 1 }; renderCalendar(); });
    $('#calNext').addEventListener('click', () => { const c = state.calMonth; state.calMonth = c.m === 12 ? { y: c.y + 1, m: 1 } : { y: c.y, m: c.m + 1 }; renderCalendar(); });
    $('#calToday').addEventListener('click', () => { state.calMonth = null; renderCalendar(); });

    // modals: close buttons + backdrop
    $$('.modal').forEach((m) => {
      m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) m.hidden = true; });
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $$('.modal').forEach((m) => (m.hidden = true)); });

    // detail actions
    $('#btnEditEvent').addEventListener('click', async () => { const ev = await api(`/api/events/${state.detailId}`); $('#detailModal').hidden = true; openEventForm(ev); });
    $('#btnDeleteEvent').addEventListener('click', async () => {
      if (!confirm(t('confirm_delete_event'))) return;
      try { await api(`/api/events/${state.detailId}`, { method: 'DELETE' }); $('#detailModal').hidden = true; toast(t('deleted')); await refreshAll(false); }
      catch (err) { toast(errMsg(err), true); }
    });
    $('#dMaterials').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-del-material]'); if (!b) return;
      if (!confirm(t('confirm_delete_material'))) return;
      try { await api(`/api/materials/${state.detailId}/${b.dataset.delMaterial}`, { method: 'DELETE' }); toast(t('deleted')); await refreshDetailMaterials(); }
      catch (err) { toast(errMsg(err), true); }
    });
    $('#uploadFile').addEventListener('change', (e) => { uploadFiles([...e.target.files]); e.target.value = ''; });
    const drop = $('.file-drop');
    ['dragenter', 'dragover'].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((n) => drop.addEventListener(n, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => uploadFiles([...e.dataTransfer.files]));
    $('#linkForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/api/events/${state.detailId}/materials/link`, { method: 'POST', body: json({ url: $('#linkUrl').value, name: $('#linkName').value }) });
        $('#linkForm').reset(); toast(t('saved')); await refreshDetailMaterials();
      } catch (err) { toast(errMsg(err), true); }
    });

    // forms
    $('#eventForm').addEventListener('submit', submitEventForm);
    $('#formAllDay').addEventListener('change', toggleAllDay);
    $('#btnNewMember').addEventListener('click', () => openMemberForm(null));
    $('#memberForm').addEventListener('submit', submitMemberForm);
    $('#view-members').addEventListener('click', (e) => {
      const b = e.target.closest('[data-edit-member]'); if (!b) return;
      openMemberForm($('#view-members')._all.find((m) => m.id === b.dataset.editMember));
    });
    $('#btnDeactivateMember').addEventListener('click', async () => {
      if (!confirm(t('confirm_deactivate'))) return;
      await api(`/api/members/${editingMember.id}`, { method: 'DELETE' });
      $('#memberModal').hidden = true; toast(t('saved')); await loadMeta(); fillSelects(); renderMembers();
    });
    $('#btnNewType').addEventListener('click', () => openTypeForm(null));
    $('#typeForm').addEventListener('submit', submitTypeForm);
    $('#typesTable').addEventListener('click', (e) => {
      const b = e.target.closest('[data-edit-type]'); if (!b) return;
      openTypeForm($('#typesTable')._all.find((x) => x.id === b.dataset.editType));
    });
    $('#btnDeactivateType').addEventListener('click', async () => {
      if (!confirm(t('confirm_deactivate'))) return;
      await api(`/api/types/${editingType.id}`, { method: 'DELETE' });
      $('#typeModal').hidden = true; toast(t('saved')); await loadMeta(); fillSelects(); renderSettings();
    });
    $('#btnLogout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); location.href = '/login'; });
  }

  // ---------- boot ----------
  (async () => {
    wire();
    try {
      await loadMeta();
      applyI18n();
      await loadEvents();
      await showView('list');
    } catch (e) {
      console.error(e);
      if (e.message !== 'unauthorized') toast(errMsg(e), true);
    }
  })();
})();
