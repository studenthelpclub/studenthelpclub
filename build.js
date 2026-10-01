// Student Help Club: build-time blog + sitemap generator.
// Runs on every Vercel deploy (npm run build). Scans the root *.html files,
// writes blog.html (from blog-template.html) and sitemap.xml.
// A page is listed in the sitemap if it is indexable (no noindex, not blocked
// in robots.txt). A page appears as a blog card if it has Article/BlogPosting
// JSON-LD with a headline. Nothing needs to be edited by hand when adding a page.
const fs = require('fs');
const path = require('path');

const SITE = 'https://www.studenthelpclub.in';
// Folder that holds the site's .html files, relative to this file. '.' = repo root.
// If the site files live in another folder (for example 'public'), change it here.
const SITE_DIR = '.';
const ROOT = path.resolve(__dirname, SITE_DIR);
const SKIP_FILES = new Set(['blog-template.html', '404.html']);

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function unesc(s) {
  return String(s).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function disallowed() {
  try {
    const t = fs.readFileSync(path.join(ROOT, 'robots.txt'), 'utf8');
    const out = [];
    let all = false;
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^\s*(user-agent|disallow)\s*:\s*(.*?)\s*$/i);
      if (!m) continue;
      if (m[1].toLowerCase() === 'user-agent') all = m[2] === '*';
      else if (all && m[2]) out.push(m[2]);
    }
    return out;
  } catch (e) { return []; }
}
function jsonLdItems(html) {
  const items = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      const j = JSON.parse(m[1]);
      for (const x of (Array.isArray(j) ? j : [j])) {
        if (x && Array.isArray(x['@graph'])) items.push(...x['@graph']); else items.push(x);
      }
    } catch (e) { /* ignore bad JSON-LD on one page */ }
  }
  return items;
}
function metaContent(html, name) {
  const a = html.match(new RegExp('<meta[^>]*name=["\']' + name + '["\'][^>]*content=["\']([^"\']*)["\']', 'i'));
  const b = html.match(new RegExp('<meta[^>]*content=["\']([^"\']*)["\'][^>]*name=["\']' + name + '["\']', 'i'));
  return (a || b) ? unesc((a || b)[1]) : '';
}
function isoDate(v) {
  if (!v) return '';
  const m = String(v).match(/^\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : '';
}
function prettyDate(iso) {
  if (!iso) return '';
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const [y, mo, d] = iso.split('-').map(Number);
  return d + ' ' + months[mo - 1] + ' ' + y;
}

function main() {
  const blocked = disallowed();
  const files = fs.readdirSync(ROOT).filter(f => f.endsWith('.html') && !SKIP_FILES.has(f) && !/^google[0-9a-z]+\.html$/i.test(f)).sort((a, b) => (a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b)));
  const pages = [];
  for (const f of files) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const robots = metaContent(html, 'robots').toLowerCase();
    if (robots.includes('noindex')) continue;
    const urlPath = f === 'index.html' ? '/' : '/' + f;
    if (blocked.some(p => urlPath.startsWith(p))) continue;
    const ld = jsonLdItems(html);
    const art = ld.find(x => x && ['Article', 'BlogPosting', 'NewsArticle'].includes(Array.isArray(x['@type']) ? x['@type'][0] : x['@type']));
    pages.push({
      file: f, urlPath, art,
      lastmod: art ? (isoDate(art.dateModified) || isoDate(art.datePublished)) : '',
      title: art ? unesc(art.headline || '') : '',
      desc: art ? unesc(art.description || metaContent(html, 'description')) : '',
      published: art ? isoDate(art.datePublished) : '',
    });
  }

  // sitemap.xml (blog.html is included because it is a normal indexable page)
  const urls = pages.map(p => {
    let x = '  <url>\n    <loc>' + SITE + (p.urlPath === '/' ? '/' : p.urlPath) + '</loc>\n';
    if (p.lastmod) x += '    <lastmod>' + p.lastmod + '</lastmod>\n';
    return x + '  </url>';
  });
  if (!pages.some(p => p.file === 'blog.html') && fs.existsSync(path.join(ROOT, 'blog-template.html'))) {
    urls.push('  <url>\n    <loc>' + SITE + '/blog.html</loc>\n  </url>');
  }
  const sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.join('\n') + '\n</urlset>\n';

  // blog.html
  const posts = pages.filter(p => p.art && p.title).sort((a, b) =>
    (b.published || '').localeCompare(a.published || '') || a.file.localeCompare(b.file));
  const CODE = /^([A-Z]{2,6}-\d{1,3})\b/;
  const card = p => {
    const m = p.title.match(CODE);
    return '<article class="blog-card"><span class="card-num' + (m ? '' : ' tip') + '">' + esc(m ? m[1] : 'Checklist') + '</span><h2><a href="' + esc(p.file) + '">' + esc(p.title) + '</a></h2>' +
      (p.desc ? '<p>' + esc(p.desc) + '</p>' : '') +
      '<p class="meta">' + esc(prettyDate(p.published)) + '</p>' +
      '<a class="read-link" href="' + esc(p.file) + '" aria-label="' + esc('Padhein: ' + p.title) + '">Poori guide padhein →</a></article>';
  };
  const courseGuides = posts.filter(p => CODE.test(p.title));
  const checklists = posts.filter(p => !CODE.test(p.title));
  const group = (title, sub, list) => list.length ? '<h2 class="group-title">' + title + '</h2><p class="group-sub">' + sub + '</p><div class="grid">' + list.map(card).join('') + '</div>' : '';
  const cards = group('Subject-code guides', 'Course code ke hisaab se study process, topic groups aur original answer planning.', courseGuides) +
    group('Student checklists', 'Study PDF, dates, exam form aur re-evaluation jaise practical topics.', checklists);
  const tplPath = path.join(ROOT, 'blog-template.html');
  if (!fs.existsSync(tplPath)) throw new Error('blog-template.html not found in ' + ROOT);
  const tpl = fs.readFileSync(tplPath, 'utf8');
  if (!tpl.includes('<!--SHC_POSTS-->')) throw new Error('blog-template.html has no <!--SHC_POSTS--> marker');
  if (!posts.length) throw new Error('no pages with Article JSON-LD found, so the blog would be empty');
  fs.writeFileSync(path.join(ROOT, 'blog.html'), tpl.replace('<!--SHC_COUNT-->', String(posts.length)).replace('<!--SHC_POSTS-->', cards).replace('<meta name="robots" content="noindex,follow">', '<meta name="robots" content="index,follow">'));
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), sitemap);
  console.log('SHC build: ' + pages.length + ' sitemap URLs, ' + posts.length + ' blog cards');
}

try { main(); } catch (e) {
  // Fail loudly: the deploy turns red in Vercel and the last good version stays live.
  // Nothing is overwritten when this happens (files are written only at the very end).
  console.error('SHC build FAILED: ' + e.message);
  process.exit(1);
}
