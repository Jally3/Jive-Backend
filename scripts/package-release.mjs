import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const outputDirectory = 'artifacts';
const archiveName = `jive-catalog-${packageJson.version}.tar.gz`;
const archivePath = join(outputDirectory, archiveName);

await mkdir(outputDirectory, { recursive: true });
try {
  await access(archivePath);
  throw new Error(`${archivePath} already exists; bump the package version before releasing again`);
} catch (error) {
  if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error;
}

const result = spawnSync(
  'tar',
  ['-czf', archivePath, 'dist', 'package.json', 'deploy/jive-catalog.service'],
  { stdio: 'inherit' },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`tar exited with status ${result.status ?? 'unknown'}`);

const checksum = createHash('sha256')
  .update(await readFile(archivePath))
  .digest('hex');
await writeFile(`${archivePath}.sha256`, `${checksum}  ${basename(archivePath)}\n`, 'utf8');

console.log(`Created ${archivePath}`);
console.log(`SHA-256 ${checksum}`);
