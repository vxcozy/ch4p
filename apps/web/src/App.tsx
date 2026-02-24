import { useState, useCallback, useMemo, lazy, Suspense } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useCanvasState } from './hooks/useCanvasState';
import type { S2CMessage } from '@ch4p/canvas';
import './styles/globals.css';

// Lazy-load heavyweight components to reduce initial bundle size.
// CanvasEditor pulls in tldraw (~500KB gzipped); ChatPanel is lighter
// but still benefits from code-splitting.
const CanvasEditor = lazy(() =>
  import('./canvas/CanvasEditor').then((m) => ({ default: m.CanvasEditor })),
);
const ChatPanel = lazy(() =>
  import('./chat/ChatPanel').then((m) => ({ default: m.ChatPanel })),
);

// Preload tldraw chunk during idle time so canvas opens instantly.
if (typeof window !== 'undefined') {
  const preload = () => import('./canvas/CanvasEditor');
  if ('requestIdleCallback' in window) {
    requestIdleCallback(preload);
  } else {
    setTimeout(preload, 2000);
  }
}

/** Extract session ID from URL params or use a default. */
function getSessionId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get('session') ?? 'default';
}

export function App() {
  const sessionId = useMemo(() => getSessionId(), []);

  // Agent status state
  const [agentStatus, setAgentStatus] = useState<string>('idle');
  const [agentStatusMessage, setAgentStatusMessage] = useState<string>('');

  // Chat messages
  const [messages, setMessages] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([]);
  const [partialText, setPartialText] = useState('');

  // Canvas state management (processes canvas-specific S2C messages)
  const canvasState = useCanvasState(sessionId);

  // WebSocket handler — processes S2C messages, delegating canvas msgs
  const handleMessage = useCallback((msg: S2CMessage) => {
    switch (msg.type) {
      case 's2c:agent:status':
        setAgentStatus(msg.status);
        setAgentStatusMessage(msg.message ?? '');
        if (msg.status === 'idle' || msg.status === 'complete') {
          setPartialText('');
        }
        break;

      case 's2c:text:delta':
        setPartialText(msg.partial);
        break;

      case 's2c:text:complete':
        setMessages((prev) => [...prev, { role: 'assistant', text: msg.text }]);
        setPartialText('');
        break;

      default:
        // Canvas changes, tool events, etc. — delegate to canvas state handler
        canvasState.handleMessage(msg);
        break;
    }
  }, [canvasState]);

  // WebSocket connection
  const { send, connected } = useWebSocket(sessionId, handleMessage);

  // Send a chat message
  const handleSendMessage = useCallback(
    (text: string) => {
      setMessages((prev) => [...prev, { role: 'user', text }]);
      send({ type: 'c2s:message', text });
    },
    [send],
  );

  // Abort agent
  const handleAbort = useCallback(() => {
    send({ type: 'c2s:abort', reason: 'User requested abort' });
  }, [send]);

  return (
    <div className="app-layout">
      <div className="canvas-area">
        <Suspense fallback={<div className="loading-indicator">Loading canvas...</div>}>
          <CanvasEditor
            nodes={canvasState.nodes}
            connections={canvasState.connections}
            onDrag={(componentId, position) => {
              send({ type: 'c2s:drag', componentId, position });
            }}
            onClick={(componentId, actionId) => {
              send({ type: 'c2s:click', componentId, actionId });
            }}
            onFormSubmit={(componentId, values) => {
              send({ type: 'c2s:form_submit', componentId, values });
            }}
          />
        </Suspense>
      </div>
      <div className="chat-area">
        <Suspense fallback={<div className="loading-indicator">Loading chat...</div>}>
          <ChatPanel
            messages={messages}
            partialText={partialText}
            agentStatus={agentStatus}
            agentStatusMessage={agentStatusMessage}
            connected={connected}
            onSend={handleSendMessage}
            onAbort={handleAbort}
          />
        </Suspense>
      </div>
    </div>
  );
}
