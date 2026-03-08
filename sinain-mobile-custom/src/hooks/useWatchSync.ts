import {useEffect, useRef} from 'react';
import {NativeModules} from 'react-native';
import type {GatewayStatus, RpcStatus, MessageEntry} from '../types';

const {WatchBridge} = NativeModules;

interface PipelineStatus {
  gatewayStatus: GatewayStatus;
  lastRpcStatus: RpcStatus;
  isStreaming: boolean;
  tick: number;
}

const MAX_WATCH_MESSAGES = 10;
const DEBOUNCE_MS = 200;

export function useWatchSync(
  messages: MessageEntry[],
  status: PipelineStatus,
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastKeyRef = useRef<string>('');

  useEffect(() => {
    if (!WatchBridge) {
      return;
    }

    const filtered = messages
      .filter(m => m.id !== 'placeholder')
      .slice(0, MAX_WATCH_MESSAGES);

    const key = JSON.stringify({
      ids: filtered.map(m => m.id),
      streaming: filtered.map(m => m.isStreaming),
      texts: filtered.map(m => m.text.slice(0, 100)),
      gw: status.gatewayStatus,
      rpc: status.lastRpcStatus,
      str: status.isStreaming,
      tick: status.tick,
    });

    if (key === lastKeyRef.current) {
      return;
    }

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    timerRef.current = setTimeout(() => {
      lastKeyRef.current = key;

      const payload = filtered.map(m => ({
        id: m.id,
        text: m.text,
        isStreaming: m.isStreaming,
        timestamp: m.timestamp,
      }));

      const statusPayload = {
        gatewayStatus: status.gatewayStatus,
        lastRpcStatus: status.lastRpcStatus,
        isStreaming: status.isStreaming,
        tick: status.tick,
      };

      WatchBridge.updateFeed(payload, statusPayload).catch(() => {});
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [
    messages,
    status.gatewayStatus,
    status.lastRpcStatus,
    status.isStreaming,
    status.tick,
  ]);
}
