/** Replace matching source-detail entries with one accurate contribution. */
export function replaceSourceEntries(sourceInfo, path, { matches, name, value, id }) {
  const details = sourceInfo[path] ??= { negative: [], positive: [] };
  for (const group of ["negative", "positive"]) {
    details[group] = (details[group] ?? []).filter((entry) => !matches(entry));
  }

  const amount = Number(value) || 0;
  if (amount === 0) return;
  const entry = { name, value: amount };
  if (id) entry.id = id;
  details[amount >= 0 ? "positive" : "negative"].push(entry);
}

/** Update an existing source-detail entry without disturbing other sources. */
export function updateSourceEntry(sourceInfo, path, matches, value) {
  const details = sourceInfo[path];
  if (!details) return false;
  for (const group of ["negative", "positive"]) {
    const entry = (details[group] ?? []).find(matches);
    if (!entry) continue;
    entry.value = Number(value) || 0;
    return true;
  }
  return false;
}
