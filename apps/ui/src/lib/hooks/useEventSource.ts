import { useEffect, useRef } from "react";

type EventSourceHandler = (event: MessageEvent<string>) => void;

export function useEventSource(url: string | null | undefined, onMessage: EventSourceHandler): void {
  const handlerRef = useRef(onMessage);

  useEffect(() => {
    handlerRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    if (!url) return;
    const source = new EventSource(url);
    source.onmessage = (event) => {
      handlerRef.current(event);
    };
    return () => source.close();
  }, [url]);
}
