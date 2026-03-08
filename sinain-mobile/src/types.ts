export interface FrameData {
  uri: string;
  width: number;
  height: number;
  fps: number;
  timestamp: number;
}

export interface PhotoResult {
  uri: string;
  width: number;
  height: number;
}

export interface WearableState {
  connection: string;
  stream: string;
}

export interface StreamConfig {
  resolution?: 'low' | 'medium' | 'high';
  frameRate?: number;
}

export interface WearableError {
  code: string;
  message: string;
}

export type FrameClass = 'scene' | 'text' | 'motion' | 'ambient' | 'drop';

export type GatewayStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'error';

export type RpcStatus =
  | 'idle'
  | 'sending'
  | 'accepted'
  | 'streaming'
  | 'received'
  | 'error'
  | 'timeout';

export interface VisionResult {
  description: string;
  ocrText: string;
  latencyMs: number;
}

export interface PipelineState {
  gatewayStatus: GatewayStatus;
  lastRpcStatus: RpcStatus;
  tick: number;
  lastResponse: string;
  lastVision: VisionResult | null;
  error: string | null;
}

export interface MessageEntry {
  id: string;
  text: string;
  isStreaming: boolean;
  timestamp: number;
}
