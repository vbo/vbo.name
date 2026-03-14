#!/usr/bin/env node
/**
 * Validation script for the Hexo site.
 * Checks that all internal links resolve and optionally validates external links.
 *
 * Usage: node tools/validate.js [--external]
 *   --external  Also check external URLs (slower)
 *
 * Run after build: npm run build && npm run validate
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const EXTERNAL_FLAG = process.argv.includes('--external');

// Read site root from Hexo _config.yml
let SITE_ROOT = '/vbo.name/';
try {
  const configPath = path.join(__dirname, '..', '_config.yml');
  const configStr = fs.readFileSync(configPath, 'utf8');
  const m = configStr.match(/^root:\s*["']?([^"'\s#]+)/m);
  if (m) SITE_ROOT = m[1].replace(/\/*$/, '/');
} catch {
  /* use default */
}

// Extract href and src from HTML
function extractLinks(html, basePath) {
  const links = [];
  const hrefRegex = /href=["']([^"']+)["']/g;
  const srcRegex = /src=["']([^"']+)["']/g;

  let m;
  while ((m = hrefRegex.exec(html))) links.push({ url: m[1], attr: 'href', basePath });
  while ((m = srcRegex.exec(html))) links.push({ url: m[1], attr: 'src', basePath });

  return links;
}

function isExternal(url) {
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//');
}

function isSpecial(url) {
  return url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('tel:') || url === '' || url.startsWith('javascript:');
}

function resolveInternalPath(linkUrl, fromPath) {
  if (linkUrl.startsWith(SITE_ROOT)) {
    const afterRoot = linkUrl.slice(SITE_ROOT.length).replace(/\/$/, '');
    return afterRoot ? afterRoot + '/' : '';
  }
  const fromDirAbs = path.join(PUBLIC_DIR, path.dirname(fromPath));
  const targetAbs = path.resolve(fromDirAbs, linkUrl);
  return path.relative(PUBLIC_DIR, targetAbs).replace(/\\/g, '/');
}

function findHtmlFiles(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findHtmlFiles(full, files);
    else if (e.name.endsWith('.html')) files.push(path.relative(PUBLIC_DIR, full).replace(/\\/g, '/'));
  }
  return files;
}

async function checkExternal(url) {
  try {
    const target = url.startsWith('//') ? 'https:' + url : url;
    const res = await fetch(target, { method: 'HEAD', redirect: 'follow' });
    return res.ok;
  } catch {
    return false;
  }
}

async function main() {
  if (!fs.existsSync(PUBLIC_DIR)) {
    console.error('public/ not found. Run npm run build first.');
    process.exit(1);
  }

  const htmlFiles = findHtmlFiles(PUBLIC_DIR);
  const broken = [];
  const externalChecked = new Map();
  const externalBroken = [];

  for (const file of htmlFiles) {
    const fullPath = path.join(PUBLIC_DIR, file);
    const html = fs.readFileSync(fullPath, 'utf8');
    const links = extractLinks(html, file);

    for (const { url, attr } of links) {
      if (isSpecial(url)) continue;

      if (isExternal(url)) {
        if (EXTERNAL_FLAG) {
          const cacheKey = url;
          if (!externalChecked.has(cacheKey)) {
            const ok = await checkExternal(url);
            externalChecked.set(cacheKey, ok);
            if (!ok) externalBroken.push({ file, url, attr });
          } else if (!externalChecked.get(cacheKey)) {
            externalBroken.push({ file, url, attr });
          }
        }
        continue;
      }

      // Internal link – resolve and check file exists
      const resolved = resolveInternalPath(url, file);
      const targetPath = path.join(PUBLIC_DIR, resolved);

      let exists = fs.existsSync(targetPath);
      if (!exists) {
        const idxPath = path.join(targetPath, 'index.html');
        exists = fs.existsSync(idxPath);
      }
      if (!exists) {
        const hashIdx = url.indexOf('#');
        const urlNoHash = hashIdx >= 0 ? url.slice(0, hashIdx) : url;
        if (hashIdx >= 0 && urlNoHash) {
          const resolvedNoHash = resolveInternalPath(urlNoHash, file);
          const targetNoHash = path.join(PUBLIC_DIR, resolvedNoHash);
          exists = fs.existsSync(targetNoHash) || fs.existsSync(path.join(targetNoHash, 'index.html'));
        }
      }
      if (!exists) {
        broken.push({ file, url: resolved, attr });
      }
    }
  }

  // Report
  let failed = false;

  if (broken.length > 0) {
    failed = true;
    console.error('\n❌ Broken internal links:\n');
    for (const { file, url, attr } of broken) {
      console.error(`  ${file} (${attr}="${url}")`);
    }
  }

  if (EXTERNAL_FLAG && externalBroken.length > 0) {
    failed = true;
    console.error('\n❌ Broken external links:\n');
    for (const { file, url, attr } of externalBroken) {
      console.error(`  ${file} (${attr}="${url}")`);
    }
  }

  if (!failed) {
    console.log(`✓ Validated ${htmlFiles.length} HTML files`);
    if (EXTERNAL_FLAG) console.log(`✓ Checked ${externalChecked.size} external URLs`);
  }

  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
