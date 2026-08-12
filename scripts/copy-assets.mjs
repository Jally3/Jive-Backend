import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/migrations/meta', { recursive: true });
await cp('migrations', 'dist/migrations', { recursive: true, force: true });
