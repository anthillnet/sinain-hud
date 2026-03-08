import React from 'react';
import {View, Image, Text, StyleSheet} from 'react-native';
import type {FrameData} from '../types';

interface Props {
  frame: FrameData | null;
  isStreaming: boolean;
}

function CameraPreview({frame, isStreaming}: Props): React.JSX.Element {
  if (!frame) {
    return (
      <View style={styles.container}>
        <View style={styles.placeholder}>
          <Text style={styles.placeholderText}>
            {isStreaming ? 'Waiting for frames...' : 'No stream active'}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.previewWrapper}>
        <Image
          source={{uri: frame.uri + '?t=' + frame.timestamp}}
          style={styles.preview}
          resizeMode="contain"
        />
        <View style={styles.fpsOverlay}>
          <Text style={styles.fpsText}>FPS: {frame.fps}</Text>
        </View>
        <View style={styles.resOverlay}>
          <Text style={styles.resText}>
            {frame.width}x{frame.height}
          </Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    margin: 16,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#111',
  },
  previewWrapper: {
    flex: 1,
  },
  preview: {
    flex: 1,
  },
  fpsOverlay: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  fpsText: {
    color: '#34C759',
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  resOverlay: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  resText: {
    color: '#AAA',
    fontSize: 12,
  },
  placeholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  placeholderText: {
    color: '#555',
    fontSize: 16,
  },
});

export default React.memo(CameraPreview);
