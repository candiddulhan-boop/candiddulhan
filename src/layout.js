const { html, raw } = require('./util');

function layout({ title, user, body, nav = true, flash }) {
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
</head>
<body>
${nav ? html`<header class="topbar">
  <a class="brand" href="${user?.role === 'caller' ? '/caller' : '/admin'}">Candid Dulhan <span>RSVP</span></a>
  ${user ? html`<nav>
    ${user.role === 'admin' ? html`<a href="/admin">Weddings</a><a href="/admin/team">Team</a>` : ''}
    <a href="/caller">Caller</a>
    <form method="post" action="/logout"><button class="link">Log out</button></form>
  </nav>` : ''}
</header>` : ''}
<main class="${nav ? 'wrap' : 'wrap narrow'}">
${flash ? html`<div class="flash">${flash}</div>` : ''}
${raw(String(body))}
</main>
<script src="/static/app.js" defer></script>
</body>
</html>`.toString();
}

module.exports = layout;
