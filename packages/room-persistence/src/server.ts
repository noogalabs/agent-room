import type { Message, Room, RoomReport, TaskBoard } from '@agent-room/shared';
import { createRoomPersistence, type PersistenceDependencies, type PersistenceEnvironment } from './factory.js';
import type { LeaseEventInput, LeaseMembershipPrecondition, RoomPersistence, RoomReceipt, StoredFleetTrustKey } from './types.js';

/**
 * Server-side production entry for durable room records. Business-rule layers
 * call this object; only the selected adapter knows Redis or Postgres.
 */
export class RoomRecordServer {
  constructor(readonly persistence: RoomPersistence) {}

  static async fromEnvironment(
    env: PersistenceEnvironment,
    dependencies: PersistenceDependencies = {},
  ): Promise<RoomRecordServer> {
    return new RoomRecordServer(await createRoomPersistence(env, dependencies));
  }

  createRoom(room: Room): Promise<void> { return this.persistence.createRoom(room); }
  deleteRoomIfVersion(code: string, expectedVersion: number): Promise<boolean> {
    return this.persistence.deleteRoomIfVersion(code, expectedVersion);
  }
  async getRoom(code: string): Promise<Room | null> {
    const room = await this.persistence.getRoom(code);
    if (!room) return null;
    const seen = new Set<string>();
    const participants = room.participants.filter(participant => {
      const fingerprint = participant.authenticatedIdentity?.cardFingerprint;
      if (!fingerprint) return true;
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    });
    return participants.length === room.participants.length ? room : { ...room, participants };
  }
  updateRoom(code: string, expectedVersion: number, next: Room): Promise<boolean> {
    return this.persistence.compareAndSwapRoom(code, expectedVersion, next);
  }
  updateRoomAndDeleteReceipt(code: string, expectedVersion: number, next: Room, receiptId: string): Promise<boolean> {
    return this.persistence.compareAndSwapRoomAndDeleteReceipt(code, expectedVersion, next, receiptId);
  }
  updateRoomAndReplaceReceipt(
    code: string, expectedVersion: number, next: Room, receipt: RoomReceipt, deleteReceiptId?: string,
  ): Promise<boolean> {
    return this.persistence.compareAndSwapRoomAndReplaceReceipt(code, expectedVersion, next, receipt, deleteReceiptId);
  }
  updateRoomAndReceipts(
    code: string, expectedVersion: number, next: Room,
    deleteReceiptIds: readonly string[], appendReceipts: readonly RoomReceipt[],
  ): Promise<boolean> {
    return this.persistence.compareAndSwapRoomAndReceipts(
      code, expectedVersion, next, deleteReceiptIds, appendReceipts,
    );
  }
  appendMessage(code: string, message: Message): Promise<number> {
    return this.persistence.appendMessage(code, message);
  }
  listMessages(code: string, fromSequence: number): Promise<Message[]> {
    return this.persistence.listMessages(code, fromSequence);
  }
  getTaskBoard(code: string): Promise<TaskBoard | null> {
    return this.persistence.getTaskBoard(code);
  }
  updateTaskBoard(code: string, expectedVersion: number | null, next: TaskBoard): Promise<boolean> {
    return this.persistence.compareAndSwapTaskBoard(code, expectedVersion, next);
  }
  updateTaskBoardWithLeaseEvents(
    code: string,
    expectedVersion: number | null,
    next: TaskBoard,
    events: readonly LeaseEventInput[],
    membership?: LeaseMembershipPrecondition,
  ): Promise<boolean> {
    return this.persistence.compareAndSwapTaskBoardWithLeaseEvents(code, expectedVersion, next, events, membership);
  }
  putMinutes(code: string, reportId: string, report: RoomReport): Promise<void> {
    return this.persistence.putMinutes(code, reportId, report);
  }
  getMinutes(code: string, reportId: string): Promise<RoomReport | null> {
    return this.persistence.getMinutes(code, reportId);
  }
  appendReceipt(receipt: RoomReceipt): Promise<boolean> {
    return this.persistence.appendReceipt(receipt);
  }
  deleteReceipt(code: string, receiptId: string): Promise<boolean> {
    return this.persistence.deleteReceipt(code, receiptId);
  }
  appendLeaseEvent(event: LeaseEventInput): Promise<boolean> {
    return this.persistence.appendLeaseEvent(event);
  }
  listReceipts(code: string): Promise<RoomReceipt[]> {
    return this.persistence.listReceipts(code);
  }
  listFleetTrustKeys(): Promise<StoredFleetTrustKey[]> { return this.persistence.listFleetTrustKeys(); }
  putFleetTrustKey(key: StoredFleetTrustKey): Promise<void> { return this.persistence.putFleetTrustKey(key); }
  deleteFleetTrustKey(fleetId: string, keyId: string): Promise<boolean> {
    return this.persistence.deleteFleetTrustKey(fleetId, keyId);
  }
  close(): Promise<void> { return this.persistence.close(); }
}
