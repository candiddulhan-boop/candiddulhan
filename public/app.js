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
    const v = rsvp.querySelector('input[name="rsvp_status"]:checked')?.value;
    rsvp.querySelectorAll('[data-when]').forEach((el) => { el.hidden = !v || !el.dataset.when.split(' ').includes(v); });
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
