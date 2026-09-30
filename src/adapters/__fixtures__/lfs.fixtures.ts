import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const POINTER_VERSION_LINE = 'version https://git-lfs.github.com/spec/v1';

/** One Git LFS object: its bytes, the SHA-256 and size a pointer names it by, and that pointer's text. */
export type LfsObject = {
  oid: string;
  size: number;
  content: Buffer;
  pointer: string;
};

/** Builds the pointer text git-lfs writes for `oid` and `size`, with one line per extension. */
export function buildLfsPointer(
  oid: string,
  size: number,
  extensionLines: readonly string[] = [],
): string {
  return `${[POINTER_VERSION_LINE, ...extensionLines, `oid sha256:${oid}`, `size ${size}`].join('\n')}\n`;
}

export function buildLfsObject(
  content: string | Uint8Array = 'synthetic object bytes\n',
): LfsObject {
  const bytes = Buffer.from(content);
  const oid = createHash('sha256').update(bytes).digest('hex');
  return { oid, size: bytes.length, content: bytes, pointer: buildLfsPointer(oid, bytes.length) };
}

/** Builds one `ext-<index>-<name> sha256:<64 hex>` pointer line. */
export function buildLfsExtensionLine(name = 'foo', index = 0): string {
  return `ext-${index}-${name} sha256:${'a1b2c3d4'.repeat(8)}`;
}

/** The path git-lfs stores `oid` under inside an `objects` directory. */
export function lfsObjectFile(objectsDirectory: string, oid: string): string {
  return join(objectsDirectory, oid.slice(0, 2), oid.slice(2, 4), oid);
}

/** Writes `object` into an `objects` directory at git-lfs's own path and returns that path. */
export async function storeLfsObject(objectsDirectory: string, object: LfsObject): Promise<string> {
  const file = lfsObjectFile(objectsDirectory, object.oid);
  await mkdir(join(objectsDirectory, object.oid.slice(0, 2), object.oid.slice(2, 4)), {
    recursive: true,
  });
  await writeFile(file, object.content);
  return file;
}
