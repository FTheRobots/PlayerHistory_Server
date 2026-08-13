import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import caxa from '@cdxgen/caxa';
import { readProductVersion, releaseExeName } from './productVersion.mjs';
import { setWinIcon } from './setWinIcon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');
const buildDir = path.join(projectRoot, 'build');

const product = readProductVersion(projectRoot);
const versionedName = releaseExeName('Server', product);
const outputExe = path.join(releaseDir, versionedName);
const leftoverGeneric = path.join(releaseDir, 'PlayerHistory-Server.exe');

if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
}

const label = product.codename ? `v${product.version} (“${product.codename}”)` : `v${product.version}`;
console.log(`[pack] Building portable server exe ${label} → ${versionedName}`);

const iconPath = path.join(buildDir, 'icon.ico');
const caxaStub = path.join(
  projectRoot,
  'node_modules',
  '@cdxgen',
  'caxa',
  'stubs',
  `stub--${process.platform}--${process.arch}`
);

let stub = fs.existsSync(caxaStub) ? caxaStub : undefined;
if (fs.existsSync(iconPath) && stub) {
  fs.mkdirSync(buildDir, { recursive: true });
  const iconedStub = path.join(buildDir, 'caxa-stub.exe');
  fs.copyFileSync(stub, iconedStub);
  try {
    setWinIcon(iconedStub, iconPath);
    stub = iconedStub;
    console.log(`[pack] Icon applied to caxa stub`);
  } catch (err) {
    console.warn(`[pack] Could not icon caxa stub: ${err instanceof Error ? err.message : err}`);
    stub = caxaStub;
  }
} else if (!fs.existsSync(iconPath)) {
  console.warn(`[pack] No icon at ${iconPath} — leaving default stub icon`);
}

await caxa({
  input: projectRoot,
  output: outputExe,
  force: true,
  ...(stub ? { stub } : {}),
  exclude: [
    'src',
    'release',
    '.git',
    'scripts',
    '*.ts',
    'tsconfig.json',
    'config.json',
    'README.md',
    'build',
    'build-server.bat',
    'start-server.bat',
  ],
  command: ['{{caxa}}/node_modules/.bin/node', '{{caxa}}/dist/index.js'],
});

if (fs.existsSync(leftoverGeneric)) {
  fs.unlinkSync(leftoverGeneric);
}

const exampleSrc = path.join(projectRoot, 'config.example.json');
const exampleDest = path.join(releaseDir, 'config.example.json');
if (fs.existsSync(exampleSrc)) {
  fs.copyFileSync(exampleSrc, exampleDest);
}

const versionDest = path.join(releaseDir, 'VERSION');
fs.copyFileSync(product.versionPath, versionDest);

const launcherSrc = path.join(projectRoot, 'scripts', 'start-server-launcher.bat');
const launcherDest = path.join(releaseDir, 'Start-Server.bat');
if (fs.existsSync(launcherSrc)) {
  fs.copyFileSync(launcherSrc, launcherDest);
}

console.log(`[pack] Done: ${outputExe}`);
