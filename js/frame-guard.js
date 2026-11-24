// Clickjacking guard. GitHub Pages cannot send `frame-ancestors` / X-Frame-Options and the CSP
// <meta> tag cannot carry `frame-ancestors`, so the page refuses to run inside a frame.
// Imported first by app.js: throwing here stops every later module from evaluating, so no data
// is loaded and no button is wired while framed.
export function isFramed(win = globalThis.window) {
  try {
    return win.top !== win.self;
  } catch {
    return true; // cross-origin access to top throws — that is a frame too
  }
}

if (isFramed()) {
  const box = document.createElement('main');
  box.className = 'framed';
  const text = document.createElement('p');
  text.textContent = 'PRP нельзя открывать внутри другой страницы.';
  const link = document.createElement('a');
  link.href = location.href;
  link.target = '_top';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Открыть PRP отдельно';
  box.append(text, link);
  document.body.replaceChildren(box);
  throw new Error('PRP refuses to run inside a frame');
}
