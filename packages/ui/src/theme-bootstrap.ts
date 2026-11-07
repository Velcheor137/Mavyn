/** Dependency-free so build tooling (vite.config) can import it. */
export const PREFS_KEY = 'mdreader.preferences.v1';

/**
 * Served as `/theme-bootstrap.js` and loaded synchronously in `<head>`: applies the stored theme
 * and accent before first paint, preventing a light/dark flash. Tolerates missing storage. An
 * external file (not inline) so the CSP can forbid inline scripts.
 */
export const THEME_BOOTSTRAP_SCRIPT = `(()=>{try{var p=JSON.parse(localStorage.getItem('${PREFS_KEY}')||'{}');var m=p.theme||'system';var d=m==='dark'||(m==='system'&&matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.dataset.theme=d?'dark':'light';r.style.colorScheme=d?'dark':'light';if(/^#[0-9a-f]{6}$/i.test(p.accent||''))r.style.setProperty('--color-accent',p.accent);}catch(e){}})();\n`;
