import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Button, Empty, Input, Tabs, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useRemoteWorkspace } from '../../modules/remote/RemoteWorkspaceProvider';

const { Text } = Typography;

interface RemoteTerminalSessionPayload {
  id: string;
  connectionId: string;
  title: string;
  cwd: string;
}

interface TerminalOutputEvent {
  connectionId: string;
  sessionId: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function TerminalPane() {
  const { state, dispatch } = useRemoteWorkspace();
  const [command, setCommand] = useState('');

  const activeConnectionId = state.activeConnectionId;
  const activeConnectionTabs = useMemo(
    () =>
      activeConnectionId
        ? state.terminalTabs.filter(
            (terminalTab) => terminalTab.connectionId === activeConnectionId,
          )
        : [],
    [activeConnectionId, state.terminalTabs],
  );
  const activeTerminalTabId = activeConnectionTabs.some(
    (terminalTab) => terminalTab.id === state.activeTerminalTabId,
  )
    ? state.activeTerminalTabId
    : activeConnectionTabs[0]?.id ?? null;

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;

    const registerListener = async () => {
      try {
        const unlisten = await listen<TerminalOutputEvent>(
          'remote://terminal-output',
          (event) => {
            const nextLine = [event.payload.stdout, event.payload.stderr]
              .filter(Boolean)
              .join('\n')
              .trim();

            if (!nextLine) {
              return;
            }

            dispatch({
              type: 'terminal/lineAppended',
              payload: {
                terminalTabId: event.payload.sessionId,
                line: nextLine,
              },
            });
          },
        );

        if (cancelled) {
          unlisten();
          return;
        }

        cleanup = unlisten;
      } catch {
        cleanup = undefined;
      }
    };

    void registerListener();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [dispatch]);

  const handleOpenTerminal = async () => {
    if (!activeConnectionId) {
      return;
    }

    if (activeTerminalTabId) {
      dispatch({
        type: 'terminal/activated',
        payload: { terminalTabId: activeTerminalTabId },
      });
      return;
    }

    const title = `term-${activeConnectionTabs.length + 1}`;
    const session = await invoke<RemoteTerminalSessionPayload>(
      'remote_open_terminal_session',
      {
        connectionId: activeConnectionId,
        title,
      },
    );

    dispatch({
      type: 'terminal/opened',
      payload: {
        ...session,
        lines: [],
      },
    });
  };

  const handleRunCommand = async (value: string) => {
    const trimmedValue = value.trim();

    if (!trimmedValue || !activeConnectionId || !activeTerminalTabId) {
      return;
    }

    dispatch({
      type: 'terminal/lineAppended',
      payload: {
        terminalTabId: activeTerminalTabId,
        line: `$ ${trimmedValue}`,
      },
    });

    await invoke('remote_run_terminal_command', {
      connectionId: activeConnectionId,
      sessionId: activeTerminalTabId,
      command: trimmedValue,
    });

    setCommand('');
  };

  return (
    <div className="remote-terminal-pane">
      <div className="remote-terminal-toolbar">
        <Button
          disabled={!activeConnectionId}
          onClick={() => void handleOpenTerminal()}
          type="primary"
        >
          Open Terminal
        </Button>
        <Text type="secondary">
          {activeConnectionId
            ? activeConnectionTabs.length > 0
              ? `${activeConnectionTabs.length} terminal session${activeConnectionTabs.length > 1 ? 's' : ''} retained`
              : 'Open a retained shell for the active remote host.'
            : 'Connect a host to start a terminal session.'}
        </Text>
      </div>

      <div className="remote-terminal-stage">
        {activeConnectionTabs.length > 0 ? (
          <Tabs
            activeKey={activeTerminalTabId ?? undefined}
            className="remote-terminal-tabs"
            items={activeConnectionTabs.map((terminalTab) => ({
              key: terminalTab.id,
              label: terminalTab.title,
              children: (
                <pre className="remote-terminal-output">
                  {terminalTab.lines.length > 0
                    ? terminalTab.lines.join('\n\n')
                    : 'Session ready. Run a command to see output here.'}
                </pre>
              ),
            }))}
            onChange={(terminalTabId) =>
              dispatch({
                type: 'terminal/activated',
                payload: { terminalTabId },
              })
            }
          />
        ) : (
          <div className="remote-terminal-empty">
            <Empty
              description="No terminal sessions open yet"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          </div>
        )}
      </div>

      <Input.Search
        className="remote-terminal-input"
        disabled={!activeTerminalTabId}
        enterButton="Send"
        onChange={(event) => setCommand(event.target.value)}
        onSearch={(value) => void handleRunCommand(value)}
        placeholder="Run command"
        value={command}
      />
    </div>
  );
}
