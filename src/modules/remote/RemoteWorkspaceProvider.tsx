import {
  createContext,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import {
  createInitialRemoteWorkspaceState,
  remoteWorkspaceReducer,
} from './remoteWorkspaceReducer';

function useRemoteWorkspaceValue() {
  const [state, dispatch] = useReducer(
    remoteWorkspaceReducer,
    undefined,
    createInitialRemoteWorkspaceState,
  );

  return useMemo(() => ({ state, dispatch }), [state]);
}

type RemoteWorkspaceContextValue = ReturnType<typeof useRemoteWorkspaceValue>;

const RemoteWorkspaceContext = createContext<RemoteWorkspaceContextValue | null>(
  null,
);

export function RemoteWorkspaceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const value = useRemoteWorkspaceValue();

  return (
    <RemoteWorkspaceContext.Provider value={value}>
      {children}
    </RemoteWorkspaceContext.Provider>
  );
}

export function useRemoteWorkspace() {
  const value = useContext(RemoteWorkspaceContext);
  if (!value) {
    throw new Error(
      'useRemoteWorkspace must be used inside RemoteWorkspaceProvider',
    );
  }

  return value;
}
