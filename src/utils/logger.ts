import pino from 'pino';

const isTTY = process.stdout.isTTY ?? false;

export const logger = pino(
  isTTY
    ? {
        level: process.env.LOG_LEVEL ?? 'info',
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : { level: process.env.LOG_LEVEL ?? 'info' },
);

export type Logger = typeof logger;
