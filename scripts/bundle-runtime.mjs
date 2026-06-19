// Assembles a self-contained server runtime for the desktop app and drops it
// in packages/desktop/src-tauri/payload/ (a Tauri `bundle.resources` dir).
//
// Why not `pnpm deploy`: pnpm's isolated layout symlinks @meos/core into the
// virtual store and never materialises native binaries (better-sqlite3's
// .node, onnxruntime, sharp) — both break once copied into a read-only,
// cross-platform app bundle. Instead we generate a flat package.json with the
// union of core+server production deps, run a clean `npm install --omit=dev`
// (so npm builds/downloads the correct-arch native modules), vendor the built
// @meos/core in, and add a bundled Node runtime plus a pre-seeded embedding
// model so first launch works offline.
//
// Runs once per platform on its own CI runner (native modules can't be
// cross-compiled). Detects the host platform/arch unless overridden via
// --platform / --arch (handy for local testing of the current host).

import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(fileURLToPath(import.meta.url), "../..");
const pkgDir = (name) => path.join(root, "packages", name);
const desktop = path.join(root, "packages", "desktop", "src-tauri");
const payload = path.join(desktop, "payload");

// The Node runtime we ship to friends. Keep on an active LTS line.
const NODE_VERSION = process.env.MEOS_BUNDLE_NODE_VERSION ?? "22.12.0";
const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

function arg(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const platform = arg("platform", process.platform); // darwin | win32 | linux
const arch = arg("arch", process.arch); // arm64 | x64
const isWin = platform === "win32";
const hostIsWin = process.platform === "win32";

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);

  // Recent Node versions reject direct execution of .cmd/.bat files on Windows
  // through execFile/spawn without a shell. npm is exposed as npm.cmd there, so
  // run Windows command shims through cmd.exe while keeping normal executables
  // shell-free on every platform.
  if (hostIsWin && /\.(cmd|bat)$/i.test(cmd)) {
    execFileSync("cmd.exe", ["/d", "/s", "/c", cmd, ...args], { stdio: "inherit", ...opts });
    return;
  }

  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function npmCmd() {
  return hostIsWin ? "npm.cmd" : "npm";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry a flaky async step (network fetches against nodejs.org / HuggingFace
// regularly hit ETIMEDOUT on CI runners). Exponential backoff, then give up.
async function withRetries(label, fn, { attempts = 4, baseDelayMs = 2000 } = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === attempts) throw error;
      const delay = baseDelayMs * 2 ** (attempt - 1);
      console.warn(
        `${label} failed (attempt ${attempt}/${attempts}): ${error.message}\n` +
          `Retrying in ${delay / 1000}s…`,
      );
      await sleep(delay);
    }
  }
}

async function readJson(p) {
  return JSON.parse(await fs.readFile(p, "utf-8"));
}

function resolveFromApp(app, specifier) {
  return require.resolve(specifier, { paths: [app] });
}

async function findFilesByName(dir, filename, acc = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await findFilesByName(fullPath, filename, acc);
    } else if (entry.isFile() && entry.name === filename) {
      acc.push(fullPath);
    }
  }
  return acc;
}

async function fileExists(p) {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

async function restoreCompatibleOnnxRuntimePayload(packageDir, expectedBinding) {
  const candidates = await findFilesByName(packageDir, "onnxruntime_binding.node");
  const compatible = candidates.find((candidate) => {
    const parts = candidate.split(path.sep);
    return parts.includes("darwin") && parts.includes("x64");
  });

  if (!compatible) {
    if (candidates.length > 0) {
      console.warn(
        `Found onnxruntime native candidates, but none for darwin/x64:\n${candidates.join("\n")}`,
      );
    }
    return false;
  }

  const sourceDir = path.dirname(compatible);
  const targetDir = path.dirname(expectedBinding);
  await fs.mkdir(targetDir, { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
  console.warn(`Restored onnxruntime native payload from ${sourceDir} to ${targetDir}.`);
  return fileExists(expectedBinding);
}

async function ensureOnnxRuntimeNativeBinary(app) {
  // onnxruntime-node officially supports macOS x64 prebuilt binaries, but some
  // npm installs leave the package present without the exact N-API folder that
  // binding.js requires. When a compatible darwin/x64 payload exists under a
  // different napi-v* folder, copy the full native payload into the expected one.
  if (platform !== "darwin" || arch !== "x64") return;

  const packageJson = resolveFromApp(app, "onnxruntime-node/package.json");
  const packageDir = path.dirname(packageJson);
  const pkg = await readJson(packageJson);
  const binding = path.join(
    packageDir,
    "bin",
    "napi-v6",
    "darwin",
    "x64",
    "onnxruntime_binding.node",
  );

  if (await fileExists(binding)) return;
  if (await restoreCompatibleOnnxRuntimePayload(packageDir, binding)) return;

  console.warn(
    `onnxruntime-node native binary missing at ${binding}; rebuilding ${pkg.name}@${pkg.version}.`,
  );
  run(npmCmd(), ["rebuild", "onnxruntime-node", "--foreground-scripts"], { cwd: app });
  if (await fileExists(binding)) return;
  if (await restoreCompatibleOnnxRuntimePayload(packageDir, binding)) return;

  console.warn(
    `onnxruntime-node rebuild did not restore the native binary; reinstalling ${pkg.name}@${pkg.version}.`,
  );
  run(
    npmCmd(),
    ["install", `${pkg.name}@${pkg.version}`, "--no-audit", "--no-fund", "--foreground-scripts"],
    { cwd: app },
  );

  if (await fileExists(binding)) return;
  if (await restoreCompatibleOnnxRuntimePayload(packageDir, binding)) return;

  const candidates = await findFilesByName(packageDir, "onnxruntime_binding.node");
  throw new Error(
    `onnxruntime-node native binary is still missing after rebuild/reinstall: ${binding}` +
      (candidates.length
        ? `\nAvailable candidates:\n${candidates.join("\n")}`
        : "\nNo onnxruntime_binding.node candidates were found."),
  );
}

// ---------------------------------------------------------------------------
// 1. Reset the payload dir.
// ---------------------------------------------------------------------------
async function resetPayload() {
  await fs.rm(payload, { recursive: true, force: true });
  await fs.mkdir(path.join(payload, "app"), { recursive: true });
}

// ---------------------------------------------------------------------------
// 2. Flat prod install of the union of core + server runtime deps.
// ---------------------------------------------------------------------------
async function installRuntimeDeps() {
  const core = await readJson(path.join(pkgDir("core"), "package.json"));
  const server = await readJson(path.join(pkgDir("server"), "package.json"));
  // wiki-mcp is vendored too (it's spawned as the agent's meOS MCP server), so
  // fold in its runtime deps (the MCP SDK) — otherwise it can't resolve them.
  const wikiMcp = await readJson(path.join(pkgDir("wiki-mcp"), "package.json"));
  const deps = { ...core.dependencies, ...server.dependencies, ...wikiMcp.dependencies };
  // Workspace packages are vendored locally below, not pulled from a registry.
  delete deps["@meos/core"];
  delete deps["@meos/contracts"];
  delete deps["@meos/wiki-mcp"];

  const app = path.join(payload, "app");
  await fs.writeFile(
    path.join(app, "package.json"),
    JSON.stringify(
      {
        name: "meos-runtime",
        private: true,
        version: core.version,
        type: "module",
        dependencies: deps,
      },
      null,
      2,
    ),
  );
  // A clean install builds native modules for the runner's platform/arch.
  // better-sqlite3's prebuilt is ABI-bound, so the host Node running this
  // script MUST match the Node we bundle (NODE_VERSION) — CI pins setup-node to
  // it; locally, override with MEOS_BUNDLE_NODE_VERSION. Guard against a
  // silent mismatch that would only surface as ERR_DLOPEN_FAILED at runtime.
  const hostMajor = process.versions.node.split(".")[0];
  const bundleMajor = NODE_VERSION.split(".")[0];
  if (hostMajor !== bundleMajor) {
    throw new Error(
      `host Node ${process.versions.node} != bundled Node ${NODE_VERSION}: native ABI would mismatch. ` +
        `Run under Node ${bundleMajor}.x or set MEOS_BUNDLE_NODE_VERSION to ${hostMajor}.x.`,
    );
  }
  run(npmCmd(), ["install", "--omit=dev", "--no-audit", "--no-fund"], { cwd: app });
  await ensureOnnxRuntimeNativeBinary(app);
}

// ---------------------------------------------------------------------------
// 3. Vendor the built @meos/core and copy server + web builds into place.
// ---------------------------------------------------------------------------
async function vendorBuilds() {
  const app = path.join(payload, "app");
  const coreDest = path.join(app, "node_modules", "@meos", "core");
  await fs.mkdir(coreDest, { recursive: true });
  await fs.cp(path.join(pkgDir("core"), "dist"), path.join(coreDest, "dist"), { recursive: true });
  await fs.cp(path.join(pkgDir("core"), "package.json"), path.join(coreDest, "package.json"));

  // @meos/contracts: the shared API schemas the server imports at runtime.
  const contractsDest = path.join(app, "node_modules", "@meos", "contracts");
  await fs.mkdir(contractsDest, { recursive: true });
  await fs.cp(path.join(pkgDir("contracts"), "dist"), path.join(contractsDest, "dist"), {
    recursive: true,
  });
  await fs.cp(
    path.join(pkgDir("contracts"), "package.json"),
    path.join(contractsDest, "package.json"),
  );

  // @meos/wiki-mcp: the stdio MCP server the coding agent spawns to reach the
  // meOS wiki/knowledge tools. Resolved at runtime via require.resolve.
  const wikiMcpDest = path.join(app, "node_modules", "@meos", "wiki-mcp");
  await fs.mkdir(wikiMcpDest, { recursive: true });
  await fs.cp(path.join(pkgDir("wiki-mcp"), "dist"), path.join(wikiMcpDest, "dist"), {
    recursive: true,
  });
  await fs.cp(
    path.join(pkgDir("wiki-mcp"), "package.json"),
    path.join(wikiMcpDest, "package.json"),
  );

  await fs.cp(path.join(pkgDir("server"), "dist"), path.join(app, "server", "dist"), {
    recursive: true,
  });
  await fs.cp(path.join(pkgDir("web"), "dist"), path.join(app, "web"), { recursive: true });
}

// ---------------------------------------------------------------------------
// 4. Download a Node runtime for the target platform/arch.
// ---------------------------------------------------------------------------
async function bundleNode() {
  const runtime = path.join(payload, "runtime");
  await fs.mkdir(runtime, { recursive: true });
  const plat = platform === "darwin" ? "darwin" : isWin ? "win" : "linux";
  const ext = isWin ? "zip" : plat === "darwin" ? "tar.gz" : "tar.xz";
  const name = `node-v${NODE_VERSION}-${plat}-${arch}`;
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}.${ext}`;
  const tmp = path.join(os.tmpdir(), `${name}.${ext}`);

  console.log(`Downloading ${url}`);
  await withRetries(`Node download (${url})`, async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Node download failed: ${res.status} ${url}`);
    await pipeline(res.body, createWriteStream(tmp));
  });

  const extractDir = await fs.mkdtemp(path.join(os.tmpdir(), "meos-node-"));
  run("tar", ["-xf", tmp, "-C", extractDir]); // bsdtar (mac/win) and GNU tar both handle zip/xz
  const binSrc = isWin
    ? path.join(extractDir, name, "node.exe")
    : path.join(extractDir, name, "bin", "node");
  const binDest = path.join(runtime, isWin ? "node.exe" : "node");
  await fs.copyFile(binSrc, binDest);
  if (!isWin) await fs.chmod(binDest, 0o755);
}

// ---------------------------------------------------------------------------
// 5. Pre-seed the embedding model so first launch needs no network.
// ---------------------------------------------------------------------------
async function seedModel() {
  const models = path.join(payload, "models");
  const transformers = resolveFromApp(path.join(payload, "app"), "@huggingface/transformers");
  const transformersSpecifier = pathToFileURL(transformers).href;
  const script = `
    import { pipeline, env } from ${JSON.stringify(transformersSpecifier)};
    env.cacheDir = ${JSON.stringify(models)};
    await pipeline("feature-extraction", ${JSON.stringify(EMBED_MODEL)});
    console.log("model cached");
  `;
  // The HuggingFace CDN fetch flakes with ETIMEDOUT on CI; retry before failing
  // the whole bundle. Clear any partial cache between attempts so a half-written
  // model can't poison the retry.
  await withRetries(`seed embedding model (${EMBED_MODEL})`, async () => {
    await fs.rm(models, { recursive: true, force: true });
    await fs.mkdir(models, { recursive: true });
    run(process.execPath, ["--input-type=module", "-e", script]);
  });
}

// ---------------------------------------------------------------------------
// 6. Fail loudly if a critical native binary didn't materialise.
// ---------------------------------------------------------------------------
async function verify() {
  const app = path.join(payload, "app");
  const checks = [
    path.join(app, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
    path.join(app, "node_modules", "@meos", "core", "dist", "index.js"),
    path.join(app, "server", "dist", "main.js"),
    path.join(app, "web", "index.html"),
    path.join(payload, "runtime", isWin ? "node.exe" : "node"),
  ];
  for (const c of checks) {
    await fs.access(c).catch(() => {
      throw new Error(`bundle verification failed — missing: ${c}`);
    });
  }
  let size = "";
  try {
    size = ` (${execFileSync("du", ["-sh", payload]).toString().trim().split("\t")[0]})`;
  } catch {
    // du is absent on Windows; size is informational only.
  }
  console.log(`\n✓ payload assembled${size}`);
}

async function main() {
  console.log(`Bundling runtime for ${platform}/${arch} (Node ${NODE_VERSION})`);
  await resetPayload();
  await installRuntimeDeps();
  await vendorBuilds();
  await bundleNode();
  await seedModel();
  await verify();
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}`);
  process.exit(1);
});
