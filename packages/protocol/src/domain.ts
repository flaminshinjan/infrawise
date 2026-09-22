export type DeviceState =
  "AVAILABLE" | "RESERVED" | "IN_USE" | "CLEANING" | "OFFLINE";

export type DeviceKind = "ANDROID_EMULATOR" | "ANDROID_PHYSICAL";

export interface Device {
  id: string;
  adbSerial: string;
  kind: DeviceKind;
  state: DeviceState;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  currentSessionId?: string;
  leaseFence?: number;
  lastHealthAt: number;
  /** consecutive failed health checks / cleanups, drives OFFLINE transitions */
  failureCount?: number;
}

export type QueueState = "WAITING" | "CLAIMED" | "CANCELLED" | "EXPIRED";

export interface QueueEntry {
  requestId: string;
  clientId: string;
  clientTokenHash: string;
  enqueuedAt: number;
  state: QueueState;
  claimDeadline?: number;
}

export type SessionState =
  | "RESERVED"
  | "ACTIVE"
  | "DISCONNECTED"
  | "ENDING"
  | "CLEANING"
  | "ENDED"
  | "EXPIRED";

export const NONTERMINAL_SESSION_STATES: SessionState[] = [
  "RESERVED",
  "ACTIVE",
  "DISCONNECTED",
  "ENDING",
  "CLEANING",
];

export interface Session {
  id: string;
  clientId: string;
  deviceId: string;
  state: SessionState;
  leaseFence: number;
  claimTokenHash?: string;
  createdAt: number;
  activatedAt?: number;
  expiresAt: number;
  claimDeadline?: number;
  reconnectDeadline?: number;
  lastHeartbeatAt: number;
  lastAcceptedInputSeq: number;
  endReason?: string;
}

export type LabEventType =
  | "QUEUE_JOINED"
  | "QUEUE_POSITION_CHANGED"
  | "QUEUE_CANCELLED"
  | "QUEUE_EXPIRED"
  | "DEVICE_RESERVED"
  | "SESSION_ACTIVATED"
  | "CLIENT_DISCONNECTED"
  | "SESSION_RECONNECTED"
  | "SESSION_ENDED"
  | "SESSION_EXPIRED"
  | "CLEANUP_STARTED"
  | "CLEANUP_COMPLETED"
  | "CLEANUP_FAILED"
  | "DEVICE_OFFLINE"
  | "DEVICE_RECOVERED"
  | "SERVER_RESTARTED";

export interface LabEvent {
  id: string;
  at: number;
  type: LabEventType;
  clientId?: string;
  sessionId?: string;
  deviceId?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export interface DisplayInfo {
  deviceId: string;
  kind: DeviceKind;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
}

export interface PoolStatus {
  available: number;
  inUse: number;
  reserved: number;
  cleaning: number;
  offline: number;
  queueDepth: number;
}
