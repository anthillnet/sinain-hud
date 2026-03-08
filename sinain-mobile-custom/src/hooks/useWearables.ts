import {useState, useEffect, useCallback} from 'react';
import {NativeModules, NativeEventEmitter} from 'react-native';
import type {FrameData, PhotoResult, StreamConfig, WearableState} from '../types';

const {WearablesBridge} = NativeModules;
const emitter = WearablesBridge
  ? new NativeEventEmitter(WearablesBridge)
  : null;

export function useWearables() {
  const [state, setState] = useState<WearableState>({
    connection: 'idle',
    stream: 'stopped',
  });
  const [frame, setFrame] = useState<FrameData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!emitter) return;

    const frameSub = emitter.addListener('onFrame', (data: FrameData) => {
      setFrame(data);
    });

    const stateSub = emitter.addListener('onState', (data: WearableState) => {
      setState(data);
    });

    const errorSub = emitter.addListener(
      'onError',
      (data: {code: string; message: string}) => {
        setError(`${data.code}: ${data.message}`);
      },
    );

    WearablesBridge?.getState().then((s: WearableState) => setState(s));

    return () => {
      frameSub.remove();
      stateSub.remove();
      errorSub.remove();
    };
  }, []);

  const startRegistration = useCallback(async () => {
    setError(null);
    try {
      await WearablesBridge.startRegistration();
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const startStream = useCallback(async (config?: StreamConfig) => {
    setError(null);
    try {
      await WearablesBridge.startStream(config ?? {});
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const stopStream = useCallback(async () => {
    setError(null);
    try {
      await WearablesBridge.stopStream();
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  const capturePhoto = useCallback(async (): Promise<PhotoResult | null> => {
    setError(null);
    try {
      return await WearablesBridge.capturePhoto();
    } catch (e: any) {
      setError(e.message);
      return null;
    }
  }, []);

  return {
    ...state,
    frame,
    error,
    isStreaming: state.stream === 'streaming',
    startRegistration,
    startStream,
    stopStream,
    capturePhoto,
  };
}
