import React from 'react';
import { Text } from 'ink';

interface WritebackNotificationProps {
  file: string;
  status: 'writing' | 'success' | 'error';
  error?: string;
}

export default function WritebackNotification({ file, status, error }: WritebackNotificationProps): React.ReactElement {
  if (status === 'error') {
    return <Text dimColor color="red">[memory] failed to write {file}: {error}</Text>;
  }
  if (status === 'writing') {
    return <Text dimColor>[memory] writing {file}...</Text>;
  }
  return <Text dimColor>[memory] wrote {file}</Text>;
}

export { type WritebackNotificationProps };
