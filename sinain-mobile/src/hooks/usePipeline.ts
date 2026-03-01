import {useEffect, useState} from 'react';
import {NativeEventEmitter, NativeModules} from 'react-native';
import type {PipelineState, GatewayStatus, RpcStatus} from '../types';

const {WearablesBridge} = NativeModules;
const emitter = new NativeEventEmitter(WearablesBridge);

/**
 * Subscribes to native pipeline events (onPipelineResponse, onPipelineStatus).
 * Zero JS pipeline code — this is a pure event listener.
 */
export function usePipeline(): PipelineState {
  const [state, setState] = useState<PipelineState>({
    gatewayStatus: 'disconnected',
    lastRpcStatus: 'idle',
    tick: 0,
    lastResponse: '',
    lastVision: null,
    error: null,
  });

  useEffect(() => {
    const respSub = emitter.addListener('onPipelineResponse', e => {
      setState(s => ({
        ...s,
        tick: e.tick,
        lastResponse: e.text,
        lastRpcStatus: e.isStreaming
          ? ('streaming' as RpcStatus)
          : ('received' as RpcStatus),
      }));
    });

    const statusSub = emitter.addListener('onPipelineStatus', e => {
      setState(s => ({
        ...s,
        gatewayStatus: e.gatewayStatus as GatewayStatus,
        lastRpcStatus: e.rpcStatus as RpcStatus,
        tick: e.tick,
      }));
    });

    return () => {
      respSub.remove();
      statusSub.remove();
    };
  }, []);

  return state;
}
