(() => {
  'use strict';

  const STORAGE_KEY = 'smartPillTracker_v1';
  const RULES = {
    empty: 'Натщесерце',
    before: 'До їди',
    after: 'Після їди',
    with: 'Під час їди',
    anytime: 'Незалежно від їди'
  };

  const defaultState = {
    meds: [],
    history: {},
    streak: 0,
    notificationsEnabled: false
  };

  let state = loadState();
  let notificationCheckInterval = null;
  let scheduledTimeouts = new Map();

  const $ = (sel) => document.querySelector(sel);

  document.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker();
    render();
    setupEventListeners();
    requestNotificationPermissionOnDemand();
    startNotificationScheduler();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', handleSWMessage);
    }
  });

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(defaultState);
      return { ...structuredClone(defaultState), ...JSON.parse(raw) };
    } catch {
      return structuredClone(defaultState);
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  async function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    try {
      await navigator.serviceWorker.register('./sw.js', { scope: './' });
    } catch (err) {
      console.warn('[SW] failed', err);
    }
  }

  function handleSWMessage(event) {
    const { type, action, medId } = event.data || {};
    if (type === 'NOTIFICATION_ACTION' && medId) {
      if (action === 'taken') markTaken(medId);
      else if (action === 'snooze') snoozeMed(medId);
    }
    if (type === 'REQUEST_MEDS_CHECK') sendMedsToSW();
  }

  function sendMedsToSW() {
    if (!navigator.serviceWorker?.controller) return;
    const medsForSW = state.meds.map((m) => ({
      id: m.id,
      name: m.name,
      time: m.time,
      rule: m.rule,
      ruleLabel: RULES[m.rule] || m.rule,
      takenToday: isTakenToday(m),
      snoozeUntil: m.snoozeUntil || null
    }));
    navigator.serviceWorker.controller.postMessage({ type: 'CHECK_DUE_MEDS', meds: medsForSW });
  }

  async function requestNotificationPermissionOnDemand() {
    if (!('Notification' in window)) return;
    const banner = $('#permission-banner');
    if (Notification.permission === 'granted') {
      state.notificationsEnabled = true;
      saveState();
      banner?.classList.remove('visible');
      return;
    }
    if (Notification.permission === 'denied') {
      banner?.classList.remove('visible');
      return;
    }
    banner?.classList.add('visible');
  }

  async function enableNotifications() {
    if (!('Notification' in window)) {
      showToast('Сповіщення не підтримуються');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      state.notificationsEnabled = true;
      saveState();
      $('#permission-banner')?.classList.remove('visible');
      showToast('Сповіщення увімкнено 🔔');
      scheduleAllNotifications();
      try {
        const reg = await navigator.serviceWorker.ready;
        if ('periodicSync' in reg) {
          await reg.periodicSync.register('check-meds', { minInterval: 15 * 60 * 1000 });
        }
      } catch (_) {}
    } else {
      showToast('Дозвіл відхилено');
    }
  }

  function startNotificationScheduler() {
    if (notificationCheckInterval) clearInterval(notificationCheckInterval);
    notificationCheckInterval = setInterval(() => {
      checkDueAndNotify();
      sendMedsToSW();
    }, 30000);
    scheduleAllNotifications();
  }

  function scheduleAllNotifications() {
    scheduledTimeouts.forEach((id) => clearTimeout(id));
    scheduledTimeouts.clear();
    if (Notification.permission !== 'granted') return;

    const now = Date.now();
    state.meds.forEach((med) => {
      if (isTakenToday(med)) return;
      let targetTime;
      if (med.snoozeUntil) {
        targetTime = new Date(med.snoozeUntil).getTime();
      } else {
        const [h, m] = med.time.split(':').map(Number);
        const d = new Date();
        d.setHours(h, m, 0, 0);
        targetTime = d.getTime();
      }
      const delay = targetTime - now;
      if (delay > 0 && delay < 24 * 60 * 60 * 1000) {
        const tid = setTimeout(() => {
          showPillNotification(med);
          scheduledTimeouts.delete(med.id);
        }, delay);
        scheduledTimeouts.set(med.id, tid);
      } else if (delay <= 0 && delay > -2 * 60 * 1000) {
        showPillNotification(med);
      }
    });
  }

  function showPillNotification(med) {
    if (Notification.permission !== 'granted' || isTakenToday(med)) return;
    const title = `💊 Час прийняти: ${med.name}`;
    const body = `${RULES[med.rule] || med.rule} • ${med.time}`;

    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'SHOW_NOTIFICATION',
        title, body,
        tag: `pill-${med.id}`,
        data: { medId: med.id }
      });
    } else {
      new Notification(title, { body, tag: `pill-${med.id}`, requireInteraction: true });
    }
  }

  function checkDueAndNotify() {
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    state.meds.forEach((med) => {
      if (isTakenToday(med)) return;
      let targetMinutes;
      if (med.snoozeUntil) {
        const s = new Date(med.snoozeUntil);
        if (s > now) return;
        targetMinutes = s.getHours() * 60 + s.getMinutes();
      } else {
        const [h, m] = med.time.split(':').map(Number);
        targetMinutes = h * 60 + m;
      }
      const diff = currentMinutes - targetMinutes;
      if (diff >= 0 && diff <= 1) showPillNotification(med);
    });
  }

  function isTakenToday(med) {
    return med.takenDate === todayKey();
  }

  function getCourseDay(med) {
    if (!med.startDate || !med.durationDays) return null;
    const start = new Date(med.startDate);
    const today = new Date();
    start.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);
    const diff = Math.floor((today - start) / 86400000) + 1;
    if (diff < 1) return 1;
    if (diff > med.durationDays) return med.durationDays;
    return diff;
  }

  function isCourseActive(med) {
    if (!med.durationDays) return true;
    const day = getCourseDay(med);
    return day !== null && day <= med.durationDays;
  }

  function getTodayMeds() {
    return state.meds.filter(isCourseActive).sort((a, b) => {
      const now = new Date();
      const getTime = (med) => {
        if (med.snoozeUntil) return new Date(med.snoozeUntil).getTime();
        const [h, m] = med.time.split(':').map(Number);
        const d = new Date(now);
        d.setHours(h, m, 0, 0);
        return d.getTime();
      };
      return getTime(a) - getTime(b);
    });
  }

  function markTaken(id) {
    const med = state.meds.find((m) => m.id === id);
    if (!med) return;
    med.takenDate = todayKey();
    med.snoozeUntil = null;
    saveState();
    playTakenSound();
    updateDailyHistory();
    scheduleAllNotifications();
    render();
    showToast(`${med.name} — випито ✅`);
  }

  function snoozeMed(id) {
    const med = state.meds.find((m) => m.id === id);
    if (!med) return;
    const until = new Date(Date.now() + 15 * 60 * 1000);
    med.snoozeUntil = until.toISOString();
    med.takenDate = null;
    saveState();
    scheduleAllNotifications();
    render();
    showToast(`Відкладено до ${until.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' })}`);
  }

  function deleteMed(id) {
    if (!confirm('Видалити цей препарат?')) return;
    state.meds = state.meds.filter((m) => m.id !== id);
    if (scheduledTimeouts.has(id)) {
      clearTimeout(scheduledTimeouts.get(id));
      scheduledTimeouts.delete(id);
    }
    saveState();
    updateDailyHistory();
    render();
    showToast('Видалено');
  }

  function addMed(data) {
    const med = {
      id: generateId(),
      name: data.name.trim(),
      time: data.time,
      rule: data.rule,
      durationDays: parseInt(data.durationDays, 10) || 0,
      startDate: todayKey(),
      takenDate: null,
      snoozeUntil: null
    };
    state.meds.push(med);
    saveState();
    updateDailyHistory();
    scheduleAllNotifications();
    render();
    showToast(`Додано: ${med.name}`);
  }

  function updateDailyHistory() {
    const key = todayKey();
    const todayMeds = getTodayMeds();
    const total = todayMeds.length;
    const taken = todayMeds.filter(isTakenToday).length;
    const completed = total > 0 && taken === total;
    state.history[key] = { total, taken, completed };
    recalculateStreak();
    saveState();
  }

  function recalculateStreak() {
    let streak = 0;
    const todayEntry = state.history[todayKey()];
    const check = new Date();
    if (!todayEntry || !todayEntry.completed) {
      check.setDate(check.getDate() - 1);
    }
    for (let i = 0; i < 365; i++) {
      const key = check.toISOString().slice(0, 10);
      const entry = state.history[key];
      if (entry && entry.completed) {
        streak++;
        check.setDate(check.getDate() - 1);
      } else break;
    }
    if (todayEntry && todayEntry.completed) streak++;
    state.streak = streak;
  }

  function playTakenSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.25);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.25);
    } catch (_) {}
  }

  function render() {
    updateDailyHistory();
    renderStats();
    renderTodayList();
    renderPermissionBanner();
  }

  function renderStats() {
    const todayMeds = getTodayMeds();
    const total = todayMeds.length;
    const taken = todayMeds.filter(isTakenToday).length;
    const pct = total === 0 ? 0 : Math.round((taken / total) * 100);
    $('#stat-streak').textContent = state.streak > 0 ? `🔥 ${state.streak}` : '—';
    $('#stat-percent').textContent = `${pct}%`;
    $('#stat-percent').style.color = pct === 100 ? 'var(--success)' : 'var(--accent2)';
  }

  function renderTodayList() {
    const list = $('#meds-list');
    const todayMeds = getTodayMeds();
    if (todayMeds.length === 0) {
      list.innerHTML = `<div class="empty-state"><div class="emoji">💊</div><p>Немає препаратів на сьогодні</p><p style="font-size:0.85rem;margin-top:8px">Натисніть + щоб додати</p></div>`;
      return;
    }
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    list.innerHTML = todayMeds.map((med) => {
      const taken = isTakenToday(med);
      const courseDay = getCourseDay(med);
      let displayTime = med.time;
      let isOverdue = false;
      if (med.snoozeUntil) {
        const s = new Date(med.snoozeUntil);
        displayTime = s.toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
        if (!taken && s < now) isOverdue = true;
      } else {
        const [h, m] = med.time.split(':').map(Number);
        if (!taken && currentMinutes > h * 60 + m + 5) isOverdue = true;
      }
      return `
        <article class="med-card ${taken ? 'taken' : ''} ${isOverdue ? 'overdue' : ''}" data-id="${med.id}">
          <div class="med-top">
            <div class="med-name">${escapeHtml(med.name)}</div>
            <div class="med-time">${displayTime}</div>
          </div>
          <div class="med-meta">
            <span class="badge rule">${RULES[med.rule] || med.rule}</span>
            ${courseDay && med.durationDays ? `<span class="badge day">День ${courseDay} з ${med.durationDays}</span>` : ''}
            <span class="badge ${taken ? 'status-taken' : 'status-pending'}">${taken ? '✓ Випито' : isOverdue ? 'Пропущено' : 'Очікує'}</span>
          </div>
          <div class="med-actions">
            <button class="btn btn-primary" data-action="taken" ${taken ? 'disabled' : ''}>✅ Випити</button>
            <button class="btn btn-secondary" data-action="snooze" ${taken ? 'disabled' : ''}>⏰ +15 хв</button>
            <button class="btn btn-danger" data-action="delete">🗑️</button>
          </div>
        </article>`;
    }).join('');
  }

  function renderPermissionBanner() {
    const banner = $('#permission-banner');
    if (!banner) return;
    if (Notification.permission === 'default') banner.classList.add('visible');
    else banner.classList.remove('visible');
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function showToast(msg) {
    let toast = $('#toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'toast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toast._tid);
    toast._tid = setTimeout(() => toast.classList.remove('show'), 2500);
  }

  function openModal() { $('#add-modal').classList.add('open'); $('#med-name').focus(); }
  function closeModal() { $('#add-modal').classList.remove('open'); $('#add-form').reset(); }

  function setupEventListeners() {
    $('#fab-add').addEventListener('click', openModal);
    $('#close-modal').addEventListener('click', closeModal);
    $('#add-modal').addEventListener('click', (e) => { if (e.target === $('#add-modal')) closeModal(); });

    $('#add-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const name = $('#med-name').value.trim();
      const time = $('#med-time').value;
      const rule = $('#med-rule').value;
      const durationDays = $('#med-duration').value;
      if (!name || !time) { showToast('Заповніть назву та час'); return; }
      addMed({ name, time, rule, durationDays });
      closeModal();
    });

    $('#btn-enable-notifications')?.addEventListener('click', enableNotifications);

    $('#meds-list').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const card = btn.closest('.med-card');
      if (!card) return;
      const id = card.dataset.id;
      const action = btn.dataset.action;
      if (action === 'taken') markTaken(id);
      else if (action === 'snooze') snoozeMed(id);
      else if (action === 'delete') deleteMed(id);
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        scheduleAllNotifications();
        checkDueAndNotify();
        render();
      }
    });
  }
})();
