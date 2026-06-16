# meOS landing page

A standalone marketing site for [meOS](https://github.com/alaaeddine-ahriz/meOS). It is
**independent** of the main app (its own `package.json`, not part of the pnpm workspace) so you
can deploy it anywhere.

Built with Vite + React + TypeScript + Tailwind v4. Layout is inspired by
[vite.dev](https://vite.dev); the palette is meOS's own warm "candlelight" theme, with light and
dark mode.

## Develop

```sh
cd landing
pnpm install   # or npm install
pnpm dev       # http://localhost:5173
```

## Build

```sh
pnpm build     # type-checks, then emits static files to dist/
pnpm preview   # serve the production build locally
```

Deploy the `dist/` folder to any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages, …).

## Deploy to GitHub Pages

This repo ships a workflow at [`.github/workflows/deploy-landing.yml`](../.github/workflows/deploy-landing.yml)
that builds this folder and publishes it to GitHub Pages on every push to `main` that touches
`landing/**` (and on manual dispatch).

One-time setup: in **Settings → Pages**, set **Source: GitHub Actions**. The site then publishes to
`https://alaaeddine-ahriz.github.io/meOS/`.

Because project pages are served under `/<repo>/`, the workflow builds with `BASE_PATH=/meOS/` so
asset URLs resolve. Locally (and on a root domain) the base stays `/`.

## Editing

- **Links** (the GitHub URL, site name, tagline) live in `src/lib/site.ts`.
- **Colors / light + dark theme** live in `src/index.css` (`:root` and `.dark`).
- **Brand logos** live in `src/lib/logos.tsx`; the full-colour SVGs are generated into
  `src/lib/brandSvgs.ts`.
- **Sections** are one file each in `src/components/` (`Hero`, `Features`, `Showcase`,
  `Integrations`, `Steps`, `Faq`, `FinalCta`, `Footer`).
