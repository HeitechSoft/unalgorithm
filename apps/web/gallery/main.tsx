/**
 * The gallery (`pnpm gallery`): an index of every scenario, and each scenario as the portal itself renders it. A
 * scenario sets up the fake server, puts its address in the address bar and loads the portal's own entry point, so the
 * page is exactly what the server serves. Links between pages keep working: the dev server answers every page address
 * with this file, and the scenario chosen last stays set for them. `?theme=dark` or `?theme=light` forces a theme.
 */
import { SCENARIOS } from './scenarios.ts';

const KEY = 'gallery-scenario';
const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') ?? sessionStorage.getItem('gallery-theme');
if (theme === 'dark' || theme === 'light') {
  sessionStorage.setItem('gallery-theme', theme);
  document.documentElement.style.colorScheme = theme;
  document.documentElement.dataset.theme = theme;
}

const chosen = params.get('s');
if (window.location.pathname === '/gallery.html' && !chosen) {
  const root = document.getElementById('root') as HTMLElement;
  root.innerHTML = `<main style="max-width:640px;margin:48px auto;padding:0 16px;font:15px/1.4 system-ui">
    <h1 style="font-size:28px">Portal gallery</h1>
    ${[...new Set(SCENARIOS.map((s) => s.group))]
      .map(
        (group) =>
          `<h2 style="font-size:17px;margin-top:24px">${group}</h2><ul>${SCENARIOS.filter((s) => s.group === group)
            .map(
              (s) =>
                `<li><a href="/gallery.html?s=${s.id}">${s.title}</a> · <a href="/gallery.html?s=${s.id}&theme=dark">dark</a></li>`,
            )
            .join('')}</ul>`,
      )
      .join('')}
  </main>`;
} else {
  const id = chosen ?? sessionStorage.getItem(KEY) ?? 'home';
  const scenario = SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0];
  if (scenario) {
    sessionStorage.setItem(KEY, scenario.id);
    scenario.setup();
    if (chosen) window.history.replaceState(null, '', scenario.url);
  }
  await import('../src/main.tsx');
}
