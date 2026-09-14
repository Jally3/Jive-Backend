import { RecommendationError } from './types.js';

/** Extracts completed object values from a top-level {"items":[...]} JSON response. */
export class JsonItemsStreamParser {
  private source = '';
  private offset = 0;
  private arrayStarted = false;
  private arrayClosed = false;
  private valueStart = -1;
  private depth = 0;
  private inString = false;
  private escaped = false;

  push(chunk: string): unknown[] {
    if (this.arrayClosed && chunk.trim()) throw invalidResponse();
    this.source += chunk;
    if (!this.arrayStarted) {
      const prefix = /^\s*\{\s*"items"\s*:\s*\[/.exec(this.source);
      if (!prefix) {
        if (this.source.length > 64) throw invalidResponse();
        return [];
      }
      this.arrayStarted = true;
      this.offset = prefix[0].length;
    }

    const values: unknown[] = [];
    while (this.offset < this.source.length && !this.arrayClosed) {
      const character = this.source[this.offset]!;
      if (this.valueStart < 0) {
        if (/\s|,/.test(character)) {
          this.offset += 1;
          continue;
        }
        if (character === ']') {
          this.arrayClosed = true;
          this.offset += 1;
          break;
        }
        if (character !== '{') throw invalidResponse();
        this.valueStart = this.offset;
        this.depth = 1;
        this.offset += 1;
        continue;
      }

      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (character === '\\') this.escaped = true;
        else if (character === '"') this.inString = false;
      } else if (character === '"') {
        this.inString = true;
      } else if (character === '{' || character === '[') {
        this.depth += 1;
      } else if (character === '}' || character === ']') {
        this.depth -= 1;
        if (this.depth === 0) {
          const raw = this.source.slice(this.valueStart, this.offset + 1);
          try {
            values.push(JSON.parse(raw));
          } catch {
            throw invalidResponse();
          }
          this.valueStart = -1;
        }
      }
      this.offset += 1;
    }
    return values;
  }

  finish(): string {
    if (!this.arrayStarted || !this.arrayClosed || this.valueStart >= 0 || this.inString) {
      throw invalidResponse();
    }
    return this.source;
  }
}

const invalidResponse = (): RecommendationError =>
  new RecommendationError(502, 'RECOMMENDATION_INVALID_RESPONSE', '模型未返回有效推荐');
