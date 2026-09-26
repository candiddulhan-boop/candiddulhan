const { html, raw } = require('./util');

function layout({ title, user, body, nav = true, flash, event }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · Candid Dulhan</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/style.css">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#8c1c3a">
<link rel="icon" href="/static/icons/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/static/icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="CD RSVP">
</head>
<body>
${nav ? html`<header class="topbar">
  <a class="brand" href="${user?.role === 'caller' ? '/caller' : '/admin'}">${user && !user.platform ? html`${user.org_name} <span>by Candid Dulhan</span>` : html`Candid Dulhan <span>RSVP</span>`}</a>
  ${user ? html`<nav>
    ${user.role === 'admin' ? html`<a href="/admin">Weddings</a><a href="/admin/team">Team</a>` : ''}
    <a href="/caller">Caller</a>
    <button class="btn sm install-btn" data-install hidden>⬇ Install app</button>
    <form method="post" action="/logout"><button class="link">Log out</button></form>
  </nav>` : ''}
</header>` : ''}
<main class="${nav ? 'wrap' : 'wrap narrow'}">
${flash ? html`<div class="flash">${flash}</div>` : ''}
${raw(String(body))}
</main>
${event ? html`<footer class="powered">${event.is_platform ? html`Candid Dulhan RSVP` : html`Guest management by <strong>${event.org_name}</strong> · Powered by Candid Dulhan`}</footer>` : ''}
<script src="/static/app.js" defer></script>
</body>
</html>`.toString();
}

module.exports = layout;
