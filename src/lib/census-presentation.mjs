/** An absent legacy field is unknown, never a measured zero. Shared by CLI/UI. */
export function censusDisclosure(census = {}) {
  const count = (field) => Number.isInteger(census[field]) && census[field] >= 0 ? String(census[field]) : 'Unknown number of';
  return `${count('importedExcluded')} confirmed pure imported copies excluded (no project, host or origin contribution); `
    + `${count('importedMixed')} mixed files retain proven native activity; `
    + `${count('importedUnresolved')} files have unresolved bounded ownership (not confirmed exclusions). `
    + 'The dedicated Cowork transcript source is not covered; Cowork declarations in covered transcripts remain valid observations.';
}
