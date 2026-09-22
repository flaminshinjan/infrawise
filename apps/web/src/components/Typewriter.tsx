import { useEffect, useRef, useState } from "react";

interface Props {
  text: string;
  /** ms per character */
  speed?: number;
  onTick?: () => void;
}

/**
 * Reveals text one character at a time. Each mounted instance animates once
 * (keyed by message id upstream), so scrolling back doesn't re-type.
 */
export function Typewriter({ text, speed = 14, onTick }: Props) {
  const [count, setCount] = useState(0);
  const tickRef = useRef(onTick);
  tickRef.current = onTick;

  useEffect(() => {
    setCount(0);
    let i = 0;
    const timer = setInterval(() => {
      i += 1;
      setCount(i);
      tickRef.current?.();
      if (i >= text.length) clearInterval(timer);
    }, speed);
    return () => clearInterval(timer);
  }, [text, speed]);

  const done = count >= text.length;
  return (
    <span className="typewriter">
      {text.slice(0, count)}
      {!done && <span className="type-caret" />}
    </span>
  );
}
