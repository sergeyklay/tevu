/** Renders a value path for an error reason: `(root)` when empty, else every segment through `String`, joined by `.`. */
export function describePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '(root)' : path.map((segment) => String(segment)).join('.');
}
