type Level = 'debug' | 'info' | 'warn' | 'error';
const weights: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(private readonly minimum: Level = 'info') {}

  debug(message: string, fields: Record<string, unknown> = {}): void {
    this.write('debug', message, fields);
  }
  info(message: string, fields: Record<string, unknown> = {}): void {
    this.write('info', message, fields);
  }
  warn(message: string, fields: Record<string, unknown> = {}): void {
    this.write('warn', message, fields);
  }
  error(message: string, fields: Record<string, unknown> = {}): void {
    this.write('error', message, fields);
  }

  private write(level: Level, message: string, fields: Record<string, unknown>): void {
    if (weights[level] < weights[this.minimum]) return;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, message, ...fields });
    (level === 'error' ? process.stderr : process.stdout).write(`${line}\n`);
  }
}
