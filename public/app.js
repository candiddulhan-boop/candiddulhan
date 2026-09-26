// Copy-to-clipboard buttons: data-copy="text" or copies the sibling input's value.
document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-copy]');
  if (!btn) return;
  const text = btn.dataset.copy || btn.parentElement.querySelector('input')?.value || '';
  try { await navigator.clipboard.writeText(text); } catch { prompt('Copy this link:', text); return; }
  const old = btn.textContent;
  btn.textContent = 'Copied ✓';
  setTimeout(() => (btn.textContent = old), 1500);
});

// Confirm destructive forms.
document.addEventListener('submit', (ev) => {
  const msg = ev.target.dataset.confirm;
  if (msg && !confirm(msg)) ev.preventDefault();
});

// RSVP form: only show attendance details when attending / maybe.
const rsvp = document.querySelector('[data-rsvp]');
if (rsvp) {
  const sync = () => {
    // Overall state across all functions: attending anywhere > maybe > declined.
    const vals = [...rsvp.querySelectorAll('input[data-answer]:checked')].map((i) => i.value);
    const v = vals.includes('yes') ? 'yes' : vals.includes('maybe') ? 'maybe' : vals.length ? 'no' : '';
    rsvp.querySelectorAll('[data-when]').forEach((el) => { el.hidden = !v || !el.dataset.when.split(' ').includes(v); });
    rsvp.querySelectorAll('[data-show-if]').forEach((el) => {
      el.hidden = rsvp.querySelector(`input[name="${el.dataset.showIf}"]:checked`)?.value !== 'yes';
    });
  };
  rsvp.addEventListener('change', sync);
  sync();
}

// Caller console: after tapping "Call", open the log form when the caller returns to the browser.
document.querySelectorAll('[data-call]').forEach((a) => a.addEventListener('click', () => {
  const id = a.dataset.call;
  const onBack = () => {
    if (document.visibilityState === 'visible') {
      document.removeEventListener('visibilitychange', onBack);
      location.href = `/caller/guest/${id}`;
    }
  };
  setTimeout(() => document.addEventListener('visibilitychange', onBack), 500);
}));

// Bulk selection on the admin guest table.
const selAll = document.querySelector('[data-selall]');
const selCount = () => {
  const n = document.querySelectorAll('[data-sel]:checked').length;
  document.querySelectorAll('[data-selcount]').forEach((el) => (el.textContent = n));
};
selAll?.addEventListener('change', () => {
  document.querySelectorAll('[data-sel]').forEach((c) => (c.checked = selAll.checked));
  selCount();
});
document.addEventListener('change', (ev) => { if (ev.target.matches('[data-sel]')) selCount(); });

// Confirm for individual submit buttons.
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-confirm-click]');
  if (b && !confirm(b.dataset.confirmClick)) ev.preventDefault();
});

// Follow-up quick picks (local time).
document.addEventListener('click', (ev) => {
  const chip = ev.target.closest('[data-in]');
  const input = chip && chip.closest('form')?.querySelector('[data-followup]');
  if (!input) return;
  const d = new Date();
  if (chip.dataset.in === '2h') d.setHours(d.getHours() + 2);
  else if (chip.dataset.in === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(11, 0, 0, 0); }
  else if (chip.dataset.in === '2d') { d.setDate(d.getDate() + 2); d.setHours(11, 0, 0, 0); }
  const pad = (n) => String(n).padStart(2, '0');
  input.value = chip.dataset.in ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
});

// ---------- AI helpers ----------
const postJson = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({ error: 'Unexpected response' }));
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
};
const busy = (btn, on, label) => {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Thinking…'; btn.disabled = true; btn.classList.add('loading'); }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; btn.classList.remove('loading'); }
};
// Render the AI's plain-text answer safely (escape, then light formatting).
const renderAnswer = (text) => {
  const esc = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return esc.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').split(/\n{2,}/)
    .map((p) => (/^\s*[-•]/m.test(p) ? `<ul>${p.split('\n').map((l) => l.replace(/^\s*[-•]\s?/, '')).filter(Boolean).map((l) => `<li>${l}</li>`).join('')}</ul>` : `<p>${p.replace(/\n/g, '<br>')}</p>`)).join('');
};

// Ask AI
document.querySelectorAll('[data-ask]').forEach((form) => {
  const out = form.parentElement.querySelector('.answer');
  const ask = async (q) => {
    const btn = form.querySelector('button');
    busy(btn, true, 'Thinking…');
    out.hidden = false;
    out.innerHTML = `<p class="muted">Reading your guest data…</p>`;
    try {
      const { answer } = await postJson(form.dataset.ask, { q });
      out.innerHTML = `<p class="q">“${q.replace(/[&<>]/g, '')}”</p>${renderAnswer(answer)}`;
    } catch (err) { out.innerHTML = `<p class="flash warn">${err.message}</p>`; }
    busy(btn, false);
  };
  form.addEventListener('submit', (ev) => { ev.preventDefault(); ask(form.q.value.trim()); });
  form.parentElement.querySelectorAll('[data-q]').forEach((chip) => chip.addEventListener('click', () => { form.q.value = chip.dataset.q; ask(chip.dataset.q); }));
});

// AI WhatsApp message
document.querySelectorAll('[data-ai-msg]').forEach((form) => form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const btn = form.querySelector('button.primary');
  const out = form.querySelector('.ai-out');
  busy(btn, true, 'Writing…');
  try {
    const { text, wa } = await postJson(form.dataset.aiMsg, { purpose: form.purpose.value, language: form.language.value });
    out.hidden = false;
    out.querySelector('textarea').value = text;
    const link = out.querySelector('[data-wa]');
    link.hidden = !wa;
    if (wa) link.href = wa;
  } catch (err) { alert(err.message); }
  busy(btn, false);
}));
document.addEventListener('input', (ev) => {
  // Keep the WhatsApp link in sync if the planner edits the drafted message.
  const out = ev.target.closest('.ai-out');
  const link = out?.querySelector('[data-wa]');
  if (link?.href) link.href = link.href.replace(/text=.*$/, `text=${encodeURIComponent(ev.target.value)}`);
});
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-copy-area]');
  if (!b) return;
  const ta = b.closest('.ai-out').querySelector('textarea');
  try { await navigator.clipboard.writeText(ta.value); b.textContent = 'Copied ✓'; } catch { ta.select(); }
});

// Smart fill from call notes
document.querySelectorAll('[data-smart-fill]').forEach((btn) => btn.addEventListener('click', async () => {
  const form = btn.closest('form');
  const notes = form.querySelector('[data-notes]').value.trim();
  const out = form.querySelector('.smart-result');
  if (!notes) { alert('Write your call notes first.'); return; }
  busy(btn, true, '✨ Reading notes…');
  try {
    const x = await postJson(btn.dataset.smartFill, { notes });
    const filled = [];
    for (const f of x.functions || []) {
      const sel = form.querySelector(`[name="fn_rsvp_${f.function_id}"]`);
      if (sel) { sel.value = f.rsvp; filled.push(sel.closest('label').firstChild.textContent.trim()); }
      const pax = form.querySelector(`[name="fn_pax_${f.function_id}"]`);
      if (pax && f.pax != null) pax.value = f.pax;
    }
    const setField = (name, v) => {
      const el = form.querySelector(`[name="${name}"]`);
      if (!el || v == null || v === '') return;
      el.value = typeof v === 'boolean' ? (v ? '1' : '0') : v;
      filled.push(el.closest('label')?.firstChild.textContent.trim() || name);
    };
    for (const k of ['arrival_date', 'arrival_time', 'arrival_mode', 'arrival_details', 'arrival_point', 'pickup_required', 'departure_date',
      'departure_time', 'departure_mode', 'departure_number', 'drop_required', 'needs_stay', 'dietary', 'allergies', 'special_needs', 'kids']) setField(k, x[k]);
    if (filled.some((f) => !/^(Haldi|Mehndi|Sangeet|Wedding|Reception)/.test(f))) form.querySelector('.travel-fields').open = true;
    if (x.suggested_follow_up && form.follow_up_at && !form.follow_up_at.value) filled.push(`Suggested follow-up: ${x.suggested_follow_up}`);
    out.hidden = false;
    out.textContent = filled.length ? `✓ Filled: ${filled.join(' · ')}. Please check before saving.` : 'Nothing to fill from these notes.';
  } catch (err) { out.hidden = false; out.textContent = err.message; }
  busy(btn, false);
}));

// Forms that call slow AI endpoints: show progress.
document.addEventListener('submit', (ev) => {
  const msg = ev.target.dataset.busy;
  if (msg && !ev.defaultPrevented) busy(ev.target.querySelector('button'), true, msg);
});

// ---------- Installable app (PWA) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
let installPrompt;
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  installPrompt = ev;
  document.querySelectorAll('[data-install]').forEach((b) => { b.hidden = false; });
});
document.addEventListener('click', async (ev) => {
  if (!ev.target.closest('[data-install]') || !installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  document.querySelectorAll('[data-install]').forEach((b) => { b.hidden = true; });
});
