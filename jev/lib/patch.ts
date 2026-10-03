/** Codex apply_patch: "*** Add File: p" / "*** Update File: p" sections; '+' lines are the new content. */
export function patchFiles(patch: string): { path: string; content: string }[] {
  const files: { path: string; content: string[] }[] = [];
  for (const line of patch.split("\n")) {
    const m = line.match(/^\*\*\* (Add|Update) File: (.+)$/);
    if (m) { files.push({ path: m[2].trim(), content: [] }); continue; }
    if (/^\*\*\* (Delete File|Move to|End Patch|Begin Patch)/.test(line)) {
      const mv = line.match(/^\*\*\* Move to: (.+)$/);
      if (mv && files.length) files.at(-1)!.path = mv[1].trim();
      continue;
    }
    if (files.length && line.startsWith("+")) files.at(-1)!.content.push(line.slice(1));
  }
  return files.map((f) => ({ path: f.path, content: f.content.join("\n") }));
}
