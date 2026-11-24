import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Root folder for all output. Override with VISUAL_QA_OUT_DIR. */
export function outRoot(): string {
  return path.resolve(process.env.VISUAL_QA_OUT_DIR ?? path.join(process.cwd(), 'qa-reports'));
}

const ID_RE = /^[A-Za-z0-9._-]+$/;

export type Kind = 'design' | 'capture' | 'run';

const KIND_DIR: Record<Kind, string> = {
  design: '_designs',
  capture: '_captures',
  run: '',
};

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function slugify(input: string, max = 40): string {
  const s = input
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'page').slice(0, max).replace(/-+$/, '');
}

/** Short readable slug for a page URL (host + path, or file name). */
export function pageSlug(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return slugify(path.basename(decodeURIComponent(u.pathname)).replace(/\.html?$/i, ''));
    return slugify(`${u.hostname}${u.port ? '-' + u.port : ''}${u.pathname}`);
  } catch {
    return slugify(url);
  }
}

export function newId(prefix: string, label?: string): string {
  const rnd = randomBytes(2).toString('hex');
  return [prefix, stamp(), label ? slugify(label, 30) : '', rnd].filter(Boolean).join('-');
}

export function dirFor(kind: Kind, id: string): string {
  if (!ID_RE.test(id)) throw new Error(`Invalid ${kind} id: ${id}`);
  return path.join(outRoot(), KIND_DIR[kind], id);
}

export async function makeDir(kind: Kind, id: string): Promise<string> {
  const dir = dirFor(kind, id);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}

/** Reads meta.json of a stored item, with a helpful error if the id is unknown. */
export async function readMeta<T>(kind: Kind, id: string): Promise<T> {
  const file = path.join(dirFor(kind, id), 'meta.json');
  if (!(await exists(file))) {
    throw new Error(`Unknown ${kind} id "${id}" (looked in ${path.dirname(file)}).`);
  }
  return readJson<T>(file);
}
