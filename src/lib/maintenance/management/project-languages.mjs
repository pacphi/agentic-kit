import { stackEntryById } from '../../footprint/stack-registry.mjs';
import { languageIcon } from '../../footprint/language-coverage.mjs';
const NON_PROGRAMMING = new Set(['config','markdown','restructuredtext','asciidoc','tex','diagrams','html','css','templates']);
export function projectLanguages(row) {
  const languages = [...(row.loc?.languages ?? []), ...(row.stack?.languagePresence ?? [])];
  const unique = new Map();
  for (const language of languages) {
    if (unique.get(language.id)?.evidence === 'source') continue;
    const entry = stackEntryById(language.id);
    if (entry?.kind !== 'language' || NON_PROGRAMMING.has(entry.id)) continue;
    // Public labels come from our registry, never cached free text. Spaced
    // slashes look like paths to the inventory guard; use a prose separator.
    const name = entry.name.replace(/\s+\/\s+/g, ' · ');
    unique.set(entry.id, { id: entry.id, name, icon: languageIcon(language.id), evidence: language.evidence === 'artifact' ? 'artifact' : 'source' });
  }
  return [...unique.values()].slice(0, 100);
}
