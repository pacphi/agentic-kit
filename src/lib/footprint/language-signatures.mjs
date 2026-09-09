// Bounded disambiguation. Source text is transient and never leaves this module.
import path from 'node:path';
export function languageSignature(file, fsImpl) {
  const ext = path.extname(file).toLowerCase();
  if (!['.m', '.pl', '.d', '.gml', '.xml'].includes(ext)) return undefined;
  let fd;
  try {
    fd = fsImpl.openSync(file, 'r');
    const buffer = Buffer.alloc(16384);
    const size = fsImpl.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, size).toString('utf8');
    if (ext === '.gml') return /^\s*</.test(text) ? null : { id: 'gml' };
    if (ext === '.d') return /^\s*(?:module\s+[\w.]+\s*;|import\s+[\w.]+|(?:void|int)\s+main\s*\()/m.test(text) ? { id: 'd' } : null;
    if (ext === '.m') {
      if (/^\s*(?:@interface|@implementation|#import)\b/m.test(text)) return { id: 'objective-c' };
      if (/^\s*(?:function\s|classdef\s)/m.test(text)) return { id: 'matlab' };
      return null;
    }
    if (ext === '.pl') {
      if (/^#![^\n]*\bperl\b|^\s*use\s+(?:strict|warnings)\b/m.test(text)) return { id: 'perl' };
      if (/^\s*:-\s*(?:module|use_module|dynamic)\b/m.test(text)) return { id: 'prolog' };
      return null;
    }
    const xml = text.replace(/<!--[\s\S]*?-->/g, '');
    if (/<AxClass(?:\s|>)/.test(xml) && /<Source>/.test(xml)) return { id: 'xpp', artifact: true };
    if (/https?:\/\/www\.plcopen\.org\/xml\/tc6(?:_|\/)/.test(xml) && /<body>\s*<LD(?:\s|\/?>)/.test(xml)) return { id: 'ladder', artifact: true };
    return undefined;
  } catch { return ext === '.xml' ? undefined : null; }
  finally { if (fd !== undefined) fsImpl.closeSync(fd); }
}
