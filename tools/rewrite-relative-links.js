#!/usr/bin/env node
/**
 * Post-processes generated HTML to replace root-relative links (e.g. /vbo.name/page/)
 * with proper relative paths (e.g. ../../../page/) so links work from any base URL.
 *
 * Run after hexo generate, before validate. Called automatically from build script.
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

let SITE_ROOT = '/vbo.name/';
try {
  const configPath = path.join(__dirname, '..', '_config.yml');
  const configStr = fs.readFileSync(configPath, 'utf8');
  const m = configStr.match(/^root:\s*["']?([^"'\s#]+)/m);
  if (m) SITE_ROOT = m[1].replace(/\/*$/, '/');
} catch {
  /* use default */
}

function findHtmlFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findHtmlFiles(full, files);
    else if (e.name.endsWith('.html'))
      files.push(path.relative(PUBLIC_DIR, full).replace(/\\/g, '/'));
  }
  return files;
}

function rewriteLinks(html, depth) {
  const prefix = depth === 0 ? '' : '../'.repeat(depth);

  // href="/vbo.name/path" or href="/vbo.name/path/" → href="../../../path/"
  const rootEscaped = SITE_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(
    `(href|src)=(["'])${rootEscaped}([^"']*?)(["'])`,
    'g'
  );
  return html.replace(regex, (_, attr, q1, subpath, q2) => {
    if (subpath.startsWith('/')) return _; // protocol-relative url (//...)
    const p = subpath.replace(/\/+$/, '') || '';
    const rel = p ? `${prefix}${p}/` : (prefix.replace(/\/$/, '') || './');
    return `${attr}=${q1}${rel}${q2}`;
  });
}

function main() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    console.error('public/ not found. Run hexo generate first.');
    process.exit(1);
  }

  const files = findHtmlFiles(PUBLIC_DIR);
  let count = 0;

  for (const file of files) {
    const fullPath = path.join(PUBLIC_DIR, file);
    const dir = path.dirname(file);
    const depth = dir === '.' ? 0 : dir.split('/').length;

    let html = fs.readFileSync(fullPath, 'utf8');
    const original = html;
    html = rewriteLinks(html, depth);

    if (html !== original) {
      fs.writeFileSync(fullPath, html);
      count++;
    }
  }

  if (count > 0) {
    console.log(`Rewrote root-relative links in ${count} file(s)`);
  }
}

main();
