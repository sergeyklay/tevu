/** The variable names a child process reports, without the one macOS adds to every child environment. */
export function withoutPlatformVariables(names: readonly string[]): string[] {
  // macOS adds __CF_USER_TEXT_ENCODING to a child's environment even when the
  // parent omits it, so its presence says nothing about what tevu passed.
  return process.platform === 'darwin'
    ? names.filter((name) => name !== '__CF_USER_TEXT_ENCODING')
    : [...names];
}
