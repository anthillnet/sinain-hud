import React, {useEffect, useRef} from 'react';
import {Animated, FlatList, StyleSheet, Text, View} from 'react-native';
import type {MessageEntry} from '../types';

interface Props {
  messages: MessageEntry[];
}

function ResponseFeed({messages}: Props): React.JSX.Element {
  const animMap = useRef<Map<string, Animated.Value>>(new Map());

  // Fade-in new messages
  useEffect(() => {
    for (const msg of messages) {
      if (msg.id === 'placeholder') {
        continue;
      }
      if (!animMap.current.has(msg.id)) {
        const val = new Animated.Value(0);
        animMap.current.set(msg.id, val);
        Animated.timing(val, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }).start();
      }
    }
  }, [messages]);

  // Prune stale animation values
  useEffect(() => {
    const currentIds = new Set(messages.map(m => m.id));
    for (const key of animMap.current.keys()) {
      if (!currentIds.has(key)) {
        animMap.current.delete(key);
      }
    }
  }, [messages]);

  const renderItem = ({
    item,
    index,
  }: {
    item: MessageEntry;
    index: number;
  }) => {
    const fadeAnim = animMap.current.get(item.id);
    const positionalOpacity = Math.max(0.25, 1 - index * 0.12);

    if (item.id === 'placeholder') {
      return <Text style={styles.placeholderText}>{item.text}</Text>;
    }

    return (
      <Animated.View
        style={[
          styles.messageRow,
          {
            opacity: fadeAnim
              ? Animated.multiply(fadeAnim, positionalOpacity)
              : positionalOpacity,
          },
        ]}>
        {item.isStreaming && <View style={styles.streamDot} />}
        <Text style={styles.messageText}>{item.text}</Text>
      </Animated.View>
    );
  };

  return (
    <FlatList
      data={messages}
      renderItem={renderItem}
      keyExtractor={item => item.id}
      inverted
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.listContent}
    />
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingVertical: 4,
    gap: 8,
  },
  messageRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  streamDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#0A84FF',
    marginTop: 7,
    flexShrink: 0,
  },
  messageText: {
    color: '#E5E5EA',
    fontSize: 15,
    lineHeight: 20,
    flex: 1,
  },
  placeholderText: {
    color: '#666',
    fontSize: 15,
    lineHeight: 20,
    fontStyle: 'italic',
  },
});

export default React.memo(ResponseFeed);
