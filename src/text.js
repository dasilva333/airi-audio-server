const fs = require('fs');
const path = require('path');

// Emoji regex: Strips pictographic emoji but preserves digits 0-9.
const EMOJI_REGEX = /(?!\d)[\u{1F000}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\uFE0F?/gu;

class TextProcessor {
  constructor(tagsCsvPath) {
    this.validTags = new Set();
    this.loadSupportedTags(tagsCsvPath);
  }

  loadSupportedTags(csvPath) {
    if (fs.existsSync(csvPath)) {
      try {
        const content = fs.readFileSync(csvPath, 'utf-8');
        const lines = content.split('\n');
        for (let i = 1; i < lines.length; i++) {
          const parts = lines[i].split(',');
          if (parts.length >= 2) {
            const tag = parts[1].trim().toLowerCase();
            if (tag) {
              this.validTags.add(`[${tag.replace(/_/g, ' ')}]`);
              this.validTags.add(`[${tag}]`);
            }
          }
        }
        console.log(`[TextProcessor] Loaded ${this.validTags.size} supported tags.`);
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

  filterBracketedTags(text, allowUnfiltered = false) {
    if (!text) return '';
    if (allowUnfiltered) {
      return text;
    }
    return text.replace(/\[[^\]]+\]/g, (match) => {
      const normalized = match.trim().toLowerCase();
      if (this.validTags.has(normalized)) {
        return match;
      }
      return ' ';
    }).replace(/\s+/g, ' ').trim();
  }

  process(text, allowUnfiltered = false) {
    let cleaned = this.cleanEmoji(text);
    cleaned = this.filterBracketedTags(cleaned, allowUnfiltered);
    return cleaned;
  }
}

module.exports = TextProcessor;
