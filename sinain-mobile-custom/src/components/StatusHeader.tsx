import React from 'react';
import {View, Text, StyleSheet} from 'react-native';
import type {GatewayStatus} from '../types';

const GATEWAY_STATUS_COLORS: Record<string, string> = {
  connected: '#34C759',
  connecting: '#FF9500',
  disconnected: '#FF3B30',
  error: '#FF3B30',
};

interface Props {
  connection: string;
  gatewayStatus: GatewayStatus;
  tick: number;
}

function StatusHeader({connection, gatewayStatus, tick}: Props): React.JSX.Element {
  const isConnected = connection === 'connected';
  const gwColor = GATEWAY_STATUS_COLORS[gatewayStatus] || '#FF3B30';

  return (
    <View style={styles.header}>
      <Text style={styles.title}>ISinain</Text>
      <View style={styles.statusRow}>
        <View
          style={[
            styles.statusDot,
            {backgroundColor: isConnected ? '#34C759' : '#FF3B30'},
          ]}
        />
        <Text style={styles.statusText}>{connection}</Text>

        <View style={styles.statusSpacer} />
        <View style={[styles.statusDot, {backgroundColor: gwColor}]} />
        <Text style={styles.statusText}>{gatewayStatus}</Text>

        {tick > 0 && <Text style={styles.tickText}>#{tick}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFF',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  statusSpacer: {
    width: 8,
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusText: {
    color: '#AAA',
    fontSize: 14,
  },
  tickText: {
    color: '#666',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    marginLeft: 4,
  },
});

export default React.memo(StatusHeader);
