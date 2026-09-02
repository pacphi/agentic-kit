import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicSource, readJsonSource } from './common.mjs';

const defaultFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'config', 'agentic-dependency-constraints.json');

export function loadUpstreamConstraints({ file = defaultFile } = {}) {
  const source = readJsonSource(file, path.dirname(file), { kind: 'upstream-constraints' });
  if (!source || source.status !== 'valid') {
    return { status: source?.status ?? 'absent', source: source ? publicSource(source) : { file, status: 'absent' }, constraints: [], errors: [source?.error ?? 'constraint registry is absent'] };
  }
  const document = source.document;
  const errors = [];
  if (document?.schemaVersion !== 1) errors.push('unsupported upstream constraint schema');
  if (!Array.isArray(document?.constraints)) errors.push('constraints must be an array');
  const constraints = Array.isArray(document?.constraints) ? document.constraints.filter((entry, index) => {
    const valid = entry && typeof entry === 'object'
      && typeof entry.dependency === 'string' && typeof entry.kind === 'string'
      && Array.isArray(entry.affected) && typeof entry.strategy === 'string'
      && typeof entry.sunsetWhen === 'string';
    if (!valid) errors.push(`constraint ${index} is invalid`);
    return valid;
  }) : [];
  return {
    status: errors.length ? 'invalid' : 'valid', source: publicSource(source),
    lastVerifiedAt: document?.lastVerifiedAt ?? null,
    recheckPolicy: document?.recheckPolicy ?? null,
    constraints, errors,
  };
}
