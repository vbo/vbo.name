# vbo.name

My personal blog/site built with [Hexo](https://hexo.io/), using the [Apollo](https://github.com/pinggod/hexo-theme-apollo) theme.

## Build and run locally

**Requirements:** Node.js 22+

```bash
# Install dependencies
npm install

# Build the static site (outputs to public/)
npm run build

# Start the dev server at http://localhost:4000
npm run server
```

Additional scripts:
- `npm run clean` — removes the generated files and cache before a fresh build
- `npm run validate` — checks internal links (run after build). Use `--external` to also check external URLs: `npm run validate -- --external`

Internal links in posts use `__ROOT__path/to/page/` in markdown; a build step rewrites them to proper relative paths per page so the site works from any base URL (local, GitHub Pages, custom domain).

## Deployment

The site is deployed to [GitHub Pages](https://vbo.github.io/vbo.name/) via GitHub Actions. Custom domain: [vbo.name](https://vbo.name).

**How it works:**

1. On every push to the `master` branch, the [workflow](.github/workflows/pages.yml) runs.

2. **Build job:**
   - Checks out the repo
   - Sets up Node.js 22
   - Runs `npm ci`, `npm run build`, and `npm run validate`
   - Uploads the `public/` folder as a GitHub Pages artifact

3. **Deploy job:**
   - Runs after the build succeeds
   - Uses `actions/deploy-pages` to publish the artifact to GitHub Pages

4. **GitHub Pages** must be configured to use GitHub Actions as the source (Settings → Pages → Build and deployment → Source: GitHub Actions).
