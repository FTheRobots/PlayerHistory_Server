import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function readProductVersion(root = serverRoot) {
  const versionPath = path.join(root, 'VERSION');
  let version = '0.0.0';
  let codename = '';

  if (fs.existsSync(versionPath)) {
    const lines = fs
      .readFileSync(versionPath, 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines[0]) version = lines[0];
    if (lines[1]) codename = lines[1];
  } else {
    const pkgPath = path.join(root, 'package.json');
    if (fs.existsSync(pkgPath)) {
      version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version ?? version;
    }
  }

  return { version, codename, versionPath };
}

/** "Nimble Jackal" → "NimbleJackal" for Windows filenames. */
export function filenameSafeCodename(codename) {
  return (codename ?? '').replace(/[^A-Za-z0-9]+/g, '');
}

/**
 * Release artifact name, e.g. PlayerHistory-Server.2.1.0-NimbleJackal.exe
 * @param {'Server' | 'Admin'} kind
 */
export function releaseExeName(kind, info = readProductVersion()) {
  const slug = filenameSafeCodename(info.codename);
  const base = `PlayerHistory-${kind}.${info.version}`;
  return slug ? `${base}-${slug}.exe` : `${base}.exe`;
}
