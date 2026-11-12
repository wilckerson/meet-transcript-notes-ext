/**
 * Whisper's 99 languages, taken from the Whisper tokenizer (same set as Transformers.js
 * WHISPER_LANGUAGES). `code` is what we pass to the pipeline; the Whisper token is `<|code|>`.
 */
export interface Language {
  code: string;
  /** English name, as used by Whisper (lowercase there). */
  name: string;
  native: string;
}

export const AUTO_LANGUAGE = 'auto';

export const LANGUAGES: readonly Language[] = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'zh', name: 'Chinese', native: '中文' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'ru', name: 'Russian', native: 'Русский' },
  { code: 'ko', name: 'Korean', native: '한국어' },
  { code: 'fr', name: 'French', native: 'Français' },
  { code: 'ja', name: 'Japanese', native: '日本語' },
  { code: 'pt', name: 'Portuguese', native: 'Português' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe' },
  { code: 'pl', name: 'Polish', native: 'Polski' },
  { code: 'ca', name: 'Catalan', native: 'Català' },
  { code: 'nl', name: 'Dutch', native: 'Nederlands' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
  { code: 'sv', name: 'Swedish', native: 'Svenska' },
  { code: 'it', name: 'Italian', native: 'Italiano' },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'fi', name: 'Finnish', native: 'Suomi' },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt' },
  { code: 'he', name: 'Hebrew', native: 'עברית' },
  { code: 'uk', name: 'Ukrainian', native: 'Українська' },
  { code: 'el', name: 'Greek', native: 'Ελληνικά' },
  { code: 'ms', name: 'Malay', native: 'Bahasa Melayu' },
  { code: 'cs', name: 'Czech', native: 'Čeština' },
  { code: 'ro', name: 'Romanian', native: 'Română' },
  { code: 'da', name: 'Danish', native: 'Dansk' },
  { code: 'hu', name: 'Hungarian', native: 'Magyar' },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்' },
  { code: 'no', name: 'Norwegian', native: 'Norsk' },
  { code: 'th', name: 'Thai', native: 'ไทย' },
  { code: 'ur', name: 'Urdu', native: 'اردو' },
  { code: 'hr', name: 'Croatian', native: 'Hrvatski' },
  { code: 'bg', name: 'Bulgarian', native: 'Български' },
  { code: 'lt', name: 'Lithuanian', native: 'Lietuvių' },
  { code: 'la', name: 'Latin', native: 'Latina' },
  { code: 'mi', name: 'Maori', native: 'Te Reo Māori' },
  { code: 'ml', name: 'Malayalam', native: 'മലയാളം' },
  { code: 'cy', name: 'Welsh', native: 'Cymraeg' },
  { code: 'sk', name: 'Slovak', native: 'Slovenčina' },
  { code: 'te', name: 'Telugu', native: 'తెలుగు' },
  { code: 'fa', name: 'Persian', native: 'فارسی' },
  { code: 'lv', name: 'Latvian', native: 'Latviešu' },
  { code: 'bn', name: 'Bengali', native: 'বাংলা' },
  { code: 'sr', name: 'Serbian', native: 'Српски' },
  { code: 'az', name: 'Azerbaijani', native: 'Azərbaycan' },
  { code: 'sl', name: 'Slovenian', native: 'Slovenščina' },
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ' },
  { code: 'et', name: 'Estonian', native: 'Eesti' },
  { code: 'mk', name: 'Macedonian', native: 'Македонски' },
  { code: 'br', name: 'Breton', native: 'Brezhoneg' },
  { code: 'eu', name: 'Basque', native: 'Euskara' },
  { code: 'is', name: 'Icelandic', native: 'Íslenska' },
  { code: 'hy', name: 'Armenian', native: 'Հայերեն' },
  { code: 'ne', name: 'Nepali', native: 'नेपाली' },
  { code: 'mn', name: 'Mongolian', native: 'Монгол' },
  { code: 'bs', name: 'Bosnian', native: 'Bosanski' },
  { code: 'kk', name: 'Kazakh', native: 'Қазақ' },
  { code: 'sq', name: 'Albanian', native: 'Shqip' },
  { code: 'sw', name: 'Swahili', native: 'Kiswahili' },
  { code: 'gl', name: 'Galician', native: 'Galego' },
  { code: 'mr', name: 'Marathi', native: 'मराठी' },
  { code: 'pa', name: 'Punjabi', native: 'ਪੰਜਾਬੀ' },
  { code: 'si', name: 'Sinhala', native: 'සිංහල' },
  { code: 'km', name: 'Khmer', native: 'ខ្មែរ' },
  { code: 'sn', name: 'Shona', native: 'chiShona' },
  { code: 'yo', name: 'Yoruba', native: 'Yorùbá' },
  { code: 'so', name: 'Somali', native: 'Soomaali' },
  { code: 'af', name: 'Afrikaans', native: 'Afrikaans' },
  { code: 'oc', name: 'Occitan', native: 'Occitan' },
  { code: 'ka', name: 'Georgian', native: 'ქართული' },
  { code: 'be', name: 'Belarusian', native: 'Беларуская' },
  { code: 'tg', name: 'Tajik', native: 'Тоҷикӣ' },
  { code: 'sd', name: 'Sindhi', native: 'سنڌي' },
  { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી' },
  { code: 'am', name: 'Amharic', native: 'አማርኛ' },
  { code: 'yi', name: 'Yiddish', native: 'ייִדיש' },
  { code: 'lo', name: 'Lao', native: 'ລາວ' },
  { code: 'uz', name: 'Uzbek', native: 'Oʻzbek' },
  { code: 'fo', name: 'Faroese', native: 'Føroyskt' },
  { code: 'ht', name: 'Haitian Creole', native: 'Kreyòl Ayisyen' },
  { code: 'ps', name: 'Pashto', native: 'پښتو' },
  { code: 'tk', name: 'Turkmen', native: 'Türkmen' },
  { code: 'nn', name: 'Nynorsk', native: 'Nynorsk' },
  { code: 'mt', name: 'Maltese', native: 'Malti' },
  { code: 'sa', name: 'Sanskrit', native: 'संस्कृतम्' },
  { code: 'lb', name: 'Luxembourgish', native: 'Lëtzebuergesch' },
  { code: 'my', name: 'Myanmar', native: 'မြန်မာ' },
  { code: 'bo', name: 'Tibetan', native: 'བོད་ཡིག' },
  { code: 'tl', name: 'Tagalog', native: 'Tagalog' },
  { code: 'mg', name: 'Malagasy', native: 'Malagasy' },
  { code: 'as', name: 'Assamese', native: 'অসমীয়া' },
  { code: 'tt', name: 'Tatar', native: 'Татар' },
  { code: 'haw', name: 'Hawaiian', native: 'ʻŌlelo Hawaiʻi' },
  { code: 'ln', name: 'Lingala', native: 'Lingála' },
  { code: 'ha', name: 'Hausa', native: 'Hausa' },
  { code: 'ba', name: 'Bashkir', native: 'Башҡорт' },
  { code: 'jw', name: 'Javanese', native: 'Basa Jawa' },
  { code: 'su', name: 'Sundanese', native: 'Basa Sunda' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function getLanguage(code: string | undefined | null): Language | undefined {
  return code ? BY_CODE.get(code) : undefined;
}

export function isValidLanguage(code: string): boolean {
  return code === AUTO_LANGUAGE || BY_CODE.has(code);
}

export function whisperToken(code: string): string {
  return `<|${code}|>`;
}

/** Label for UI and the Markdown header, e.g. "Português (Portuguese)". */
export function languageLabel(code: string | undefined | null): string {
  if (!code || code === AUTO_LANGUAGE) return 'Auto-detect';
  const l = BY_CODE.get(code);
  if (!l) return code;
  return l.native === l.name ? l.name : `${l.native} (${l.name})`;
}

/** Case/diacritic-insensitive search over code, English and native names. */
export function searchLanguages(query: string): Language[] {
  const q = normalize(query.trim());
  if (!q) return [...LANGUAGES];
  return LANGUAGES.filter(
    (l) => l.code === q || normalize(l.name).includes(q) || normalize(l.native).includes(q),
  );
}

function normalize(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/**
 * Orders languages for the selector: favorites first, then recents, then the rest
 * alphabetically by English name.
 */
export function orderLanguages(favorites: string[], recents: string[]): {
  pinned: Language[];
  rest: Language[];
} {
  const seen = new Set<string>();
  const pinned: Language[] = [];
  for (const code of [...favorites, ...recents]) {
    const l = BY_CODE.get(code);
    if (l && !seen.has(code)) {
      pinned.push(l);
      seen.add(code);
    }
  }
  const rest = LANGUAGES.filter((l) => !seen.has(l.code)).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { pinned, rest };
}

