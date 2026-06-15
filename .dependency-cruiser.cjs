/* eslint-disable */
// =============================================================================
// meOS — Package boundaries & dependency direction (dependency-cruiser)
// -----------------------------------------------------------------------------
// This config encodes the architectural rules from issue #24. It is the single
// source of truth for how the four workspace packages may depend on each other.
// The `boundaries` npm script runs it locally and in CI so violations fail fast.
//
// Allowed dependency direction
// ----------------------------
//   core     domain/runtime-agnostic; depends on NOTHING in this monorepo.
//   server   may depend on `core`.
//   web      talks to the server ONLY over HTTP (see packages/web/src/api.ts).
//            It must NOT import @meos/server or @meos/core (source or built).
//   desktop  owns shell/lifecycle only (Tauri); no app-package source imports.
//
// Enforced rules (see `forbidden` below)
// --------------------------------------
//   1. core-stays-agnostic        core   -/->  server | web | desktop
//   2. server-no-frontend         server -/->  web | desktop
//   3. web-is-http-only           web    -/->  @meos/server | @meos/core
//   4. no-deep-cross-package      cross-package imports must hit a package's
//                                 public entry (`@meos/core`), never
//                                 `@meos/core/src/...` or `@meos/core/dist/...`.
//                                 (This rule is OWNED by this PR; the lint PR
//                                 #20 deliberately left it out.)
//   5. no-circular                circular dependencies across modules error.
//
// Package public APIs are explicit: each package.json declares an `exports`/
// `main`/`types` entry, so the only supported way in is the barrel.
// =============================================================================

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // -------------------------------------------------------------------------
    // 1. core must stay domain/runtime-agnostic.
    // -------------------------------------------------------------------------
    {
      name: "core-stays-agnostic",
      comment:
        "packages/core is the domain layer and must not depend on server, web, or desktop " +
        "(neither @meos/* packages nor their source paths).",
      severity: "error",
      from: { path: "^packages/core/src" },
      to: {
        path: [
          "^packages/(server|web|desktop)",
          // Resolved through node_modules, OR the bare/unresolved @meos specifier.
          "(^|[/]node_modules[/])@meos[/](server|web|desktop)",
        ],
      },
    },

    // -------------------------------------------------------------------------
    // 2. server may depend on core, but never on the frontend/shell.
    // -------------------------------------------------------------------------
    {
      name: "server-no-frontend",
      comment: "packages/server must not depend on the web frontend or the desktop shell.",
      severity: "error",
      from: { path: "^packages/server/src" },
      to: {
        path: ["^packages/(web|desktop)", "(^|[/]node_modules[/])@meos[/](web|desktop)"],
      },
    },

    // -------------------------------------------------------------------------
    // 3. web is HTTP-only: it must not import any @meos/* package.
    //    The web<->server contract lives in packages/web/src/api.ts over HTTP.
    // -------------------------------------------------------------------------
    {
      name: "web-is-http-only",
      comment:
        "packages/web must talk to the server over HTTP (packages/web/src/api.ts) and must " +
        "not import @meos/server or @meos/core (source or built output).",
      severity: "error",
      from: { path: "^packages/web/src" },
      to: {
        path: ["^packages/(server|core)", "(^|[/]node_modules[/])@meos[/](server|core)"],
      },
    },

    // -------------------------------------------------------------------------
    // 4. No deep imports across @meos/* package boundaries.
    //    Cross-package imports must resolve through the package's public entry
    //    (e.g. `@meos/core`), never a deep `@meos/core/src/...` /
    //    `@meos/core/dist/...` path, and never a relative reach into a sibling
    //    package's source tree.
    // -------------------------------------------------------------------------
    {
      name: "no-deep-cross-package",
      comment:
        "Cross-package imports must use a package's public entry (e.g. `@meos/core`), not a " +
        "deep `@meos/<pkg>/src/...` / `@meos/<pkg>/dist/...` specifier, and not a relative " +
        "path that reaches into another package's source tree.",
      severity: "error",
      from: { path: "^packages/([^/]+)/src" },
      to: {
        path: [
          // Deep import of a built/source subpath behind the package entry,
          // resolved through node_modules or as a bare `@meos/<pkg>/...` specifier.
          "(^|[/]node_modules[/])@meos[/][^/]+[/].+",
        ],
      },
    },
    {
      name: "no-cross-package-relative",
      comment:
        "A module in one package must not reach into another package's source via a relative " +
        "path; use the sibling package's public entry (e.g. `@meos/core`) instead.",
      severity: "error",
      from: { path: "^packages/([^/]+)/src" },
      to: {
        path: "^packages/(?!$1)([^/]+)/src",
        pathNot: "^packages/$1/src",
      },
    },

    // -------------------------------------------------------------------------
    // 5. Circular dependencies.
    //    Cross-package cycles are an ERROR (they create implicit, bidirectional
    //    coupling between packages). Cycles confined to a single package are a
    //    WARNING: barrel re-export cycles are common in this codebase and the
    //    eslint config (`import/no-cycle`) already flags them as warnings.
    // -------------------------------------------------------------------------
    {
      name: "no-circular-cross-package",
      comment:
        "A circular dependency crosses a @meos package boundary; this makes packages mutually " +
        "dependent and must be broken.",
      severity: "error",
      from: { path: "^packages/([^/]+)/src" },
      to: {
        circular: true,
        // Fire only when some module in the cycle lives OUTSIDE the package the
        // cycle started in (i.e. the cycle crosses a package boundary).
        viaSomeNot: "^packages/$1/(src|dist)",
      },
    },
    {
      name: "no-circular-within-package",
      comment:
        "Circular dependency within a single package (often a barrel re-export cycle). Prefer to " +
        "break it, but kept as a warning to match the eslint `import/no-cycle` policy.",
      severity: "warn",
      from: { path: "^packages/([^/]+)/src" },
      to: {
        circular: true,
        // Every module in the cycle stays inside the starting package.
        via: "^packages/$1/(src|dist)",
      },
    },
  ],

  options: {
    // Only follow first-party source; never crawl into vendored code we don't own.
    doNotFollow: {
      path: ["node_modules", "dist"],
    },

    // Paths excluded from the crawl entirely (build output, data, generated).
    exclude: {
      path: [
        "node_modules",
        "(^|/)dist/",
        "(^|/)data/",
        "packages/desktop/src-tauri/target/",
        "packages/desktop/src-tauri/gen/",
      ],
    },

    // Resolve @meos/* workspace aliases and TS path/extension rules via the
    // package tsconfigs so cross-package edges are detected accurately.
    tsConfig: {
      fileName: "tsconfig.base.json",
    },
    tsPreCompilationDeps: true,

    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      extensions: [".js", ".jsx", ".ts", ".tsx", ".json"],
    },

    // @meos/* packages resolve to built dist/ output (absent before `pnpm build`);
    // dependency-cruiser still detects the @meos/* specifier from node_modules
    // symlinks, which is all the boundary rules need.
    combinedDependencies: true,

    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
