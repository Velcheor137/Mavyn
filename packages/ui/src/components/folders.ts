import { compareNames, type Folder } from '@mdr/core';

/** Ordered display paths; orphaned legacy folders stay reachable. Cycles are bounded. */
export function folderPaths(folders: Folder[], locale: string): Array<{ folder: Folder; path: string }> {
  const ids = new Set(folders.map((f) => f.id));
  const children = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    const parent = folder.parentId && ids.has(folder.parentId) ? folder.parentId : null;
    const siblings = children.get(parent) ?? [];
    siblings.push(folder);
    children.set(parent, siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => compareNames(a.name, b.name, locale));
  const result: Array<{ folder: Folder; path: string }> = [];
  const seen = new Set<string>();
  const stack = (children.get(null) ?? []).map((folder) => ({ folder, path: folder.name })).reverse();
  while (stack.length) {
    const entry = stack.pop()!;
    if (seen.has(entry.folder.id)) continue;
    seen.add(entry.folder.id);
    result.push(entry);
    for (const folder of [...(children.get(entry.folder.id) ?? [])].reverse()) {
      stack.push({ folder, path: `${entry.path} / ${folder.name}` });
    }
  }
  return result;
}

export function descendantIds(folders: Folder[], id: string): Set<string> {
  const result = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId && result.has(folder.parentId) && !result.has(folder.id)) {
        result.add(folder.id);
        grew = true;
      }
    }
  }
  return result;
}
