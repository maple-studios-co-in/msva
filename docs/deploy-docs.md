# Deploying the docs site

The docs site is VitePress, sourced from `docs/`, built by `@msva/docs`, hosted on Cloudflare Pages.

## Local

```bash
pnpm install                # one-time
pnpm dev:docs               # http://localhost:5174
pnpm build:docs             # outputs to docs/.vitepress/dist
```

## Cloudflare Pages — first-time setup

1. **Push the repo to GitHub** (or GitLab) if it isn't already.
2. In the Cloudflare dashboard → Workers & Pages → Create application → Pages → Connect to Git.
3. Pick the MSVA repo.
4. Build configuration:
   - **Framework preset:** None (we run pnpm directly).
   - **Build command:** `pnpm install --frozen-lockfile && pnpm build:docs`
   - **Build output directory:** `docs/.vitepress/dist`
   - **Root directory:** *(leave blank — repo root)*
   - **Environment variables:**
     - `NODE_VERSION` = `22`
     - `PNPM_VERSION` = `10.6.4`
5. Click Save and Deploy. First build takes ~2 min.
6. Once green, you'll get a `<project>.pages.dev` URL. Custom domain in Pages → Custom domains.

## Deploy from the CLI (optional)

If you'd rather push from a laptop or CI runner instead of relying on the Git integration:

```bash
pnpm dlx wrangler pages deploy docs/.vitepress/dist \
  --project-name msva-docs \
  --branch main
```

You'll need `wrangler login` first.

## Branch previews

Cloudflare auto-builds a preview deploy for every branch. The URL format is `https://<branch>.<project>.pages.dev`. Useful for reviewing docs changes in PRs before merging.

## Updating the site

Cloudflare rebuilds on every push to `main`. To trigger a rebuild without a code change, push an empty commit or hit "Retry deployment" in the dashboard.

## Custom domain

In Pages → your project → Custom domains → Set up. Cloudflare handles the TLS cert. If the domain is already on Cloudflare DNS, it's a one-click setup.

## Headers / redirects

VitePress emits a static site, so any `_headers` or `_redirects` files placed in `docs/public/` get copied into the build output and respected by Cloudflare Pages. Useful for adding security headers (CSP, X-Frame-Options, etc.) once the site is live.
