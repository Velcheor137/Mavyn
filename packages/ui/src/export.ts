function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/**
 * Standalone HTML export. The body is the sanitized render output; a strict CSP forbids scripts
 * so the exported file is safe to open anywhere. KaTeX styles are linked from the same pinned
 * version used by the app (formulas degrade to MathML without network access).
 */
export function buildStandaloneHtml(title: string, bodyHtml: string, lang: string): string {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https: data:; style-src 'unsafe-inline' https://cdn.jsdelivr.net; font-src https://cdn.jsdelivr.net">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.19.1/dist/katex.min.css">
<style>
body{font:16px/1.7 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1f2328}
pre{background:#f6f8fa;padding:1rem;border-radius:8px;overflow:auto}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
table{border-collapse:collapse}th,td{border:1px solid #d0d7de;padding:.4rem .7rem}blockquote{border-left:3px solid #d0d7de;margin:0;padding-left:1rem;color:#57606a}
img{max-width:100%}.callout{border-left:3px solid #5e6ad2;background:#f3f4fb;padding:.5rem 1rem;border-radius:6px}.callout-title{font-weight:600}
li.task-list-item{list-style:none}.contains-task-list{padding-left:1.2rem}
@media print{pre{white-space:pre-wrap}h1,h2,h3{break-after:avoid}pre,table,figure{break-inside:avoid}}
</style>
</head>
<body>
<article>
${bodyHtml}
</article>
</body>
</html>
`;
}
