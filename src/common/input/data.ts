import translations from "./translations.json";

const translationData: Record<string, string[]> = translations;

let characterMap: Map<string, string[]> | null = null;

/** Input character to trigger Agda input. */
export const leader = "\\";

const getCharacterMap = (): Map<string, string[]> => {
  if (characterMap !== null) return characterMap;

  characterMap = new Map();
  for (const [input, chars] of Object.entries(translationData)) {
    for (const char of chars) {
      let inputs = characterMap.get(char);
      if (inputs === undefined) {
        inputs = [];
        characterMap.set(char, inputs);
      }

      inputs.push(input);
    }
  }
  return characterMap;
}

/** Find the input needed for a given translation. */
export const findTranslationInput = (character: string): string[] => getCharacterMap().get(character) ?? [];

/** Find translations matching the current input. */
export const findTranslationChars = (filter: string): [string, string[]][] => Object.entries(translationData).filter(([input, _]) => input.startsWith(filter));
