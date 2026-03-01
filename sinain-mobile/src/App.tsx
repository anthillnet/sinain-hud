import React, {useEffect, useRef, useState} from 'react';
import {
  SafeAreaView,
  View,
  Image,
  Text,
  StyleSheet,
  StatusBar,
  NativeModules,
} from 'react-native';
import {useWearables} from './hooks/useWearables';
import {usePipeline} from './hooks/usePipeline';
import {useWatchSync} from './hooks/useWatchSync';
import {configFromEnv} from './pipeline/config';
import type {PhotoResult, GatewayStatus, RpcStatus, MessageEntry} from './types';
import StatusHeader from './components/StatusHeader';
import CameraPreview from './components/CameraPreview';
import Controls from './components/Controls';
import ResponseFeed from './components/ResponseFeed';

const {WearablesBridge} = NativeModules;
const PIPELINE_CONFIG = configFromEnv();
const MAX_HISTORY = 15;

function getResponsePlaceholder(
  rpcStatus: RpcStatus,
  gwStatus: GatewayStatus,
  streaming: boolean,
): string {
  if (rpcStatus === 'sending') return 'Sending to agent...';
  if (rpcStatus === 'accepted') return 'Agent thinking...';
  if (gwStatus === 'disconnected') return 'Gateway disconnected';
  if (gwStatus === 'connecting') return 'Connecting...';
  if (gwStatus === 'error') return 'Gateway error';
  if (!streaming) return 'Start streaming to begin';
  return 'Awaiting first observation...';
}

function App(): React.JSX.Element {
  const {
    connection,
    frame,
    error,
    isStreaming,
    startRegistration,
    startStream,
    stopStream,
    capturePhoto,
  } = useWearables();

  const pipeline = usePipeline();

  // Pass config to native pipeline on mount
  useEffect(() => {
    console.log(
      '[App] configure: token=' +
        (PIPELINE_CONFIG.gateway.token ? 'present' : 'EMPTY'),
    );
    WearablesBridge?.configure({
      openRouterApiKey: PIPELINE_CONFIG.vision.apiKey,
      visionModel: PIPELINE_CONFIG.vision.model,
      gatewayWsUrl: PIPELINE_CONFIG.gateway.wsUrl,
      gatewayToken: PIPELINE_CONFIG.gateway.token,
      sessionKey: PIPELINE_CONFIG.gateway.sessionKey,
    }).catch((e: any) => console.warn('[App] configure failed:', e));
  }, []);

  const [lastPhoto, setLastPhoto] = useState<PhotoResult | null>(null);
  const [messageHistory, setMessageHistory] = useState<MessageEntry[]>([]);
  const prevTickRef = useRef(0);

  // Capture finalized responses when tick advances
  useEffect(() => {
    if (pipeline.tick > prevTickRef.current && pipeline.lastResponse) {
      prevTickRef.current = pipeline.tick;
      setMessageHistory(prev =>
        [
          {
            id: `tick-${pipeline.tick}`,
            text: pipeline.lastResponse,
            isStreaming: false,
            timestamp: Date.now(),
          },
          ...prev,
        ].slice(0, MAX_HISTORY),
      );
    }
  }, [pipeline.tick, pipeline.lastResponse]);

  // Derived streaming entry (recomputed each render, not state)
  const streamingEntry: MessageEntry | null =
    pipeline.lastRpcStatus === 'streaming' ||
    pipeline.lastRpcStatus === 'accepted' ||
    pipeline.lastRpcStatus === 'sending'
      ? {
          id: 'stream-current',
          text:
            pipeline.lastResponse ||
            getResponsePlaceholder(
              pipeline.lastRpcStatus,
              pipeline.gatewayStatus,
              isStreaming,
            ),
          isStreaming: true,
          timestamp: Date.now(),
        }
      : null;

  const displayMessages: MessageEntry[] = streamingEntry
    ? [streamingEntry, ...messageHistory]
    : messageHistory.length > 0
      ? messageHistory
      : [
          {
            id: 'placeholder',
            text: getResponsePlaceholder(
              pipeline.lastRpcStatus,
              pipeline.gatewayStatus,
              isStreaming,
            ),
            isStreaming: false,
            timestamp: 0,
          },
        ];

  // Sync to watch
  useWatchSync(displayMessages, {
    gatewayStatus: pipeline.gatewayStatus,
    lastRpcStatus: pipeline.lastRpcStatus,
    isStreaming,
    tick: pipeline.tick,
  });

  const handleCapture = async () => {
    const photo = await capturePhoto();
    if (photo) setLastPhoto(photo);
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" />

      <StatusHeader
        connection={connection}
        gatewayStatus={pipeline.gatewayStatus}
        tick={pipeline.tick}
      />

      <CameraPreview frame={frame} isStreaming={isStreaming} />

      <View style={styles.responseContainer}>
        <ResponseFeed messages={displayMessages} />
      </View>

      <Controls
        isStreaming={isStreaming}
        onRegister={startRegistration}
        onStream={() => startStream({resolution: 'high', frameRate: 10})}
        onStop={stopStream}
        onCapture={handleCapture}
      />

      {lastPhoto && (
        <View style={styles.photoRow}>
          <Image
            source={{uri: lastPhoto.uri}}
            style={styles.thumbnail}
            resizeMode="cover"
          />
          <Text style={styles.photoText}>
            {lastPhoto.width}x{lastPhoto.height}
          </Text>
        </View>
      )}

      {(error || pipeline.error) && (
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>{error || pipeline.error}</Text>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  responseContainer: {
    marginHorizontal: 16,
    marginBottom: 8,
    height: 180,
    backgroundColor: '#1C1C1E',
    borderRadius: 10,
    padding: 12,
  },
  photoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 10,
  },
  thumbnail: {
    width: 48,
    height: 48,
    borderRadius: 6,
  },
  photoText: {
    color: '#AAA',
    fontSize: 13,
  },
  errorContainer: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 10,
    backgroundColor: '#3A1010',
    borderRadius: 8,
  },
  errorText: {
    color: '#FF6B6B',
    fontSize: 13,
  },
});

export default App;
