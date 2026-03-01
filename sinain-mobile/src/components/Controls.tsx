import React from 'react';
import {View, TouchableOpacity, Text, StyleSheet} from 'react-native';

interface Props {
  isStreaming: boolean;
  onRegister: () => void;
  onStream: () => void;
  onStop: () => void;
  onCapture: () => void;
}

function Controls({
  isStreaming,
  onRegister,
  onStream,
  onStop,
  onCapture,
}: Props): React.JSX.Element {
  return (
    <View style={styles.controls}>
      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.button, styles.registerBtn]}
          onPress={onRegister}>
          <Text style={styles.buttonText}>Register</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.button,
            isStreaming ? styles.stopBtn : styles.streamBtn,
          ]}
          onPress={isStreaming ? onStop : onStream}>
          <Text style={styles.buttonText}>
            {isStreaming ? 'Stop' : 'Stream'}
          </Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity
        style={[
          styles.button,
          styles.captureBtn,
          !isStreaming && styles.disabledBtn,
        ]}
        onPress={onCapture}
        disabled={!isStreaming}>
        <Text style={styles.buttonText}>Capture Photo</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  controls: {
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  button: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  registerBtn: {
    backgroundColor: '#1C1C1E',
  },
  streamBtn: {
    backgroundColor: '#0A84FF',
  },
  stopBtn: {
    backgroundColor: '#FF3B30',
  },
  captureBtn: {
    backgroundColor: '#30D158',
  },
  disabledBtn: {
    opacity: 0.4,
  },
  buttonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
  },
});

export default React.memo(Controls);
