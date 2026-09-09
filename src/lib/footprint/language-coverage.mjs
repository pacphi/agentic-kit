// TIOBE September 2026 coverage baseline, retrieved 2026-09-08.
// Popularity selects coverage priorities, never evidence for a project's language.
export const LANGUAGE_BASELINE = Object.freeze([
  ['python','Python','Py'],['c','C','C'],['cpp','C++','C++'],['java','Java','Jv'],['csharp','C#','C#'],
  ['javascript','JavaScript','JS'],['visual-basic','Visual Basic','VB'],['sql','SQL','SQL'],['r','R','R'],['rust','Rust','Rs'],
  ['fortran','Fortran','F'],['go','Go','Go'],['pascal','Delphi/Object Pascal','Pas'],['php','PHP','PHP'],['scratch','Scratch','Scr'],
  ['assembly','Assembly language','Asm'],['ada','Ada','Ada'],['swift','Swift','Sw'],['objective-c','Objective-C','Obj'],['cobol','COBOL','Cob'],
  ['julia','Julia','Jl'],['ruby','Ruby','Rb'],['perl','Perl','Pl'],['sas','SAS','SAS'],['classic-vb','Classic Visual Basic','VB6'],
  ['kotlin','Kotlin','Kt'],['matlab','MATLAB','Mat'],['ocaml','Caml','ML'],['prolog','Prolog','Pro'],['gml','GML','GML'],
  ['lua','Lua','Lua'],['powershell','PowerShell','PS'],['d','D','D'],['plsql','PL/SQL','PLS'],['abap','ABAP','AB'],
  ['tsql','Transact-SQL','TSQL'],['vbscript','VBScript','VBS'],['ocaml','OCaml','ML'],['typescript','TypeScript','TS'],['zig','Zig','Zig'],
  ['dart','Dart','Dt'],['xpp','X++','X++'],['lisp','Lisp','Lsp'],['scala','Scala','Sc'],['labview','LabVIEW','LV'],
  ['ladder','Ladder Logic','LD'],['vhdl','VHDL','VHD'],['xslt','XSLT','XSL'],['haskell','Haskell','Hs'],['foxpro','(Visual) FoxPro','Fox'],
].map(([id,name,icon], index) => Object.freeze({rank:index+1,id,name,icon})));
export function languageIcon(id) { return LANGUAGE_BASELINE.find(row => row.id === id)?.icon ?? id.slice(0, 3).toUpperCase(); }

// Artifact-only matches prove presence, never textual lines of code.
export const LANGUAGE_ARTIFACTS = Object.freeze({
  '.sb':'scratch', '.sb2':'scratch', '.sb3':'scratch', '.vi':'labview', '.lvproj':'labview', '.lvclass':'labview', '.lvlib':'labview',
  '.vbp':'classic-vb', '.pjx':'foxpro', '.mlx':'matlab',
});
