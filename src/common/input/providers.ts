import { CompletionItem, CompletionItemProvider, Hover, HoverProvider, Position, Range, TextDocument } from 'vscode'
import { leader, findTranslationInput, findTranslationChars } from './data';

/** A hover provider for custom input mappings, telling the user what strings can be used to type a value. */
export class InputHoverProvider implements HoverProvider {
  provideHover(document: TextDocument, pos: Position): Hover | undefined {
    const symbol = document.lineAt(pos.line).text.substring(pos.character, pos.character + 1);
    const inputs = findTranslationInput(symbol)
    if (inputs.length === 0) return undefined;

    const markdown = `Type ${symbol} using ${inputs.map(a => '`' + leader + a + '`').join(' or ')}`;
    return new Hover(markdown, new Range(pos, pos.translate(0, 1)))
  }
}

const commitCharacters = [" ", leader];

/** A completion provider for Agda input values. */
export class InputCompletionProvider implements CompletionItemProvider {
  provideCompletionItems(document: TextDocument, position: Position): CompletionItem[] | undefined {
    const line = document.lineAt(position.line).text;
    const lastIndex = line.lastIndexOf(leader, position.character);
    if (lastIndex < 0) return;

    const replacements = findTranslationChars(line.substring(lastIndex + 1, position.character));
    if(replacements.length === 0) return undefined;

    const range = new Range(new Position(position.line, lastIndex), position.translate(0, 1));

    return replacements.flatMap(([input, translations]) => {
      const label = leader + input;
      return translations.map(translation => {
        const res = new CompletionItem({ label, detail: " " + translation });
        res.range = range;
        res.insertText = translation;
        res.commitCharacters = commitCharacters;
        return res;
      })
    })
  }
}
