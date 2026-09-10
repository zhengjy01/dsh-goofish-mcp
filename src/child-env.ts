/**
 * dsh-xianyu — child-process environment.
 *
 * The goofish MCP server is spawned as a child process. DSH itself can be
 * started by launchd (the shipped `com.dsh.web` service), whose PATH is only
 * `/usr/bin:/bin`, so a bare `goofish-mcp` (or `npx` / `uvx`) fails with
 * ENOENT even though it is installed. Every spawned server therefore receives
 * a PATH that also carries the well-known install directories.
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Well-known directories that commonly hold a globally installed CLI. */
function extraBinDirs(): string[] {
  const home = homedir()
  const dirs = [
    path.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    '/usr/bin',
    '/bin',
  ]
  // Node version managers keep each release under its own bin directory.
  for (const manager of ['.nvm/versions/node', '.local/share/fnm/node-versions', '.asdf/installs/nodejs']) {
    const root = path.join(home, manager)
    try {
      for (const entry of readdirSync(root)) dirs.push(path.join(root, entry, 'bin'))
    } catch {
      // Not installed with this manager — nothing to add.
    }
  }
  return dirs
}

/**
 * The inherited PATH with every existing well-known bin directory appended.
 * @returns a PATH value safe to hand to a spawned child process.
 */
export function extendedPath(): string {
  const segments = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => dir !== '')
  const seen = new Set(segments)
  for (const dir of extraBinDirs()) {
    if (seen.has(dir) || !existsSync(dir)) continue
    seen.add(dir)
    segments.push(dir)
  }
  return segments.join(path.delimiter)
}
