import path from "path";
import { fileURLToPath } from "url";
import { promises as fs } from "fs";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const extensionRoot = path.resolve(__dirname, "..");
const srcDir = path.resolve(extensionRoot, "src");
const distDir = path.resolve(extensionRoot, "dist");

async function rmrf(dirPath) {
  await fs.rm(dirPath, { recursive: true, force: true });
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function walkDir(dirPath, visitor) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkDir(fullPath, visitor);
    } else if (entry.isFile()) {
      await visitor(fullPath);
    }
  }
}

function toDistPath(srcPath) {
  const rel = path.relative(srcDir, srcPath);
  return path.join(distDir, rel.replace(/\.jsx$/i, ".js"));
}

async function buildFile(srcPath) {
  const destPath = toDistPath(srcPath);
  await ensureDir(path.dirname(destPath));

  if (!srcPath.endsWith(".jsx")) {
    await fs.copyFile(srcPath, destPath);
    return;
  }

  const source = await fs.readFile(srcPath, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: path.basename(srcPath),
  });

  await fs.writeFile(destPath, compiled.outputText, "utf8");
}

await rmrf(distDir);
await ensureDir(distDir);
await walkDir(srcDir, buildFile);
