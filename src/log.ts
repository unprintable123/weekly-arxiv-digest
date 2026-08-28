import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
    run?: string;
    stage?: string;
    arxiv_id?: string;
    category?: string;
    cache_hit?: boolean;
    elapsed_ms?: number;
    status?: string;
    error_type?: string;
    [key: string]: unknown;
}

export interface LoggerOptions {
    /** run id attached to every entry */
    runId?: string;
    /** emit debug-level entries (also enables trace file writes) */
    debug?: boolean;
    /** optional protected trace file path for full detail */
    traceFile?: string;
    /** stream for normal entries (default: stderr so stdout stays machine-readable) */
    stream?: NodeJS.WritableStream;
}

/**
 * Structured JSON-lines logger. Summaries are intentionally excluded from the
 * log: prompts and digest bodies only ever go to the optional trace file.
 */
export class Logger {
    private readonly runId?: string;
    private readonly debugEnabled: boolean;
    private readonly traceFile?: string;
    private readonly stream: NodeJS.WritableStream;

    constructor(options: LoggerOptions = {}) {
        this.runId = options.runId;
        this.debugEnabled = options.debug ?? false;
        this.traceFile = options.traceFile;
        this.stream = options.stream ?? process.stderr;
    }

    log(level: LogLevel, event: string, fields: LogFields = {}): void {
        if (level === 'debug' && !this.debugEnabled) return;
        const entry: Record<string, unknown> = {
            ts: new Date().toISOString(),
            level,
            event,
            ...(this.runId ? { run: this.runId } : {}),
            ...fields,
        };
        this.stream.write(`${JSON.stringify(entry)}\n`);
        if (this.debugEnabled && this.traceFile) this.writeTrace(entry);
    }

    debug(event: string, fields: LogFields = {}): void {
        this.log('debug', event, fields);
    }

    info(event: string, fields: LogFields = {}): void {
        this.log('info', event, fields);
    }

    warn(event: string, fields: LogFields = {}): void {
        this.log('warn', event, fields);
    }

    error(event: string, fields: LogFields = {}): void {
        this.log('error', event, fields);
    }

    private writeTrace(entry: Record<string, unknown>): void {
        try {
            mkdirSync(dirname(this.traceFile!), { recursive: true });
            appendFileSync(this.traceFile!, `${JSON.stringify(entry)}\n`);
        } catch {
            // Trace logging must never break the pipeline.
        }
    }
}

export const elapsed = (start: number): number => Date.now() - start;
