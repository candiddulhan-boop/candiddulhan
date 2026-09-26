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
