import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(__dirname, '..');
const versionLines = fs
  .readFileSync(path.join(serverRoot, 'VERSION'), 'utf8')
  .trim()
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean);
const version = versionLines[0];
const codename = versionLines[1] ?? '';

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`[sync-version] Invalid VERSION: ${version}`);
  process.exit(1);
}

const targets = [
  path.join(serverRoot, 'package.json'),
  path.join(serverRoot, '..', 'PlayerHistory_Web', 'web', 'package.json'),
  path.join(serverRoot, '..', 'PlayerHistory_Web', 'desktop', 'package.json'),
];

for (const pkgPath of targets) {
  if (!fs.existsSync(pkgPath)) {
    console.warn(`[sync-version] Skip missing ${pkgPath}`);
    continue;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = version;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  console.log(`[sync-version] ${path.relative(serverRoot, pkgPath)} → ${version}`);
}

console.log(`[sync-version] Product version: ${version}${codename ? ` (“${codename}”)` : ''}`);
