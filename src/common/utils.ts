import * as vscode from "vscode";
import type * as lsp from "vscode-languageclient";

/** Assert a value is never inhabited. */
export const assertNever = (x: never): never => { throw new Error(`Impossible case: ${x}`) };

/**
 * The text documents that the Agda extension will run on.
 */
export const agdaSelector: lsp.DocumentSelector = [
  { scheme: "file", language: "agda" },
  // By matching lagda.md files, rather than defining a new language, we allow
  // other Markdown extensions to work with literate files.
  { scheme: "file", pattern: "**/*.lagda.md" }
];

/** Determine if this document is an Agda file. */
export const isAgdaDocument = (d: vscode.TextDocument): boolean => vscode.languages.match(agdaSelector, d) > 0;
