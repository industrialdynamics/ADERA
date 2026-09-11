/**
 * Builds docs/01-ADERA-Whitepaper.md into:
 *   _site/index.html                — the GitHub Pages site
 *   _site/ADERA-Whitepaper.pdf      — the print-ready PDF
 *
 * Both outputs share tools/docs/style.css, so the page and the paper stay
 * visually identical. Run `npm run build` here, or let the docs workflow do it.
 *
 * Flags:  --no-pdf   HTML only (skips launching Chromium)
 */
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const SOURCE   = resolve(ROOT, 'docs/01-ADERA-Whitepaper.md');
const OUT_DIR  = resolve(ROOT, '_site');
const PDF_NAME = 'ADERA-Whitepaper.pdf';

const TITLE       = 'ADERA — Automated Decentralized Energy Roaming Architecture';
const DESCRIPTION = 'A sovereign, tokenless, hubless framework for national EV charging interoperability. Published by Industrial Dynamics.';
const PUBLISHER   = 'Industrial Dynamics';

const skipPdf = process.argv.includes('--no-pdf');

/* ---------- Markdown -> HTML ---------- */

const md = new MarkdownIt({ html: true, linkify: true, typographer: true })
  .use(anchor, {
    permalink: anchor.permalink.linkInsideHeader({ symbol: '#', placement: 'before' }),
    slugify: (s) => s.toLowerCase().replace(/[^\wÀ-￿]+/g, '-').replace(/^-+|-+$/g, ''),
  });

const markdown = await readFile(SOURCE, 'utf8');
let body = md.render(markdown);

// The first <h1> is the document title, not a Part: exempt it from the
// page-break-before rule that the print stylesheet applies to every other h1.
body = body.replace(/<h1(\s[^>]*)?>/, (m, attrs = '') =>
  /class=/.test(attrs)
    ? m.replace(/class="([^"]*)"/, 'class="$1 doc-title"')
    : `<h1${attrs} class="doc-title">`);

const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${TITLE}</title>
<meta name="description" content="${DESCRIPTION}">
<meta name="author" content="${PUBLISHER}">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:type" content="article">
<link rel="stylesheet" href="style.css">
</head>
<body>
<div class="wrap">
  <header class="masthead">
    <p class="downloads"><a href="${PDF_NAME}" download>Download PDF</a></p>
  </header>
  <main>
${body}
  </main>
</div>
</body>
</html>
`;

await mkdir(OUT_DIR, { recursive: true });
await writeFile(resolve(OUT_DIR, 'index.html'), page, 'utf8');
await copyFile(resolve(HERE, 'style.css'), resolve(OUT_DIR, 'style.css'));
// Tell GitHub Pages not to run Jekyll over the output.
await writeFile(resolve(OUT_DIR, '.nojekyll'), '', 'utf8');
console.log(`HTML  -> _site/index.html (${(page.length / 1024).toFixed(0)} KB)`);

if (skipPdf) {
  console.log('PDF   -> skipped (--no-pdf)');
  process.exit(0);
}

/* ---------- HTML -> PDF ---------- */

const { default: puppeteer } = await import('puppeteer');

// Puppeteer ships no Linux/arm64 Chromium, so on an ARM machine (an Apple
// Silicon dev container, for instance) point at the distro's own build:
//   sudo apt-get install -y chromium
//   PUPPETEER_EXECUTABLE_PATH=$(which chromium) npm run build
// CI runners are x86-64 and need none of this.
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

const browser = await puppeteer.launch({
  executablePath,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});
try {
  const tab = await browser.newPage();
  await tab.goto('file://' + resolve(OUT_DIR, 'index.html'), { waitUntil: 'networkidle0' });

  const footer = `
    <div style="width:100%;font-family:system-ui,sans-serif;font-size:7.5pt;color:#6b727a;
                padding:0 18mm;display:flex;justify-content:space-between;">
      <span>ADERA — Automated Decentralized Energy Roaming Architecture · ${PUBLISHER}</span>
      <span class="pageNumber"></span>
    </div>`;

  await tab.pdf({
    path: resolve(OUT_DIR, PDF_NAME),
    format: 'A4',
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate: footer,
    margin: { top: '18mm', bottom: '20mm', left: '18mm', right: '18mm' },
  });
  console.log(`PDF   -> _site/${PDF_NAME}`);
} finally {
  await browser.close();
}
