import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FEEDS, type CatalogSnapshot, type PersistedState } from './types.js';

export async function loadState(path: string | undefined): Promise<PersistedState | undefined> {
  if (!path) return undefined;
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as PersistedState;
    if (parsed.schemaVersion !== 1 || !parsed.snapshots || typeof parsed.snapshots !== 'object') {
      throw new Error('unsupported state schema');
    }
    for (const feed of FEEDS) {
      const snapshot = parsed.snapshots[feed];
      if (snapshot) validateSnapshot(snapshot, feed);
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function saveState(path: string | undefined, state: PersistedState): Promise<void> {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { encoding: 'utf8', mode: 0o640 });
  await rename(temporary, path);
}

function validateSnapshot(snapshot: CatalogSnapshot, feed: string): void {
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.feed !== feed ||
    !snapshot.revision ||
    !snapshot.generatedAt ||
    !snapshot.expiresAt ||
    !snapshot.groups ||
    !snapshot.items
  ) {
    throw new Error(`invalid persisted snapshot for ${feed}`);
  }
  for (const group of ['all', 'movie', 'tv', 'animation', 'variety'] as const) {
    const ids = snapshot.groups[group];
    if (!Array.isArray(ids) || ids.length > 200 || new Set(ids).size !== ids.length) {
      throw new Error(`invalid ${feed}.${group} group`);
    }
    if (ids.some((id) => snapshot.items[id] === undefined)) {
      throw new Error(`missing item referenced by ${feed}.${group}`);
    }
  }
  if (snapshot.groups.all.length === 0) throw new Error(`empty persisted snapshot for ${feed}`);
}
