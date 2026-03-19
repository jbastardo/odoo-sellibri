export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  module: string;
  message: string;
}

const MAX_LOG_ENTRIES = 500;
const logBuffer: LogEntry[] = [];

function addLog(level: LogEntry['level'], module: string, message: string): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_LOG_ENTRIES) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_ENTRIES);
  }
  const prefix = `[${entry.timestamp}] [${level.toUpperCase()}] [${module}]`;
  if (level === 'error') {
    console.error(`${prefix} ${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ${message}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

export const logger = {
  info: (module: string, message: string) => addLog('info', module, message),
  warn: (module: string, message: string) => addLog('warn', module, message),
  error: (module: string, message: string) => addLog('error', module, message),
  getLogs: (limit = 100): LogEntry[] => logBuffer.slice(-limit),
};
