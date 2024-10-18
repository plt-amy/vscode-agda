import { BaseLanguageClient } from 'vscode-languageclient';

/**
 * A {@link BaseLanguageClient}, with additional methods that are present on
 * both implementations.
 */
export interface AbstractLanguageClient extends BaseLanguageClient {
  restart?(): void;
}
