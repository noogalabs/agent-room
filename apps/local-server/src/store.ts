import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Message, Participant, Room, TaskBoard } from '@agent-room/shared';

export interface AuthenticatedParticipant {
  id: string;
  tokenHash: string;
  participant: Participant;
}

export interface DurableRoom {
  room: Room;
  accessHash: string;
  participants: Record<string, AuthenticatedParticipant>;
  messages: Message[];
  board: TaskBoard;
}

interface Database {
  version: 1;
  rooms: Record<string, DurableRoom>;
}

const EMPTY: Database = { version: 1, rooms: {} };

export function secret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class DurableStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = join(dataDir, 'rooms.json');
  }

  async read<T>(fn: (db: Readonly<Database>) => T): Promise<T> {
    await this.queue;
    return fn(await this.load());
  }

  async transaction<T>(fn: (db: Database) => T | Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const db = await this.load();
      const result = await fn(db);
      await this.save(db);
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async load(): Promise<Database> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Database;
      if (parsed.version !== 1 || !parsed.rooms) throw new Error('unsupported local store');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(EMPTY);
      throw error;
    }
  }

  private async save(db: Database): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
