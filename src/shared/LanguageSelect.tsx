/**
 * Searchable Whisper language selector with Auto-detect, pinned favorites/recents,
 * and native names (PLAN §6).
 */
import { useMemo, useState } from 'preact/hooks';
import {
  AUTO_LANGUAGE,
  languageLabel,
  orderLanguages,
  searchLanguages,
  type Language,
} from './languages';

export interface LanguageSelectProps {
  value: string;
  detectedLanguage?: string;
  favorites: string[];
  recents: string[];
  disabled?: boolean;
  onChange: (code: string) => void;
  onToggleFavorite?: (code: string) => void;
}

export function LanguageSelect({
  value,
  detectedLanguage,
  favorites,
  recents,
  disabled,
  onChange,
  onToggleFavorite,
}: LanguageSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const { pinned, rest } = useMemo(
    () => orderLanguages(favorites, recents),
    [favorites, recents],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return null;
    return searchLanguages(query);
  }, [query]);

  const currentLabel = useMemo(() => {
    if (value === AUTO_LANGUAGE) {
      if (detectedLanguage) {
        return `Auto-detect (${languageLabel(detectedLanguage)})`;
      }
      return 'Auto-detect';
    }
    return languageLabel(value);
  }, [value, detectedLanguage]);

  const select = (code: string) => {
    onChange(code);
    setOpen(false);
    setQuery('');
  };

  const renderItem = (lang: Language) => {
    const isFav = favorites.includes(lang.code);
    const isSelected = value === lang.code;
    return (
      <div
        key={lang.code}
        class={`lang-item ${isSelected ? 'selected' : ''}`}
        onClick={() => select(lang.code)}
      >
        <div class="lang-item-main">
          <span class="lang-native">{lang.native}</span>
          {lang.native !== lang.name && <span class="lang-english">{lang.name}</span>}
          <span class="lang-code">{lang.code}</span>
        </div>
        {onToggleFavorite && (
          <button
            type="button"
            class={`lang-fav-btn ${isFav ? 'active' : ''}`}
            title={isFav ? 'Remove from favorites' : 'Pin to favorites'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(lang.code);
            }}
          >
            {isFav ? '★' : '☆'}
          </button>
        )}
      </div>
    );
  };

  return (
    <div class="lang-select">
      <button
        type="button"
        class="lang-trigger"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{currentLabel}</span>
        <span class="lang-caret">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div class="lang-dropdown">
          <input
            type="search"
            class="lang-search"
            placeholder="Search 99 languages…"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            autoFocus
          />
          <div class="lang-list">
            {!filtered && (
              <div
                class={`lang-item ${value === AUTO_LANGUAGE ? 'selected' : ''}`}
                onClick={() => select(AUTO_LANGUAGE)}
              >
                <div class="lang-item-main">
                  <span class="lang-native">Auto-detect</span>
                  <span class="lang-english">Detect from first 30s</span>
                </div>
              </div>
            )}

            {filtered ? (
              filtered.length > 0 ? (
                filtered.map(renderItem)
              ) : (
                <div class="lang-empty">No matching language</div>
              )
            ) : (
              <>
                {pinned.length > 0 && (
                  <>
                    <div class="lang-group-label">Pinned &amp; Recent</div>
                    {pinned.map(renderItem)}
                  </>
                )}
                <div class="lang-group-label">All Whisper Languages (99)</div>
                {rest.map(renderItem)}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

