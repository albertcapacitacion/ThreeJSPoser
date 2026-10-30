// History contains plain pose data, never Three.js renderer objects.
export function createHistory(initial) {
  let entries = [structuredClone(initial)], index = 0;
  return {
    push(pose) {
      if (JSON.stringify(entries[index]) === JSON.stringify(pose)) return;
      entries = entries.slice(0, index + 1);
      entries.push(structuredClone(pose));
      if (entries.length > 100) entries.shift();
      index = entries.length - 1;
    },
    undo() { if (index > 0) return structuredClone(entries[--index]); },
    redo() { if (index < entries.length - 1) return structuredClone(entries[++index]); },
    get canUndo() { return index > 0; },
    get canRedo() { return index < entries.length - 1; },
  };
}
