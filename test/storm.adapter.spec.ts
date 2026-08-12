import { describe, expect, it } from 'vitest';
import { parsePlayLines } from '../packages/sources/storm/src/storm.adapter.js';

describe('Storm playback parser', () => {
  it('maps multiple lines and supported formats', () => {
    const lines = parsePlayLines(
      'hls$$$backup',
      '第1集$https://media.example/1.m3u8#第2集$https://media.example/2.m3u8$$$第1集$https://cdn.example/1.mp4',
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]?.episodes).toHaveLength(2);
    expect(lines[1]?.formatHint).toBe('mp4');
  });
  it('drops malformed, duplicate, insecure and unsupported entries', () => {
    const lines = parsePlayLines(
      'x',
      'bad#A$http://bad.example/a.m3u8#A$https://ok.example/a.avi#A$https://ok.example/a.m3u8#A$https://ok.example/a.m3u8',
    );
    expect(lines[0]?.episodes).toHaveLength(1);
  });
  it('extracts episode numbers', () => {
    expect(parsePlayLines('x', '第12集$https://ok.example/a.m3u8')[0]?.episodes[0]?.episodeNo).toBe(
      12,
    );
  });
});
