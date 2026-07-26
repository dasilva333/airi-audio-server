const fs = require('fs');
const path = require('path');

// Emoji regex: Strips pictographic emoji but preserves digits 0-9.
const EMOJI_REGEX = /(?!\d)[\u{1F000}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\uFE0F?/gu;

class TextProcessor {
  constructor(tagsCsvPath) {
    this.modelTags = new Map(); // modelName -> Set of valid tags
    this.allValidTags = new Set();
    this.loadSupportedTags(tagsCsvPath);
  }

  loadSupportedTags(csvPath) {
    if (fs.existsSync(csvPath)) {
      try {
        const content = fs.readFileSync(csvPath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          const parts = line.split(',');
          if (parts.length >= 4) {
            const rawTag = parts[1].trim().toLowerCase();
            if (!rawTag) continue;

            // Support comma-delimited model names in type column (e.g. "chatterbox,chatterbox_turbo")
            const types = parts.slice(3).join(',').split(',').map(t => t.trim().toLowerCase());

            const tagVariations = [
              rawTag,
              `[${rawTag}]`,
              `[${rawTag.replace(/_/g, ' ')}]`,
              `<|${rawTag}|>`
            ];

            for (const v of tagVariations) {
              this.allValidTags.add(v);
            }

            for (const t of types) {
              if (!t) continue;
              if (!this.modelTags.has(t)) {
                this.modelTags.set(t, new Set());
              }
              const modelSet = this.modelTags.get(t);
              for (const v of tagVariations) {
                modelSet.add(v);
              }
            }
          }
        }
        console.log(`[TextProcessor] Loaded tag mappings for ${this.modelTags.size} model families (${this.allValidTags.size} total tag variations).`);
      } catch (err) {
        console.error(`[TextProcessor] Error reading supported_tags.csv: ${err.message}`);
      }
    }
  }

  hasPronounceableText(text) {
    if (!text || typeof text !== 'string') return false;
    // Check if there is at least one letter or digit
    return /[a-zA-Z0-9\u00C0-\u024F\u4E00-\u9FFF]/u.test(text);
  }

  cleanEmoji(text) {
    if (!text) return '';
    return text.replace(EMOJI_REGEX, '').trim();
  }

  filterBracketedTags(text, modelFamily = 'omnivoice', allowUnfiltered = false) {
    if (!text) return '';
    if (allowUnfiltered) {
      return text;
    }

    const familyKey = (modelFamily || 'omnivoice').toLowerCase().replace('-', '_');
    const validSet = this.modelTags.get(familyKey) || this.modelTags.get('omni') || this.allValidTags;

    // Filter both [tag] and <|tag|> bracket formats based on model-specific tag set
    return text.replace(/(\[[^\]]+\]|<\|[^|]+\|>)/g, (match) => {
      const normalized = match.trim().toLowerCase();
      if (validSet.has(normalized)) {
        return match;
      }
      return ' ';
    }).replace(/\s+/g, ' ').trim();
  }

  process(text, modelFamily = 'omnivoice', allowUnfiltered = false) {
    let cleaned = this.cleanEmoji(text);
    cleaned = this.filterBracketedTags(cleaned, modelFamily, allowUnfiltered);
    return cleaned;
  }
}

module.exports = TextProcessor;
