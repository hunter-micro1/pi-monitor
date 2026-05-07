/**
 * Bash-style tab completion for directory paths. Pure function so
 * it's easy to unit-test without a real filesystem (we accept a
 * `listDir` callback that defaults to `fs.readdirSync`).
 *
 * Mirrors `_complete_dir_path` in `tui.py`:
 *   - Returns the longest common prefix of all matching subdirs.
 *   - When exactly one match, appends a trailing slash so the
 *     user can immediately tab into the next level.
 *   - Hidden entries (`.`-prefix) only show when the user typed a
 *     leading dot themselves.
 *   - Preserves `~/...` syntax if the user typed it.
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export interface DirCompleteResult {
  /**
   * The new path to put back into the input. May be unchanged when
   * there's nothing to complete.
   */
  readonly value: string;
  /**
   * Names of every matching subdirectory at the current parent. Used
   * to render the "candidates" hint when there's more than one
   * match.
   */
  readonly matches: readonly string[];
}

/** Optional injection point for tests. Defaults to `fs.readdirSync`. */
export type ListDir = (path: string) => readonly string[];

const defaultListDir: ListDir = (path) => {
  // Filter to directories only. `withFileTypes: true` saves us a
  // stat per entry on Linux.
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      out.push(e.name);
      continue;
    }
    if (e.isSymbolicLink()) {
      // Resolve the link to see if it points at a directory.
      try {
        if (statSync(join(path, e.name)).isDirectory()) out.push(e.name);
      } catch {
        // Broken link or permission error \u2014 ignore.
      }
    }
  }
  return out;
};

/**
 * Compute the new input value + match list for a partial directory
 * path. Always returns a result; `value` is unchanged when there's
 * nothing useful to do.
 */
export function completeDirPath(
  value: string,
  listDir: ListDir = defaultListDir,
): DirCompleteResult {
  if (value === "") return { value, matches: [] };

  const expanded = expandHome(value);
  let parent: string;
  let partial: string;

  if (expanded.endsWith("/")) {
    parent = expanded.replace(/\/+$/, "") || "/";
    partial = "";
  } else {
    parent = dirname(expanded) || ".";
    partial = basename(expanded);
  }

  const showHidden = partial.startsWith(".");

  // List + filter to entries that start with the partial.
  const entries = [...listDir(parent)].sort();
  const matches: string[] = [];
  for (const name of entries) {
    if (!showHidden && name.startsWith(".")) continue;
    if (!name.startsWith(partial)) continue;
    matches.push(name);
  }

  if (matches.length === 0) return { value, matches: [] };

  let full: string;
  if (matches.length === 1) {
    // Exactly one match \u2014 complete and append trailing slash.
    full = `${join(parent, matches[0] as string)}/`;
  } else {
    // Multiple matches \u2014 longest common prefix.
    let common = matches[0] as string;
    for (let i = 1; i < matches.length; i++) {
      common = longestCommonPrefix(common, matches[i] as string);
    }
    if (common === "" || common === partial) {
      // No more letters to share \u2014 just hand back the candidates.
      return { value, matches };
    }
    full = join(parent, common);
  }

  // Re-collapse the home directory to `~` if the user originally
  // typed it that way.
  if (value.startsWith("~")) {
    const home = homedir();
    if (full.startsWith(home)) {
      full = `~${full.slice(home.length)}`;
    }
  }

  return { value: full, matches };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function longestCommonPrefix(a: string, b: string): string {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return a.slice(0, i);
}
