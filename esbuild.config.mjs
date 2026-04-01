import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";

const isWatch = process.argv.includes("--watch");
const isProduction = process.argv.includes("--production");

/** Plugin that copies static assets (CSS) to dist. */
const copyAssetsPlugin = {
  name: "copy-assets",
  setup(build) {
    build.onEnd(() => {
      const distDir = "dist";
      if (!fs.existsSync(distDir)) fs.mkdirSync(distDir, { recursive: true });
      fs.copyFileSync(
        path.join("src", "webview", "styles.css"),
        path.join(distDir, "styles.css"),
      );
      fs.copyFileSync(
        path.join("src", "webview", "sidebar.css"),
        path.join(distDir, "sidebar.css"),
      );
    });
  },
};

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  external: ["vscode", "node-pty"],
  sourcemap: !isProduction,
  minify: isProduction,
  target: "es2020",
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ["src/webview/main.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  external: ["vscode"],
  sourcemap: !isProduction,
  minify: isProduction,
  target: "es2020",
  plugins: [copyAssetsPlugin],
};

/** @type {import('esbuild').BuildOptions} */
const sidebarConfig = {
  entryPoints: ["src/webview/sidebarMain.ts"],
  bundle: true,
  outfile: "dist/sidebar.js",
  platform: "browser",
  format: "iife",
  external: ["vscode"],
  sourcemap: !isProduction,
  minify: isProduction,
  target: "es2020",
};

async function main() {
  if (isWatch) {
    const extCtx = await esbuild.context(extensionConfig);
    const webCtx = await esbuild.context(webviewConfig);
    const sbCtx = await esbuild.context(sidebarConfig);
    await Promise.all([extCtx.watch(), webCtx.watch(), sbCtx.watch()]);
    console.log("Watching for changes...");
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(webviewConfig),
      esbuild.build(sidebarConfig),
    ]);
    console.log("Build complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
