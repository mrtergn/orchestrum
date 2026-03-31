import { useEffect } from "react";

type EventSourceHandler = (event: MessageEvent<string>) => void;

export function useEventSource(url: string, onMessage: EventSourceHandler): void {
  useEffect(() => {
    const source = new EventSource(url);
    source.onmessage = onMessage;
    return () => source.close();
  }, [url, onMessage]);
}
